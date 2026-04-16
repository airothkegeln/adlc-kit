-- =============================================================================
-- ADLC Engine — Migration 001: schema inicial
-- =============================================================================
-- Crea las tablas centrales del ciclo ADLC. Todas las mutaciones del
-- project_state son APPEND-ONLY: nunca se sobreescribe una version, solo
-- se agrega una nueva. Esto da auditabilidad completa y replay deterministico.
--
-- Tablas:
--   runs                — un row por ciclo ADLC iniciado
--   state_versions      — append-only, cada step de cada agente
--   agent_runs          — metricas + heartbeat por ejecucion de agente
--   hitl_checkpoints    — checkpoints HITL pendientes y resueltos
--   artifacts           — outputs estructurados (md + json) por archivo
--   schema_migrations   — control de versiones de migraciones (bootstrap)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
    id              TEXT PRIMARY KEY,
    prompt          TEXT NOT NULL,
    requester       TEXT NOT NULL,
    target_repo     TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'pending',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    error           TEXT,
    CONSTRAINT runs_status_chk CHECK (status IN (
        'pending', 'running', 'awaiting_hitl', 'completed', 'failed', 'aborted'
    ))
);

CREATE INDEX IF NOT EXISTS idx_runs_status     ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);

-- ---------------------------------------------------------------------------
-- state_versions (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS state_versions (
    run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    version          INTEGER NOT NULL,
    agent            TEXT NOT NULL,
    phase            TEXT NOT NULL,
    json_state       JSONB NOT NULL,
    md_state         TEXT NOT NULL,
    diff             JSONB NOT NULL DEFAULT '{}'::jsonb,
    spec_commit_sha  TEXT,
    ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, version)
);

CREATE INDEX IF NOT EXISTS idx_state_versions_run_ts ON state_versions(run_id, ts DESC);

-- ---------------------------------------------------------------------------
-- agent_runs (metricas + heartbeat)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_runs (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    agent               TEXT NOT NULL,
    model               TEXT NOT NULL,
    spec_commit_sha     TEXT,
    tokens_in           INTEGER NOT NULL DEFAULT 0,
    tokens_out          INTEGER NOT NULL DEFAULT 0,
    cost_usd            NUMERIC(10,4) NOT NULL DEFAULT 0,
    duration_ms         INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'running',
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ,
    last_heartbeat_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    error               TEXT,
    CONSTRAINT agent_runs_status_chk CHECK (status IN (
        'running', 'completed', 'failed', 'timeout'
    ))
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_run        ON agent_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_heartbeat  ON agent_runs(last_heartbeat_at)
    WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- hitl_checkpoints
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hitl_checkpoints (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    phase           TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    artifact_md     TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    deadline        TIMESTAMPTZ NOT NULL,
    resolver_email  TEXT NOT NULL,
    decision        TEXT,
    resolved_by     TEXT,
    resolved_at     TIMESTAMPTZ,
    magic_token     TEXT UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hitl_status_chk CHECK (status IN (
        'pending', 'approved', 'rejected', 'timeout', 'auto_advanced'
    ))
);

CREATE INDEX IF NOT EXISTS idx_hitl_pending ON hitl_checkpoints(status, deadline)
    WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- artifacts (outputs estructurados por archivo)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifacts (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    phase           TEXT NOT NULL,
    agent           TEXT NOT NULL,
    content_md      TEXT,
    content_json    JSONB,
    ts              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
