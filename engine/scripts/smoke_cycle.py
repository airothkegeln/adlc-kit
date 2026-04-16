"""
Smoke test del cycle_executor end-to-end (sin LLM real).

A diferencia de smoke_runtime.py (que valida UN agente con LLM real),
este script valida que el cycle_executor recorra las 8 phases canonicas
y persista state_versions correctas. Usa un ScriptedProvider in-memory
y un FakeStateStore para que sea deterministico y no dependa de la red,
de claude CLI ni de Postgres.

Sirve para:
  - Confirmar que el cableado del cycle_executor esta sano post-deploy
  - Detectar regressions del ciclo cuando se agreguen specs nuevos
  - Smoke rapido durante CI (corre en <1 segundo)

Para validar el ciclo con LLM real (Claude Max via CLI), correr el
mismo flujo via API: POST /runs con un prompt y observar /runs/<id>/history.
Eso es el smoke "del paso 6" que requiere VM + container con creds OAuth.

Uso:
  docker exec adlc-engine python /app/scripts/smoke_cycle.py
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any, Iterator

from llm.base import LLMProvider, LLMResponse, StreamChunk
from agents.cycle_executor import make_cycle_executor
from agents.tools.factory import build_tool_registry
from orchestrator.tests.fake_store import FakeStateStore


# ----------------------------------------------------------------------
# Scripted provider que devuelve un final_answer canned para discovery
# ----------------------------------------------------------------------
class ScriptedProvider(LLMProvider):
    def __init__(self, responses: list[LLMResponse]):
        self._responses = list(responses)
        self.calls = 0

    def complete(self, messages, system=None, tools=None, max_tokens=4096, temperature=0.0, model=None):
        self.calls += 1
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
        return "scripted-smoke"

    @property
    def context_window(self) -> int:
        return 200_000


DISCOVERY_FINAL = (
    '{"existing_docs": ["docs/onboarding-personas.md", "docs/compliance-cmf.md"], '
    '"related_tickets": ["MACHBANK-42", "MACHBANK-43"], '
    '"codebase_references": ["src/onboarding/personas.py", "src/onboarding/identity.py"], '
    '"gaps_identified": ['
    '"src/onboarding/empresas.py no existe", '
    '"validacion identidad para representantes legales no implementada", '
    '"falta integracion con SII para verificar estado tributario"]}'
)


async def main() -> int:
    print("==> Building scripted provider + tool registry")
    provider = ScriptedProvider([
        LLMResponse(
            content=DISCOVERY_FINAL,
            tool_calls=[],
            tokens_in=20,
            tokens_out=200,
            cost_usd=0.05,
            model_id="scripted-smoke",
            finish_reason="stop",
        ),
    ])
    registry, status = build_tool_registry(config={}, env={}, include_stubs=True)
    print(f"    tool registry status: {status}")

    print("==> Building cycle_executor (default canonical phases)")
    executor = make_cycle_executor(provider=provider, tool_registry=registry)

    print("==> Creating run in FakeStateStore")
    store = FakeStateStore()
    run = await store.create_run(
        prompt="machbank onboarding empresas — carga documentos identidad",
        requester="smoke@adlc.test",
        target_repo="airothkegeln/adlc-fixture-machbank-mini",
        metadata={"source": "smoke_cycle"},
    )
    print(f"    run_id={run.id}")

    print("==> Executing cycle")
    try:
        await executor(store, run, None)
    except Exception as e:
        print(f"    ERROR: ciclo fallo con: {e}")
        return 1

    print()
    print("==> State versions persistidas:")
    history = await store.get_state_history(run.id)
    for v in history:
        added = v.diff.get("added") or []
        added_str = ", ".join(added[:3]) + ("..." if len(added) > 3 else "")
        print(f"    v{v.version:>2} [{v.phase:>13}] agent={v.agent:<13} added: {added_str}")

    print()
    print("==> Agent runs:")
    for ar in store.agent_runs.values():
        print(f"    {ar.agent:<13} status={ar.status:<10} cost=${ar.cost_usd:.4f} "
              f"tokens={ar.tokens_in}/{ar.tokens_out} model={ar.model}")

    print()
    print("==> Sanity checks")
    expected_phases = [
        "discovery", "hypothesis", "mapping", "spec",
        "architecture", "business", "coding", "validation",
    ]
    actual_phases = [v.phase for v in history]
    assert actual_phases == expected_phases, (
        f"Phases en orden incorrecto: {actual_phases}"
    )
    print(f"    [OK] 8 phases en orden canonico")

    final_state = history[-1].json_state
    for k in ("prompt_inicial", "existing_docs", "gaps_identified", "test_results"):
        assert k in final_state, f"falta '{k}' en el state final"
    print(f"    [OK] state final acumula initial + discovery real + 7 stubs")

    discovery_v = history[0]
    assert "MACHBANK-42" in discovery_v.json_state.get("related_tickets", []), \
        "discovery no proceso el final_answer del provider"
    print(f"    [OK] discovery agent persistio el state_patch del LLM")

    assert provider.calls == 1, f"provider llamado {provider.calls} veces (esperado 1)"
    print(f"    [OK] provider llamado exactamente 1 vez (solo discovery)")

    print()
    print("==> Smoke cycle PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
