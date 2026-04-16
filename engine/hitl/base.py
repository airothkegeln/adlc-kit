"""
HITL Transport — interfaz aislada.

Cada transport entrega un checkpoint a un humano y le permite resolverlo.
Defaults: WebTransport (UI) + EmailSESTransport (AWS SES con magic links).

Para agregar Slack, Teams, etc., implementar HITLTransport.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime


@dataclass
class HITLCheckpoint:
    id: str
    run_id: str
    phase: str
    title: str
    description: str
    artifact_md: str
    deadline: datetime  # auto-avance si pasa
    resolver_email: str


class HITLTransport(ABC):

    @abstractmethod
    async def notify(self, checkpoint: HITLCheckpoint) -> None:
        """Entrega el checkpoint al humano."""
        ...

    @abstractmethod
    def name(self) -> str: ...
