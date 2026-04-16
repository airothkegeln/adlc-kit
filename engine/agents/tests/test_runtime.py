"""
Tests del agent runtime con LLMProvider scripted y ToolRegistry stub.

Cobertura:
  - Single-shot final_answer (sin tools)
  - Multi-iter tool_use → tool_result → final_answer
  - max_iterations excedido
  - max_cost_usd excedido
  - Tool fuera de la whitelist (KeyError al filtrar)
  - Tool que lanza excepcion → STATUS_TOOL_ERROR
  - required_outputs faltantes → STATUS_GUARDRAIL_VIOLATION
  - LLMProvider que lanza excepcion → STATUS_LLM_ERROR
  - reads filtrado del initial_state
  - Parseo de final_answer con fences markdown
  - Wiring real con stubs (EchoTool, NoopSearchTool)

NO requieren claude CLI ni red. El LLMProvider es un script in-memory.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Iterator

import pytest

from llm.base import LLMProvider, LLMResponse, Message, StreamChunk, ToolCall, ToolSpec

from ..base import (
    STATUS_BUDGET_EXCEEDED,
    STATUS_COMPLETED,
    STATUS_GUARDRAIL_VIOLATION,
    STATUS_ITERATION_EXCEEDED,
    STATUS_LLM_ERROR,
    STATUS_TOOL_ERROR,
    AgentRunContext,
    AgentSpec,
    Budget,
    Guardrails,
    Tool,
    ToolRegistry,
)
from ..runtime import _parse_final_answer, run_agent
from ..tools.stubs import EchoTool, NoopSearchTool


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
class ScriptedProvider(LLMProvider):
    """LLMProvider que devuelve respuestas pre-armadas en orden."""

    def __init__(self, responses: list[LLMResponse]):
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def complete(self, messages, system=None, tools=None, max_tokens=4096, temperature=0.0, model=None):
        self.calls.append({
            "messages": list(messages),
            "system": system,
            "tools": list(tools) if tools else None,
        })
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
        return "scripted-test"

    @property
    def context_window(self) -> int:
        return 200_000


class FailingProvider(LLMProvider):
    def complete(self, *a, **kw):
        raise RuntimeError("simulated llm crash")

    def stream(self, *a, **kw):
        raise RuntimeError("simulated llm crash")

    @property
    def supports_tools(self) -> bool:
        return True

    @property
    def model_id(self) -> str:
        return "failing"

    @property
    def context_window(self) -> int:
        return 1


def make_spec(
    *,
    name: str = "test_agent",
    tools_whitelist: list[str] | None = None,
    writes: list[str] | None = None,
    required_outputs: list[str] | None = None,
    max_iterations: int = 10,
    max_cost_usd: float = 1.0,
    reads: list[str] | None = None,
) -> AgentSpec:
    return AgentSpec(
        name=name,
        phase="test",
        tier="fast",
        description="agent de test",
        model="claude-haiku-4-5",
        max_tokens=1024,
        temperature=0.0,
        system_prompt="Eres un agente de prueba.",
        tools_whitelist=tools_whitelist or [],
        capability_matrix_llm=[],
        capability_matrix_deterministic=[],
        reads=reads or [],
        writes=writes or [],
        guardrails=Guardrails(
            max_iterations=max_iterations,
            required_outputs=required_outputs or [],
        ),
        budget=Budget(max_cost_usd=max_cost_usd, timeout_minutes=10),
        hitl_enabled=False,
        failure_modes=[],
    )


def text_response(content: str, cost: float = 0.001, t_in: int = 10, t_out: int = 10) -> LLMResponse:
    return LLMResponse(
        content=content,
        tool_calls=[],
        tokens_in=t_in,
        tokens_out=t_out,
        cost_usd=cost,
        model_id="scripted-test",
        finish_reason="stop",
    )


def tool_use_response(name: str, args: dict, call_id: str = "tu_1", cost: float = 0.001) -> LLMResponse:
    return LLMResponse(
        content="",
        tool_calls=[ToolCall(id=call_id, name=name, arguments=args)],
        tokens_in=10,
        tokens_out=10,
        cost_usd=cost,
        model_id="scripted-test",
        finish_reason="tool_use",
    )


@pytest.fixture
def registry() -> ToolRegistry:
    r = ToolRegistry()
    r.register(EchoTool())
    r.register(NoopSearchTool())
    return r


# ----------------------------------------------------------------------
# Single-shot
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_single_shot_final_answer(registry):
    spec = make_spec(writes=["result"], required_outputs=["result"])
    provider = ScriptedProvider([
        text_response('{"result": "ok"}', cost=0.005),
    ])

    out = await run_agent(
        spec=spec,
        provider=provider,
        tools=registry,
        context=AgentRunContext(run_id="r1", initial_state={"prompt": "x"}),
    )

    assert out.status == STATUS_COMPLETED
    assert out.ok
    assert out.state_patch == {"result": "ok"}
    assert out.iterations_used == 1
    assert out.total_cost_usd == pytest.approx(0.005)
    assert len(out.transcript) == 1
    assert out.transcript[0].role == "llm"


@pytest.mark.asyncio
async def test_final_answer_with_markdown_fence(registry):
    spec = make_spec(writes=["x"], required_outputs=["x"])
    fenced = '```json\n{"x": 42}\n```'
    provider = ScriptedProvider([text_response(fenced)])
    out = await run_agent(spec, provider, registry, AgentRunContext(run_id="r", initial_state={}))
    assert out.status == STATUS_COMPLETED
    assert out.state_patch == {"x": 42}


# ----------------------------------------------------------------------
# Multi-iter tool use
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_tool_use_loop_completes(registry):
    spec = make_spec(
        tools_whitelist=["echo"],
        writes=["result"],
        required_outputs=["result"],
    )
    provider = ScriptedProvider([
        tool_use_response("echo", {"message": "hola"}, call_id="tu_1"),
        text_response('{"result": "el echo dijo hola"}'),
    ])

    out = await run_agent(spec, provider, registry, AgentRunContext(run_id="r", initial_state={}))

    assert out.status == STATUS_COMPLETED
    assert out.iterations_used == 2
    assert out.state_patch == {"result": "el echo dijo hola"}

    # Verificar que el segundo call al provider recibio el tool_result en messages
    second_call_msgs = provider.calls[1]["messages"]
    tool_msg = next((m for m in second_call_msgs if m.role == "tool"), None)
    assert tool_msg is not None
    assert tool_msg.tool_call_id == "tu_1"
    assert "echoed" in tool_msg.content


@pytest.mark.asyncio
async def test_multi_tool_calls_in_one_turn(registry):
    spec = make_spec(tools_whitelist=["echo"], writes=["r"], required_outputs=["r"])
    multi = LLMResponse(
        content="",
        tool_calls=[
            ToolCall(id="tu_a", name="echo", arguments={"message": "uno"}),
            ToolCall(id="tu_b", name="echo", arguments={"message": "dos"}),
        ],
        tokens_in=5, tokens_out=5, cost_usd=0.001,
        finish_reason="tool_use",
    )
    provider = ScriptedProvider([multi, text_response('{"r": "done"}')])
    out = await run_agent(spec, provider, registry, AgentRunContext(run_id="r", initial_state={}))
    assert out.status == STATUS_COMPLETED
    # 2 entries de tools en el transcript de la iteracion 1
    tool_entries = [t for t in out.transcript if t.role == "tool"]
    assert len(tool_entries) == 2


# ----------------------------------------------------------------------
# Budgets / guardrails
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_max_iterations_exceeded(registry):
    spec = make_spec(
        tools_whitelist=["echo"],
        writes=["r"],
        max_iterations=3,
    )
    # Provider que SIEMPRE pide echo, nunca da final_answer
    provider = ScriptedProvider([
        tool_use_response("echo", {"message": "loop"}, call_id=f"tu_{i}")
        for i in range(10)
    ])
    out = await run_agent(spec, provider, registry, AgentRunContext(run_id="r", initial_state={}))
    assert out.status == STATUS_ITERATION_EXCEEDED
    assert out.iterations_used == 3
    assert "max_iterations" in out.error_message


@pytest.mark.asyncio
async def test_budget_exceeded(registry):
    spec = make_spec(
        tools_whitelist=["echo"],
        writes=["r"],
        max_cost_usd=0.005,
    )
    provider = ScriptedProvider([
        tool_use_response("echo", {"message": "x"}, cost=0.003),
        tool_use_response("echo", {"message": "y"}, cost=0.003),  # acumulado 0.006 > 0.005
    ])
    out = await run_agent(spec, provider, registry, AgentRunContext(run_id="r", initial_state={}))
    assert out.status == STATUS_BUDGET_EXCEEDED
    assert out.total_cost_usd >= 0.005
    assert "Budget" in out.error_message


@pytest.mark.asyncio
async def test_required_outputs_missing_raises_guardrail(registry):
    spec = make_spec(
        writes=["a", "b"],
        required_outputs=["a", "b"],
    )
    provider = ScriptedProvider([text_response('{"a": 1}')])  # falta "b"
    out = await run_agent(spec, provider, registry, AgentRunContext(run_id="r", initial_state={}))
    assert out.status == STATUS_GUARDRAIL_VIOLATION
    assert "b" in out.error_message
    assert out.state_patch == {"a": 1}  # se devuelve el patch parcial igual


# ----------------------------------------------------------------------
# Errores
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_tool_not_in_registry_raises_at_filter():
    spec = make_spec(tools_whitelist=["tool_inexistente"], writes=["x"])
    provider = ScriptedProvider([text_response("{}")])
    r = ToolRegistry()
    r.register(EchoTool())
    with pytest.raises(KeyError, match="tool_inexistente"):
        await run_agent(spec, provider, r, AgentRunContext(run_id="r", initial_state={}))


@pytest.mark.asyncio
async def test_tool_execution_failure(registry):
    class BoomTool(Tool):
        name = "boom"
        description = "tool que explota"
        input_schema = {"type": "object"}
        async def run(self, arguments):
            raise RuntimeError("kaboom")

    registry.register(BoomTool())
    spec = make_spec(tools_whitelist=["boom"], writes=["r"])
    provider = ScriptedProvider([
        tool_use_response("boom", {}),
        text_response('{"r": "no se llega"}'),
    ])
    out = await run_agent(spec, provider, registry, AgentRunContext(run_id="r", initial_state={}))
    assert out.status == STATUS_TOOL_ERROR
    assert "kaboom" in out.error_message
    assert out.iterations_used == 1


@pytest.mark.asyncio
async def test_llm_error_propagates_as_status(registry):
    spec = make_spec(writes=["x"])
    out = await run_agent(spec, FailingProvider(), registry, AgentRunContext(run_id="r", initial_state={}))
    assert out.status == STATUS_LLM_ERROR
    assert "simulated llm crash" in out.error_message
    assert out.iterations_used == 1


# ----------------------------------------------------------------------
# reads filtering
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_reads_filters_initial_state(registry):
    spec = make_spec(reads=["prompt", "requester"], writes=["x"], required_outputs=["x"])
    provider = ScriptedProvider([text_response('{"x": 1}')])
    state = {"prompt": "hola", "requester": "test", "secret": "no debe ir"}
    await run_agent(spec, provider, registry, AgentRunContext(run_id="r", initial_state=state))
    body = provider.calls[0]["messages"][0].content
    assert "hola" in body
    assert "test" in body
    assert "secret" not in body
    assert "no debe ir" not in body


@pytest.mark.asyncio
async def test_no_reads_passes_full_state(registry):
    spec = make_spec(reads=[], writes=["x"], required_outputs=["x"])
    provider = ScriptedProvider([text_response('{"x": 1}')])
    state = {"foo": "bar", "baz": "qux"}
    await run_agent(spec, provider, registry, AgentRunContext(run_id="r", initial_state=state))
    body = provider.calls[0]["messages"][0].content
    assert "foo" in body and "bar" in body
    assert "baz" in body and "qux" in body


# ----------------------------------------------------------------------
# Stubs reales
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_noop_search_returns_canned_hits(registry):
    spec = make_spec(
        tools_whitelist=["noop_search"],
        writes=["found"],
        required_outputs=["found"],
    )
    provider = ScriptedProvider([
        tool_use_response("noop_search", {"query": "machbank onboarding empresas"}),
        text_response('{"found": 2}'),
    ])
    out = await run_agent(spec, provider, registry, AgentRunContext(run_id="r", initial_state={}))
    assert out.status == STATUS_COMPLETED
    tool_entry = next(t for t in out.transcript if t.role == "tool")
    assert "Onboarding empresas" in tool_entry.content


# ----------------------------------------------------------------------
# Helper unit tests
# ----------------------------------------------------------------------
def test_parse_final_answer_handles_plain_text():
    assert _parse_final_answer("solo texto") == {"raw_text": "solo texto"}


def test_parse_final_answer_handles_empty():
    assert _parse_final_answer("") == {}
    assert _parse_final_answer("   ") == {}


def test_parse_final_answer_returns_dict_directly():
    assert _parse_final_answer('{"a": 1, "b": [1,2]}') == {"a": 1, "b": [1, 2]}


def test_parse_final_answer_strips_fences():
    assert _parse_final_answer('```json\n{"x": 1}\n```') == {"x": 1}


def test_parse_final_answer_non_dict_json():
    # Non-dict JSON (e.g. array) can't be a state_patch → raw_text fallback
    out = _parse_final_answer("[1, 2, 3]")
    assert out == {"raw_text": "[1, 2, 3]"}


def test_parse_final_answer_json_embedded_in_prose():
    """LLM wraps JSON in explanation text — extractor should find it."""
    text = (
        'Aquí está el resultado del coding:\n\n'
        '{"files_modified": ["src/foo.py"], "unit_tests": {"exit_code": 0}, '
        '"pr_reference": "pending"}\n\n'
        'Espero que sea útil.'
    )
    out = _parse_final_answer(text)
    assert out["files_modified"] == ["src/foo.py"]
    assert out["unit_tests"]["exit_code"] == 0
    assert out["pr_reference"] == "pending"


def test_parse_final_answer_fence_in_middle_of_prose():
    """JSON in a ```json fence surrounded by prose."""
    text = (
        'El resultado es:\n\n'
        '```json\n'
        '{"files_modified": ["a.py"], "unit_tests": {"exit_code": 0}, '
        '"pr_reference": "pending"}\n'
        '```\n\n'
        'Listo.'
    )
    out = _parse_final_answer(text)
    assert out["files_modified"] == ["a.py"]


def test_parse_final_answer_multiple_fences_picks_dict():
    """Multiple fenced blocks — picks the first that parses as dict."""
    text = (
        '```\n[1, 2, 3]\n```\n\n'
        '```json\n{"key": "value"}\n```'
    )
    out = _parse_final_answer(text)
    assert out == {"key": "value"}
