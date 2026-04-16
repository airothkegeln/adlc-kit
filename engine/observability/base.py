"""
Tracer / Observability — interfaz aislada.

Default: StructlogTracer (JSON logs a stdout + métricas a Postgres).
Reemplazable por Langfuse, LangSmith, Phoenix, OpenTelemetry, etc.

La interfaz es deliberadamente mínima para que reemplazos sean baratos.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from contextlib import contextmanager
from typing import Any


class Tracer(ABC):

    @abstractmethod
    def event(self, name: str, **fields: Any) -> None:
        """Evento puntual con dimensiones arbitrarias."""
        ...

    @abstractmethod
    @contextmanager
    def span(self, name: str, **fields: Any):
        """Span temporal — usado para medir duración de un agente."""
        ...

    @abstractmethod
    def metric(self, name: str, value: float, **tags: Any) -> None:
        """Métrica numérica (tokens, costo, latencia)."""
        ...
