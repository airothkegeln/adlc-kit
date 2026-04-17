#!/bin/bash
# =============================================================================
# run_local.sh — Levanta el stack ADLC localmente con docker compose
# =============================================================================
# Funciona en cualquier maquina con Docker:
#   - Tu laptop (Linux/macOS/WSL)
#   - Una EC2/VM con docker instalado
#
# Hace todos los checks de pre-vuelo, copia los archivos de config si no
# existen, valida que la API key este puesta, y levanta el stack.
#
# Uso:
#   export ANTHROPIC_API_KEY=sk-ant-...
#   ./scripts/run_local.sh
#
# O con la API key inline:
#   ANTHROPIC_API_KEY=sk-ant-... ./scripts/run_local.sh
#
# Para detenerlo:
#   ./scripts/stop_local.sh
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ENGINE_PORT=8000

echo "==> Pre-checks"

# --- docker ---
if ! command -v docker >/dev/null; then
    # Si estamos en Ubuntu/Debian, ofrecer correr el bootstrap automaticamente
    if [[ -f /etc/os-release ]]; then
        # shellcheck source=/dev/null
        . /etc/os-release
        if [[ "${ID:-}" == "ubuntu" || "${ID:-}" == "debian" || "${ID_LIKE:-}" == *"debian"* ]]; then
            cat <<EOF
Docker no esta instalado, pero detectamos ${PRETTY_NAME:-Ubuntu/Debian}.

Tenemos un bootstrap automatico que instala docker oficial + compose
plugin + git + jq. ¿Lo corremos ahora? [y/N]
EOF
            read -r RESP
            if [[ "$RESP" =~ ^[yY]$ ]]; then
                exec "$REPO_ROOT/scripts/bootstrap_ubuntu.sh"
            fi
        fi
    fi

    cat <<EOF
ERROR: Docker no esta instalado.

Instalarlo:
  - macOS:           https://docs.docker.com/desktop/install/mac-install/
  - Windows (WSL):   https://docs.docker.com/desktop/install/windows-install/
  - Linux Ubuntu:    ./scripts/bootstrap_ubuntu.sh
  - Linux Amazon:    sudo dnf install docker && sudo systemctl enable --now docker
                     sudo usermod -aG docker \$USER  # cerrar y re-abrir sesion

Despues volve a correr este script.
EOF
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: 'docker compose' (plugin v2) no esta disponible." >&2
    echo "       Instala el plugin: https://docs.docker.com/compose/install/" >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    # Caso comun: instalado pero el usuario no esta en el grupo docker
    if [[ -S /var/run/docker.sock ]] && ! groups | grep -qw docker; then
        cat <<EOF
ERROR: Docker esta instalado pero tu usuario no esta en el grupo 'docker'.

Soluciones (elegi una):

  Opcion A) Refrescar el grupo en esta sesion:
    newgrp docker
    ./scripts/run_local.sh

  Opcion B) Cerrar sesion y volver a entrar (luego correr de nuevo)

  Opcion C) Si todavia no corriste el bootstrap:
    sudo usermod -aG docker \$USER
    # luego newgrp docker o relogin
EOF
        exit 1
    fi

    cat <<EOF
ERROR: Docker daemon no responde.

  - macOS/Windows: abri Docker Desktop
  - Linux: sudo systemctl start docker
           sudo usermod -aG docker \$USER  # luego cerrar/abrir sesion
EOF
    exit 1
fi

echo "    docker:         $(docker --version)"
echo "    docker compose: $(docker compose version --short 2>/dev/null || docker compose version)"

# --- deteccion de stack ADLC corriendo desde otro clone ---
# Los container_name (adlc-postgres, adlc-engine, etc) y los ports (5432,
# 8000, 5173) son globales en el host, asi que dos clones del repo no
# pueden correr a la vez. Detectamos el conflicto temprano y damos un
# mensaje directamente accionable en vez del error cryptico de docker.
OTHER_WORKING_DIR=$(docker inspect adlc-postgres \
    --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
    2>/dev/null || true)
if [[ -n "$OTHER_WORKING_DIR" && "$OTHER_WORKING_DIR" != "$REPO_ROOT" ]]; then
    cat >&2 <<EOF
ERROR: ya hay un stack ADLC corriendo desde OTRO clone del repo:
       $OTHER_WORKING_DIR

