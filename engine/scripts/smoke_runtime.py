"""
Smoke test del agent runtime con LLM real (claude_cli) + tools stub.

Este script valida END-TO-END que:
  - El claude_cli_provider habla con el binario `claude` real
  - El runtime serializa el system prompt + tools whitelist correctamente
  - El modelo emite tool_use parseable, el runtime lo ejecuta contra el stub
  - El modelo sigue con un final_answer JSON que satisface required_outputs
  - El AgentResult viene completed con state_patch valido

Uso (DENTRO del container engine):
  docker exec adlc-engine python /app/scripts/smoke_runtime.py

El bind mount `./engine:/app` hace que este archivo aparezca como
/app/scripts/smoke_runtime.py dentro del container — no requiere rebuild.

Requisitos:
  - Container engine corriendo con la imagen post-Fase2 (Node + claude CLI)
  - ~/.claude/.credentials.json montado en /root/.claude/ (claude login OK)
"""

from __future__ import annotations

import asyncio
import sys

from llm.registry import get_provider
from agents.base import AgentRunContext, ToolRegistry
from agents.spec_loader import parse_agent_spec
from agents.tools.stubs import NoopSearchTool
from agents.runtime import run_agent


SMOKE_SPEC = {
    "agent": "discovery_smoke",
    "phase": "discovery",
    "tier": "fast",
    "system_prompt": (
        "Eres un agente de discovery. Tu unico trabajo es:\n"
        "1. Llamar a la tool noop_search con la query 'onboarding empresas'.\n"
        "2. Contar cuantos hits devolvio la tool.\n"
        "3. Responder con un JSON con la forma {\"hits_count\": <numero entero>}.\n"
        "No hagas nada mas. No uses otras tools."
    ),
    "tools_whitelist": ["noop_search"],
    "writes": ["hits_count"],
    "guardrails": {
        "max_iterations": 5,
        "required_outputs": ["hits_count"],
    },
    "budget": {"max_cost_usd": 1.0},
    "model": "claude-haiku-4-5",
    "max_tokens": 1024,
    "temperature": 0.0,
}


async def main() -> int:
    print("==> Loading agent spec")
    spec = parse_agent_spec(SMOKE_SPEC)
    print(f"    name={spec.name} model={spec.model} tools={spec.tools_whitelist}")

    print("==> Building provider (claude_cli)")
    provider = get_provider({
        "provider": "claude_cli",
        "model_default": spec.model,
    })
    print(f"    provider model_id={provider.model_id} supports_tools={provider.supports_tools}")

    print("==> Building tool registry with NoopSearchTool")
    registry = ToolRegistry()
    registry.register(NoopSearchTool())

    print("==> Running agent")
    context = AgentRunContext(
        run_id="smoke1",
        initial_state={"prompt": "onboarding empresas"},
        requester="smoke@test",
    )
    result = await run_agent(spec, provider, registry, context)

    print()
    print("==> Result")
    print(f"    status        : {result.status}")
    print(f"    iterations    : {result.iterations_used}")
    print(f"    state_patch   : {result.state_patch}")
    print(f"    tokens_in     : {result.total_tokens_in}")
    print(f"    tokens_out    : {result.total_tokens_out}")
    print(f"    cost_usd      : {result.total_cost_usd}")
    if result.error_message:
        print(f"    error         : {result.error_message}")

    print()
    print("==> Transcript")
    for entry in result.transcript:
        marker = entry.tool_name or entry.role
        snippet = entry.content[:160].replace("\n", " ")
        print(f"    [{entry.iteration}/{entry.role}] {marker}: {snippet}")

    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
