"""
Tests del FakeStateStore para HITL checkpoints (Fase 3 paso 3a).

Cobertura:
  - create_hitl_checkpoint guarda el state_patch sin aplicar
  - get_hitl_checkpoint lo recupera
  - list_pending_hitl_checkpoints filtra por status y run_id
  - resolve_hitl_checkpoint marca status/decision/feedback/resolved_by/resolved_at
  - errores: checkpoint inexistente, doble resolve, decision invalida
"""

from __future__ import annotations

import pytest

from .fake_store import FakeStateStore


@pytest.mark.asyncio
async def test_create_and_get_hitl_checkpoint():
    store = FakeStateStore()
    run = await store.create_run(prompt="test", requester="user@x")

    patch = {"hypothesis": "H1", "impact_score": {"score": 7}}
    cp = await store.create_hitl_checkpoint(
        run_id=run.id,
        agent="hypothesis",
        phase="hypothesis",
        pending_state_patch=patch,
        next_phase="mapping",
    )

    assert cp.id.startswith("hitl_")
    assert cp.run_id == run.id
    assert cp.agent == "hypothesis"
    assert cp.phase == "hypothesis"
    assert cp.pending_state_patch == patch
    assert cp.next_phase == "mapping"
    assert cp.status == "pending"
    assert cp.decision is None
    assert cp.created_at is not None

    got = await store.get_hitl_checkpoint(cp.id)
    assert got is not None
    assert got.id == cp.id
    assert got.pending_state_patch == patch


@pytest.mark.asyncio
async def test_list_pending_hitl_checkpoints_filters_by_run_and_status():
    store = FakeStateStore()
    r1 = await store.create_run(prompt="a", requester="u")
    r2 = await store.create_run(prompt="b", requester="u")

    await store.create_hitl_checkpoint(
        run_id=r1.id, agent="hypothesis", phase="hypothesis",
        pending_state_patch={"x": 1},
    )
    cp2 = await store.create_hitl_checkpoint(
        run_id=r2.id, agent="hypothesis", phase="hypothesis",
        pending_state_patch={"y": 2},
    )
    # Resolver cp2 para que quede fuera del filtro "pending"
    await store.resolve_hitl_checkpoint(
        cp2.id, decision="approved", resolved_by="reviewer@x",
    )

    all_pending = await store.list_pending_hitl_checkpoints()
    assert len(all_pending) == 1
    assert all_pending[0].run_id == r1.id

    r1_pending = await store.list_pending_hitl_checkpoints(run_id=r1.id)
    assert len(r1_pending) == 1

    r2_pending = await store.list_pending_hitl_checkpoints(run_id=r2.id)
    assert len(r2_pending) == 0


@pytest.mark.asyncio
async def test_resolve_hitl_checkpoint_approved():
    store = FakeStateStore()
    run = await store.create_run(prompt="test", requester="u")
    cp = await store.create_hitl_checkpoint(
        run_id=run.id, agent="hypothesis", phase="hypothesis",
        pending_state_patch={"hypothesis": "H1"},
        next_phase="mapping",
    )

    resolved = await store.resolve_hitl_checkpoint(
        cp.id, decision="approved", resolved_by="alice@x",
        feedback="looks good",
    )

    assert resolved.status == "approved"
    assert resolved.decision == "approved"
    assert resolved.resolved_by == "alice@x"
    assert resolved.feedback == "looks good"
    assert resolved.resolved_at is not None
    # el pending_state_patch NO se muta al resolver — sigue disponible para
    # que el orchestrator lo aplique al accumulated_state
    assert resolved.pending_state_patch == {"hypothesis": "H1"}


@pytest.mark.asyncio
async def test_resolve_hitl_checkpoint_rejected():
    store = FakeStateStore()
    run = await store.create_run(prompt="test", requester="u")
    cp = await store.create_hitl_checkpoint(
        run_id=run.id, agent="hypothesis", phase="hypothesis",
        pending_state_patch={"hypothesis": "H1"},
    )

    resolved = await store.resolve_hitl_checkpoint(
        cp.id, decision="rejected", resolved_by="bob@x",
        feedback="scope is wrong",
    )

    assert resolved.status == "rejected"
    assert resolved.feedback == "scope is wrong"


@pytest.mark.asyncio
async def test_resolve_hitl_checkpoint_errors():
    store = FakeStateStore()
    run = await store.create_run(prompt="test", requester="u")
    cp = await store.create_hitl_checkpoint(
        run_id=run.id, agent="hypothesis", phase="hypothesis",
        pending_state_patch={},
    )

    # Decision invalida
    with pytest.raises(ValueError, match="decision invalida"):
        await store.resolve_hitl_checkpoint(
            cp.id, decision="maybe", resolved_by="x",
        )

    # Checkpoint inexistente
    with pytest.raises(KeyError):
        await store.resolve_hitl_checkpoint(
            "hitl_nosuch", decision="approved", resolved_by="x",
        )

    # Doble resolve: primero approve, despues intentar reject
    await store.resolve_hitl_checkpoint(
        cp.id, decision="approved", resolved_by="x",
    )
    with pytest.raises(ValueError, match="ya resuelto"):
        await store.resolve_hitl_checkpoint(
            cp.id, decision="rejected", resolved_by="y",
        )