No podes correr dos stacks simultaneos: los nombres de container y los
puertos (5432, 8000, 5173) chocan. Apaga el otro primero:

  cd "$OTHER_WORKING_DIR" && ./scripts/stop_local.sh

y despues volve a correr este script.
EOF
    exit 1
fi

# --- archivos de config ---
if [[ ! -f .env ]]; then
    echo "==> Creando .env desde .env.example"
    cp .env.example .env
fi

if [[ ! -f config/adlc.config.yaml ]]; then
    echo "==> Creando config/adlc.config.yaml desde el example"
    cp config/adlc.config.example.yaml config/adlc.config.yaml
fi

# --- LLM auth ---
# Dos caminos soportados:
#   1. claude_cli (default): usa Claude Max del host via `claude login`
#   2. anthropic:            usa ANTHROPIC_API_KEY paga
LLM_PROVIDER_EFFECTIVE="${LLM_PROVIDER:-claude_cli}"

if sed --version >/dev/null 2>&1; then
    SED_INPLACE=(-i)
else
    SED_INPLACE=(-i '')
fi

if [[ "$LLM_PROVIDER_EFFECTIVE" == "claude_cli" ]]; then
    if [[ ! -d "$HOME/.claude" ]] || [[ ! -f "$HOME/.claude.json" ]]; then
        cat <<EOF
ERROR: provider=claude_cli pero no hay creds de Claude CLI en el host.

Opcion 1 (recomendada) - loguearte con tu cuenta Claude Max/Pro:
  claude login
  ./scripts/run_local.sh

Opcion 2 - usar API key paga en vez de Claude Max:
  export ANTHROPIC_API_KEY=sk-ant-...
  export LLM_PROVIDER=anthropic
  ./scripts/run_local.sh
EOF
        exit 1
    fi
    echo "    LLM provider:   claude_cli (OAuth Max via ~/.claude)"
elif [[ "$LLM_PROVIDER_EFFECTIVE" == "anthropic" ]]; then
    if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
        echo "ERROR: LLM_PROVIDER=anthropic requiere ANTHROPIC_API_KEY exportado." >&2
        exit 1
    fi
    sed "${SED_INPLACE[@]}" "s|^LLM_PROVIDER=.*|LLM_PROVIDER=anthropic|" .env
    sed "${SED_INPLACE[@]}" "s|^LLM_API_KEY=.*|LLM_API_KEY=${ANTHROPIC_API_KEY}|" .env
    sed "${SED_INPLACE[@]}" "s|REPLACE_ME_OR_USE_SECRETS_MANAGER|${ANTHROPIC_API_KEY}|" config/adlc.config.yaml
    sed "${SED_INPLACE[@]}" "s|provider: claude_cli|provider: anthropic|" config/adlc.config.yaml
    echo "    LLM provider:   anthropic (API key)"
else
    echo "    LLM provider:   $LLM_PROVIDER_EFFECTIVE (custom — validar config a mano)"
fi

# --- placeholders para mounts de Claude CLI ---
# docker-compose.yml monta ~/.claude y ~/.claude.json (creds OAuth del
# provider claude_cli). Si el usuario no tiene Claude CLI instalado y va
# a usar provider=anthropic, el bind mount falla con "file not found".
# Creamos placeholders vacios para que el mount no rompa.
if [[ ! -e "$HOME/.claude" ]]; then
    mkdir -p "$HOME/.claude"
fi
if [[ ! -e "$HOME/.claude.json" ]]; then
    echo '{}' > "$HOME/.claude.json"
fi

# --- recursos del host ---
TOTAL_MEM_MB=$(free -m 2>/dev/null | awk '/^Mem:/ {print $2}' || echo "?")
FREE_MEM_MB=$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}' || echo "?")
if [[ "$TOTAL_MEM_MB" != "?" && "$TOTAL_MEM_MB" -lt 2000 ]]; then
    echo
    echo "WARN: el host tiene ${TOTAL_MEM_MB}MB de RAM total (~${FREE_MEM_MB}MB libres)."
    echo "      El stack necesita ~700MB. Si no anda, considera:"
    echo "        - Subir la maquina a 2GB+"
    echo "        - Habilitar swap (sudo fallocate -l 2G /swapfile && ...)"
    echo "        - Apagar otros servicios pesados antes de levantar"
    echo
fi

