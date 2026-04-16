"""
Orchestrator — interfaz aislada.

El orquestador coordina la ejecución del ciclo ADLC: arranca runs, ejecuta
agentes en orden, persiste estado, gestiona heartbeats y HITL.

Default: SimpleOrchestrator (asyncio + Postgres).
Para producción a escala considera Temporal, Inngest, Trigger.dev.

Requisitos no-negociables del orquestador:
  - Memoria: cada agente recibe el project_state completo
  - Contexto: history append-only para auditoría
  - Heartbeat: agentes vivos hacen update cada N segundos
  - Watchdog: agentes sin heartbeat son marcados como failed
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass
class RunRequest:
    prompt: str
    requester: str
    target_repo: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass
class RunHandle:
    run_id: str
    status: str  # pending | running | awaiting_hitl | completed | failed | aborted


class Orchestrator(ABC):

    @abstractmethod
    async def start_run(self, request: RunRequest) -> RunHandle:
        """Crea un run nuevo y lo encola."""
        ...

    @abstractmethod
    async def get_run(self, run_id: str) -> RunHandle:
        """Estado actual de un run."""
        ...

    @abstractmethod
    async def resolve_hitl(
        self, run_id: str, checkpoint_id: str, decision: str, resolver: str
    ) -> None:
        """Resuelve un HITL pendiente y reanuda el run."""
        ...

    @abstractmethod
    async def abort_run(self, run_id: str, reason: str) -> None:
        """Aborta un run en curso."""
        ...

    @abstractmethod
    async def heartbeat(self, run_id: str, agent_run_id: str) -> None:
        """Llamado por el runtime de agentes mientras corren."""
        ...
