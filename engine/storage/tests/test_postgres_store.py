"""
Tests del PostgresStateStore.

Hay dos niveles:

  1. Tests unitarios que NO requieren Postgres — verifican que la clase
     cumple la interfaz abstracta y que from_env() construye un DSN valido.

  2. Tests de integracion que requieren un Postgres con migraciones
     aplicadas. Se SKIPean si la variable de entorno ADLC_TEST_POSTGRES
     no esta seteada en "1".

Para correr los tests de integracion:

    docker compose up -d postgres migrate
    ADLC_TEST_POSTGRES=1 \
    POSTGRES_HOST=localhost POSTGRES_PORT=5432 \
    POSTGRES_USER=adlc POSTGRES_PASSWORD=adlc_dev_password \
    POSTGRES_DB=adlc \
    pytest engine/storage/tests/test_postgres_store.py -v
"""

from __future__ import annotations

import inspect
import os

import pytest

from ..base import StateStore
from ..postgres_store import PostgresStateStore


# ----------------------------------------------------------------------
# Unit tests
# ----------------------------------------------------------------------

def test_postgres_store_implements_interface():
    """PostgresStateStore no debe tener metodos abstractos sin implementar."""
    abstract = {
        name for name, m in inspect.getmembers(StateStore, predicate=inspect.isfunction)
        if getattr(m, "__isabstractmethod__", False)
    }
    implemented = set(dir(PostgresStateStore))
    missing = abstract - implemented
    assert not missing, f"Metodos abstractos sin implementar: {missing}"


def test_from_env_builds_dsn(monkeypatch):
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("POSTGRES_HOST", "h")
    monkeypatch.setenv("POSTGRES_PORT", "1234")
    monkeypatch.setenv("POSTGRES_DB", "d")
    store = PostgresStateStore.from_env()
    assert store._dsn == "postgresql://u:p@h:1234/d"


def test_pool_property_raises_before_connect():
    store = PostgresStateStore("postgresql://user:pass@host:5432/db")
    with pytest.raises(RuntimeError, match="no esta conectado"):
        _ = store.pool


# ----------------------------------------------------------------------
# Integration tests (require running Postgres with migrations applied)
# ----------------------------------------------------------------------

requires_postgres = pytest.mark.skipif(
    os.environ.get("ADLC_TEST_POSTGRES") != "1",
    reason="Set ADLC_TEST_POSTGRES=1 con un Postgres real para correr este test",
)


@pytest.fixture
async def store():
    s = PostgresStateStore.from_env()
    await s.connect()
    yield s
    await s.close()


@requires_postgres
@pytest.mark.asyncio
async def test_create_and_get_run(store):
    run = await store.create_run(
        prompt="caso de prueba MACHBank onboarding",
        requester="test@example.com",
        target_repo="machbank/mobile",
        metadata={"source": "pytest"},
    )
    assert run.status == "pending"
    fetched = await store.get_run(run.id)
    assert fetched is not None
    assert fetched.prompt == "caso de prueba MACHBank onboarding"
    assert fetched.metadata == {"source": "pytest"}


@requires_postgres
@pytest.mark.asyncio
async def test_append_state_versions_are_monotonic(store):
    run = await store.create_run(prompt="x", requester="t@e.com")
    v1 = await store.append_state_version(
        run_id=run.id, agent="discovery", phase="discovery",
        json_state={"a": 1}, md_state="# v1",
    )
    v2 = await store.append_state_version(
        run_id=run.id, agent="hypothesis", phase="hypothesis",
        json_state={"a": 1, "b": 2}, md_state="# v2",
        diff={"added": ["b"]},
    )
    assert v1.version == 1
    assert v2.version == 2
    history = await store.get_state_history(run.id)
    assert [v.version for v in history] == [1, 2]
    latest = await store.get_latest_state(run.id)
    assert latest.version == 2


@requires_postgres
@pytest.mark.asyncio
async def test_agent_run_heartbeat_lifecycle(store):
    run = await store.create_run(prompt="x", requester="t@e.com")
    ar = await store.start_agent_run(
        run_id=run.id, agent="discovery", model="claude-opus-4-6",
    )
    await store.heartbeat(ar.id)
    await store.finish_agent_run(
        ar.id, status="completed",
        tokens_in=100, tokens_out=50, cost_usd=0.012, duration_ms=1234,
    )

    # Stale watchdog: tras finish, ningun running queda
    stale = await store.find_stale_agent_runs(timeout_seconds=0)
    assert ar.id not in stale
