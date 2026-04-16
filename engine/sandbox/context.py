"""
Context vars seteadas por el cycle_executor al arrancar cada phase.

Las tools que corren dentro del agent runtime (ej. sandbox_run) las leen
para saber a que run/phase pertenece la invocacion y poder persistir
artefactos (tar.gz del workspace) en /data/runs/<run_id>/<phase>/.

El cycle_executor hace:
    token_run = current_run_id.set(run.id)
    token_phase = current_phase.set(phase_cfg.phase)
    try:
        await run_agent(...)
    finally:
        current_run_id.reset(token_run)
        current_phase.reset(token_phase)

Las tools leen con .get(None) — si no esta seteado (ej. tests unitarios
corriendo la tool en aislamiento), skip del snapshot.
"""

from __future__ import annotations

from contextvars import ContextVar

current_run_id: ContextVar[str | None] = ContextVar("adlc_current_run_id", default=None)
current_phase: ContextVar[str | None] = ContextVar("adlc_current_phase", default=None)
