"""
Tests del cycle_executor end-to-end con FakeStateStore + ScriptedProvider.

NO requieren claude CLI ni red. Validan:
  - El ciclo recorre las 8 phases canonicas en orden
  - La phase discovery (real) llama run_agent y persiste el state_patch real
  - Las phases stub agregan sus stub_output_keys al accumulated state
  - Cada phase deja un state_version + un agent_run en el store
  - El accumulated state crece a traves del ciclo (append, no overwrite)
  - Si una phase real falla, el cycle_executor propaga CycleExecutionError
    y el agent_run queda marcado como failed
  - El initial_state contiene prompt_inicial / requester / target_repo
  - Cycle_config custom permite usar solo un subset de phases
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Iterator

import pytest

from llm.base import LLMProvider, LLMResponse, Message, StreamChunk, ToolCall
from orchestrator.tests.fake_store import FakeStateStore
from storage.base import Run

from ..base import ToolRegistry
from ..cycle import CANONICAL_PHASES, PhaseConfig, resolve_specs_root
from ..cycle_executor import (
    CycleExecutionError,
    HitlPauseSignal,
    make_cycle_executor,
)
from ..tools.factory import build_tool_registry
from ..tools.stubs import EchoTool, NoopSearchTool


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
class ScriptedProvider(LLMProvider):
    def __init__(self, responses: list[LLMResponse]):
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def complete(self, messages, system=None, tools=None, max_tokens=4096, temperature=0.0, model=None):
        self.calls.append({"messages": list(messages), "system": system})
        if not self._responses:
            raise AssertionError("ScriptedProvider sin mas respuestas")
        return self._responses.pop(0)

    def stream(self, *a, **kw) -> Iterator[StreamChunk]:
        raise NotImplementedError

    @property
    def supports_tools(self) -> bool:
        return True

    @property
    def model_id(self) -> str:
        return "scripted-test-model"

    @property
    def context_window(self) -> int:
        return 200_000


def _final_text(content: str, cost: float = 0.001) -> LLMResponse:
    return LLMResponse(
        content=content,
        tool_calls=[],
        tokens_in=10,
        tokens_out=20,
        cost_usd=cost,
        model_id="scripted-test-model",
        finish_reason="stop",
    )


async def _create_run(store: FakeStateStore) -> Run:
    return await store.create_run(
        prompt="machbank onboarding empresas",
        requester="test@machbank.cl",
        target_repo="airothkegeln/adlc-fixture-machbank-mini",
        metadata={"source": "test"},
    )


def _registry() -> ToolRegistry:
    """
    Registry para tests del cycle_executor: incluye los 4 tools del catalogo
    como DisabledTool (faltan creds) + los stubs Echo/Noop. Asi el discovery
    spec — que tiene github_search/notion_search/linear_search/web_fetch en
    su whitelist — puede arrancar sin tener tools reales configuradas.
    El LLM nunca llega a invocarlas porque el ScriptedProvider devuelve
    final_answer en el primer turn.
    """
    registry, _ = build_tool_registry(config={}, env={}, include_stubs=True)
    return registry


# ----------------------------------------------------------------------
# Specs root sanity
# ----------------------------------------------------------------------
def test_resolve_specs_root_finds_discovery_yaml():
    root = resolve_specs_root()
    assert (root / "discovery.yaml").exists(), (
        f"discovery.yaml no encontrado en {root}. "
        f"Layout esperado: host=engine/../agent_specs/ o container=/app/agent_specs/"
    )


# ----------------------------------------------------------------------
# Ciclo completo con HITL pause en hypothesis + resume hasta validation
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_full_cycle_pauses_at_hypothesis_hitl_then_resumes():
    """
    Flujo E2E con hypothesis.yaml.hitl.enabled=true:
      1. Executor corre discovery -> hypothesis y PAUSA (HitlPauseSignal)
      2. El run queda en awaiting_hitl con un checkpoint pending
      3. Simulamos approve del checkpoint + update run a pending
      4. Executor se llama de nuevo: skip discovery+hypothesis (en history),
         ejecuta mapping + stubs hasta validation
      5. Al final hay 8 state_versions y todos los campos poblados
    """
    store = FakeStateStore()
    run = await _create_run(store)

    discovery_final = (
        '{"existing_docs": ["docs/onboarding-personas.md"], '
        '"related_tickets": ["MACHBANK-42", "MACHBANK-43"], '
        '"codebase_references": ["src/onboarding/personas.py"], '
        '"gaps_identified": ["empresas no implementado", "validacion identidad empresas no implementada"]}'
    )
    hypothesis_final = (
        '{"hypothesis": "Implementar carga de documentos de identidad de representantes legales reusando identity.py permite cumplir MACHBANK-42 sin romper el flujo de personas.", '
        '"success_criteria": ["test_empresas.py pasa sin tocar test_personas.py", "validate_identity_documents acepta el nuevo tipo company_legal_rep"], '
        '"impact_score": {"score": 7, "justification": "scope acotado al modulo onboarding, dependencia clara con identity.py existente"}}'
    )
    mapping_final = (
        '{"human_agent_map": {'
        '"human": ["revisar compliance CMF circular 1.812", "aprobar scope final"], '
        '"agent": ["crear src/onboarding/identity_empresas.py", "escribir tests"]}, '
        '"scope_boundaries": {'
        '"in_scope": ["nuevo modulo identity_empresas", "tests unitarios"], '
        '"out_of_scope": ["integracion notarius-bridge", "modificar personas.py"]}}'
    )
    spec_dev_final = (
        '{"feature_intent": "Agregar src/onboarding/identity_empresas.py con validate_representantes_legales", '
        '"capability_matrix": {"llm": [], "tool": [], "deterministic": ["implementar funcion", "escribir tests"]}, '
        '"acceptance_criteria": ['
        '{"criterion": "import funciona", "metric": "python -c import ok"}, '
        '{"criterion": "3 tests de tipo_poder pasan", "metric": "pytest -k empresas exit 0"}, '
        '{"criterion": "personas.py no modificado", "metric": "git diff src/onboarding/personas.py vacio"}'
        ']}'
    )
    architecture_final = (
        '{"tech_stack": {"language": "python 3.11", "framework": "fastapi", "libs": ["pydantic", "pytest"]}, '
        '"patterns": {"architecture": "clean light", "boundaries": "pydantic", "reasoning": "coherente con identity.py existente"}, '
        '"infra_constraints": {}}'
    )
    business_final = (
        '{"business_case": "Desbloquea MACHBANK-42/43, reusa identity.py minimizando riesgo, scope claro.", '
        '"go_no_go": {"decision": "go", "reasons": ["impact_score alto", "sin contradicciones", "scope acotado"]}, '
        '"eval_score": {"total": 78, "breakdown": {"impact": 20, "risk": 20, "cost": 19, "fit": 19}}}'
    )
    coding_final = (
        '{"files_modified": ["src/onboarding/identity_empresas.py", "tests/test_identity_empresas.py"], '
        '"unit_tests": {"exit_code": 0, "stdout_tail": "3 passed in 0.5s", "passed_count": 3}, '
        '"pr_reference": "pending"}'
    )
    validation_final = (
        '{"test_results": {"exit_code": 0, "passed_count": 3, "coverage_summary": "3/3 criterios cubiertos", "baseline_ok": true}, '
        '"static_analysis": {"status": "skipped", "notes": "MVP: queda para Fase 7 hardening"}, '
        '"deploy_status": "ready:all_ok"}'
    )
    stack_contract_final = (
        '{"stack_contract": {'
        '"language": "python", "framework": "fastapi", "runtime": "cpython3.11", '
        '"libs_required": ["pytest"], "libs_forbidden": [], '
        '"source": "repo_inferred", "ambiguous": false, '
        '"justification": "identity.py ya vive en el repo con FastAPI+pytest"'
        '}}'
    )
    provider = ScriptedProvider([
        _final_text(discovery_final, cost=0.05),
        _final_text(hypothesis_final, cost=0.08),
        _final_text(mapping_final, cost=0.02),
        _final_text(stack_contract_final, cost=0.01),
        _final_text(spec_dev_final, cost=0.07),
        _final_text(architecture_final, cost=0.06),
        _final_text(business_final, cost=0.01),
        _final_text(coding_final, cost=0.12),
        _final_text(validation_final, cost=0.01),
    ])

    executor = make_cycle_executor(
        provider=provider,
        tool_registry=_registry(),
    )

    # Primera corrida: debe pausar en hypothesis (HitlPauseSignal)
    with pytest.raises(HitlPauseSignal) as exc_info:
        await executor(store, run, None)

    assert exc_info.value.agent == "hypothesis"
    assert exc_info.value.phase == "hypothesis"

    # Estado despues del pause
    history_partial = await store.get_state_history(run.id)
    assert len(history_partial) == 2  # solo discovery y hypothesis
    assert history_partial[0].phase == "discovery"
    assert history_partial[1].phase == "hypothesis"
    assert "reusando identity.py" in history_partial[1].json_state["hypothesis"]

    # Run quedo en awaiting_hitl
    run_after_pause = await store.get_run(run.id)
    assert run_after_pause.status == "awaiting_hitl"

    # Hay un checkpoint pending
    pending_cps = await store.list_pending_hitl_checkpoints(run.id)
    assert len(pending_cps) == 1
    cp = pending_cps[0]
    assert cp.agent == "hypothesis"
    assert cp.next_phase == "mapping"
    assert "hypothesis" in cp.pending_state_patch

    # Simulamos approve: resolver + reabrir run a pending
    await store.resolve_hitl_checkpoint(
        cp.id, decision="approved", resolved_by="tester@x",
    )
    await store.update_run_status(run.id, "pending")

    # Segunda corrida: debe saltar discovery+hypothesis y correr mapping..validation
    await executor(store, run, None)

    # Ahora hay 9 state_versions (10 phases - publish skipped por deploy_status 'ready:...' — aca SI publica)
    # Hypothesis (1) + discovery (1) + mapping, stack_contract, spec_dev, architecture, business, coding, validation = 9
    history = await store.get_state_history(run.id)
    expected_phases = [p.phase for p in CANONICAL_PHASES if p.phase != "publish"]
    # Publish se ejecuta si deploy_status='ready:...' — este test pone 'ready:all_ok'
    # pero el publish agent es real y el scripted provider no tiene respuesta para el.
    # Filtramos publish del expected.
    assert [v.phase for v in history] == expected_phases[: len(history)]
    assert len(history) == 9

    # mapping (version 3) tiene el state_patch real
    mapping_v = history[2]
    assert mapping_v.agent == "mapping"
    assert "human" in mapping_v.json_state["human_agent_map"]
    assert "in_scope" in mapping_v.json_state["scope_boundaries"]

    # Ultimo state tiene campos de discovery real, hypothesis real, mapping real, stubs
    final_state = history[-1].json_state
    assert "prompt_inicial" in final_state
    assert "existing_docs" in final_state
    assert "hypothesis" in final_state
    assert "human_agent_map" in final_state
    assert "test_results" in final_state   # validation stub

    # 9 agent_runs, todos completed (no fallaron)
    assert len(store.agent_runs) == 9
    for ar in store.agent_runs.values():
        assert ar.status == "completed"

    discovery_ar = next(ar for ar in store.agent_runs.values() if ar.agent == "discovery")
    assert discovery_ar.cost_usd == pytest.approx(0.05)

    hypothesis_ar = next(ar for ar in store.agent_runs.values() if ar.agent == "hypothesis")
    assert hypothesis_ar.cost_usd == pytest.approx(0.08)

    mapping_ar = next(ar for ar in store.agent_runs.values() if ar.agent == "mapping")
    assert mapping_ar.cost_usd == pytest.approx(0.02)

    # spec_dev, architecture, business ahora tambien son reales
    spec_dev_ar = next(ar for ar in store.agent_runs.values() if ar.agent == "spec_dev")
    assert spec_dev_ar.cost_usd == pytest.approx(0.07)
    assert spec_dev_ar.model == "scripted-test-model"

    architecture_ar = next(ar for ar in store.agent_runs.values() if ar.agent == "architecture")
    assert architecture_ar.cost_usd == pytest.approx(0.06)

    business_ar = next(ar for ar in store.agent_runs.values() if ar.agent == "business")
    assert business_ar.cost_usd == pytest.approx(0.01)

    # El state final tiene los campos de los 6 agentes reales
    assert "feature_intent" in final_state
    assert "tech_stack" in final_state
    assert "go_no_go" in final_state
    assert final_state["go_no_go"]["decision"] == "go"

    # coding ahora es real (7/8 agentes LLM)
    coding_ar = next(ar for ar in store.agent_runs.values() if ar.agent == "coding")
    assert coding_ar.cost_usd == pytest.approx(0.12)
    assert coding_ar.model == "scripted-test-model"
    assert "files_modified" in final_state
    assert "identity_empresas.py" in final_state["files_modified"][0]
    assert final_state["unit_tests"]["exit_code"] == 0

    # validation ahora es real (8/8 agentes LLM — ciclo completo)
    validation_ar = next(ar for ar in store.agent_runs.values() if ar.agent == "validation")
    assert validation_ar.cost_usd == pytest.approx(0.01)
    assert validation_ar.model == "scripted-test-model"
    assert final_state["deploy_status"].startswith("ready")
    assert final_state["test_results"]["exit_code"] == 0

    # ningun agente en stub: todos son reales ahora
    stub_models = [ar.model for ar in store.agent_runs.values() if ar.model == "stub-no-llm"]
    assert len(stub_models) == 0, f"Aun hay agentes en stub: {stub_models}"


# ----------------------------------------------------------------------
# Initial state
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_initial_state_includes_run_metadata():
    store = FakeStateStore()
    run = await _create_run(store)

    discovery_final = (
        '{"existing_docs": [], "related_tickets": [], '
        '"codebase_references": [], "gaps_identified": ["nada"]}'
    )
    provider = ScriptedProvider([_final_text(discovery_final)])

    # Solo corro hasta discovery para inspeccionar el initial_state
    only_discovery = [CANONICAL_PHASES[0]]
    executor = make_cycle_executor(
        provider=provider,
        tool_registry=_registry(),
        cycle_config=only_discovery,
    )
    await executor(store, run, None)

    # El primer USER message del provider debe contener prompt_inicial,
    # requester, target_repo (porque el spec.reads incluye prompt_inicial,
    # requester, timestamp — pero el AgentRunContext.initial_state lleva todo)
    first_call = provider.calls[0]
    body = first_call["messages"][0].content
    assert "machbank onboarding empresas" in body
    assert "test@machbank.cl" in body


# ----------------------------------------------------------------------
# Custom cycle_config
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_custom_cycle_config_runs_only_specified_phases():
    store = FakeStateStore()
    run = await _create_run(store)

    custom = [
        PhaseConfig(
            name="hypothesis", phase="hypothesis", agent_name="hypothesis",
            spec_path=None, stub_output_keys=["hypothesis"],
        ),
        PhaseConfig(
            name="business", phase="business", agent_name="business",
            spec_path=None, stub_output_keys=["go_no_go"],
        ),
    ]
    provider = ScriptedProvider([])  # no se debe llamar (todas las phases son stub)
    executor = make_cycle_executor(
        provider=provider,
        tool_registry=_registry(),
        cycle_config=custom,
    )
    await executor(store, run, None)

    history = await store.get_state_history(run.id)
    assert len(history) == 2
    assert [v.phase for v in history] == ["hypothesis", "business"]
    assert provider.calls == []


# ----------------------------------------------------------------------
# Fail-fast
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_failed_real_phase_raises_and_marks_agent_run_failed():
    store = FakeStateStore()
    run = await _create_run(store)

    # Provider devuelve final_answer SIN los required_outputs del spec
    # → guardrail violation → run_agent devuelve status != completed
    bad_final = '{"existing_docs": ["x"]}'  # falta gaps_identified
    provider = ScriptedProvider([_final_text(bad_final)])

    only_discovery = [CANONICAL_PHASES[0]]
    executor = make_cycle_executor(
        provider=provider,
        tool_registry=_registry(),
        cycle_config=only_discovery,
    )

    with pytest.raises(CycleExecutionError, match="discovery"):
        await executor(store, run, None)

    # El agent_run de discovery quedo marcado failed
    discovery_ar = next(ar for ar in store.agent_runs.values() if ar.agent == "discovery")
    assert discovery_ar.status == "failed"
    assert "gaps_identified" in (discovery_ar.error or "")


@pytest.mark.asyncio
async def test_llm_exception_marks_agent_run_failed_and_propagates():
    store = FakeStateStore()
    run = await _create_run(store)

    class CrashProvider(LLMProvider):
        def complete(self, *a, **kw):
            raise RuntimeError("boom")
        def stream(self, *a, **kw):
            raise RuntimeError("boom")
        @property
        def supports_tools(self): return True
        @property
        def model_id(self): return "crash"
        @property
        def context_window(self): return 1

    only_discovery = [CANONICAL_PHASES[0]]
    executor = make_cycle_executor(
        provider=CrashProvider(),
        tool_registry=_registry(),
        cycle_config=only_discovery,
    )

    # run_agent atrapa la excepcion del LLM y devuelve STATUS_LLM_ERROR
    # → el cycle_executor lo trata como fail y tira CycleExecutionError
    with pytest.raises(CycleExecutionError, match="LLM call fallo"):
        await executor(store, run, None)

    discovery_ar = next(ar for ar in store.agent_runs.values() if ar.agent == "discovery")
    assert discovery_ar.status == "failed"


# ----------------------------------------------------------------------
# Stub-only ciclo (sin LLM)
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stub_only_cycle_runs_without_provider_calls():
    store = FakeStateStore()
    run = await _create_run(store)

    all_stubs = [
        PhaseConfig(name=p.name, phase=p.phase, agent_name=p.agent_name,
                    spec_path=None, stub_output_keys=p.stub_output_keys or ["x"])
        for p in CANONICAL_PHASES
    ]
    provider = ScriptedProvider([])  # no se debe llamar
    executor = make_cycle_executor(
        provider=provider,
        tool_registry=_registry(),
        cycle_config=all_stubs,
    )
    await executor(store, run, None)

    history = await store.get_state_history(run.id)
    # 10 phases canonicas - 1 (publish skipped por deploy_status stub) = 9
    assert len(history) == 9
    assert provider.calls == []
    # Cada agent_run completed con cost 0
    for ar in store.agent_runs.values():
        assert ar.status == "completed"
        assert ar.cost_usd == 0.0


# ----------------------------------------------------------------------
# md_state rendering
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_md_state_includes_all_keys():
    store = FakeStateStore()
    run = await _create_run(store)

    discovery_final = (
        '{"existing_docs": ["a"], "related_tickets": ["MACHBANK-42"], '
        '"codebase_references": [], "gaps_identified": ["x"]}'
    )
    provider = ScriptedProvider([_final_text(discovery_final)])

    only_discovery = [CANONICAL_PHASES[0]]
    executor = make_cycle_executor(
        provider=provider,
        tool_registry=_registry(),
        cycle_config=only_discovery,
    )
    await executor(store, run, None)

    latest = await store.get_latest_state(run.id)
    assert latest is not None
    md = latest.md_state
    assert "# Project State" in md
    assert "## prompt_inicial" in md
    assert "## existing_docs" in md
    assert "MACHBANK-42" in md
