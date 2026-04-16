# ADLC Platform

**Agentic Development Lifecycle** — plataforma forkable que materializa un
ciclo de desarrollo de software completamente agentizado: desde la toma de
requerimientos hasta el despliegue en producción.

> Este es un sistema funcional, no una demo. Los agentes están diseñados
> para ejecutar el flujo completo en producción contra un repo target real.

- **Repo canónico:** `github.com/airothkegeln/adlc`
- **Licencia:** [Creative Commons BY-SA 4.0](./LICENSE)
- **PRs upstream** son revisados exclusivamente por el dueño del repo.
  Los forks son bienvenidos siempre que atribuyan el trabajo original
  (ver [LICENSE](./LICENSE) y [CONTRIBUTING.md](./CONTRIBUTING.md)).

---

## Qué es ADLC

ADLC organiza el ciclo de desarrollo en agentes especializados, cada uno
con su responsabilidad acotada, sus tools whitelisted y su contribución
visible al `project_state` central. Los humanos participan en
checkpoints HITL (Human-In-The-Loop) clave del ciclo.

**Flujo canónico de 9 pasos:**

```
Discovery → Hypothesis → Mapping → Spec Development → Architecture
   → Business Case → Orchestrator → Coding Agents → Validation
```

Cada agente lee el `project_state` anterior, agrega su capa, y devuelve
el estado actualizado. El historial es **append-only** y auditable.

---

## Arquitectura de adapters (forkable por diseño)

ADLC está diseñado para que **toda dependencia externa esté detrás de una
interfaz aislada**. Esto significa que un contribuidor puede reemplazar
cualquier componente sin tocar el resto del sistema.

| Componente     | Default                 | Reemplazable por                          |
| -------------- | ----------------------- | ----------------------------------------- |
| **LLM**        | Anthropic Claude        | OpenAI, Bedrock, Mistral, modelos locales |
| **Orchestrator** | Simple (asyncio + PG) | Temporal, Inngest, Trigger.dev            |
| **Storage**    | PostgreSQL              | SQLite, DynamoDB, MongoDB                 |
| **Sandbox**    | Docker local            | E2B, Daytona, Modal, Firecracker          |
| **HITL**       | Web + AWS SES email     | Slack, Teams, SMS                         |
| **Observability** | structlog + Postgres | Langfuse, LangSmith, Phoenix, OTel        |
| **Secrets**    | AWS Secrets Manager     | Vault, .env local                         |

