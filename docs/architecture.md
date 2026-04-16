# ADLC Platform — Arquitectura

## Visión general

```
┌──────────────────┐         ┌─────────────────────────────────┐
│       UI         │◄──WS────┤            engine               │
│ (React + Vite)   │         │  (FastAPI + asyncio + Postgres) │
│  src/App.jsx     │◄──REST──┤                                 │
└──────────────────┘         │  ┌──────────────────────────┐   │
                             │  │      Orchestrator        │   │
                             │  └────────────┬─────────────┘   │
                             │               │                  │
                             │       ┌───────▼────────┐         │
                             │       │ Agent Runtime  │         │
                             │       │ (lee specs YAML)│        │
                             │       └───────┬────────┘         │
                             │               │                  │
                             │   ┌───────────┼──────────────┐   │
                             │   ▼           ▼              ▼   │
                             │  LLM       Sandbox       Storage │
                             │ Provider                         │
                             └───────────────────────────────────┘
                                       │              │
                                       ▼              ▼
                                  Anthropic       Postgres
                                  (default)       (default)
```

## Principios

1. **Adapters aislados.** Cada dependencia externa está detrás de una
   interfaz `base.py`. Reemplazar un proveedor no toca otras partes.

2. **project_state como única memoria.** Los agentes no comparten estado
   por canales laterales. Todo lo que un agente necesita saber está en el
   `project_state` que recibe como input.

3. **Append-only history.** Ninguna mutación pisa la anterior. Cada
   versión es un snapshot inmutable + diff.

4. **Determinismo donde importa.** Cálculos financieros, decisiones
   regulatorias y acciones irreversibles van por code paths
   determinísticos, no por LLM. Esto se declara en
   `capability_matrix` de cada agent_spec.

5. **HITL real.** Los checkpoints humanos no son opcionales. El sistema
   pausa, espera resolución, y avanza solo con aprobación o timeout.

6. **Versionado de specs.** Cada `agent_run` queda atado al commit SHA
   del agent_spec con el que corrió. Replay es siempre posible.

## Componentes

### Orchestrator (`engine/orchestrator/`)

Coordina la ejecución del ciclo. Default: `SimpleOrchestrator` con
`asyncio` + Postgres. Funcionalidades obligatorias:

- **Memoria:** project_state completo entregado a cada agente
- **Contexto:** history append-only en `state_versions`
- **Heartbeat:** cada agente actualiza `last_heartbeat_at` cada 10s
- **Watchdog:** mata runs sin heartbeat >2min
- **HITL pausable:** runs detenidos hasta resolución o timeout

Para escala alta, reemplazar por Temporal/Inngest sin tocar el resto.

### Agent Runtime (`engine/agents/`)

Carga `agent_specs/*.yaml`, instancia el LLMProvider apropiado, ejecuta el
loop de tool use con guardrails, y devuelve el `project_state` actualizado.

### Storage (`engine/storage/`)

Persistencia del project_state en Postgres. Tablas:

- `runs` — un row por ciclo iniciado
- `state_versions` — append-only, cada step de cada agente
- `agent_runs` — métricas + heartbeat por ejecución de agente
- `hitl_checkpoints` — checkpoints pendientes y resueltos
- `artifacts` — outputs estructurados (md + json) por archivo

### LLM Provider (`engine/llm/`)

Adapter aislado. Ver `engine/llm/base.py` para la interfaz. Agregar un
proveedor = 1 archivo nuevo + registro.

### Sandbox (`engine/sandbox/`)

Ejecución segura de comandos generados por coding agents. Default Docker
local con `network=none`, memoria acotada, timeout duro.

### HITL (`engine/hitl/`)

Transports para entregar checkpoints a humanos. Defaults:
- **Web** — UI muestra `/hitl/pending` con countdown
- **Email SES** — magic link firmado con TTL

### Observability (`engine/observability/`)

Tracer con interfaz mínima (`event`, `span`, `metric`). Default
structlog → stdout → CloudWatch. Métricas (tokens, costo, duración) van
a la tabla `agent_runs`.

## Multi-tenant

**Por diseño, ADLC es single-tenant por instalación.** Si necesitas
multi-tenant, forkea y agrega un `tenant_id` a todas las tablas + un
selector en la API. Esto no está en la roadmap del repo canónico.

## Versionado de agent_specs

Cada `agent_run` guarda en `agent_specs_commit_sha` el commit del repo en
que vivía el spec al momento de ejecutar. Esto permite:

- **Replay determinístico:** correr el mismo spec viejo aunque haya
  cambiado en main
- **Auditoría:** quién decidió qué con qué reglas
- **A/B de specs:** correr dos versiones del mismo agente y comparar

La trazabilidad es obligatoria pero **no afecta el flujo de runtime**:
es solo metadata adicional en cada `agent_run`.
