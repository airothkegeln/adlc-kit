"""
FakeStateStore — implementacion in-memory del StateStore para tests del
orquestador. NO usar en produccion.

Cubre la interfaz completa con dicts en memoria. Las versiones de
state_versions son atomicas via lock.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from storage.base import AgentRunRecord, EvalScore, HitlCheckpoint, Run, StateStore, StateVersion


class FakeStateStore(StateStore):

    def __init__(self):
        self.runs: dict[str, Run] = {}
        self.state_versions: dict[str, list[StateVersion]] = {}
        self.agent_runs: dict[str, AgentRunRecord] = {}
        self.hitl_checkpoints: dict[str, HitlCheckpoint] = {}
        self.eval_scores: dict[str, list[EvalScore]] = {}
        self._lock = asyncio.Lock()

    async def connect(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def create_run(
        self, prompt, requester, target_repo=None, metadata=None, run_id=None
    ) -> Run:
        run_id = run_id or f"run_{uuid.uuid4().hex[:8]}"
        run = Run(
            id=run_id,
            prompt=prompt,
            requester=requester,
            target_repo=target_repo,
            metadata=metadata or {},
            status="pending",
            started_at=datetime.now(timezone.utc),
        )
        self.runs[run_id] = run
        self.state_versions[run_id] = []
        return run

    async def get_run(self, run_id):
        return self.runs.get(run_id)

    async def list_pending_runs(self, limit=10):
        return [r for r in self.runs.values() if r.status == "pending"][:limit]

    async def list_active_runs(self, limit=50):
        active_statuses = {"pending", "running", "awaiting_hitl"}
        active = [r for r in self.runs.values() if r.status in active_statuses]
        # Ordenar por started_at desc para que el mas reciente quede primero
        active.sort(key=lambda r: r.started_at or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
        return active[:limit]

    async def list_recent_runs(self, limit=30):
        all_runs = list(self.runs.values())
        all_runs.sort(key=lambda r: r.started_at or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
        return all_runs[:limit]

    async def get_stats(self):
        now = datetime.now(timezone.utc)
        cutoff_7d = now - timedelta(days=7)

        runs_by_status: dict[str, int] = {}
        runs_last_7d = 0
        run_durations_sec: list[float] = []
        for r in self.runs.values():
            runs_by_status[r.status] = runs_by_status.get(r.status, 0) + 1
            if r.started_at and r.started_at >= cutoff_7d:
                runs_last_7d += 1
            if r.status == "completed" and r.started_at and r.finished_at:
                run_durations_sec.append((r.finished_at - r.started_at).total_seconds())

        total_cost = 0.0
        cost_7d = 0.0
        phase_durations: dict[str, list[int]] = {}
        for ar in self.agent_runs.values():
            total_cost += ar.cost_usd or 0
            # FakeStateStore no trackea started_at de agent_runs por simplicidad,
            # asumimos que todos los agent_runs son recientes para tests.
            cost_7d += ar.cost_usd or 0
            if ar.status == "completed" and ar.duration_ms > 0:
                phase_durations.setdefault(ar.agent, []).append(ar.duration_ms)

        avg_phase_duration_ms = {
            agent: int(sum(durs) / len(durs))
            for agent, durs in phase_durations.items()
        }
        avg_run_duration_sec = (
            sum(run_durations_sec) / len(run_durations_sec)
            if run_durations_sec else None
        )

        return {
            "total_runs": len(self.runs),
            "runs_by_status": runs_by_status,
            "runs_last_7_days": runs_last_7d,
            "total_cost_usd": float(total_cost),
            "cost_last_7_days_usd": float(cost_7d),
            "avg_run_duration_sec": avg_run_duration_sec,
            "avg_phase_duration_ms": avg_phase_duration_ms,
            "total_agent_runs": len(self.agent_runs),
        }

    async def update_run_status(self, run_id, status, error=None):
        r = self.runs[run_id]
        r.status = status
        r.error = error
        if status in ("completed", "failed", "aborted"):
            r.finished_at = datetime.now(timezone.utc)

    async def append_state_version(
        self, run_id, agent, phase, json_state, md_state, diff=None, spec_commit_sha=None
    ) -> StateVersion:
        async with self._lock:
            versions = self.state_versions.setdefault(run_id, [])
            next_version = len(versions) + 1
            sv = StateVersion(
                run_id=run_id,
                version=next_version,
                agent=agent,
                phase=phase,
                json_state=json_state,
                md_state=md_state,
                diff=diff or {},
                spec_commit_sha=spec_commit_sha,
                ts=datetime.now(timezone.utc),
            )
            versions.append(sv)
            return sv

    async def get_latest_state(self, run_id):
        versions = self.state_versions.get(run_id, [])
        return versions[-1] if versions else None

    async def get_state_history(self, run_id):
        return list(self.state_versions.get(run_id, []))

    async def start_agent_run(
        self, run_id, agent, model, spec_commit_sha=None, agent_run_id=None
    ) -> AgentRunRecord:
        ar_id = agent_run_id or f"ar_{uuid.uuid4().hex[:8]}"
        ar = AgentRunRecord(
            id=ar_id,
            run_id=run_id,
            agent=agent,
            model=model,
            status="running",
            last_heartbeat_at=datetime.now(timezone.utc),
        )
        self.agent_runs[ar_id] = ar
        return ar

    async def heartbeat(self, agent_run_id):
        ar = self.agent_runs.get(agent_run_id)
        if ar and ar.status == "running":
            ar.last_heartbeat_at = datetime.now(timezone.utc)

    async def finish_agent_run(
        self, agent_run_id, status="completed", tokens_in=0, tokens_out=0,
        cost_usd=0.0, duration_ms=0, error=None
    ):
        ar = self.agent_runs.get(agent_run_id)
        if ar:
            ar.status = status
            ar.tokens_in = tokens_in
            ar.tokens_out = tokens_out
            ar.cost_usd = cost_usd
            ar.duration_ms = duration_ms
            ar.error = error

    async def find_stale_agent_runs(self, timeout_seconds):
        now = datetime.now(timezone.utc)
        threshold = now - timedelta(seconds=timeout_seconds)
        return [
            ar.id for ar in self.agent_runs.values()
            if ar.status == "running" and (ar.last_heartbeat_at or now) < threshold
        ]

    # ---- HITL checkpoints ----
    async def create_hitl_checkpoint(
        self, run_id, agent, phase, pending_state_patch,
        next_phase=None, checkpoint_id=None,
    ) -> HitlCheckpoint:
        cid = checkpoint_id or f"hitl_{uuid.uuid4().hex[:8]}"
        cp = HitlCheckpoint(
            id=cid,
            run_id=run_id,
            agent=agent,
            phase=phase,
            pending_state_patch=dict(pending_state_patch),
            next_phase=next_phase,
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        self.hitl_checkpoints[cid] = cp
        return cp

    async def get_hitl_checkpoint(self, checkpoint_id):
        return self.hitl_checkpoints.get(checkpoint_id)

    async def list_pending_hitl_checkpoints(self, run_id=None):
        return [
            cp for cp in self.hitl_checkpoints.values()
            if cp.status == "pending" and (run_id is None or cp.run_id == run_id)
        ]

    async def resolve_hitl_checkpoint(
        self, checkpoint_id, decision, resolved_by, feedback=None,
    ) -> HitlCheckpoint:
        cp = self.hitl_checkpoints.get(checkpoint_id)
        if cp is None:
            raise KeyError(f"checkpoint {checkpoint_id} no existe")
        if cp.status != "pending":
            raise ValueError(
                f"checkpoint {checkpoint_id} ya resuelto (status={cp.status})"
            )
        if decision not in ("approved", "rejected"):
            raise ValueError(f"decision invalida: {decision}")
        cp.status = decision
        cp.decision = decision
        cp.feedback = feedback
        cp.resolved_by = resolved_by
        cp.resolved_at = datetime.now(timezone.utc)
        return cp

    # ---- eval scores ----
    async def save_eval_score(
        self, run_id, agent_run_id, agent, phase, score,
        checks, violations, eval_id=None,
    ) -> EvalScore:
        eid = eval_id or f"eval_{uuid.uuid4().hex[:12]}"
        es = EvalScore(
            id=eid, run_id=run_id, agent_run_id=agent_run_id,
            agent=agent, phase=phase, score=score,
            checks=checks, violations=violations,
            ts=datetime.now(timezone.utc),
        )
        self.eval_scores.setdefault(run_id, []).append(es)
        return es

    async def get_eval_scores(self, run_id) -> list[EvalScore]:
        return list(self.eval_scores.get(run_id, []))

    async def archive_completed_runs(self, older_than_days):
        return 0

    async def export_run_for_target_repo(self, run_id):
        latest = await self.get_latest_state(run_id)
        if latest is None:
            raise ValueError(f"Run {run_id} no tiene state_versions")
        return latest.json_state, latest.md_state
