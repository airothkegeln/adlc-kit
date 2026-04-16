"""
LLM Provider — interfaz aislada.

Cualquier proveedor (Anthropic, OpenAI, Bedrock, Mistral, modelos locales)
implementa esta interfaz. El resto del engine consume LLMProvider sin saber
qué implementación está activa.

Para agregar un nuevo proveedor:
  1. Crear engine/llm/<mi_provider>.py implementando LLMProvider
  2. Registrarlo en engine/llm/registry.py
  3. Documentar en docs/adding_an_llm_provider.md
  4. NO tocar nada fuera de engine/llm/
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Iterator


@dataclass
class Message:
    role: str  # "system" | "user" | "assistant" | "tool"
    content: str
    tool_call_id: str | None = None
    name: str | None = None


@dataclass
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class LLMResponse:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    model_id: str = ""
    finish_reason: str = "stop"  # "stop" | "tool_use" | "length" | "error"
    raw: dict[str, Any] | None = None


@dataclass
class StreamChunk:
    delta_text: str = ""
    tool_call_delta: dict[str, Any] | None = None
    finish_reason: str | None = None


class LLMProvider(ABC):
    """Interfaz abstracta para todos los proveedores de LLM."""

    @abstractmethod
    def complete(
        self,
        messages: list[Message],
        system: str | None = None,
        tools: list[ToolSpec] | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.0,
        model: str | None = None,
    ) -> LLMResponse:
        """Llamada bloqueante. model overrides the provider default if set."""
        ...

    @abstractmethod
    def stream(
        self,
        messages: list[Message],
        system: str | None = None,
        tools: list[ToolSpec] | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.0,
        model: str | None = None,
    ) -> Iterator[StreamChunk]:
        """Streaming. Yields chunks hasta finish_reason."""
        ...

    @property
    @abstractmethod
    def supports_tools(self) -> bool:
        """Si el modelo soporta tool use nativo."""
        ...

    @property
    @abstractmethod
    def model_id(self) -> str:
        """Identificador exacto del modelo (ej: 'claude-opus-4-6')."""
        ...

    @property
    @abstractmethod
    def context_window(self) -> int:
        """Tamaño máximo de contexto en tokens."""
        ...
