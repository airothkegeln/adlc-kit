# ADLC Roadmap

Estado detallado del buildout del sistema. El README tiene un resumen
corto de alto nivel; este archivo es la versión larga con detalle por
fase.

## Fases completadas

| Fase | Descripción | Notas |
|---|---|---|
| 0 | Decisiones de arquitectura | Adapters aislados, append-only state, HITL en checkpoints |
| 1 | Backbone (engine + DB schema + API) | FastAPI + Postgres + migraciones idempotentes |
| 2 | Discovery agent end-to-end real | GitHub + Notion + Linear tools con allowlist |
| 3 | Discovery → Hypothesis → Mapping con HITL real | Transporte web + email (SES), timeout configurable |
| 4 | Spec + Architecture + Business (LLM real) | Business agent explicado en `business_agent_explained.md` |
| 5 | Coding agents en sandbox | Docker sidecar aislado, grace nudge fix (commit `4f6d480`) |
| 6 | Validation + deploy | Tests en sandbox, report estructurado en UI |

## En curso

### Fase 7 — Hardening

- ✓ Auth API (Bearer token single-tenant)
- Pendiente: eval real de agentes (golden tasks + scoring)
- Pendiente: observability production-grade (Langfuse/Phoenix adapter)
- Pendiente: rate limit por tenant y budget enforcement

### Fase 8 — Publish (decidida 2026-04-14)

Subir los fuentes generados por los coding agents a GitHub al cerrar el
run. Hoy el sandbox es efímero y los diffs se descartan.

- **Greenfield**: engine genera slug `<prompt-base>-<runid6>`, crea repo
  público `airothkegeln/<slug>` con el `GITHUB_TOKEN` del engine
- **Brownfield**: branch `adlc/<run_id>`, commit con `files_modified`,
  PR contra default branch (nunca commit directo a main)
- Corre **después** de validation. Si validation falla, no se publica.
- Expone `pr_url` / `repo_url` en el reporte del run

Pendiente: validar scope `repo` del token, implementar `engine/agents/tools/git_publish.py`,
capturar archivos antes del teardown del sandbox.
