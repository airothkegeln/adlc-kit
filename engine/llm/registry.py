"""
Registry de LLM providers. Lee la config y devuelve la instancia activa.

Para agregar un proveedor, importarlo aquí y agregarlo al dict PROVIDERS.
"""

from __future__ import annotations

from typing import Callable

from .base import LLMProvider


# Cada entrada es un constructor lazy: Callable[[dict], LLMProvider].
# Lazy para no importar SDKs que el usuario no usa.
PROVIDERS: dict[str, Callable[[dict], LLMProvider]] = {}


def register(name: str):
    """Decorator para registrar un provider."""
    def _wrap(factory):
        PROVIDERS[name] = factory
        return factory
    return _wrap


def get_provider(config: dict) -> LLMProvider:
    """
    config = {
        "provider": "anthropic",
        "model_default": "claude-opus-4-6",
        "api_key": "...",
        ...
    }
    """
    name = config.get("provider", "anthropic")

    # Lazy import del provider activo
    if name == "anthropic":
        from . import anthropic_provider  # noqa: F401
    elif name == "claude_cli":
        from . import claude_cli_provider  # noqa: F401
    elif name == "openai":
        from . import openai_provider  # noqa: F401
    elif name == "bedrock":
        from . import bedrock_provider  # noqa: F401

    if name not in PROVIDERS:
        raise ValueError(
            f"LLM provider '{name}' no registrado. "
            f"Disponibles: {list(PROVIDERS.keys())}. "
            f"Para agregar uno nuevo ver docs/adding_an_llm_provider.md"
        )

    return PROVIDERS[name](config)
