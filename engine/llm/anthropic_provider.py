"""
AnthropicProvider — implementación default de LLMProvider.

Wrapper sobre el SDK oficial de Anthropic. Soporta:
  - complete()  → llamada bloqueante con tool use
  - stream()    → streaming token a token
  - tracking de tokens, costo, finish_reason

Para reemplazar este provider por OpenAI / Bedrock / local:
  1. Crear engine/llm/<mi_provider>.py implementando LLMProvider
  2. Registrarlo en engine/llm/registry.py
  3. Cambiar config/adlc.config.yaml -> llm.provider: <nombre>

Ver docs/adding_an_llm_provider.md
"""

from __future__ import annotations

from typing import Any, Iterator

from .base import (
    LLMProvider,
    LLMResponse,
    Message,
    StreamChunk,
    ToolCall,
    ToolSpec,
)
from .registry import register


# ----------------------------------------------------------------------
# Pricing (USD por 1M tokens)
#
# Estos valores son el DEFAULT y pueden ser sobrescritos pasando
# `pricing` en la config del provider. Mantenerlos actualizados aqui
# cuando Anthropic publique cambios de precio.
# ----------------------------------------------------------------------
DEFAULT_PRICING: dict[str, dict[str, float]] = {
    # Familia Claude 4
    "claude-opus-4-6":            {"input": 15.00, "output": 75.00},
    "claude-opus-4-6[1m]":        {"input": 15.00, "output": 75.00},
    "claude-sonnet-4-6":          {"input":  3.00, "output": 15.00},
    "claude-haiku-4-5-20251001":  {"input":  0.80, "output":  4.00},
    "claude-haiku-4-5":           {"input":  0.80, "output":  4.00},
}


def _compute_cost(model: str, tokens_in: int, tokens_out: int,
                  pricing: dict[str, dict[str, float]] | None = None) -> float:
    table = pricing or DEFAULT_PRICING
    rates = table.get(model)
    if rates is None:
        # Fallback conservador: usa precio Opus para no subestimar
        rates = table.get("claude-opus-4-6", {"input": 15.0, "output": 75.0})
    return (tokens_in / 1_000_000) * rates["input"] + (tokens_out / 1_000_000) * rates["output"]


# ----------------------------------------------------------------------
# Provider
# ----------------------------------------------------------------------
@register("anthropic")
def _factory(config: dict) -> "AnthropicProvider":
    return AnthropicProvider(
        api_key=config["api_key"],
        model=config.get("model_default", "claude-opus-4-6"),
        pricing=config.get("pricing"),
        max_retries=config.get("max_retries", 3),
        timeout_seconds=config.get("timeout_seconds", 120),
    )


class AnthropicProvider(LLMProvider):

    def __init__(
        self,
        api_key: str,
        model: str = "claude-opus-4-6",
        pricing: dict | None = None,
        max_retries: int = 3,
        timeout_seconds: int = 120,
    ):
        # Lazy import: el SDK solo se importa si este provider esta activo
        try:
            import anthropic  # noqa: F401
        except ImportError as e:
            raise ImportError(
                "El paquete 'anthropic' no esta instalado. "
                "Agregalo a engine/requirements.txt o cambia llm.provider en config."
            ) from e

        self._anthropic = anthropic
        self._client = anthropic.Anthropic(
            api_key=api_key,
            max_retries=max_retries,
            timeout=timeout_seconds,
        )
        self._model = model
        self._pricing = pricing

    # ------------------------------------------------------------------
    # interfaz LLMProvider
    # ------------------------------------------------------------------
    @property
    def model_id(self) -> str:
        return self._model

    @property
    def supports_tools(self) -> bool:
        return True

    @property
    def context_window(self) -> int:
        # Modelos Claude 4 soportan al menos 200k tokens; familia [1m] soporta 1M
        return 1_000_000 if "[1m]" in self._model else 200_000

    def complete(
        self,
        messages: list[Message],
        system: str | None = None,
        tools: list[ToolSpec] | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.0,
        model: str | None = None,
    ) -> LLMResponse:
        kwargs: dict[str, Any] = {
            "model": model or self._model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": _messages_to_anthropic(messages),
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = _tools_to_anthropic(tools)

        resp = self._client.messages.create(**kwargs)

        # Parsear content: text + tool_use blocks
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in resp.content:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                text_parts.append(block.text)
            elif block_type == "tool_use":
                tool_calls.append(
                    ToolCall(
                        id=block.id,
                        name=block.name,
                        arguments=dict(block.input or {}),
                    )
                )

        tokens_in = getattr(resp.usage, "input_tokens", 0)
        tokens_out = getattr(resp.usage, "output_tokens", 0)

        return LLMResponse(
            content="".join(text_parts),
            tool_calls=tool_calls,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd=_compute_cost(self._model, tokens_in, tokens_out, self._pricing),
            model_id=self._model,
            finish_reason=_normalize_stop(resp.stop_reason),
            raw=None,
        )

    def stream(
        self,
        messages: list[Message],
        system: str | None = None,
        tools: list[ToolSpec] | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.0,
        model: str | None = None,
    ) -> Iterator[StreamChunk]:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": _messages_to_anthropic(messages),
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = _tools_to_anthropic(tools)

        with self._client.messages.stream(**kwargs) as stream:
            for text in stream.text_stream:
                yield StreamChunk(delta_text=text)
            final = stream.get_final_message()
            yield StreamChunk(
                finish_reason=_normalize_stop(getattr(final, "stop_reason", None)),
            )


# ----------------------------------------------------------------------
# Conversion helpers
# ----------------------------------------------------------------------
def _messages_to_anthropic(messages: list[Message]) -> list[dict[str, Any]]:
    """Convierte Message canonico a formato del SDK Anthropic."""
    out: list[dict[str, Any]] = []
    for m in messages:
        if m.role == "system":
            # Anthropic usa system fuera de messages — el caller lo pasa aparte
            continue
        if m.role == "tool":
            # Anthropic representa tool results como user con content tool_result
            out.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": m.tool_call_id,
                            "content": m.content,
                        }
                    ],
                }
            )
            continue
        out.append({"role": m.role, "content": m.content})
    return out


def _tools_to_anthropic(tools: list[ToolSpec]) -> list[dict[str, Any]]:
    return [
        {
            "name": t.name,
            "description": t.description,
            "input_schema": t.input_schema,
        }
        for t in tools
    ]


def _normalize_stop(stop_reason: str | None) -> str:
    """Normaliza el stop_reason de Anthropic al vocabulario de LLMResponse."""
    if stop_reason in (None, "end_turn", "stop_sequence"):
        return "stop"
    if stop_reason == "tool_use":
        return "tool_use"
    if stop_reason == "max_tokens":
        return "length"
    return stop_reason or "stop"
