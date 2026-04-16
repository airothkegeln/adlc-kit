"""
SimpleOrchestrator — implementación default del Orchestrator.

Asyncio + Postgres como cola/estado. Sin Temporal, Inngest, ni Redis. Una
sola dependencia operativa: el StateStore (Postgres por default).

Garantías obligatorias:
  - Memoria: cada agente recibe el project_state completo
  - Contexto: history append-only en state_versions
  - Heartbeat: agentes vivos hacen update cada N segundos
  - Watchdog: agentes sin heartbeat son marcados como timeout
  - HITL pausable: runs awaiting_hitl no se procesan hasta resolverse

Para reemplazar este orquestador por Temporal/Inngest/Trigger:
  1. Implementa Orchestrator en engine/orchestrator/<tu_orq>.py
  2. Cambia config/adlc.config.yaml -> orchestrator.driver: <tu_driver>
  3. Mantén el contrato: heartbeat + watchdog + HITL pausable
"""

from __future__ import annotations

import asyncio
import sys
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from observability.base import Tracer
from storage.base import Run, StateStore
from .base import Orchestrator, RunHandle, RunRequest


# Type alias: el agent executor recibe (store, run) y procesa todas las
# fases del ciclo. Cuando exista engine/agents/runtime.py, ese módulo
# proveerá el executor real. Por ahora SimpleOrchestrator usa un stub
# que simula el ciclo para que el orquestador sea end-to-end testeable.
AgentExecutor = Callable[[StateStore, Run, "SimpleOrchestrator"], Awaitable[None]]


# ----------------------------------------------------------------------
# Stub executor: simula el ciclo ADLC sin agentes reales
# ----------------------------------------------------------------------
STUB_PHASES = [
    ("discovery", "discovery"),
    ("hypothesis", "hypothesis"),
    ("mapping", "mapping"),
    ("spec_dev", "spec"),
    ("architecture", "architecture"),
    ("business", "business"),
    ("coding", "coding"),
    ("validation", "validation"),
]


async def stub_agent_executor(
    store: StateStore, run: Run, orchestrator: "SimpleOrchestrator"
) -> None:
    """
    Stub: simula la ejecucion de los 8 agentes canonicos del ciclo ADLC.

    NO llama a un LLM real. Crea un agent_run por cada fase, manda
    heartbeats, y appendea una version del project_state. Sirve para
    validar end-to-end del orquestador antes de que exista el agent
    runtime real.

    Sera reemplazado por engine/agents/runtime.py:execute_cycle() en
    el Paso 6 del buildout.
    """
    accumulated: dict[str, Any] = {
        "prompt_inicial": run.prompt,
        "requester": run.requester,
        "started_at": run.started_at.isoformat() if run.started_at else None,
    }

    for agent_name, phase in STUB_PHASES:
        ar = await store.start_agent_run(
            run_id=run.id,
            agent=agent_name,
            model="stub-no-llm",
        )

        # Heartbeat simulado: 3 ticks de 0.1s
        for _ in range(3):
            await store.heartbeat(ar.id)
            await asyncio.sleep(0.1)

        # Cada agente "agrega" su capa al state
        accumulated[f"{phase}_output"] = f"stub output de {agent_name}"
        md = _render_md(accumulated)

        await store.append_state_version(
            run_id=run.id,
            agent=agent_name,
            phase=phase,
            json_state=accumulated,
            md_state=md,
            diff={"added": [f"{phase}_output"]},
        )

        await store.finish_agent_run(
            ar.id,
            status="completed",
            tokens_in=0,
            tokens_out=0,
            cost_usd=0.0,
            duration_ms=300,
        )


def _render_md(state: dict[str, Any]) -> str:
    lines = ["# Project State", ""]
    for k, v in state.items():
        lines.append(f"## {k}")
        lines.append(f"{v}")
        lines.append("")
    return "\n".join(lines)


