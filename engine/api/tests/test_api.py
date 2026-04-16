"""
Tests del API FastAPI usando FakeStateStore y SimpleOrchestrator sin loop.

NO requieren Postgres ni Anthropic API key. Para tests de integracion
contra el stack real, usar docker compose up + curl.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from ...orchestrator.simple_orchestrator import SimpleOrchestrator, stub_agent_executor
from ...orchestrator.tests.fake_store import FakeStateStore
from ..main import create_app


def _build_app(api_key: str | None = None):
    store = FakeStateStore()
    orch = SimpleOrchestrator(store=store)
    app = create_app(
        store=store,
        orchestrator=orch,
        start_loop=False,
        api_key=api_key,
    )
    return app, store, orch


def test_healthz():
    app, _, _ = _build_app()
    with TestClient(app) as client:
        r = client.get("/healthz")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["auth_required"] is False  # _build_app default sin key


def test_create_and_get_run():
    app, store, _ = _build_app()
    with TestClient(app) as client:
        r = client.post(
            "/runs",
            json={
                "prompt": "machbank onboarding",
                "requester": "test@example.com",
                "target_repo": "machbank/mobile",
                "metadata": {"source": "pytest"},
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        run_id = body["run_id"]
        assert body["status"] == "pending"

        r2 = client.get(f"/runs/{run_id}")
        assert r2.status_code == 200
        assert r2.json()["prompt"] == "machbank onboarding"


def test_get_nonexistent_run_returns_404():
    app, _, _ = _build_app()
    with TestClient(app) as client:
        r = client.get("/runs/no-existe")
        assert r.status_code == 404


def test_get_state_404_when_empty():
    app, store, _ = _build_app()
    with TestClient(app) as client:
        r = client.post(
            "/runs",
            json={"prompt": "x", "requester": "t@e.com"},
        )
        run_id = r.json()["run_id"]
        # Aun no se ejecuto, no hay state versions
        r2 = client.get(f"/runs/{run_id}/state")
        assert r2.status_code == 404


def test_history_after_stub_run(tmp_path):
    """
    Crea un run, ejecuta el stub_executor manualmente, y verifica que
    /history devuelve las 8 fases.
    """
    app, store, orch = _build_app()
    with TestClient(app) as client:
        r = client.post(
            "/runs",
            json={"prompt": "x", "requester": "t@e.com"},
        )
        run_id = r.json()["run_id"]

        # Ejecutar el ciclo manualmente (no hay loop corriendo)
        run = asyncio.get_event_loop().run_until_complete(store.get_run(run_id))
        asyncio.get_event_loop().run_until_complete(
            stub_agent_executor(store, run, orch)
        )

        r2 = client.get(f"/runs/{run_id}/history")
        assert r2.status_code == 200
        history = r2.json()
        assert len(history) == 8
        assert history[0]["version"] == 1
        assert history[-1]["version"] == 8


def test_abort_run():
    app, store, _ = _build_app()
    with TestClient(app) as client:
        r = client.post("/runs", json={"prompt": "x", "requester": "t@e.com"})
        run_id = r.json()["run_id"]
        r2 = client.post(f"/runs/{run_id}/abort", json={"reason": "test"})
        assert r2.status_code == 200
        assert r2.json()["status"] == "aborted"


# ----------------------------------------------------------------------
# Stats — agregados para Dashboard
# ----------------------------------------------------------------------
def test_stats_empty_store():
    app, _, _ = _build_app()
    with TestClient(app) as client:
        r = client.get("/stats")
        assert r.status_code == 200
        s = r.json()
        assert s["total_runs"] == 0
        assert s["runs_by_status"] == {}
        assert s["total_cost_usd"] == 0.0
        assert s["avg_run_duration_sec"] is None
        assert s["avg_phase_duration_ms"] == {}


def test_stats_with_runs_and_agent_runs():
    """
    Crea 3 runs con statuses distintos y agent_runs con costos para
    verificar que los agregados son correctos.
    """
    from datetime import datetime, timedelta, timezone
    from storage.base import AgentRunRecord, Run

    app, store, _ = _build_app()
    now = datetime.now(timezone.utc)

    # Run 1: completed, 60s duration
    store.runs["r1"] = Run(
        id="r1", prompt="p1", requester="u",
        status="completed",
        started_at=now - timedelta(minutes=5),
        finished_at=now - timedelta(minutes=4),
    )
    # Run 2: completed, 120s duration
    store.runs["r2"] = Run(
        id="r2", prompt="p2", requester="u",
        status="completed",
        started_at=now - timedelta(minutes=10),
        finished_at=now - timedelta(minutes=8),
    )
    # Run 3: failed
    store.runs["r3"] = Run(
        id="r3", prompt="p3", requester="u",
        status="failed",
        started_at=now - timedelta(minutes=2),
        finished_at=now - timedelta(minutes=1),
    )
    # Agent runs con cost
    store.agent_runs["a1"] = AgentRunRecord(
        id="a1", run_id="r1", agent="discovery", model="m",
        cost_usd=0.10, duration_ms=15000, status="completed",
    )
    store.agent_runs["a2"] = AgentRunRecord(
        id="a2", run_id="r1", agent="coding", model="m",
        cost_usd=0.50, duration_ms=180000, status="completed",
    )
    store.agent_runs["a3"] = AgentRunRecord(
        id="a3", run_id="r2", agent="discovery", model="m",
        cost_usd=0.05, duration_ms=10000, status="completed",
    )

    with TestClient(app) as client:
        r = client.get("/stats")
        assert r.status_code == 200
        s = r.json()
        assert s["total_runs"] == 3
        assert s["runs_by_status"] == {"completed": 2, "failed": 1}
        assert s["runs_last_7_days"] == 3
        assert s["total_cost_usd"] == pytest.approx(0.65)
        # avg run duration: (60 + 120) / 2 = 90s
        assert s["avg_run_duration_sec"] == pytest.approx(90.0, abs=1.0)
        # avg phase: discovery = (15000+10000)/2 = 12500, coding = 180000
        assert s["avg_phase_duration_ms"]["discovery"] == 12500
        assert s["avg_phase_duration_ms"]["coding"] == 180000
        assert s["total_agent_runs"] == 3


# ----------------------------------------------------------------------
# Auth — ADLC_API_KEY (Fase 7 paso 1)
# ----------------------------------------------------------------------
class TestAuth:
    """
    Cubre los 4 estados del flag ADLC_API_KEY:
      1. Sin key (modo dev abierto) — todo pasa, /healthz reporta auth_required:false
      2. Con key correcta — pasa
      3. Con key incorrecta — 401
      4. Sin header de Authorization — 401
    Plus: /healthz exenta en ambos modos.
    """

    def test_dev_mode_open(self):
        app, _, _ = _build_app(api_key=None)
        with TestClient(app) as client:
            r = client.get("/healthz")
            assert r.status_code == 200
            assert r.json() == {"status": "ok", "auth_required": False}

            r2 = client.post("/runs", json={"prompt": "x", "requester": "t@e.com"})
            assert r2.status_code == 200, r2.text

    def test_healthz_exempt_when_auth_on(self):
        app, _, _ = _build_app(api_key="secret-abc")
        with TestClient(app) as client:
            r = client.get("/healthz")
            assert r.status_code == 200
            assert r.json() == {"status": "ok", "auth_required": True}

    def test_correct_bearer_token(self):
        app, _, _ = _build_app(api_key="secret-abc")
        with TestClient(app) as client:
            r = client.post(
                "/runs",
                headers={"Authorization": "Bearer secret-abc"},
                json={"prompt": "x", "requester": "t@e.com"},
            )
            assert r.status_code == 200, r.text

    def test_wrong_bearer_token_returns_401(self):
        app, _, _ = _build_app(api_key="secret-abc")
        with TestClient(app) as client:
            r = client.post(
                "/runs",
                headers={"Authorization": "Bearer wrong-key"},
                json={"prompt": "x", "requester": "t@e.com"},
            )
            assert r.status_code == 401
            assert "invalid" in r.json()["error"].lower()

    def test_missing_authorization_header_returns_401(self):
        app, _, _ = _build_app(api_key="secret-abc")
        with TestClient(app) as client:
            r = client.post("/runs", json={"prompt": "x", "requester": "t@e.com"})
            assert r.status_code == 401
            assert "missing" in r.json()["error"].lower()

    def test_malformed_authorization_header_returns_401(self):
        """Authorization sin 'Bearer ' prefix → 401."""
        app, _, _ = _build_app(api_key="secret-abc")
        with TestClient(app) as client:
            r = client.get(
                "/runs/active",
                headers={"Authorization": "Basic dXNlcjpwYXNz"},
            )
            assert r.status_code == 401

    def test_get_endpoints_also_protected(self):
        """No solo POST/PUT — los GET de lectura también requieren auth."""
        app, _, _ = _build_app(api_key="secret-abc")
        with TestClient(app) as client:
            r = client.get("/runs/active")
            assert r.status_code == 401
            r2 = client.get("/runs/active", headers={"Authorization": "Bearer secret-abc"})
            assert r2.status_code == 200

    def test_websocket_requires_query_param_when_auth_on(self):
        """WebSocket /runs/{id}/stream cierra con 1008 si falta api_key."""
        app, store, _ = _build_app(api_key="secret-abc")
        with TestClient(app) as client:
            # Sin api_key → cierre inmediato
            with pytest.raises(Exception):
                with client.websocket_connect("/runs/run-x/stream") as ws:
                    ws.receive_json()

    def test_websocket_accepts_correct_query_param(self):
        """WebSocket con ?api_key=correcta abre la conexión."""
        app, store, _ = _build_app(api_key="secret-abc")
        with TestClient(app) as client:
            # Crear un run con state para que el WS tenga algo que enviar
            r = client.post(
                "/runs",
                headers={"Authorization": "Bearer secret-abc"},
                json={"prompt": "x", "requester": "t@e.com"},
            )
            run_id = r.json()["run_id"]
            # Abre con la key correcta — no debe cerrarse al conectar
            with client.websocket_connect(
                f"/runs/{run_id}/stream?api_key=secret-abc"
            ) as ws:
                # No esperamos mensajes (no hay state versions todavía),
                # solo que la conexión se abrió sin 1008. Cerrar limpio.
                pass

    def test_websocket_rejects_wrong_query_param(self):
        app, _, _ = _build_app(api_key="secret-abc")
        with TestClient(app) as client:
            with pytest.raises(Exception):
                with client.websocket_connect(
                    "/runs/run-x/stream?api_key=wrong"
                ) as ws:
                    ws.receive_json()