# --- levantar ---
# `--build` fuerza rebuild de las imagenes si hay cambios en el Dockerfile o
# en el codigo. Sin esto, tras un `git pull` el usuario queda con la imagen
# vieja y ve errores crípticos (columnas faltantes, comportamiento stale).
#
# Sin argumentos explicitos levantamos TODO el stack (postgres, migrate,
# engine, sandbox, ui). Antes se levantaba solo postgres+migrate+engine y
# el usuario tenia que acordarse de `docker compose up -d ui` para ver la
# consola web. Con esto, un solo comando deja la plataforma accesible en
# :8000 (API) y :5173 (UI).
echo "==> docker compose up -d --build  (postgres + migrate + engine + sandbox + ui)"
docker compose up -d --build

# --- verificacion de migraciones ---
# Las migraciones son idempotentes. Si el container migrate salio OK pero
# el numero de *.sql aplicadas no coincide con los archivos en disco,
# probablemente BuildKit cacheo un layer viejo con menos archivos. Forzamos
# otra corrida de migrate (idempotente) despues de esperar a que postgres
# este healthy — y ahi si fallamos duro si sigue el drift.
echo "==> Verificando migraciones aplicadas"
MIGRATIONS_ON_DISK=$(ls engine/storage/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')
for i in $(seq 1 15); do
    MIGRATIONS_APPLIED=$(docker compose exec -T postgres \
        psql -U "${POSTGRES_USER:-adlc}" -d "${POSTGRES_DB:-adlc}" -tAc \
        "SELECT count(*) FROM schema_migrations" 2>/dev/null || echo "0")
    if [[ "$MIGRATIONS_APPLIED" -ge "$MIGRATIONS_ON_DISK" ]]; then
        break
    fi
    sleep 1
done
if [[ "${MIGRATIONS_APPLIED:-0}" -lt "$MIGRATIONS_ON_DISK" ]]; then
    echo "    drift detectado: $MIGRATIONS_APPLIED aplicadas vs $MIGRATIONS_ON_DISK en disco"
    echo "    re-corriendo migrate (el volumen montado en docker-compose.yml lee del host)"
    docker compose run --rm migrate
fi

echo "==> Esperando healthz (hasta 60s)"
HEALTHY=false
for i in $(seq 1 30); do
    if curl -fsS "http://localhost:${ENGINE_PORT}/healthz" >/dev/null 2>&1; then
        HEALTHY=true
        break
    fi
    sleep 2
done

if ! $HEALTHY; then
    echo
    echo "WARN: el engine no respondio en /healthz despues de 60s."
    echo "      Revisa los logs:"
    echo "        docker compose logs engine | tail -50"
    echo "        docker compose logs migrate | tail -20"
    echo "        docker compose logs postgres | tail -20"
    exit 1
fi

# IP del host (para accesos desde la maquina fisica si estamos en una VM
# con bridged adapter). En macOS `ip` no existe — fallback a ifconfig.
HOST_IP=$(ip -4 addr show 2>/dev/null \
    | awk '/inet /{print $2}' \
    | cut -d/ -f1 \
    | grep -vE '^(127\.|172\.17\.|169\.254\.)' \
    | head -1)
if [[ -z "${HOST_IP:-}" ]]; then
    HOST_IP=$(ifconfig 2>/dev/null \
        | awk '/inet /{print $2}' \
        | grep -vE '^(127\.|169\.254\.)' \
        | head -1)
fi
HOST_IP="${HOST_IP:-localhost}"

cat <<EOF

=================================================================
 ADLC platform arriba localmente
=================================================================
 API         : http://localhost:${ENGINE_PORT}    (tambien http://${HOST_IP}:${ENGINE_PORT})
 UI (web)    : http://localhost:5173              (tambien http://${HOST_IP}:5173)
 Healthcheck : curl http://localhost:${ENGINE_PORT}/healthz

 La UI tarda ~30-60s la primera vez mientras Vite hace npm ci.
 Seguir el progreso:
   docker compose logs -f ui

 Smoke test (lanza un run con stub_executor):
   curl -X POST http://localhost:${ENGINE_PORT}/runs \\
     -H 'content-type: application/json' \\
     -d '{"prompt":"machbank onboarding","requester":"test@example.com"}'

 Ver progreso del run:
   curl http://localhost:${ENGINE_PORT}/runs/<run_id>/history | jq

 Logs del engine en vivo:
   docker compose logs -f engine

 Apagar el stack:
   ./scripts/stop_local.sh
=================================================================
EOF
