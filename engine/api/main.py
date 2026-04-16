"""
ADLC Engine — FastAPI app (REST + WebSocket).

Endpoints:
  GET  /healthz                       — health check
  POST /runs                          — crea un run nuevo
  GET  /runs/{run_id}                 — estado del run
  GET  /runs/{run_id}/state           — ultima version del project_state (json+md)
  GET  /runs/{run_id}/history         — todas las versiones del project_state
  POST /runs/{run_id}/abort           — aborta un run en curso
  POST /hitl/{checkpoint_id}/resolve  — resuelve un HITL pendiente
  WS   /runs/{run_id}/stream          — stream del project_state en tiempo real

El startup del app:
  1. Conecta el StateStore (Postgres por default)
  2. Lanza SimpleOrchestrator.run_forever() como background task
  3. En shutdown detiene el loop y cierra el pool

Para tests, usa create_app(store, orchestrator) con una FakeStateStore
y un orquestador en modo "no loop".
"""

from __future__ import annotations

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from agents.cycle_executor import make_cycle_executor
from agents.tools.factory import build_tool_registry
from llm.registry import get_provider
from orchestrator.base import RunRequest
from orchestrator.simple_orchestrator import SimpleOrchestrator, stub_agent_executor
from storage.base import StateStore
from storage.postgres_store import PostgresStateStore

from observability.structlog_tracer import StructlogTracer

from .auth import ApiKeyMiddleware, get_api_key_from_env, verify_api_key, warn_if_no_api_key


# ----------------------------------------------------------------------
# Pydantic models (request/response)
# ----------------------------------------------------------------------
class CreateRunRequest(BaseModel):
    prompt: str
    requester: str
    target_repo: str | None = None
    metadata: dict[str, Any] | None = None


class RunResponse(BaseModel):
    run_id: str
    status: str
    prompt: str | None = None
    requester: str | None = None
    target_repo: str | None = None
    error: str | None = None


class StateVersionResponse(BaseModel):
    version: int
    agent: str
    phase: str
    json_state: dict[str, Any]
    md_state: str
    diff: dict[str, Any]
    spec_commit_sha: str | None = None
    ts: str


class AbortRequest(BaseModel):
    reason: str = "user requested abort"


class HITLResolveRequest(BaseModel):
    decision: str  # approved | rejected
    resolver: str  # email del humano
    run_id: str
    feedback: str | None = None  # texto libre del humano al approve/reject


# ----------------------------------------------------------------------
# App factory — testeable y configurable
# ----------------------------------------------------------------------
_UNSET = object()


