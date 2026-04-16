-- =============================================================================
-- ADLC Engine — Migration 002: HITL MVP
-- =============================================================================
-- Extiende hitl_checkpoints con los campos necesarios para el MVP del HITL:
--   - agent              : nombre del agente que genero el patch
--   - pending_state_patch: el state_patch sin aplicar (lo aplica resolve_hitl)
--   - next_phase         : phase desde donde reanudar al approve
--   - decision           : "approved" | "rejected" (redundante con status
--                          pero queda explicito para la API)
--   - feedback           : texto libre del humano al resolver
--
-- Las columnas del MVP anterior (deadline, resolver_email, title, description,
-- magic_token) se relajan a NULLABLE porque en esta fase no usamos email
-- notifications ni deadlines automaticos — eso vendra en Fase 7 (hardening).
-- =============================================================================

ALTER TABLE hitl_checkpoints
    ADD COLUMN IF NOT EXISTS agent                TEXT,
    ADD COLUMN IF NOT EXISTS pending_state_patch  JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS next_phase           TEXT,
    ADD COLUMN IF NOT EXISTS decision             TEXT,
    ADD COLUMN IF NOT EXISTS feedback             TEXT;

-- Relajar NOT NULL de los campos que eran orientados a email flow
ALTER TABLE hitl_checkpoints ALTER COLUMN title          DROP NOT NULL;
ALTER TABLE hitl_checkpoints ALTER COLUMN description    DROP NOT NULL;
ALTER TABLE hitl_checkpoints ALTER COLUMN deadline       DROP NOT NULL;
ALTER TABLE hitl_checkpoints ALTER COLUMN resolver_email DROP NOT NULL;

-- Index nuevo para list_pending por run_id
CREATE INDEX IF NOT EXISTS idx_hitl_run_pending
    ON hitl_checkpoints(run_id, status)
    WHERE status = 'pending';