# ----------------------------------------------------------------------
# Orquestador
# ----------------------------------------------------------------------
class SimpleOrchestrator(Orchestrator):

    def __init__(
        self,
        store: StateStore,
        agent_executor: AgentExecutor | None = None,
        max_concurrent_runs: int = 3,
        poll_interval_seconds: float = 2.0,
        watchdog_timeout_seconds: int = 120,
        heartbeat_interval_seconds: int = 10,
        tracer: Tracer | None = None,
    ):
        self._store = store
        self._executor: AgentExecutor = agent_executor or stub_agent_executor
        self._max_concurrent = max_concurrent_runs
        self._poll_interval = poll_interval_seconds
        self._watchdog_timeout = watchdog_timeout_seconds
        self._heartbeat_interval = heartbeat_interval_seconds
        self._tasks: set[asyncio.Task] = set()
        self._running = False
        self._tracer = tracer

    # ------------------------------------------------------------------
    # interfaz Orchestrator
    # ------------------------------------------------------------------
    async def start_run(self, request: RunRequest) -> RunHandle:
        run = await self._store.create_run(
            prompt=request.prompt,
            requester=request.requester,
            target_repo=request.target_repo,
            metadata=request.metadata or {},
        )
        return RunHandle(run_id=run.id, status=run.status)

    async def get_run(self, run_id: str) -> RunHandle:
        run = await self._store.get_run(run_id)
        if run is None:
            raise ValueError(f"Run {run_id} no existe")
        return RunHandle(run_id=run.id, status=run.status)

    async def resolve_hitl(
        self,
        run_id: str,
        checkpoint_id: str,
        decision: str,
        resolver: str,
        feedback: str | None = None,
    ) -> None:
        """
        Resuelve un HITL checkpoint:
          - approved: marca el checkpoint + cambia el run a 'pending' para
            que el loop lo retome. El cycle_executor al reanudar detecta
            las phases ya ejecutadas en state_versions y salta hasta la
            siguiente.
          - rejected: marca el checkpoint + cambia el run a 'failed' con
            el feedback como error. MVP simple — la opcion de re-ejecutar
            con el feedback como contexto extra queda para Fase 7.
        """
        if decision not in ("approved", "rejected"):
            raise ValueError(f"decision invalida: {decision}")

        run = await self._store.get_run(run_id)
        if run is None:
            raise ValueError(f"Run {run_id} no existe")
        if run.status != "awaiting_hitl":
            raise ValueError(
                f"Run {run_id} esta en status {run.status}, no awaiting_hitl"
            )

        await self._store.resolve_hitl_checkpoint(
            checkpoint_id,
            decision=decision,
            resolved_by=resolver,
            feedback=feedback,
        )

        if decision == "approved":
            await self._store.update_run_status(run_id, "pending")
        else:
            reject_msg = f"HITL reject por {resolver}"
            if feedback:
                reject_msg += f": {feedback}"
            await self._store.update_run_status(
                run_id, "failed", error=reject_msg
            )

    async def abort_run(self, run_id: str, reason: str) -> None:
        await self._store.update_run_status(run_id, "aborted", error=reason)

    async def heartbeat(self, run_id: str, agent_run_id: str) -> None:
        await self._store.heartbeat(agent_run_id)

    # ------------------------------------------------------------------
    # main loop
    # ------------------------------------------------------------------
    async def run_forever(self) -> None:
        """
        Loop principal. Llamar desde el startup del API o como worker
        standalone. Lanza un watchdog task en paralelo.
        """
        self._running = True
        watchdog = asyncio.create_task(self._watchdog_loop())
        try:
            while self._running:
                try:
                    await self._poll_once()
                except Exception as e:
                    print(f"[orchestrator] poll error: {e}", file=sys.stderr)
                await asyncio.sleep(self._poll_interval)
        finally:
            watchdog.cancel()
            # Espera a que tareas en curso terminen (con timeout corto)
            if self._tasks:
                await asyncio.wait(self._tasks, timeout=5)

    def stop(self) -> None:
        self._running = False

    async def _poll_once(self) -> None:
        if len(self._tasks) >= self._max_concurrent:
            return
        slots = self._max_concurrent - len(self._tasks)
        pending = await self._store.list_pending_runs(limit=slots)
        for run in pending:
            await self._store.update_run_status(run.id, "running")
            task = asyncio.create_task(self._execute_run(run))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _execute_run(self, run: Run) -> None:
        start = time.monotonic()
        if self._tracer:
            self._tracer.event("run_start", run_id=run.id, requester=run.requester, prompt=run.prompt[:100] if run.prompt else "")
        try:
            await self._executor(self._store, run, self)
            elapsed_ms = int((time.monotonic() - start) * 1000)
            await self._store.update_run_status(run.id, "completed")
            if self._tracer:
                self._tracer.metric("run_duration_ms", elapsed_ms, run_id=run.id, status="completed")
                self._tracer.event("run_completed", run_id=run.id, duration_ms=elapsed_ms)
        except Exception as e:
            # HitlPauseSignal: el ciclo pauso esperando aprobacion humana.
            # NO es un error — el cycle_executor ya persistio el state_patch
            # del agente y el checkpoint, y puso el run en awaiting_hitl.
            # Chequeamos por nombre para no acoplar el orchestrator al
            # modulo engine/agents.
            if type(e).__name__ == "HitlPauseSignal":
                elapsed = time.monotonic() - start
                print(
                    f"[orchestrator] run {run.id} pausado por HITL tras "
                    f"{elapsed:.1f}s: {e}",
                    file=sys.stderr,
                )
                if self._tracer:
                    self._tracer.event("run_hitl_pause", run_id=run.id, duration_ms=int(elapsed * 1000))
                return
            elapsed = time.monotonic() - start
            print(
                f"[orchestrator] run {run.id} fallo tras {elapsed:.1f}s: {e}",
                file=sys.stderr,
            )
            if self._tracer:
                self._tracer.metric("run_duration_ms", int(elapsed * 1000), run_id=run.id, status="failed")
                self._tracer.event("run_failed", run_id=run.id, duration_ms=int(elapsed * 1000), error=str(e)[:200])
            await self._store.update_run_status(run.id, "failed", error=str(e))

    async def _watchdog_loop(self) -> None:
        """
        Cada N/4 segundos busca agent_runs sin heartbeat y los marca
        como timeout. NO mata el run completo — solo el agent_run
        especifico. La logica de retry o fallo del run es del
        executor.
        """
        interval = max(self._watchdog_timeout / 4, 1.0)
        while self._running:
            try:
                await asyncio.sleep(interval)
                stale = await self._store.find_stale_agent_runs(
                    self._watchdog_timeout
                )
                for agent_run_id in stale:
                    await self._store.finish_agent_run(
                        agent_run_id,
                        status="timeout",
                        error=f"watchdog: sin heartbeat por mas de {self._watchdog_timeout}s",
                    )
                    print(
                        f"[watchdog] agent_run {agent_run_id} marcado como timeout",
                        file=sys.stderr,
                    )
                    if self._tracer:
                        self._tracer.event("agent_timeout", agent_run_id=agent_run_id, timeout_seconds=self._watchdog_timeout)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[watchdog] error: {e}", file=sys.stderr)
