"""
PostgresStateStore — implementación default de StateStore.

Usa asyncpg con un connection pool. Toda escritura en state_versions
calcula `version` atómicamente dentro de una transacción para garantizar
append-only sin race conditions.

Para reemplazar este store por SQLite/Dynamo/Mongo:
  1. Implementa StateStore en engine/storage/<tu_store>.py
  2. Cambia config/adlc.config.yaml -> storage.driver: <tu_driver>
  3. Registralo en engine/storage/__init__.py
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import asyncpg

from .base import AgentRunRecord, EvalScore, HitlCheckpoint, Run, StateStore, StateVersion


async def _init_conn(conn: asyncpg.Connection) -> None:
    """Setup JSONB codec en cada conexión del pool."""
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )
    await conn.set_type_codec(
        "json",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


class PostgresStateStore(StateStore):

    def __init__(self, dsn: str, min_size: int = 1, max_size: int = 10):
        self._dsn = dsn
        self._min_size = min_size
        self._max_size = max_size
        self._pool: asyncpg.Pool | None = None

    @classmethod
    def from_env(cls) -> "PostgresStateStore":
        user = os.environ.get("POSTGRES_USER", "adlc")
        password = os.environ.get("POSTGRES_PASSWORD", "adlc_dev_password")
        host = os.environ.get("POSTGRES_HOST", "localhost")
        port = os.environ.get("POSTGRES_PORT", "5432")
        db = os.environ.get("POSTGRES_DB", "adlc")
        return cls(f"postgresql://{user}:{password}@{host}:{port}/{db}")

    async def connect(self) -> None:
        if self._pool is not None:
            return
        self._pool = await asyncpg.create_pool(
            self._dsn,
            min_size=self._min_size,
            max_size=self._max_size,
            init=_init_conn,
        )

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError(
                "PostgresStateStore no esta conectado. Llama a connect() primero."
            )
        return self._pool

    # ------------------------------------------------------------------
    # runs
    # ------------------------------------------------------------------
    async def create_run(
        self,
        prompt: str,
        requester: str,
        target_repo: str | None = None,
        metadata: dict[str, Any] | None = None,
        run_id: str | None = None,
    ) -> Run:
        run_id = run_id or f"run_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc)
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO runs (id, prompt, requester, target_repo, metadata, status, started_at)
                VALUES ($1, $2, $3, $4, $5, 'pending', $6)
                """,
                run_id,
                prompt,
                requester,
                target_repo,
                metadata or {},
                now,
            )
        return Run(
            id=run_id,
            prompt=prompt,
            requester=requester,
            target_repo=target_repo,
            metadata=metadata or {},
            status="pending",
            started_at=now,
        )

    async def get_run(self, run_id: str) -> Run | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM runs WHERE id = $1", run_id)
        return _row_to_run(row) if row else None

    async def list_pending_runs(self, limit: int = 10) -> list[Run]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM runs
                WHERE status = 'pending'
                ORDER BY started_at
                LIMIT $1
                """,
                limit,
            )
        return [_row_to_run(r) for r in rows]

    async def list_active_runs(self, limit: int = 50) -> list[Run]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM runs
                WHERE status IN ('pending', 'running', 'awaiting_hitl')
                ORDER BY started_at DESC
                LIMIT $1
                """,
                limit,
            )
        return [_row_to_run(r) for r in rows]

    async def list_recent_runs(self, limit: int = 30) -> list[Run]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM runs
                ORDER BY started_at DESC
                LIMIT $1
                """,
                limit,
            )
        return [_row_to_run(r) for r in rows]

    async def get_stats(self) -> dict[str, Any]:
        # 5 queries cortas, todas indexed. Postgres las paraleliza dentro
        # del mismo connection no, pero el costo total es <50ms para una
        # DB con miles de runs (idx_runs_status, idx_runs_started_at).
        async with self.pool.acquire() as conn:
            # 1. Conteo total + por status
            status_rows = await conn.fetch(
                "SELECT status, COUNT(*) AS n FROM runs GROUP BY status"
            )
            runs_by_status = {r["status"]: r["n"] for r in status_rows}
            total_runs = sum(runs_by_status.values())

            # 2. Runs last 7 days
            last_7d = await conn.fetchval(
                """
                SELECT COUNT(*) FROM runs
                WHERE started_at >= now() - interval '7 days'
                """
            )

            # 3. Cost total + last 7d (sumado de agent_runs, no de runs)
            total_cost = await conn.fetchval(
                "SELECT COALESCE(SUM(cost_usd), 0) FROM agent_runs"
            )
            cost_7d = await conn.fetchval(
                """
                SELECT COALESCE(SUM(cost_usd), 0) FROM agent_runs
                WHERE started_at >= now() - interval '7 days'
                """
            )
            total_agent_runs = await conn.fetchval(
                "SELECT COUNT(*) FROM agent_runs"
            )

            # 4. Avg duration de runs completed (segundos)
            avg_run_dur_sec = await conn.fetchval(
                """
                SELECT AVG(EXTRACT(EPOCH FROM (finished_at - started_at)))
                FROM runs
                WHERE status = 'completed'
                  AND finished_at IS NOT NULL
                  AND started_at IS NOT NULL
                """
            )

            # 5. Avg phase duration por agent (ms), solo agent_runs completed
            phase_rows = await conn.fetch(
                """
                SELECT agent, AVG(duration_ms)::int AS avg_ms
                FROM agent_runs
                WHERE status = 'completed' AND duration_ms > 0
                GROUP BY agent
                """
            )
            avg_phase_duration_ms = {r["agent"]: r["avg_ms"] for r in phase_rows}

        return {
            "total_runs": total_runs,
            "runs_by_status": runs_by_status,
            "runs_last_7_days": int(last_7d or 0),
            "total_cost_usd": float(total_cost or 0),
            "cost_last_7_days_usd": float(cost_7d or 0),
            "avg_run_duration_sec": float(avg_run_dur_sec) if avg_run_dur_sec else None,
            "avg_phase_duration_ms": avg_phase_duration_ms,
            "total_agent_runs": int(total_agent_runs or 0),
        }

    async def update_run_status(
        self, run_id: str, status: str, error: str | None = None
    ) -> None:
        finished = status in ("completed", "failed", "aborted")
        async with self.pool.acquire() as conn:
            if finished:
                await conn.execute(
                    """
                    UPDATE runs SET status=$1, error=$2, finished_at=now()
                    WHERE id=$3
                    """,
                    status,
                    error,
                    run_id,
                )
            else:
                await conn.execute(
                    "UPDATE runs SET status=$1, error=$2 WHERE id=$3",
                    status,
                    error,
                    run_id,
                )

    # ------------------------------------------------------------------
    # state versions (append-only)
    # ------------------------------------------------------------------
    async def append_state_version(
        self,
        run_id: str,
        agent: str,
        phase: str,
        json_state: dict[str, Any],
        md_state: str,
        diff: dict[str, Any] | None = None,
        spec_commit_sha: str | None = None,
    ) -> StateVersion:
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    SELECT COALESCE(MAX(version), 0) AS v
                    FROM state_versions WHERE run_id = $1
                    """,
                    run_id,
                )
                next_version = (row["v"] or 0) + 1
                ts = datetime.now(timezone.utc)
                await conn.execute(
                    """
                    INSERT INTO state_versions
                        (run_id, version, agent, phase, json_state,
                         md_state, diff, spec_commit_sha, ts)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    """,
                    run_id,
                    next_version,
                    agent,
                    phase,
                    json_state,
                    md_state,
                    diff or {},
                    spec_commit_sha,
                    ts,
                )
        return StateVersion(
            run_id=run_id,
            version=next_version,
            agent=agent,
            phase=phase,
            json_state=json_state,
            md_state=md_state,
            diff=diff or {},
            spec_commit_sha=spec_commit_sha,
            ts=ts,
        )

    async def get_latest_state(self, run_id: str) -> StateVersion | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT * FROM state_versions
                WHERE run_id=$1
                ORDER BY version DESC
                LIMIT 1
                """,
                run_id,
            )
        return _row_to_state_version(row) if row else None

    async def get_state_history(self, run_id: str) -> list[StateVersion]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM state_versions
                WHERE run_id=$1
                ORDER BY version ASC
                """,
                run_id,
            )
        return [_row_to_state_version(r) for r in rows]

    # ------------------------------------------------------------------
    # agent runs / heartbeat
    # ------------------------------------------------------------------
    async def start_agent_run(
        self,
        run_id: str,
        agent: str,
        model: str,
        spec_commit_sha: str | None = None,
        agent_run_id: str | None = None,
    ) -> AgentRunRecord:
        agent_run_id = agent_run_id or f"ar_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc)
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO agent_runs
                    (id, run_id, agent, model, spec_commit_sha, status,
                     started_at, last_heartbeat_at)
                VALUES ($1, $2, $3, $4, $5, 'running', $6, $6)
                """,
                agent_run_id,
                run_id,
                agent,
                model,
                spec_commit_sha,
                now,
            )
        return AgentRunRecord(
            id=agent_run_id,
            run_id=run_id,
            agent=agent,
            model=model,
            status="running",
            last_heartbeat_at=now,
        )

    async def heartbeat(self, agent_run_id: str) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE agent_runs SET last_heartbeat_at=now()
                WHERE id=$1 AND status='running'
                """,
                agent_run_id,
            )

    async def finish_agent_run(
        self,
        agent_run_id: str,
        status: str = "completed",
        tokens_in: int = 0,
        tokens_out: int = 0,
        cost_usd: float = 0.0,
        duration_ms: int = 0,
        error: str | None = None,
    ) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE agent_runs
                SET status=$1, tokens_in=$2, tokens_out=$3, cost_usd=$4,
                    duration_ms=$5, error=$6, finished_at=now()
                WHERE id=$7
                """,
                status,
                tokens_in,
                tokens_out,
                cost_usd,
                duration_ms,
                error,
                agent_run_id,
            )

    async def find_stale_agent_runs(self, timeout_seconds: int) -> list[str]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id FROM agent_runs
                WHERE status='running'
                  AND last_heartbeat_at < (now() - ($1 || ' seconds')::interval)
                """,
                str(timeout_seconds),
            )
        return [r["id"] for r in rows]

    # ------------------------------------------------------------------
    # eval scores
    # ------------------------------------------------------------------
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
    ) -> EvalScore:
        eid = eval_id or f"eval_{uuid.uuid4().hex[:12]}"
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO eval_scores (id, run_id, agent_run_id, agent, phase, score, checks, violations)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id, run_id, agent_run_id, agent, phase, score, checks, violations, ts
                """,
                eid, run_id, agent_run_id, agent, phase, score, checks, violations,
            )
        return _row_to_eval_score(row)

    async def get_eval_scores(self, run_id: str) -> list[EvalScore]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, run_id, agent_run_id, agent, phase, score, checks, violations, ts
                FROM eval_scores
                WHERE run_id = $1
                ORDER BY ts
                """,
                run_id,
            )
        return [_row_to_eval_score(r) for r in rows]

    # ------------------------------------------------------------------
    # archival / retention
    # ------------------------------------------------------------------
    async def archive_completed_runs(self, older_than_days: int) -> int:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT COUNT(*) AS n FROM runs
                WHERE status IN ('completed','failed','aborted')
                  AND finished_at < (now() - ($1 || ' days')::interval)
                """,
                str(older_than_days),
            )
        return int(row["n"]) if row else 0

    async def export_run_for_target_repo(
        self, run_id: str
    ) -> tuple[dict[str, Any], str]:
        latest = await self.get_latest_state(run_id)
        if latest is None:
            raise ValueError(f"Run {run_id} no tiene state_versions")
        return latest.json_state, latest.md_state

    # ------------------------------------------------------------------
    # HITL checkpoints
    # ------------------------------------------------------------------
    async def create_hitl_checkpoint(
        self,
        run_id: str,
        agent: str,
        phase: str,
        pending_state_patch: dict[str, Any],
        next_phase: str | None = None,
        checkpoint_id: str | None = None,
    ) -> HitlCheckpoint:
        cid = checkpoint_id or f"hitl_{uuid.uuid4().hex[:8]}"
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO hitl_checkpoints
                    (id, run_id, agent, phase, pending_state_patch, next_phase, status)
                VALUES ($1, $2, $3, $4, $5, $6, 'pending')
                RETURNING id, run_id, agent, phase, pending_state_patch, next_phase,
                          status, decision, feedback, resolved_by, resolved_at, created_at
                """,
                cid, run_id, agent, phase,
                pending_state_patch, next_phase,
            )
        return _row_to_hitl_checkpoint(row)

    async def get_hitl_checkpoint(
        self, checkpoint_id: str
    ) -> HitlCheckpoint | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT id, run_id, agent, phase, pending_state_patch, next_phase,
                       status, decision, feedback, resolved_by, resolved_at, created_at
                FROM hitl_checkpoints WHERE id=$1
                """,
                checkpoint_id,
            )
        return _row_to_hitl_checkpoint(row) if row else None

    async def list_pending_hitl_checkpoints(
        self, run_id: str | None = None
    ) -> list[HitlCheckpoint]:
        async with self.pool.acquire() as conn:
            if run_id is None:
                rows = await conn.fetch(
                    """
                    SELECT id, run_id, agent, phase, pending_state_patch, next_phase,
                           status, decision, feedback, resolved_by, resolved_at, created_at
                    FROM hitl_checkpoints WHERE status='pending'
                    ORDER BY created_at
                    """
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT id, run_id, agent, phase, pending_state_patch, next_phase,
                           status, decision, feedback, resolved_by, resolved_at, created_at
                    FROM hitl_checkpoints WHERE status='pending' AND run_id=$1
                    ORDER BY created_at
                    """,
                    run_id,
                )
        return [_row_to_hitl_checkpoint(r) for r in rows]

    async def resolve_hitl_checkpoint(
        self,
        checkpoint_id: str,
        decision: str,
        resolved_by: str,
        feedback: str | None = None,
    ) -> HitlCheckpoint:
        if decision not in ("approved", "rejected"):
            raise ValueError(f"decision invalida: {decision}")
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE hitl_checkpoints
                SET status=$1, decision=$1, resolved_by=$2, feedback=$3,
                    resolved_at=now()
                WHERE id=$4 AND status='pending'
                RETURNING id, run_id, agent, phase, pending_state_patch, next_phase,
                          status, decision, feedback, resolved_by, resolved_at, created_at
                """,
                decision, resolved_by, feedback, checkpoint_id,
            )
        if row is None:
            raise ValueError(
                f"checkpoint {checkpoint_id} no existe o no esta pending"
            )
        return _row_to_hitl_checkpoint(row)


# ----------------------------------------------------------------------
# row -> dataclass helpers
# ----------------------------------------------------------------------
def _row_to_run(row) -> Run:
    return Run(
        id=row["id"],
        prompt=row["prompt"],
        requester=row["requester"],
        target_repo=row["target_repo"],
        metadata=row["metadata"] or {},
        status=row["status"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        error=row["error"],
    )


def _row_to_state_version(row) -> StateVersion:
    return StateVersion(
        run_id=row["run_id"],
        version=row["version"],
        agent=row["agent"],
        phase=row["phase"],
        json_state=row["json_state"] or {},
        md_state=row["md_state"],
        diff=row["diff"] or {},
        spec_commit_sha=row["spec_commit_sha"],
        ts=row["ts"],
    )


def _row_to_eval_score(row) -> EvalScore:
    return EvalScore(
        id=row["id"],
        run_id=row["run_id"],
        agent_run_id=row["agent_run_id"],
        agent=row["agent"],
        phase=row["phase"],
        score=float(row["score"]),
        checks=row["checks"] or [],
        violations=row["violations"] or [],
        ts=row["ts"],
    )


def _row_to_hitl_checkpoint(row) -> HitlCheckpoint:
    return HitlCheckpoint(
        id=row["id"],
        run_id=row["run_id"],
        agent=row["agent"],
        phase=row["phase"],
        pending_state_patch=row["pending_state_patch"] or {},
        next_phase=row["next_phase"],
        status=row["status"],
        decision=row["decision"],
        feedback=row["feedback"],
        resolved_by=row["resolved_by"],
        resolved_at=row["resolved_at"],
        created_at=row["created_at"],
    )
