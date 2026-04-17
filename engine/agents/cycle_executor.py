"""
Cycle executor — reemplazo de stub_agent_executor que orquesta el ciclo
ADLC ejecutando run_agent() por phase real, con fallback a stub para las
phases que aun no tienen YAML.

Contrato: devuelve una funcion compatible con `AgentExecutor` del
SimpleOrchestrator (`Callable[[StateStore, Run, SimpleOrchestrator], Awaitable[None]]`).
El orquestador la invoca cuando un run pasa de pending a running.

Garantias por phase:
  - Crea un agent_run en el StateStore (start_agent_run)
  - Ejecuta la phase (real o stub)
  - Mergea el state_patch en el accumulated_state acumulado
  - Appendea un state_version con el snapshot completo + diff
  - Cierra el agent_run con tokens/cost/duration

Manejo de errores:
  - Si una phase real falla con statuses de run_agent (budget_exceeded,
    iteration_exceeded, guardrail_violation, tool_error, llm_error), el
    cycle_executor MARCA el agent_run como failed y PROPAGA la excepcion
    al orquestador (que marca el run completo como failed).
  - Esto es estricto a proposito. Cuando los agentes posteriores existan
    y haya degraded mode (continuar pese a un fallo no critico), agregamos
    una bandera por phase. Por ahora: fail-fast.

Heartbeat:
  - Lo dispara el cycle_executor antes de cada phase, no durante. Para
    runs largos esto es subooptimo (el watchdog puede declarar timeout),
    pero el agent_runtime es sincrono dentro del proceso y no podemos
    hacer heartbeats concurrentes desde el mismo loop sin tareas async.
    Si esto se vuelve un problema real, el agent_runtime puede recibir
    un heartbeat callback como dependencia.
"""

from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from llm.base import LLMProvider
from observability.base import Tracer
from observability.run_log_buffer import run_log
from storage.base import Run, StateStore

from .base import (
    STATUS_COMPLETED,
    AgentResult,
    AgentRunContext,
    ToolRegistry,
)
from .cycle import CANONICAL_PHASES, PhaseConfig, resolve_specs_root
from .gates import GateResult, get_gate
from .runtime import run_agent
from .spec_loader import load_agent_spec
from eval.evaluator import evaluate_agent_output
from sandbox.context import current_phase, current_run_id


# Retries permitidos por gate antes de fail-fast. Incluye el intento inicial,
# o sea MAX_GATE_ATTEMPTS=3 => 1 intento original + 2 reintentos.
MAX_GATE_ATTEMPTS = 3


# Tipo del executor que devolvemos. Compatible con AgentExecutor del
# SimpleOrchestrator pero con tipos explicitos.
CycleExecutor = Callable[[StateStore, Run, Any], Awaitable[None]]


class CycleExecutionError(RuntimeError):
    """Error de una phase del ciclo. Lleva el contexto del fallo."""


class HitlPauseSignal(Exception):
    """
    Señal (no error) que el cycle_executor lanza cuando un agente con
    `hitl.enabled: true` termina OK y hay que pausar el ciclo esperando
    aprobación humana. El orchestrator la captura sin marcar el run
    como failed: deja el run en status `awaiting_hitl` y la info del
    checkpoint creado queda persistida via store.create_hitl_checkpoint.
    """

    def __init__(self, checkpoint_id: str, agent: str, phase: str):
        super().__init__(
            f"HITL pause: agente '{agent}' (phase '{phase}') "
            f"creo el checkpoint {checkpoint_id}"
        )
        self.checkpoint_id = checkpoint_id
        self.agent = agent
        self.phase = phase


def make_cycle_executor(
    provider: LLMProvider,
    tool_registry: ToolRegistry,
    cycle_config: list[PhaseConfig] | None = None,
    specs_root: Path | None = None,
    tracer: Tracer | None = None,
) -> CycleExecutor:
    """
    Construye un agent_executor con provider + tool_registry capturados
    en closure. Devuelve una funcion async compatible con SimpleOrchestrator.
    """
    phases = cycle_config or CANONICAL_PHASES
    root = specs_root or resolve_specs_root()

    async def cycle_executor(store: StateStore, run: Run, _orchestrator: Any) -> None:
        # Resume-friendly: si hay state_versions previas (run reanudado despues
        # de un HITL approve), arrancamos desde el latest state acumulado y
        # saltamos las phases ya ejecutadas. Si no, empezamos desde cero.
        accumulated, completed_phases = await _load_resume_state(store, run)

        for phase_cfg in phases:
            if phase_cfg.phase in completed_phases:
                continue
            if _should_skip_phase(phase_cfg, accumulated, run):
                continue
            await _execute_phase_with_gate(
                store=store,
                run=run,
                phase_cfg=phase_cfg,
                accumulated=accumulated,
                provider=provider,
                tool_registry=tool_registry,
                specs_root=root,
                tracer=tracer,
            )

    return cycle_executor


