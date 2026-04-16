# ADLC Engine

Backend Python que orquesta el ciclo ADLC: corre los agentes, persiste el
project_state, gestiona HITL y observability.

## Estructura

```
engine/
  llm/                ← Adapter LLM (anthropic default, swappable)
  orchestrator/       ← Orquestador (simple default, swappable)
  storage/            ← StateStore (postgres default, swappable)
  sandbox/            ← Sandbox de ejecución (docker default, swappable)
  hitl/               ← HITL transports (web + email default)
  observability/      ← Tracer (structlog default, swappable)
  agents/             ← Runtime de agentes (lee agent_specs/*.yaml)
  api/                ← FastAPI (REST + WebSocket)
  config.py           ← Carga config/adlc.config.yaml
```

Cada subcarpeta tiene `base.py` con la **interfaz abstracta** y al menos
una implementación de referencia. Los contribuidores que quieran agregar
un proveedor distinto solo tocan su subcarpeta — el resto del sistema no
sabe ni le importa qué implementación está activa.

Ver `CONTRIBUTING.md` en la raíz del repo para detalles del modelo de
adapters.

## Cómo correr migraciones

Las migraciones SQL viven en `engine/storage/migrations/` numeradas
secuencialmente (`001_initial.sql`, `002_*.sql`, etc.). El runner es
un script standalone, sin Alembic ni Django ORM.

### Desde docker-compose (recomendado para dev)

```bash
docker-compose up migrate
```

El servicio `migrate` arranca Postgres si no está corriendo, aplica las
migraciones nuevas en orden, y termina con exit 0. Es idempotente — corrérlo
dos veces seguidas no aplica nada la segunda vez.

### Desde el host (sin docker-compose)

```bash
cd engine
pip install -r requirements.txt
POSTGRES_HOST=localhost \
POSTGRES_PORT=5432 \
POSTGRES_USER=adlc \
POSTGRES_PASSWORD=adlc_dev_password \
POSTGRES_DB=adlc \
python -m storage.migrate
```

### Crear una migración nueva

1. Crear `engine/storage/migrations/00N_descripcion.sql` (numerada secuencial)
2. NO editar migraciones ya aplicadas en algún ambiente — siempre crear una nueva
3. Probar con `docker-compose up migrate` antes de commitear

## Compatibilidad de Python

- **Runtime de producción:** Python 3.11+ (definido en `Dockerfile`)
- **Tests/desarrollo local:** Python 3.9+

Para que los tests corran en Python 3.9 (donde `str | None` no se evalúa
en runtime), todos los archivos del engine usan
`from __future__ import annotations`. **Mantener esa línea en cualquier
archivo nuevo del engine.**

## Dependencias

`requirements.txt` está pinneado-flexible (`>=`) por compatibilidad con
forks. Las dependencias mínimas son:

- `asyncpg` — driver Postgres async
- `anthropic` — SDK del LLM provider default
- `fastapi` + `uvicorn` — API
- `pydantic` + `pyyaml` — config y validación
- `structlog` — logging estructurado
- `boto3` — Secrets Manager + SES (opcional en dev)
- `pytest` + `pytest-asyncio` — tests

## Estado actual del buildout

| Paso | Componente | Estado |
|---|---|---|
| 1 | Schema Postgres + migration runner | ✓ |
| 2 | postgres_store.py (StateStore) | ✓ |
| 3 | anthropic_provider.py (LLMProvider) | ✓ |
| 4 | simple_orchestrator.py | ✓ |
| 5 | engine/api/ (FastAPI) | ✓ |

## Cómo correr los tests

```bash
# Tests unitarios (sin DB ni API real)
docker compose run --rm engine pytest engine/storage/tests engine/llm/tests engine/orchestrator/tests engine/api/tests

# Tests de integracion contra Postgres real
docker compose up -d postgres migrate
docker compose run --rm \
  -e ADLC_TEST_POSTGRES=1 \
  engine pytest engine/storage/tests/test_postgres_store.py

# Smoke test del API contra el stack completo
docker compose up -d
curl -X POST localhost:8000/runs -H 'content-type: application/json' \
  -d '{"prompt":"machbank onboarding","requester":"test@example.com"}'
```

> **Nota:** los tests del API requieren `fastapi` y `httpx` instalados.
> Si tu host no tiene pip disponible, usa el container de docker compose.
