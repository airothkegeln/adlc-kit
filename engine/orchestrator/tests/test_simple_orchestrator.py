"""
Tests del SimpleOrchestrator usando FakeStateStore in-memory.
"""

from __future__ import annotations

import asyncio
import inspect

import pytest

from ..base import Orchestrator, RunRequest
from ..simple_orchestrator import STUB_PHASES, SimpleOrchestrator, stub_agent_executor
from .fake_store import FakeStateStore


def test_orchestrator_implements_interface():
    abstract = {
        n for n, m in inspect.getmembers(Orchestrator, predicate=inspect.isfunction)
        if getattr(m, "__isabstractmethod__", False)
    }
    missing = abstract - set(dir(SimpleOrchestrator))
    assert not missing, f"Faltan: {missing}"


@pytest.mark.asyncio
async def test_start_run_creates_pending():
    store = FakeStateStore()
    orch = SimpleOrchestrator(store=store)
    handle = await orch.start_run(
        RunRequest(prompt="machbank onboarding", requester="t@e.com")
    )
    assert handle.status == "pending"
    assert handle.run_id in store.runs


@pytest.mark.asyncio
async def test_stub_executor_runs_full_cycle():
    """El stub executor debe completar las 8 fases canonicas."""
    store = FakeStateStore()
    orch = SimpleOrchestrator(store=store)
    run = await store.create_run(prompt="x", requester="t@e.com")

    await stub_agent_executor(store, run, orch)

    history = await store.get_state_history(run.id)
    assert len(history) == len(STUB_PHASES)
    assert [v.agent for v in history] == [a for a, _ in STUB_PHASES]
    # Versiones monotonic
    assert [v.version for v in history] == list(range(1, len(STUB_PHASES) + 1))
    # Todos los agent_runs en completed
    assert all(ar.status == "completed" for ar in store.agent_runs.values())
    assert len(store.agent_runs) == len(STUB_PHASES)


@pytest.mark.asyncio
async def test_run_forever_processes_pending_runs():
    store = FakeStateStore()
    orch = SimpleOrchestrator(
        store=store,
        max_concurrent_runs=2,
        poll_interval_seconds=0.05,
        watchdog_timeout_seconds=10,
    )

    # Crea 2 runs pending
    await store.create_run(prompt="run 1", requester="t@e.com")
    await store.create_run(prompt="run 2", requester="t@e.com")

    # Corre el loop por un tiempo corto
    loop_task = asyncio.create_task(orch.run_forever())
    # Espera hasta que ambos esten en completed o falle el timeout
    for _ in range(50):
        await asyncio.sleep(0.1)
        statuses = [r.status for r in store.runs.values()]
        if all(s == "completed" for s in statuses):
            break
    orch.stop()
    await asyncio.wait_for(loop_task, timeout=5)

    assert len([r for r in store.runs.values() if r.status == "completed"]) == 2


@pytest.mark.asyncio
async def test_abort_run_marks_aborted():
    store = FakeStateStore()
    orch = SimpleOrchestrator(store=store)
    run = await store.create_run(prompt="x", requester="t@e.com")
    await orch.abort_run(run.id, reason="cancelado por usuario")
    fetched = await store.get_run(run.id)
    assert fetched.status == "aborted"
    assert fetched.error == "cancelado por usuario"


@pytest.mark.asyncio
async def test_resolve_hitl_approved_reopens_run_to_pending():
    store = FakeStateStore()
    orch = SimpleOrchestrator(store=store)
    run = await store.create_run(prompt="x", requester="t@e.com")
    cp = await store.create_hitl_checkpoint(
        run_id=run.id, agent="hypothesis", phase="hypothesis",
        pending_state_patch={"hypothesis": "H1"},
        next_phase="mapping",
    )

    # Run esta pending, no awaiting_hitl -> debe fallar
    with pytest.raises(ValueError, match="awaiting_hitl"):
        await orch.resolve_hitl(run.id, cp.id, "approved", "alguien@e.com")

    # Cambiar a awaiting_hitl, approve -> run vuelve a pending
    await store.update_run_status(run.id, "awaiting_hitl")
    await orch.resolve_hitl(run.id, cp.id, "approved", "alguien@e.com")
    fetched = await store.get_run(run.id)
    assert fetched.status == "pending"
    resolved_cp = await store.get_hitl_checkpoint(cp.id)
    assert resolved_cp.status == "approved"
    assert resolved_cp.resolved_by == "alguien@e.com"


@pytest.mark.asyncio
async def test_resolve_hitl_rejected_marks_run_failed():
    store = FakeStateStore()
    orch = SimpleOrchestrator(store=store)
    run = await store.create_run(prompt="x", requester="t@e.com")
    cp = await store.create_hitl_checkpoint(
        run_id=run.id, agent="hypothesis", phase="hypothesis",
        pending_state_patch={"hypothesis": "H1"},
    )
    await store.update_run_status(run.id, "awaiting_hitl")

    await orch.resolve_hitl(
        run.id, cp.id, "rejected", "bob@e.com",
        feedback="scope ambiguo",
    )

    fetched = await store.get_run(run.id)
    assert fetched.status == "failed"
    assert "scope ambiguo" in (fetched.error or "")

    resolved_cp = await store.get_hitl_checkpoint(cp.id)
    assert resolved_cp.status == "rejected"
    assert resolved_cp.feedback == "scope ambiguo"


@pytest.mark.asyncio
async def test_watchdog_marks_stale_agent_runs():
    store = FakeStateStore()
    # Crear agent_run con heartbeat antiguo
    run = await store.create_run(prompt="x", requester="t@e.com")
    ar = await store.start_agent_run(run.id, "discovery", "claude-opus-4-6")
    # Forzar heartbeat al pasado
    from datetime import datetime, timedelta, timezone
    ar.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(seconds=300)

    stale = await store.find_stale_agent_runs(timeout_seconds=120)
    assert ar.id in stale