async def _execute_phase_with_gate(
    *,
    store: StateStore,
    run: Run,
    phase_cfg: PhaseConfig,
    accumulated: dict[str, Any],
    provider: LLMProvider,
    tool_registry: ToolRegistry,
    specs_root: Path,
    tracer: Tracer | None = None,
) -> None:
    """
    Ejecuta una phase y, si tiene un gate registrado, lo corre despues.
    Si el gate falla, inyecta retry_hint en el accumulated_state y re-ejecuta
    la phase hasta MAX_GATE_ATTEMPTS. Al superar el limite, fail-fast con
    CycleExecutionError.
    """
    gate = get_gate(phase_cfg.phase)
    retry_key = f"_gate_retry_hint__{phase_cfg.phase}"

    attempts = 0
    while True:
        attempts += 1
        await _execute_phase(
            store=store,
            run=run,
            phase_cfg=phase_cfg,
            accumulated=accumulated,
            provider=provider,
            tool_registry=tool_registry,
            specs_root=specs_root,
            tracer=tracer,
        )

        # Sin gate => seguimos.
        if gate is None:
            accumulated.pop(retry_key, None)
            return

        result = gate(accumulated)
        if result.passed:
            run_log(
                run.id,
                f"[gate] phase={phase_cfg.phase} PASSED (attempt {attempts})",
            )
            if tracer:
                tracer.event(
                    "gate_passed",
                    run_id=run.id,
                    phase=phase_cfg.phase,
                    attempts=attempts,
                )
            # Limpiamos el hint para que las phases siguientes no lo vean.
            accumulated.pop(retry_key, None)
            return

        # Gate fallo.
        run_log(
            run.id,
            f"[gate] phase={phase_cfg.phase} FAILED attempt={attempts} "
            f"violations={result.violations}",
        )
        if tracer:
            tracer.event(
                "gate_failed",
                run_id=run.id,
                phase=phase_cfg.phase,
                attempts=attempts,
                violations=result.violations[:10],
            )

        if attempts >= MAX_GATE_ATTEMPTS:
            raise CycleExecutionError(
                f"phase '{phase_cfg.name}' fallo el gate tras {attempts} intentos. "
                f"Violaciones: {result.violations}"
            )

        # Inyectamos el retry_hint en el state. El siguiente _execute_phase
        # serializa accumulated completo en el initial_user_message, asi que
        # el agente lee el hint sin cambios al prompt.
        accumulated[retry_key] = result.retry_hint


# ----------------------------------------------------------------------
# Internals
# ----------------------------------------------------------------------
def _should_skip_phase(
    phase_cfg: PhaseConfig, accumulated: dict[str, Any], run: Run
) -> bool:
    """
    Gates por-phase. Por ahora el unico gate es publish: si validation
    declaro deploy_status distinto de 'ready', saltamos publish y dejamos
    que el humano revise. Loggeamos la razon para trazabilidad.

    El field deploy_status puede llegar como:
      - "ready:..." / "ready"            → publicar
      - "blocked:..." / "blocked"        → skip
      - "blocked_coverage:..."           → skip
      - "failed:..." / "failed"          → skip
      - ausente (coding/validation fallo antes) → skip
    """
    if phase_cfg.phase != "publish":
        return False

    deploy_status = accumulated.get("deploy_status")
    if not deploy_status or not isinstance(deploy_status, str):
        run_log(
            run.id,
            f"[executor] skip publish: deploy_status ausente en el state "
            f"(validation no corrio o fallo)",
        )
        return True

    # El validation agent prefija el status con la razon ("ready:all_ok",
    # "ready_partial:manual_required", "blocked_coverage:...").
    # Aceptamos ambos ready* para publish (partial = OK Linux + tasks manuales
    # documentadas, vale la pena publicar igual para que humanos ejecuten
    # las tareas). Chequeamos el prefijo antes de los dos puntos.
    head = deploy_status.split(":", 1)[0].strip().lower()
    if head not in ("ready", "ready_partial"):
        run_log(
            run.id,
            f"[executor] skip publish: deploy_status='{deploy_status}' "
            f"(esperaba 'ready')",
        )
        return True

    return False


