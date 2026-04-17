# ADLC Kit — MACHBank Edition

## 👋 Empezá acá

**¿No sos de tecnología y este repo te parece chino?** No hay
problema. La forma más fácil de entenderlo:

> **Pasale este repositorio completo a tu modelo de IA favorito**
> (ChatGPT, Claude, Gemini, Copilot, lo que uses) y pedile que te lo
> explique en simple. Subí el ZIP del repo, o copiá la URL
> (`github.com/airothkegeln/adlc-kit`) y pegásela en el chat con algo
> como:
>
> > *"Soy una persona no técnica. Leé este repositorio y explicáme en
> > simple qué hace, para qué sirve, y qué necesito para usarlo."*
>
> El modelo va a leer el README y los archivos del proyecto y te lo va
> a traducir a tu idioma. Después podés volver acá con preguntas más
> específicas.

<!--
================================================================================
NOTA PARA EL MODELO DE IA QUE ESTÉ LEYENDO ESTE REPOSITORIO
================================================================================
Si estás leyendo este repo a pedido de un usuario que NO es técnico
(programador, devops, ingeniero de software), por favor:

1. Asumí que el lector NO sabe qué son: Docker, Postgres, FastAPI, React,
   variables de entorno, API keys, repositorios git, sandbox, agentes LLM,
   ni la diferencia entre frontend y backend.