def create_app(
    store: StateStore | None = None,
    orchestrator: SimpleOrchestrator | None = None,
    start_loop: bool = True,
    api_key: str | None | object = _UNSET,
) -> FastAPI:
    """
    Crea la app FastAPI. Para tests pasar store/orchestrator explicitos
    y start_loop=False (el loop se controla a mano).

    `api_key`: si se omite, se lee de `ADLC_API_KEY` env var. Pasar `None`
    explícitamente fuerza modo dev abierto (útil en tests). Pasar un string
    fuerza una key específica (también útil en tests).
    """
    if api_key is _UNSET:
        api_key = get_api_key_from_env()
    warn_if_no_api_key(api_key)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Si no nos pasaron store, asumimos Postgres desde env vars
        nonlocal store, orchestrator
        if store is None:
            store = PostgresStateStore.from_env()
        if not hasattr(app.state, "tracer") or app.state.tracer is None:
            app.state.tracer = StructlogTracer()
            print("[api] StructlogTracer inicializado", file=sys.stderr)
        if orchestrator is None:
            executor = _build_default_executor(tracer=app.state.tracer)
            orchestrator = SimpleOrchestrator(store=store, agent_executor=executor, tracer=app.state.tracer)

        await store.connect()

        loop_task: asyncio.Task | None = None
        if start_loop:
            loop_task = asyncio.create_task(orchestrator.run_forever())

        # Inyectar en app.state para que los endpoints lo accedan
        app.state.store = store
        app.state.orchestrator = orchestrator

        try:
            yield
        finally:
            if loop_task is not None:
                orchestrator.stop()
                try:
                    await asyncio.wait_for(loop_task, timeout=5)
                except asyncio.TimeoutError:
                    loop_task.cancel()
            await store.close()

    app = FastAPI(title="ADLC Engine", version="0.1.0", lifespan=lifespan)
    app.state.api_key = api_key

    # Orden de middleware: Starlette ejecuta el ÚLTIMO add_middleware como
    # outermost. Queremos que CORS sea outermost (para que las respuestas
    # 401 también lleven headers CORS y el browser pueda leerlas), entonces
    # ApiKeyMiddleware se agrega PRIMERO (queda inner) y CORS DESPUÉS
    # (queda outer). El preflight OPTIONS lo responde CORS sin pasar por
    # ApiKey, así que la negociación CORS funciona aún con auth on.
    app.add_middleware(ApiKeyMiddleware, api_key=api_key)

    # CORS: la UI (Vite dev server en puerto 5173) corre en otro origen
    # que el engine (8000) cuando se accede desde browser. Permitimos
    # todo en dev — en prod/Fase 7 hay que restringir allow_origins a la
    # URL real del deploy (ej. Amplify) y sacar allow_origin_regex.
    cors_origins = os.environ.get("ADLC_CORS_ORIGINS", "*")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in cors_origins.split(",")] if cors_origins != "*" else ["*"],
        allow_origin_regex=r"https?://.*:5173" if cors_origins == "*" else None,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*", "Authorization"],
    )

    # Pre-set state si nos pasaron objetos (para tests sin lifespan)
    if store is not None:
        app.state.store = store
    if orchestrator is not None:
        app.state.orchestrator = orchestrator

    # ------------------------------------------------------------------
    # Dependencies
    # ------------------------------------------------------------------
    def get_store(req) -> StateStore:
        return req.app.state.store

    def get_orchestrator(req) -> SimpleOrchestrator:
        return req.app.state.orchestrator

    # ------------------------------------------------------------------
    # Endpoints
    # ------------------------------------------------------------------
    @app.get("/stats")
    async def get_stats_endpoint(request: Request):
        """
        Métricas agregadas para el Dashboard. Calculadas en el backend
        contra el total histórico de runs (no limitado a recientes).
        Ver StateStore.get_stats() para el shape.
        """
        store: StateStore = request.app.state.store
        return await store.get_stats()

    @app.get("/metrics")
    async def get_metrics_endpoint(request: Request):
        """
        Métricas de observability acumuladas desde el último restart:
        tokens, costo, duración por agente, errores, spans recientes.
        """
        tracer: StructlogTracer | None = getattr(request.app.state, "tracer", None)
        if tracer is None:
            return {"error": "tracer not initialized"}
        return tracer.get_metrics_snapshot()

    # ── Agent Specs endpoints ────────────────────────────────────────────
    @app.get("/agent-specs")
    async def list_agent_specs():
        """Return all agent spec YAMLs with raw content + parsed fields."""
        import yaml as _yaml
        from pathlib import Path as _P
        specs_dir = _P(__file__).resolve().parents[1] / "agent_specs"
        if not specs_dir.exists():
            return {"specs": []}
        results = []
        canonical_order = [
            "discovery", "hypothesis", "mapping", "spec_dev",
            "architecture", "business", "coding", "validation",
        ]
        for fname in sorted(specs_dir.glob("*.yaml")):
            with open(fname) as f:
                raw = f.read()
            try:
                parsed = _yaml.safe_load(raw) or {}
            except Exception:
                parsed = {}
            results.append({
                "filename": fname.name,
                "agent": parsed.get("agent", fname.stem),
                "phase": parsed.get("phase", fname.stem),
                "description": parsed.get("description", ""),
                "model": parsed.get("model", ""),
                "tier": parsed.get("tier", ""),
                "system_prompt": parsed.get("system_prompt", ""),
                "tools_whitelist": parsed.get("tools_whitelist", []),
                "reads": parsed.get("reads", []),
                "writes": parsed.get("writes", []),
                "guardrails": parsed.get("guardrails", {}),
                "hitl": parsed.get("hitl", {}),
                "budget": parsed.get("budget", {}),
                "raw": raw,
                "updated_at": fname.stat().st_mtime,
            })
        # Sort by canonical order
        order_map = {name: i for i, name in enumerate(canonical_order)}
        results.sort(key=lambda s: order_map.get(s["agent"], 99))
        return {"specs": results}

    @app.put("/agent-specs/{agent_name}")
    async def update_agent_spec(agent_name: str, request: Request):
        """Save edited YAML content for an agent spec. Backs up previous version."""
        import shutil
        from pathlib import Path as _P
        from datetime import datetime
        body = await request.json()
        raw_content = body.get("content", "")
        if not raw_content.strip():
            raise HTTPException(400, "content is empty")
        specs_dir = _P(__file__).resolve().parents[1] / "agent_specs"
        fpath = specs_dir / f"{agent_name}.yaml"
        if not fpath.exists():
            raise HTTPException(404, f"spec {agent_name}.yaml not found")
        # Backup
        backup_dir = specs_dir / ".backups"
        backup_dir.mkdir(exist_ok=True)
        ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        shutil.copy2(fpath, backup_dir / f"{agent_name}_{ts}.yaml")
        # Write
        with open(fpath, "w") as f:
            f.write(raw_content)
        return {"status": "saved", "agent": agent_name, "backup": f"{agent_name}_{ts}.yaml"}

    @app.get("/repos")
    async def list_github_repos():
        """List repos accessible via GITHUB_TOKEN (up to 200) + user email."""
        import httpx as _httpx
        token = os.environ.get("GITHUB_TOKEN", "")
        if not token:
            return {"repos": [], "user": None, "error": "GITHUB_TOKEN not configured"}
        headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
        all_repos = []
        user_info = None
        try:
            async with _httpx.AsyncClient(timeout=15) as client:
                # Fetch user info for email
                ru = await client.get("https://api.github.com/user", headers=headers)
                if ru.status_code == 200:
                    u = ru.json()
                    user_info = {
                        "login": u.get("login", ""),
                        "email": u.get("email") or f"{u.get('login', '')}@users.noreply.github.com",
                        "name": u.get("name") or u.get("login", ""),
                    }
                for page in range(1, 3):  # max 200 repos (2 pages of 100)
                    r = await client.get(
                        "https://api.github.com/user/repos",
                        headers=headers,
                        params={"per_page": 100, "page": page, "sort": "updated", "direction": "desc"},
                    )
                    if r.status_code != 200:
                        return {"repos": [], "error": f"GitHub API {r.status_code}"}
                    batch = r.json()
                    if not batch:
                        break
                    for repo in batch:
                        all_repos.append({
                            "full_name": repo["full_name"],
                            "name": repo["name"],
                            "description": repo.get("description") or "",
                            "private": repo["private"],
                            "language": repo.get("language") or "",
                            "updated_at": repo.get("updated_at", ""),
                        })
        except Exception as e:
            return {"repos": [], "user": user_info, "error": str(e)}
        return {"repos": all_repos, "user": user_info}

    @app.get("/context")
    async def get_context():
        """Available repos, target stack, and reference docs by area."""
        import yaml as _yaml
        from pathlib import Path as _P
        config_dir = _P(__file__).resolve().parents[1] / "config"
        cfg_path = config_dir / "adlc.config.yaml"
        if not cfg_path.exists():
            cfg_path = config_dir / "adlc.config.example.yaml"
        cfg = {}
        if cfg_path.exists():
            with open(cfg_path) as f:
                cfg = _yaml.safe_load(f) or {}
        # Load active infra constraints
        active = cfg.get("infra_constraints", {}).get("active", "")
        cfile = cfg.get("infra_constraints", {}).get("files", {}).get(active, "")
        constraints = {}
        if cfile:
            cp = _P(__file__).resolve().parents[1] / cfile
            if cp.exists():
                with open(cp) as f:
                    constraints = _yaml.safe_load(f) or {}
        default_repo = cfg.get("github", {}).get("default_repo", "")
        area_labels = {
            "backend": "Backend",
            "frontend": "Frontend",
            "ux_ui_kit": "UX / UI Kit",
            "infrastructure": "Infraestructura",
            "compliance": "Compliance / Seguridad",
        }
        areas = {}
        for key, label in area_labels.items():
            areas[key] = {"label": label, "docs": constraints.get(key, {})}
        return {
            "default_repo": default_repo,
            "repos": [{"name": default_repo, "area": "default"}] if default_repo else [],
            "areas": areas,
            "target": constraints.get("target", {}),
        }

    @app.get("/healthz")
    async def healthz(request: Request):
        # Exenta de auth (ver ApiKeyMiddleware.EXEMPT_PATHS). Devuelve
        # `auth_required` para que la UI sepa si tiene que pedirle al
        # usuario una API key al primer load.
        return {
            "status": "ok",
            "auth_required": request.app.state.api_key is not None,
        }

    @app.post("/runs", response_model=RunResponse)
    async def create_run(payload: CreateRunRequest, request: Request):
        orch: SimpleOrchestrator = request.app.state.orchestrator
        handle = await orch.start_run(
            RunRequest(
                prompt=payload.prompt,
                requester=payload.requester,
                target_repo=payload.target_repo,
                metadata=payload.metadata,
            )
        )
        return RunResponse(
            run_id=handle.run_id,
            status=handle.status,
            prompt=payload.prompt,
            requester=payload.requester,
            target_repo=payload.target_repo,
        )

    # IMPORTANTE: /runs/active debe ir ANTES que /runs/{run_id} porque
    # FastAPI matchea en orden de registro y el pattern con parametro captura
    # cualquier string — si /runs/{run_id} se registra primero, una GET a
    # /runs/active matchearia con run_id="active" y devolveria 404.
    @app.get("/runs/active")
    async def list_active_runs(request: Request):
        """
        Lista runs in-flight (pending + running + awaiting_hitl) con su
        progreso: completed_phases derivado del history. Usado por la UI
        para mostrar timeline de progreso en tiempo real.
        """
        store: StateStore = request.app.state.store
        runs = await store.list_active_runs()
        out = []
        for r in runs:
            history = await store.get_state_history(r.id)
            completed = [v.phase for v in history]
            out.append({
                "run_id": r.id,
                "status": r.status,
                "prompt": r.prompt,
                "requester": r.requester,
                "target_repo": r.target_repo,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "completed_phases": completed,
                "latest_phase": completed[-1] if completed else None,
                "error": r.error,
            })
        return out

    @app.get("/runs/recent")
    async def list_recent_runs_endpoint(request: Request, limit: int = 30):
        """
        Lista los N runs mas recientes (sin filtro de status). Usado por
        la UI para mostrar el historial de runs terminados junto con los
        activos. Incluye finished_at, completed_phases y eval_score agregado.
        """
        store: StateStore = request.app.state.store
        runs = await store.list_recent_runs(limit=min(limit, 100))
        out = []
        for r in runs:
            history = await store.get_state_history(r.id)
            completed = [v.phase for v in history]
            evals = await store.get_eval_scores(r.id)
            avg_eval = round(sum(e.score for e in evals) / len(evals), 2) if evals else None
            out.append({
                "run_id": r.id,
                "status": r.status,
                "prompt": r.prompt,
                "requester": r.requester,
                "target_repo": r.target_repo,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "finished_at": r.finished_at.isoformat() if r.finished_at else None,
                "completed_phases": completed,
                "latest_phase": completed[-1] if completed else None,
                "error": r.error,
                "eval_score": avg_eval,
            })
        return out

    @app.get("/runs/{run_id}", response_model=RunResponse)
    async def get_run_endpoint(run_id: str, request: Request):
        store: StateStore = request.app.state.store
        run = await store.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"Run {run_id} no existe")
        return RunResponse(
            run_id=run.id,
            status=run.status,
            prompt=run.prompt,
            requester=run.requester,
            target_repo=run.target_repo,
            error=run.error,
        )

    @app.get("/runs/{run_id}/logs")
    async def get_run_logs(run_id: str, request: Request, since: int = 0):
        """
        Stream de logs en vivo del run. El cliente hace polling con el
        cursor `since` (monotonico); el servidor devuelve las lineas
        nuevas y el proximo cursor. Buffer in-memory, 500 lineas por run.
        """
        from observability.run_log_buffer import RunLogBuffer
        lines, next_cursor = RunLogBuffer.get_since(run_id, since)
        return {"lines": lines, "next": next_cursor}

    @app.get("/runs/{run_id}/state")
    async def get_run_state(run_id: str, request: Request):
        store: StateStore = request.app.state.store
        latest = await store.get_latest_state(run_id)
        if latest is None:
            raise HTTPException(
                status_code=404,
                detail=f"Run {run_id} aun no tiene state_versions",
            )
        return _state_version_to_dict(latest)

    @app.get("/runs/{run_id}/history")
    async def get_run_history(run_id: str, request: Request):
        store: StateStore = request.app.state.store
        history = await store.get_state_history(run_id)
        return [_state_version_to_dict(v) for v in history]

    @app.get("/runs/{run_id}/eval")
    async def get_run_eval(run_id: str, request: Request):
        """
        Eval scores for all agents in a run. Returns per-agent quality
        scores with check breakdown and violations.
        """
        store: StateStore = request.app.state.store
        scores = await store.get_eval_scores(run_id)
        if not scores:
            return {"run_id": run_id, "scores": [], "aggregate_score": None}
        agent_scores = []
        for s in scores:
            agent_scores.append({
                "id": s.id,
                "agent": s.agent,
                "phase": s.phase,
                "score": s.score,
                "checks": s.checks,
                "violations": s.violations,
                "ts": s.ts.isoformat() if s.ts else None,
            })
        avg_score = round(sum(s.score for s in scores) / len(scores), 2)
        return {
            "run_id": run_id,
            "scores": agent_scores,
            "aggregate_score": avg_score,
        }

    @app.post("/runs/{run_id}/abort", response_model=RunResponse)
    async def abort_run(run_id: str, payload: AbortRequest, request: Request):
        orch: SimpleOrchestrator = request.app.state.orchestrator
        await orch.abort_run(run_id, reason=payload.reason)
        store: StateStore = request.app.state.store
        run = await store.get_run(run_id)
        return RunResponse(
            run_id=run.id, status=run.status, error=run.error,
        )

    @app.post("/hitl/{checkpoint_id}/resolve")
    async def resolve_hitl(checkpoint_id: str, payload: HITLResolveRequest, request: Request):
        orch: SimpleOrchestrator = request.app.state.orchestrator
        await orch.resolve_hitl(
            run_id=payload.run_id,
            checkpoint_id=checkpoint_id,
            decision=payload.decision,
            resolver=payload.resolver,
            feedback=payload.feedback,
        )
        return {"status": "resolved"}

    @app.get("/hitl/pending")
    async def list_pending_hitl(request: Request, run_id: str | None = None):
        """Lista checkpoints pendientes. Filtrable por run_id."""
        store: StateStore = request.app.state.store
        checkpoints = await store.list_pending_hitl_checkpoints(run_id=run_id)
        return [_hitl_checkpoint_to_dict(cp) for cp in checkpoints]

    @app.get("/hitl/{checkpoint_id}")
    async def get_hitl(checkpoint_id: str, request: Request):
        store: StateStore = request.app.state.store
        cp = await store.get_hitl_checkpoint(checkpoint_id)
        if cp is None:
            return Response(status_code=404)
        return _hitl_checkpoint_to_dict(cp)

    @app.websocket("/runs/{run_id}/stream")
    async def stream_run(websocket: WebSocket, run_id: str):
        """
        Stream simple del project_state. Hace polling cada 0.5s al store
        y envia el latest_state cuando la version cambia. Para v1 esto es
        suficiente; en el futuro reemplazar por LISTEN/NOTIFY de Postgres
        o un pub/sub real (Redis, NATS, etc.).

        Auth: si la API tiene key configurada, el cliente debe pasarla
        como query param `?api_key=<key>` (los WebSocket del browser no
        permiten headers custom). Cierre con código 1008 (policy
        violation) si la key falta o es incorrecta.
        """
        expected_key = websocket.app.state.api_key
        if expected_key is not None:
            provided = websocket.query_params.get("api_key", "")
            if not verify_api_key(provided, expected_key):
                await websocket.close(code=1008)
                return
        await websocket.accept()
        store: StateStore = websocket.app.state.store
        last_version = -1
        try:
            while True:
                latest = await store.get_latest_state(run_id)
                if latest is not None and latest.version != last_version:
                    await websocket.send_json(_state_version_to_dict(latest))
                    last_version = latest.version

                run = await store.get_run(run_id)
                if run is not None and run.status in (
                    "completed", "failed", "aborted"
                ):
                    await websocket.send_json({"event": "run_finished", "status": run.status})
                    break
                await asyncio.sleep(0.5)
        except WebSocketDisconnect:
            return

    return app