Para agregar un proveedor nuevo solo se toca **una subcarpeta de
`engine/`**, sin afectar el resto. Ver [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Infraestructura mínima

### Quickstart local (laptop, sin AWS, sin gastos)

**Esta es la forma recomendada para validar el sistema.**

| Requisito | Detalle |
|---|---|
| Sistema operativo | macOS, Linux o Windows con WSL2 |
| RAM libre | 4 GB recomendado |
| Disco | 5 GB |
| Docker Desktop / Docker Engine | con plugin `compose` v2 |
| Claude Code CLI | `claude login` hecho en el host (suscripcion Claude Max / Pro) |

```bash
git clone https://github.com/airothkegeln/adlc.git
cd adlc
claude login           # si todavia no lo hiciste — usa tu cuenta Claude Max/Pro
./scripts/run_local.sh
```

El script:
1. Verifica que Docker está corriendo
2. Verifica que tengas creds de Claude CLI (`~/.claude/`) **o** una
   `ANTHROPIC_API_KEY` exportada como alternativa
3. Crea `.env` y `config/adlc.config.yaml` desde los examples si no existen
4. `docker compose up -d postgres migrate engine`
5. Espera a que `/healthz` responda
6. Imprime URL del API + comando curl de smoke test

### Alternativa: usar API key paga

Si no tenés suscripción Claude, podés usar `ANTHROPIC_API_KEY`:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export LLM_PROVIDER=anthropic
./scripts/run_local.sh
```

Cuando termines:

```bash
./scripts/stop_local.sh             # apaga, preserva datos
./scripts/stop_local.sh --wipe      # apaga y borra el volumen Postgres
```

**Costo: $0.** Todo corre en tu máquina, incluido Postgres.

### Primera corrida — qué vas a ver

Después de `./scripts/run_local.sh`, estos son los hitos esperados:

1. **Pre-checks OK** — el script valida docker, crea `.env` y
   `config/adlc.config.yaml` desde los examples, e inyecta tu
   `ANTHROPIC_API_KEY`.
2. **Postgres + migrate + engine arriba** — `docker compose up -d`
   levanta los tres servicios y espera a que `/healthz` responda.
3. **Mensaje final del script** con la URL del API
   (`http://localhost:8000`) y un comando `curl` de smoke test.

**Validar que el engine responde:**

```bash
curl http://localhost:8000/healthz
# → {"status":"ok","auth_required":false,...}
```

**Lanzar un run de prueba:**

```bash
curl -X POST http://localhost:8000/runs \
  -H 'content-type: application/json' \
  -d '{"prompt":"crear onboarding mobile","requester":"tu@email.com"}'
# → {"run_id":"run_abc123...","status":"pending"}
```

**Levantar la UI (opcional):**

```bash
docker compose up -d ui
# → http://localhost:5173
```

La UI muestra la lista de runs, el reporte estructurado por fase, y el
editor YAML de agent_specs. Si seteaste `ADLC_API_KEY`, la UI te pide
pegarla en el primer load.

**Si algo falla**, ver logs:

```bash
docker compose logs engine | tail -50
docker compose logs migrate | tail -20
```

### Actualizar un clon existente (git pull)

Si ya tenías el proyecto andando y hacés `git pull`, corré simplemente:

```bash
./scripts/run_local.sh
```

El script fuerza `docker compose up --build` para que cualquier cambio en
Dockerfile o código se rebuildee, y las migraciones se leen como volumen
directamente del host — no hay que hacer `--no-cache` a mano.

### Quickstart en AWS (opcional — solo si quieres compartir el endpoint)

Para cuando termines de validar local y quieras que tu equipo le pegue al
mismo endpoint, los scripts `scripts/launch_test_env.sh` +
`scripts/teardown_test_env.sh` levantan una EC2 t4g.small descartable
(~$0.02/hora). Detalles en [scripts/README.md](./scripts/README.md).

### Para deploy en AWS (referencia)

| Recurso | Tamaño recomendado | Notas |
|---|---|---|
| EC2 (engine + sandbox) | **t3.xlarge** mínimo (4 vCPU, 16 GB RAM) | t3.medium sirve hasta Fase 4 (sin coding agents) |
| RDS Postgres | db.t4g.micro | Free tier OK para dev |
| Secrets Manager | 1 secret por API key | Path: `adlc/{tenant}/{key}` |
| SES | dominio verificado | Para HITL por email |
| IAM role en EC2 | `secretsmanager:GetSecretValue`, `ses:SendEmail`, `logs:*` | |
| Security group | 22 (SSH), 443 (HTTPS), 5432 desde el SG del engine | |

> **Nota sobre la EC2:** los agentes de razonamiento (Discovery →
> Business) corren bien en máquinas pequeñas. **Solo cuando se activan
> los Coding Agents con sandbox Docker** se necesita t3.xlarge o
> superior. Subir el tamaño antes de empezar la Fase 5.

### Servicios externos (opcionales según fase)

- **GitHub App** con permisos `read` en repos target — para Discovery y
  Coding Agents. Token PAT funciona en dev.
- **Notion / Linear** integration tokens — para Discovery agent.
- **Slack bot** — futuro, contribución bienvenida.

---

## Estructura del repo

```
adlc/
  src/                              ← Frontend React (UI / consola operativa)
  engine/                           ← Backend Python
    llm/                            ← LLMProvider (anthropic default)
    orchestrator/                   ← Orchestrator (simple default)
    storage/                        ← StateStore (postgres default)
    sandbox/                        ← Sandbox (docker default)
    hitl/                           ← HITL transports (web + email)
    observability/                  ← Tracer (structlog default)
    agents/                         ← Runtime que ejecuta agent_specs
    api/                            ← FastAPI REST + WebSocket
  agent_specs/                      ← YAML versionado de cada agente
    discovery.yaml
    hypothesis.yaml
    ...
  config/
    adlc.config.example.yaml        ← Config central (rate limits, retención, etc.)
    infra_constraints/
      machbank.yaml                 ← Stack target (back/front/UX/infra)
  docs/
    architecture.md
    business_agent_explained.md     ← Por qué Business agent es teatro hasta v2
    adding_an_llm_provider.md
    roadmap.md                      ← Estado detallado por fase
  amplify.yml                       ← Build config del frontend (AWS Amplify)
  docker-compose.yml                ← Stack completo levantable local
  .env.example
  LICENSE                           ← CC BY-SA 4.0
  CONTRIBUTING.md
  README.md
```

---

## Configuración

Toda la configuración del sistema vive en **`config/adlc.config.yaml`**
(copia de `config/adlc.config.example.yaml`). Este archivo controla:

- Qué LLM provider usar y con qué API key
- **Rate limits** y **budget caps** por run y por día
- Driver de storage y **retención** del project_state
- Driver de sandbox y límites de recursos
- Transports HITL activos
- Driver de observability
- Stack target activo (`infra_constraints`)

El archivo está en `.gitignore` — nunca se commitea. Solo
`adlc.config.example.yaml` es público.

### Auth de la API

Single-tenant: una API key compartida en `ADLC_API_KEY` (env var).

```bash
# Generar una key fuerte y agregarla al .env
echo "ADLC_API_KEY=$(openssl rand -hex 32)" >> .env
docker compose up -d
```

Cuando `ADLC_API_KEY` está seteada:
- Todas las rutas HTTP exigen `Authorization: Bearer <key>` (excepto `/healthz`)
- Los WebSocket requieren `?api_key=<key>` en el query string
- La UI muestra un modal en el primer load para que pegues la key; queda en `localStorage`
- `/healthz` reporta `auth_required: true` para que la UI sepa pedirla

Si `ADLC_API_KEY` está vacía, el engine arranca en **modo dev abierto**
con un WARNING ruidoso al startup. **No exponer así a internet** sin
firewall — cualquiera con acceso a la red puede crear runs, abortar y
aprobar HITLs.

### Persistencia del project_state

Los `project_state` viven en **dos niveles**:

1. **Postgres** durante el ciclo, con `db_retention_days` configurable
2. **Repo target** al cerrar el run: el orquestador commitea el estado
   final junto al código generado en `.adlc/runs/<run_id>/project_state.{json,md}`

Así el artefacto y su contexto quedan juntos para siempre.

---

## Estado del proyecto

**Qué funciona hoy:**

- Flujo de 9 pasos end-to-end (Discovery → Validation) con LLM real
- Coding agents en sandbox Docker aislado
- HITL por web y email (SES)
- Auth API por Bearer token
- UI completa (nuevo run, multi-repo selector, reporte estructurado, editor de agent_specs)

**En curso:**

- Hardening: eval real, observability production-grade, budget enforcement
- Fase `publish`: subir fuentes generados a GitHub (greenfield repo público, brownfield PR)

Detalle completo en [docs/roadmap.md](./docs/roadmap.md).

---

## Para forkear

1. Click en **Fork** en GitHub
2. Mantén la licencia CC BY-SA 4.0
3. Indica en tu README que tu proyecto deriva de este repo:
   `Forked from github.com/airothkegeln/adlc`
4. Si quieres contribuir cambios upstream, abre un PR — el dueño del repo
   los revisa manualmente

---

## Agradecimientos

Este proyecto materializa un Agentic Development Lifecycle inspirado en
las prácticas de equipos de ingeniería que están integrando agentes en
todo el ciclo de software, no solo en la escritura de código.