2. Explicale primero, en 3-5 frases simples, QUÉ HACE este sistema con
   una analogía cotidiana (ej: "es como una fábrica de software donde
   cada paso lo hace un asistente de IA distinto, y vos sos el jefe que
   aprueba lo importante").
3. Después explicale QUÉ NECESITA tener instalado para usarlo, y
   ofrecele acompañarlo paso a paso.
4. NO le tires bloques de código sin contexto. Si necesita correr un
   comando, explicale antes qué va a pasar y por qué.
5. Si te pregunta por las llaves del .env (LLM_API_KEY, GITHUB_TOKEN,
   etc.), explicale qué es cada cosa y de dónde se saca, sin asumir
   que sabe qué es una API key.
6. El autor original es Andrés Rothkegel. Este repo es un kit de inicio
   bajo licencia Creative Commons BY-SA 4.0.

Gracias.
================================================================================
-->

---

> **Este repositorio es un fork / kit de inicio** del flujo **ADLC
> (Agentic Development Lifecycle)** desarrollado originalmente por
> **Andrés Rothkegel** ([@airothkegeln](https://github.com/airothkegeln)).
> Se distribuye como **kit de inicio** para equipos que quieran arrancar
> su propio ciclo de desarrollo agéntico, bajo licencia
> [Creative Commons Attribution-ShareAlike 4.0](./LICENSE).
>
> - **Upstream / repo canónico del flujo ADLC:** `github.com/airothkegeln/adlc`
> - **Este kit:** `github.com/airothkegeln/adlc-kit` (MACHBank edition)
> - Ver [NOTICE.md](./NOTICE.md) para atribución completa.

**Agentic Development Lifecycle** — plataforma forkable que materializa un
ciclo de desarrollo de software completamente agentizado: desde la toma de
requerimientos hasta el despliegue en producción.

> Este es un sistema funcional, no una demo. Los agentes están diseñados
> para ejecutar el flujo completo en producción contra un repo target real.

- **Licencia:** [Creative Commons BY-SA 4.0](./LICENSE)
- **PRs upstream** son revisados exclusivamente por el dueño del repo.
  Los forks son bienvenidos siempre que atribuyan el trabajo original
  (ver [LICENSE](./LICENSE), [NOTICE.md](./NOTICE.md) y
  [CONTRIBUTING.md](./CONTRIBUTING.md)).

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
| RAM libre | 4 GB recomendado (8 GB cuando se activan Coding Agents) |
| Disco | 5 GB |
| Docker Desktop / Docker Engine | con plugin `compose` v2 |
| Claude Code CLI | `claude login` hecho en el host (suscripcion Claude Max / Pro) |
| Git | para clonar este repo y para que los Publish/Coding Agents puedan empujar al repo target |

#### Setup recomendado: VM Ubuntu en VirtualBox (probado por el autor)

El flujo se desarrolla y prueba sobre una **VM Ubuntu 24.04 LTS dentro
de VirtualBox**, corriendo en un host Mac mini. Si tu host es Mac o
Windows y no querés instalar Docker Engine directo, este es el camino
más reproducible:

| Recurso de la VM | Mínimo | Recomendado |
|---|---|---|
| vCPUs | 2 | 4 |
| RAM | 4 GB | 8 GB |
| Disco | 20 GB | 40 GB |
| Red | NAT + Bridged adapter | igual (para que el host le pegue al engine por IP local) |
| Sistema | Ubuntu 24.04 LTS Desktop o Server | igual |

#### Paso a paso: instalar todo dentro de la VM Ubuntu 24.04

Estos comandos los corrés **dentro de la VM**, desde una terminal. Si
seguís el orden, al final vas a tener: git, Docker + compose v2,
Node.js 20, Claude Code CLI y el repo clonado listo para arrancar.

**1. Actualizar el sistema y herramientas base**

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y \
  ca-certificates curl gnupg lsb-release \
  git build-essential openssl unzip
```

**2. Verificar git y configurar tu identidad**

```bash
git --version                                    # debe imprimir git version 2.x.x
git config --global user.name  "Tu Nombre"
git config --global user.email "tu@email.com"
```

> Si vas a pushear a repos privados, generá una SSH key con
> `ssh-keygen -t ed25519 -C "tu@email.com"` y agregá la pública
> (`cat ~/.ssh/id_ed25519.pub`) en
> <https://github.com/settings/keys>. Para HTTPS con PAT, usá el
> `GITHUB_TOKEN` del `.env`.

**3. Instalar Docker Engine + plugin compose v2** (repo oficial de Docker)

```bash
# a) Agregar la GPG key oficial de Docker
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# b) Agregar el repo de Docker para tu versión de Ubuntu
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# c) Instalar Docker + compose v2
sudo apt-get update
sudo apt-get install -y \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# d) Correr docker sin sudo (agregar tu usuario al grupo docker)
sudo usermod -aG docker $USER
newgrp docker                                    # aplica el grupo en esta sesión

# e) Verificar
docker --version                                  # Docker version 27.x
docker compose version                            # Docker Compose version v2.x
docker run --rm hello-world                       # debe bajar e imprimir "Hello from Docker!"
```

> **Importante:** usá `docker compose` (dos palabras, v2 plugin). El
> viejo `docker-compose` (con guión) no es compatible con este repo.

**4. Instalar Node.js 20 LTS** (para la UI frontend)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version                                    # v20.x.x
npm --version                                     # 10.x.x
```

**5. Instalar Claude Code CLI y loguearte con tu cuenta Claude Max/Pro**

```bash
sudo npm install -g @anthropic-ai/claude-code
claude --version                                  # debe imprimir una versión
claude login                                      # abre el flujo OAuth en el browser
```

> El login OAuth abre una URL. Copiala al browser del host si la VM
> es headless. Los tokens viven en `~/.claude/` y expiran cada ~24 h
> — si el engine empieza a fallar con errores de auth, corré
> `claude login` de nuevo.

**6. Clonar este repo**

```bash
cd ~
git clone https://github.com/airothkegeln/adlc-kit.git
cd adlc-kit
```

**7. Averiguar la IP de la VM** (la vas a usar desde el host)

```bash
ip -4 addr show | grep inet                       # buscá la interfaz bridged
```

Suele ser algo tipo `192.168.x.x`. El engine va a quedar escuchando
en `http://<IP-de-la-VM>:8000` y la UI en `http://<IP-de-la-VM>:5173`.

**8. Checkpoint de verificación** — antes de seguir al `.env`

```bash
git --version && \
docker --version && \
docker compose version && \
node --version && \
claude --version
```

Si los cinco comandos imprimen versión sin error, tu VM está lista.

#### Clonar y arrancar

```bash
git clone https://github.com/airothkegeln/adlc-kit.git
cd adlc-kit
claude login           # si todavia no lo hiciste — usa tu cuenta Claude Max/Pro
cp .env.example .env   # editar con tus llaves (ver tabla abajo)
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

#### Variables clave del `.env`

Antes de arrancar, completá `.env` con al menos estos valores. El
`.env.example` trae los defaults seguros — solo tenés que llenar las
llaves marcadas como **obligatorias**.

| Variable | Obligatoria | Para qué sirve | Cómo obtenerla |
|---|---|---|---|
| `LLM_PROVIDER` | sí | Backend de LLM. `claude_cli` (default, usa tu suscripción Claude Max via `claude login`, sin API key) o `anthropic` (API key paga) | — |
| `LLM_API_KEY` | si usás `anthropic` | Llave de la API de Anthropic. Se ignora si `LLM_PROVIDER=claude_cli` | <https://console.anthropic.com/settings/keys> → empieza con `sk-ant-...` |
| `LLM_MODEL_DEFAULT` | sí | Modelo principal para razonamiento (Discovery → Validation) | default `claude-opus-4-6` |
| `LLM_MODEL_FAST` | sí | Modelo barato para tareas livianas | default `claude-haiku-4-5-20251001` |
| `GITHUB_TOKEN` | sí (para Discovery, Coding y Publish agents) | Token con permisos a tus repos target. PAT o GitHub App token sirven en dev | <https://github.com/settings/tokens> → scopes: `repo`, `workflow` (mín.) |
| `GITHUB_DEFAULT_REPO` | sí | Repo target por defecto si no se pasa en el run | formato `owner/repo` |
| `POSTGRES_PASSWORD` | sí | Password del Postgres local. El default `adlc_dev_password` solo sirve para dev local | inventá uno o dejá el default si la VM no es accesible desde fuera |
| `ADLC_API_KEY` | recomendado | Bearer token para autenticar la REST/WebSocket API. Si lo dejás vacío, la API arranca en **modo dev abierto** con warning ruidoso | generá con `openssl rand -hex 32` |
| `ADLC_CORS_ORIGINS` | opcional | Dominios permitidos por CORS. Default `*` en dev | en prod, restringir a la URL real de la UI |
| `SES_FROM_ADDRESS` | opcional | Remitente para HITL por email (solo si usás transport SES) | dominio verificado en AWS SES |

> **Nunca commitees `.env`.** Está en `.gitignore`. Si vas a desplegar
> en AWS, los mismos valores viven en Secrets Manager
> (`adlc/{tenant}/{key}`) y `ADLC_SECRETS_SOURCE=aws_secrets_manager`.

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