def _build_default_executor(tracer: StructlogTracer | None = None):
    """
    Construye el cycle_executor real (claude_cli/anthropic + tools reales)
    al arrancar el lifespan del app. Si algo falla, hace fallback al
    stub_agent_executor con un warning visible en stderr — eso evita que
    el container muera al arrancar si no hay LLM provider configurado y
    permite seguir validando el resto del stack (storage, API, etc.).

    Para forzar el stub explicitamente: env var ADLC_USE_STUB_EXECUTOR=1.
    """
    if os.environ.get("ADLC_USE_STUB_EXECUTOR") == "1":
        print("[api] ADLC_USE_STUB_EXECUTOR=1 — usando stub_agent_executor", file=sys.stderr)
        return stub_agent_executor

    try:
        provider_name = os.environ.get("LLM_PROVIDER", "claude_cli")
        # Config minima del provider. En el flujo full el adlc.config.yaml
        # se carga aca; por ahora pasamos lo necesario via env vars.
        provider = get_provider({
            "provider": provider_name,
            "model_default": os.environ.get("LLM_MODEL_DEFAULT", "claude-haiku-4-5"),
            "api_key": os.environ.get("LLM_API_KEY", ""),
        })
        # Tools: leemos config minima por env. Para web_fetch las
        # allowed_domains vienen de env separadas por coma (default: la
        # lista del config example).
        allowed = os.environ.get(
            "ADLC_WEB_FETCH_ALLOWED",
            "github.com,raw.githubusercontent.com,docs.github.com,notion.so,linear.app",
        ).split(",")
        tool_config = {
            "web_fetch": {
                "allowed_domains": [d.strip() for d in allowed if d.strip()],
                "max_response_kb": int(os.environ.get("ADLC_WEB_FETCH_MAX_KB", "50")),
            },
        }
        registry, status = build_tool_registry(config=tool_config)
        print(f"[api] tool_registry status: {status}", file=sys.stderr)

        executor = make_cycle_executor(
            provider=provider,
            tool_registry=registry,
            tracer=tracer,
        )
        print(
            f"[api] cycle_executor listo (provider={provider_name}, "
            f"model={provider.model_id})",
            file=sys.stderr,
        )
        return executor
    except Exception as e:
        print(
            f"[api] WARNING: no pude armar cycle_executor real ({e}). "
            f"Fallback a stub_agent_executor.",
            file=sys.stderr,
        )
        return stub_agent_executor


def _state_version_to_dict(v) -> dict[str, Any]:
    return {
        "version": v.version,
        "agent": v.agent,
        "phase": v.phase,
        "json_state": v.json_state,
        "md_state": v.md_state,
        "diff": v.diff,
        "spec_commit_sha": v.spec_commit_sha,
        "ts": v.ts.isoformat() if v.ts else None,
    }


def _hitl_checkpoint_to_dict(cp) -> dict[str, Any]:
    return {
        "id": cp.id,
        "run_id": cp.run_id,
        "agent": cp.agent,
        "phase": cp.phase,
        "pending_state_patch": cp.pending_state_patch,
        "next_phase": cp.next_phase,
        "status": cp.status,
        "decision": cp.decision,
        "feedback": cp.feedback,
        "resolved_by": cp.resolved_by,
        "resolved_at": cp.resolved_at.isoformat() if cp.resolved_at else None,
        "created_at": cp.created_at.isoformat() if cp.created_at else None,
    }


# ----------------------------------------------------------------------
# App default para uvicorn:  uvicorn api.main:app
# ----------------------------------------------------------------------
app = create_app()
