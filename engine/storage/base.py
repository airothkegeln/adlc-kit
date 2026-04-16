"""
StateStore — interfaz aislada para persistencia del project_state.

NOTA: usa `from __future__ import annotations` para que los type hints
estilo PEP 604 (`str | None`) funcionen en Python 3.9. Runtime real es
3.11+ via Dockerfile, pero los tests deben correr en hosts mas viejos.

Default: PostgresStateStore. Reemplazable por SQLite (single-user),
DynamoDB, MongoDB, etc.

El project_state es dual-format:
  - JSON canónico (para agentes)
  - Markdown derivado (para humanos)

Cada mutación es append-only: nunca se sobreescribe una versión, solo se
agrega una nueva. Esto da auditoría completa y replay determinístico.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class Run:
    id: str
    prompt: str
    requester: str
    target_repo: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    status: str = "pending"
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None


@dataclass
class StateVersion:
    run_id: str
    version: int
    agent: str
    phase: str
    json_state: dict[str, Any]
    md_state: str
    diff: dict[str, Any]
    ts: datetime
    spec_commit_sha: str | None = None  # versión del agent_spec usado


@dataclass
class AgentRunRecord:
    id: str
    run_id: str
    agent: str
    model: str
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    duration_ms: int = 0
    status: str = "running"  # running | completed | failed | timeout
    last_heartbeat_at: datetime | None = None
    error: str | None = None


@dataclass
class HitlCheckpoint:
    """
    Checkpoint HITL: el orchestrator crea uno cada vez que un agente con
    `hitl.enabled: true` termina. El state_patch del agente queda guardado
    en `pending_state_patch` pero NO se aplica al accumulated_state hasta
    que un humano resuelva el checkpoint (approve → aplica, reject → run
    falla con el feedback).
    """
    id: str
    run_id: str
    agent: str                              # nombre del agente que genero el patch
    phase: str                              # phase del ciclo donde se pauso
    pending_state_patch: dict[str, Any]     # el state_patch sin aplicar
    next_phase: str | None = None           # phase desde donde reanudar al approve
    status: str = "pending"                 # pending | approved | rejected
    decision: str | None = None             # approved | rejected (redundante con status pero util)
    feedback: str | None = None             # texto del humano al approve/reject
    resolved_by: str | None = None          # quien resolvio (email o user id)
    resolved_at: datetime | None = None
    created_at: datetime | None = None


@dataclass
class EvalScore:
    """Quality score de un agent run, generado por el eval module."""
    id: str
    run_id: str
    agent_run_id: str
    agent: str
    phase: str
    score: float                               # 0-100
    checks: list[dict[str, Any]] = field(default_factory=list)   # [{name, passed, detail, weight}]
    violations: list[str] = field(default_factory=list)
    ts: datetime | None = None


class StateStore(ABC):
    """
    Interfaz abstracta para storage del project_state. Toda implementación
    debe garantizar:
      - Append-only en state_versions (no UPDATE, solo INSERT)
      - Versiones autoincrementales atómicas por run_id
      - Heartbeat soportado para watchdog
    """

    # ---- ciclo de vida ----
    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def close(self) -> None: ...

    # ---- runs ----
    @abstractmethod
    async def create_run(
        self,
        prompt: str,
        requester: str,
        target_repo: str | None = None,
        metadata: dict[str, Any] | None = None,
        run_id: str | None = None,
    ) -> Run: ...

    @abstractmethod
    async def get_run(self, run_id: str) -> Run | None: ...

    @abstractmethod
    async def list_pending_runs(self, limit: int = 10) -> list[Run]: ...

    @abstractmethod
    async def list_active_runs(self, limit: int = 50) -> list[Run]:
        """
        Lista runs en estado "in-flight": pending, running, awaiting_hitl.
        Usado por la UI de Operaciones para mostrar un dashboard de runs
        en progreso con timeline de phases.
        """
        ...

    @abstractmethod
    async def list_recent_runs(self, limit: int = 30) -> list[Run]:
        """
        Lista los N runs más recientes sin filtrar por status. Usado por
        la UI para mostrar el historial (completed/failed/aborted) junto
        con los activos.
        """
        ...

    @abstractmethod
    async def get_stats(self) -> dict[str, Any]:
        """
        Métricas agregadas para el Dashboard de Operaciones. Calcula sobre
        el total de runs y agent_runs en DB (no limitado a recientes).

        Returns:
            {
              "total_runs": int,
              "runs_by_status": {"completed": N, "failed": M, ...},
              "runs_last_7_days": int,
              "total_cost_usd": float,
              "cost_last_7_days_usd": float,
              "avg_run_duration_sec": float | None,    # solo runs completed
              "avg_phase_duration_ms": {"discovery": ms, ...},  # por agent
              "total_agent_runs": int,
            }
        """
        ...

    @abstractmethod
    async def update_run_status(
        self, run_id: str, status: str, error: str | None = None
    ) -> None: ...

    # ---- state versions (append-only) ----
    @abstractmethod
    async def append_state_version(
        self,
        run_id: str,
        agent: str,
        phase: str,
        json_state: dict[str, Any],
        md_state: str,
        diff: dict[str, Any] | None = None,
        spec_commit_sha: str | None = None,
    ) -> StateVersion: ...

    @abstractmethod
    async def get_latest_state(self, run_id: str) -> StateVersion | None: ...

    @abstractmethod
    async def get_state_history(self, run_id: str) -> list[StateVersion]: ...

    # ---- agent runs / heartbeat ----
    @abstractmethod
    async def start_agent_run(
        self,
        run_id: str,
        agent: str,
        model: str,
        spec_commit_sha: str | None = None,
        agent_run_id: str | None = None,
    ) -> AgentRunRecord: ...

    @abstractmethod
    async def heartbeat(self, agent_run_id: str) -> None: ...

    @abstractmethod
    async def finish_agent_run(
        self,
        agent_run_id: str,
        status: str = "completed",
        tokens_in: int = 0,
        tokens_out: int = 0,
        cost_usd: float = 0.0,
        duration_ms: int = 0,
        error: str | None = None,
    ) -> None: ...

    @abstractmethod
    async def find_stale_agent_runs(self, timeout_seconds: int) -> list[str]:
        """Devuelve agent_run ids 'running' sin heartbeat reciente. Usado por watchdog."""
        ...

    # ---- HITL checkpoints ----
    @abstractmethod
    async def create_hitl_checkpoint(
        self,
        run_id: str,
        agent: str,
        phase: str,
        pending_state_patch: dict[str, Any],
        next_phase: str | None = None,
        checkpoint_id: str | None = None,
    ) -> HitlCheckpoint:
        """Crea un checkpoint pendiente. El state_patch queda guardado sin aplicar."""
        ...

    @abstractmethod
    async def get_hitl_checkpoint(self, checkpoint_id: str) -> HitlCheckpoint | None: ...

    @abstractmethod
    async def list_pending_hitl_checkpoints(
        self, run_id: str | None = None
    ) -> list[HitlCheckpoint]:
        """Lista checkpoints 'pending'. Si run_id es None, devuelve globales."""
        ...

    @abstractmethod
    async def resolve_hitl_checkpoint(
        self,
        checkpoint_id: str,
        decision: str,             # "approved" | "rejected"
        resolved_by: str,
        feedback: str | None = None,
    ) -> HitlCheckpoint:
        """
        Marca el checkpoint como resuelto. Devuelve el checkpoint actualizado
        (con su pending_state_patch para que el orchestrator pueda aplicarlo
        al approve).
        """
        ...

    # ---- eval scores ----
    @abstractmethod
    async def save_eval_score(
        self,
        run_id: str,
        agent_run_id: str,
        agent: str,
        phase: str,
        score: float,
        checks: list[dict[str, Any]],
        violations: list[str],
        eval_id: str | None = None,
    ) -> EvalScore: ...

    @abstractmethod
    async def get_eval_scores(self, run_id: str) -> list[EvalScore]:
        """All eval scores for a run, ordered by timestamp."""
        ...

    # ---- archival / retention ----
    @abstractmethod
    async def archive_completed_runs(self, older_than_days: int) -> int:
        """Cuántos runs cumplen el criterio de archivado (no los borra todavía)."""
        ...

    @abstractmethod
    async def export_run_for_target_repo(self, run_id: str) -> tuple[dict, str]:
        """Devuelve (json_final, md_final) para commitear al repo del artefacto."""
        ...
