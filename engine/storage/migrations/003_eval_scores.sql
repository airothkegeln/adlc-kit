-- =============================================================================
-- ADLC Engine — Migration 003: eval_scores
-- =============================================================================
-- Tabla para persistir quality scores por ejecución de agente. Cada agent_run
-- genera un EvalResult con score 0-100, checks individuales y violations.
-- Append-only: un row por agent_run evaluado.
-- =============================================================================

CREATE TABLE IF NOT EXISTS eval_scores (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    agent_run_id    TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    agent           TEXT NOT NULL,
    phase           TEXT NOT NULL,
    score           NUMERIC(5,2) NOT NULL,          -- 0.00 - 100.00
    checks          JSONB NOT NULL DEFAULT '[]',    -- [{name, passed, detail, weight}]
    violations      JSONB NOT NULL DEFAULT '[]',    -- ["rule text that failed"]
    ts              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eval_scores_run ON eval_scores(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_scores_agent_run ON eval_scores(agent_run_id);