def _build_initial_state(run: Run) -> dict[str, Any]:
    # Extraer reference_repos por categoria desde metadata.repos, que el UI
    # envia como { "owner/repo": ["arquitectura", "design_system", ...] }.
    # El engine los expone como lista plana por categoria para que los
    # agent specs los lean con reads: [architecture_repos, design_system_repos].
    md = dict(run.metadata or {})
    repos_by_cat = md.get("repos") or {}
    reference_repos: dict[str, list[str]] = {}
    for repo_name, cats in repos_by_cat.items():
        for cat in (cats or []):
            reference_repos.setdefault(cat, []).append(repo_name)
    # Detectar greenfield vs brownfield: si no hay target_repo, es greenfield
    # (el requester quiere crear algo nuevo desde cero).
    project_type = "brownfield" if run.target_repo else "greenfield"

    return {
        "prompt_inicial": run.prompt,
        "requester": run.requester,
        "target_repo": run.target_repo,
        "project_type": project_type,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "metadata": md,
        "reference_repos": reference_repos,
    }


async def _load_resume_state(
    store: StateStore, run: Run
) -> tuple[dict[str, Any], set[str]]:
    """
    Para runs reanudados (HITL approve): recupera el accumulated_state del
    latest_state version y el set de phases ya ejecutadas (por lectura del
    history). Para runs nuevos, devuelve el initial_state + set vacio.
    """
    latest = await store.get_latest_state(run.id)
    if latest is None:
        return _build_initial_state(run), set()

    history = await store.get_state_history(run.id)
    completed = {v.phase for v in history}
    # Mezclamos latest.json_state (contenido acumulado hasta ahora) con el
    # initial_state por si faltara algun campo base (ej. metadata).
    accumulated = dict(latest.json_state)
    for k, v in _build_initial_state(run).items():
        accumulated.setdefault(k, v)
    return accumulated, completed


