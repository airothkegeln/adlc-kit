"""
Tests del AnthropicProvider con SDK mockeado.

NO requieren API key real ni internet. Verifican:
  - El provider implementa la interfaz LLMProvider completa
  - Conversion de Message <-> formato Anthropic
  - Conversion de ToolSpec <-> formato Anthropic
  - Parsing de respuesta con text + tool_use
  - Calculo de costo con la tabla de pricing
  - Normalizacion de stop_reason

Para tests de integracion contra la API real:
    ANTHROPIC_API_KEY=sk-ant-... pytest engine/llm/tests/test_anthropic_real.py
"""

from __future__ import annotations

import inspect
import sys
import types

import pytest

from ..base import LLMProvider, Message, ToolSpec


# ----------------------------------------------------------------------
# Stub del SDK anthropic
# ----------------------------------------------------------------------
class _StubBlock:
    def __init__(self, type_, **kwargs):
        self.type = type_
        for k, v in kwargs.items():
            setattr(self, k, v)


class _StubUsage:
    def __init__(self, input_tokens, output_tokens):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _StubResponse:
    def __init__(self, content, usage, stop_reason):
        self.content = content
        self.usage = usage
        self.stop_reason = stop_reason


class _StubMessages:
    def __init__(self, response):
        self._response = response
        self.last_kwargs = None

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return self._response


class _StubClient:
    def __init__(self, response, **_):
        self.messages = _StubMessages(response)


def _install_stub_anthropic(response):
    fake = types.ModuleType("anthropic")
    fake.Anthropic = lambda **kw: _StubClient(response, **kw)
    sys.modules["anthropic"] = fake


# ----------------------------------------------------------------------
# Tests
# ----------------------------------------------------------------------

def test_provider_implements_interface():
    from ..anthropic_provider import AnthropicProvider
    abstract = {
        n for n, m in inspect.getmembers(LLMProvider, predicate=inspect.isfunction)
        if getattr(m, "__isabstractmethod__", False)
    }
    missing = abstract - set(dir(AnthropicProvider))
    assert not missing, f"Faltan: {missing}"


def test_complete_parses_text_and_usage():
    response = _StubResponse(
        content=[_StubBlock("text", text="Hola mundo")],
        usage=_StubUsage(input_tokens=100, output_tokens=50),
        stop_reason="end_turn",
    )
    _install_stub_anthropic(response)

    from ..anthropic_provider import AnthropicProvider
    p = AnthropicProvider(api_key="sk-ant-test", model="claude-opus-4-6")

    r = p.complete(
        messages=[Message(role="user", content="Hola")],
        system="Eres un asistente",
    )
    assert r.content == "Hola mundo"
    assert r.tokens_in == 100
    assert r.tokens_out == 50
    assert r.finish_reason == "stop"
    assert r.cost_usd > 0
    # Cost = 100/1M * 15 + 50/1M * 75 = 0.0015 + 0.00375 = 0.00525
    assert abs(r.cost_usd - 0.00525) < 1e-6


def test_complete_parses_tool_use():
    response = _StubResponse(
        content=[
            _StubBlock("text", text="Voy a buscar"),
            _StubBlock("tool_use", id="tu_1", name="github_search",
                       input={"query": "machbank onboarding"}),
        ],
        usage=_StubUsage(input_tokens=200, output_tokens=80),
        stop_reason="tool_use",
    )
    _install_stub_anthropic(response)

    from ..anthropic_provider import AnthropicProvider
    p = AnthropicProvider(api_key="sk-ant-test", model="claude-opus-4-6")

    r = p.complete(
        messages=[Message(role="user", content="Busca onboarding")],
        tools=[
            ToolSpec(
                name="github_search",
                description="Busca codigo en GitHub",
                input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
            )
        ],
    )
    assert r.finish_reason == "tool_use"
    assert len(r.tool_calls) == 1
    assert r.tool_calls[0].name == "github_search"
    assert r.tool_calls[0].arguments == {"query": "machbank onboarding"}


def test_messages_to_anthropic_handles_tool_results():
    from ..anthropic_provider import _messages_to_anthropic
    msgs = [
        Message(role="user", content="hola"),
        Message(role="assistant", content="usando tool..."),
        Message(role="tool", content='{"results": []}', tool_call_id="tu_1"),
    ]
    out = _messages_to_anthropic(msgs)
    assert out[0] == {"role": "user", "content": "hola"}
    assert out[1] == {"role": "assistant", "content": "usando tool..."}
    assert out[2]["role"] == "user"
    assert out[2]["content"][0]["type"] == "tool_result"
    assert out[2]["content"][0]["tool_use_id"] == "tu_1"


def test_normalize_stop():
    from ..anthropic_provider import _normalize_stop
    assert _normalize_stop("end_turn") == "stop"
    assert _normalize_stop("stop_sequence") == "stop"
    assert _normalize_stop("tool_use") == "tool_use"
    assert _normalize_stop("max_tokens") == "length"
    assert _normalize_stop(None) == "stop"


def test_cost_unknown_model_falls_back_to_opus():
    from ..anthropic_provider import _compute_cost
    cost = _compute_cost("modelo-no-existe", 1_000_000, 0)
    # Fallback Opus: 15 USD por 1M input
    assert abs(cost - 15.0) < 1e-6


def test_context_window_1m_variant():
    response = _StubResponse(
        content=[_StubBlock("text", text="x")],
        usage=_StubUsage(0, 0),
        stop_reason="end_turn",
    )
    _install_stub_anthropic(response)
    from ..anthropic_provider import AnthropicProvider
    p_std = AnthropicProvider(api_key="k", model="claude-opus-4-6")
    p_1m = AnthropicProvider(api_key="k", model="claude-opus-4-6[1m]")
    assert p_std.context_window == 200_000
    assert p_1m.context_window == 1_000_000