async def _execute_phase(
    *,
    store: StateStore,
    run: Run,
    phase_cfg: PhaseConfig,
    accumulated: dict[str, Any],
    provider: LLMProvider,
    tool_registry: ToolRegistry,
    specs_root: Path,
    tracer: Tracer | None = None,
) -> None:
    """
    Ejecuta UNA phase. Bifurca entre real (spec_path presente) y stub.
    Persiste agent_run + state_version pase lo que pase.
    """
    is_real = phase_cfg.spec_path is not None
    # El model_label para el DB lo calculamos con provider.model_id porque
    # el spec todavía no se cargó (eso pasa dentro del try). Para el log
    # del executor, cargamos el spec acá si aplica para tener el modelo real.
    model_label = "stub-no-llm" if not is_real else provider.model_id
    display_model = model_label
    if is_real:
        try:
            _preview_spec = load_agent_spec(
                specs_root / phase_cfg.spec_path  # type: ignore[arg-type]
            )
            display_model = _preview_spec.model or provider.model_id
        except Exception:
            pass  # si falla el load, lo loggeamos abajo con el default

    run_log(
        run.id,
        f"[executor] phase={phase_cfg.phase} agent={phase_cfg.agent_name} "
        f"real={is_real} model={display_model}",
    )
    if tracer:
        tracer.event(
            "phase_start",
            run_id=run.id,
            phase=phase_cfg.phase,
            agent=phase_cfg.agent_name,
            is_real=is_real,
            model=display_model,
        )

    ar = await store.start_agent_run(
        run_id=run.id,
        agent=phase_cfg.agent_name,
        model=model_label,
    )

    start_ts = time.monotonic()

    # Heartbeat al arrancar la phase. Las phases reales pueden tomar
    # varios segundos por las llamadas LLM — el watchdog default tolera
    # 120s sin heartbeat, debe alcanzar para una phase tipica.
    await store.heartbeat(ar.id)

    spec = None  # type: ignore[assignment]
    # Setear contextvars para que tools (ej. sandbox_run) sepan a que
    # run/phase pertenece la invocacion y puedan persistir artefactos
    # en /data/runs/<run_id>/<phase>/. Reset en el finally.
    token_run = current_run_id.set(run.id)
    token_phase = current_phase.set(phase_cfg.phase)
    try:
        if is_real:
            spec_path = specs_root / phase_cfg.spec_path  # type: ignore[arg-type]
            spec = load_agent_spec(spec_path)
            context = AgentRunContext(
                run_id=run.id,
                initial_state=dict(accumulated),
                requester=run.requester,
            )
            result: AgentResult = await run_agent(
                spec=spec,
                provider=provider,
                tools=tool_registry,
                context=context,
                tracer=tracer,
            )
            state_patch = result.state_patch
            tokens_in = result.total_tokens_in
            tokens_out = result.total_tokens_out
            cost_usd = result.total_cost_usd
            agent_status = (
                "completed" if result.status == STATUS_COMPLETED else "failed"
            )
            error_message = result.error_message if not result.ok else None
        else:
            # Stub: agrega keys canned al state.
            state_patch = {
                k: f"stub output de {phase_cfg.agent_name}"
                for k in phase_cfg.stub_output_keys
            }
            tokens_in = tokens_out = 0
            cost_usd = 0.0
            agent_status = "completed"
            error_message = None

        # Solo mergeamos el patch si el agente completó OK.
        # Si falló (guardrail violation, iteration exceeded, etc.) NO
        # contaminamos el accumulated con datos parciales/raw_text.
        if agent_status == "completed":
            previous_keys = set(accumulated.keys())
            accumulated.update(state_patch)
            added = sorted(set(state_patch.keys()) - previous_keys)
            modified = sorted(set(state_patch.keys()) & previous_keys)
        else:
            added = []
            modified = []
            run_log(
                run.id,
                f"[executor] phase={phase_cfg.phase} FAILED — state_patch "
                f"NOT merged (keys={list(state_patch.keys())})",
            )

        await store.append_state_version(
            run_id=run.id,
            agent=phase_cfg.agent_name,
            phase=phase_cfg.phase,
            json_state=dict(accumulated),
            md_state=_render_md(accumulated),
            diff={"added": added, "modified": modified},
            spec_commit_sha=None,  # TODO: cargar de git si el repo lo tiene
        )

        duration_ms = int((time.monotonic() - start_ts) * 1000)

        await store.finish_agent_run(
            ar.id,
            status=agent_status,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd=cost_usd,
            duration_ms=duration_ms,
            error=error_message,
        )

        run_log(
            run.id,
            f"[executor] phase={phase_cfg.phase} status={agent_status} "
            f"duration={duration_ms}ms cost=${cost_usd:.4f} "
            f"patch_keys={list(state_patch.keys())}",
        )

        # Eval: quality scoring for completed real agents
        if is_real and agent_status == "completed" and spec is not None:
            try:
                eval_result = evaluate_agent_output(spec, state_patch)
                await store.save_eval_score(
                    run_id=run.id,
                    agent_run_id=ar.id,
                    agent=phase_cfg.agent_name,
                    phase=phase_cfg.phase,
                    score=eval_result.score,
                    checks=[
                        {"name": c.name, "passed": c.passed, "detail": c.detail, "weight": c.weight}
                        for c in eval_result.checks
                    ],
                    violations=eval_result.violations,
                )
                run_log(
                    run.id,
                    f"[eval] phase={phase_cfg.phase} agent={phase_cfg.agent_name} "
                    f"score={eval_result.score:.1f}/100 "
                    f"checks={sum(1 for c in eval_result.checks if c.passed)}/{len(eval_result.checks)} "
                    f"violations={len(eval_result.violations)}",
                )
                if tracer:
                    tracer.metric(
                        "eval_score", eval_result.score,
                        run_id=run.id, phase=phase_cfg.phase, agent=phase_cfg.agent_name,
                    )
                    if eval_result.violations:
                        tracer.event(
                            "eval_violations",
                            run_id=run.id, phase=phase_cfg.phase,
                            agent=phase_cfg.agent_name,
                            violations=eval_result.violations[:10],
                            score=eval_result.score,
                        )
            except Exception as eval_err:
                # Eval failure should NOT block the cycle
                run_log(
                    run.id,
                    f"[eval] WARNING: eval failed for {phase_cfg.agent_name}: {eval_err}",
                )

        # Emit phase metrics to tracer
        if tracer:
            tracer.metric("phase_duration_ms", duration_ms, run_id=run.id, phase=phase_cfg.phase, agent=phase_cfg.agent_name, status=agent_status)
            tracer.metric("phase_tokens_in", tokens_in, run_id=run.id, phase=phase_cfg.phase, agent=phase_cfg.agent_name)
            tracer.metric("phase_tokens_out", tokens_out, run_id=run.id, phase=phase_cfg.phase, agent=phase_cfg.agent_name)
            tracer.metric("phase_cost_usd", cost_usd, run_id=run.id, phase=phase_cfg.phase, agent=phase_cfg.agent_name)
            tracer.event(
                "state_changed",
                run_id=run.id,
                phase=phase_cfg.phase,
                agent=phase_cfg.agent_name,
                added_keys=added,
                modified_keys=modified,
            )

        if agent_status != "completed":
            if tracer:
                tracer.event("phase_failed", run_id=run.id, phase=phase_cfg.phase, agent=phase_cfg.agent_name, error=error_message)
            # Fail-fast: el orquestador captura y marca el run como failed.
            raise CycleExecutionError(
                f"phase '{phase_cfg.name}' fallo con status='{agent_status}': "
                f"{error_message or '(sin mensaje)'}"
            )

        # HITL gate: si el spec tiene hitl.enabled=true, pausamos el run
        # despues de persistir el state_patch. El humano revisa la decision
        # del agente y approve/reject via API. Ver engine/agents/cycle_executor.py
        # :HitlPauseSignal y orchestrator/simple_orchestrator.py:resolve_hitl.
        if is_real and spec is not None and spec.hitl_enabled:
            next_phase = _next_phase_name(phase_cfg.phase)
            checkpoint = await store.create_hitl_checkpoint(
                run_id=run.id,
                agent=phase_cfg.agent_name,
                phase=phase_cfg.phase,
                pending_state_patch=dict(state_patch),
                next_phase=next_phase,
            )
            await store.update_run_status(run.id, "awaiting_hitl")
            if tracer:
                tracer.event("hitl_pause", run_id=run.id, phase=phase_cfg.phase, agent=phase_cfg.agent_name, checkpoint_id=checkpoint.id)
            raise HitlPauseSignal(
                checkpoint_id=checkpoint.id,
                agent=phase_cfg.agent_name,
                phase=phase_cfg.phase,
            )

    except (CycleExecutionError, HitlPauseSignal):
        raise
    except Exception as e:
        # Excepcion inesperada (no de run_agent): marcamos el agent_run y
        # propagamos. Probablemente es un bug del cycle_executor o del
        # storage — queremos verlo en los logs del orquestador.
        duration_ms = int((time.monotonic() - start_ts) * 1000)
        if tracer:
            tracer.event("phase_exception", run_id=run.id, phase=phase_cfg.phase, agent=phase_cfg.agent_name, error=str(e)[:200])
        try:
            await store.finish_agent_run(
                ar.id,
                status="failed",
                duration_ms=duration_ms,
                error=f"excepcion inesperada: {e}",
            )
        except Exception:  # nosec — ya estamos en error path
            pass
        raise
    finally:
        current_run_id.reset(token_run)
        current_phase.reset(token_phase)


def _next_phase_name(current_phase: str) -> str | None:
    """
    Dado el nombre de la phase actual, devuelve la phase siguiente segun
    CANONICAL_PHASES. Usado para anotar HITL checkpoints con `next_phase`
    para que la UI muestre desde donde se reanudara el ciclo.
    """
    names = [p.phase for p in CANONICAL_PHASES]
    try:
        idx = names.index(current_phase)
    except ValueError:
        return None
    return names[idx + 1] if idx + 1 < len(names) else None


def _render_md(state: dict[str, Any]) -> str:
    """
    Render minimo del project_state como markdown. Mismo patron que el
    stub original — el formato lo iteramos cuando tengamos un agente
    PMO real que lo consuma.
    """
    lines = ["# Project State", ""]
    for k, v in state.items():
        lines.append(f"## {k}")
        if isinstance(v, (dict, list)):
            import json
            lines.append("```json")
            lines.append(json.dumps(v, indent=2, ensure_ascii=False, default=str))
            lines.append("```")
        else:
            lines.append(str(v))
        lines.append("")
    return "\n".join(lines)
