#!/bin/bash
# =============================================================================
# bootstrap_phase2.sh — Prerrequisitos de Fase 2 (Discovery agent real)
# =============================================================================
# Idempotente. Re-ejecutarlo no daña nada.
#
# Lo que hace:
#   1. Crea/actualiza un venv en .venv con pytest para correr los unit tests
#      del engine (subprocess mockeado, no requieren API ni binario claude).
#   2. Instala Node 20 LTS + el Claude CLI oficial en el HOST (no en el
#      container) para que puedas hacer `claude login` y dejar las creds
#      OAuth en ~/.claude/. Esas creds despues se montan read-only al
#      container del engine.
#   3. Verifica que `claude` funcione SIN ANTHROPIC_API_KEY (es decir,
#      usando la suscripcion Claude Max y no la API facturada).
#
# Pre-requisito previo: bootstrap_ubuntu.sh (Docker, git, curl, jq).
#
# Uso:
#   ./scripts/bootstrap_phase2.sh
#
# Requiere sudo para instalar Node + claude CLI globales (te lo pide cuando
# hace falta). El venv y los unit tests no requieren sudo.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CLEAR='\033[0m'
BLUE='\033[1;34m'
YELLOW='\033[1;33m'
GREEN='\033[1;32m'
RED='\033[1;31m'

log() { echo -e "${BLUE}==>${CLEAR} $*"; }
warn() { echo -e "${YELLOW}WARN:${CLEAR} $*" >&2; }
ok() { echo -e "${GREEN}OK${CLEAR} $*"; }
fail() { echo -e "${RED}ERROR:${CLEAR} $*" >&2; exit 1; }

# ----------------------------------------------------------------------
# 1) venv + pytest para unit tests del engine
# ----------------------------------------------------------------------
log "Configurando venv en .venv para correr unit tests"

if ! command -v python3 >/dev/null; then
    log "python3 no esta — instalando"
    sudo apt-get update -qq
    sudo apt-get install -y -qq python3
fi

PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
log "python3: $PY_VERSION"

# En Ubuntu/Debian modernos, python3-venv y python3-pip son paquetes
# separados que NO vienen con la instalacion base. Sin ellos `python3 -m venv`
# y `python3 -m pip` fallan. Detectamos y los instalamos.
NEED_PKGS=()
if ! python3 -c "import ensurepip" >/dev/null 2>&1; then
    # Ubuntu 22.04 → python3.10-venv, 24.04 → python3.12-venv. python3-venv
    # es un meta-paquete que tira la version correcta.
    NEED_PKGS+=(python3-venv "python${PY_VERSION}-venv")
fi
if ! python3 -m pip --version >/dev/null 2>&1; then
    NEED_PKGS+=(python3-pip)
fi

if [[ ${#NEED_PKGS[@]} -gt 0 ]]; then
    log "Instalando paquetes faltantes: ${NEED_PKGS[*]}"
    sudo apt-get update -qq
    # Algunos paquetes de la lista pueden no existir en esta distro
    # (p.ej. python3.12-venv en 22.04). Instalamos uno por uno con || true
    # y al final validamos que ensurepip funcione.
    for pkg in "${NEED_PKGS[@]}"; do
        sudo apt-get install -y -qq "$pkg" 2>/dev/null || true
    done

    if ! python3 -c "import ensurepip" >/dev/null 2>&1; then
        fail "No pude instalar python3-venv. Probá a mano: sudo apt-get install python${PY_VERSION}-venv"
    fi
fi

if [[ ! -d .venv ]]; then
    log "Creando .venv"
    python3 -m venv .venv
else
    ok ".venv ya existe"
fi

# shellcheck source=/dev/null
source .venv/bin/activate

log "Actualizando pip"
python -m pip install --quiet --upgrade pip

log "Instalando pytest en .venv"
python -m pip install --quiet pytest

ok "venv listo. Activalo con: source .venv/bin/activate"

# ----------------------------------------------------------------------
# 2) Smoke test de los unit tests del provider claude_cli
# ----------------------------------------------------------------------
log "Corriendo unit tests del claude_cli_provider (subprocess mockeado, sin red)"

if python -m pytest engine/llm/tests/test_claude_cli_provider.py -q; then
    ok "Unit tests verde"
else
    fail "Unit tests rojos. Revisa el output de arriba."
fi

# ----------------------------------------------------------------------
# 3) Node + Claude CLI en el HOST
# ----------------------------------------------------------------------
log "Verificando Node + Claude CLI en el host"

NEED_NODE=true
if command -v node >/dev/null; then
    NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
    if [[ "$NODE_MAJOR" -ge 18 ]]; then
        ok "Node $(node -v) ya instalado"
        NEED_NODE=false
    else
        warn "Node $(node -v) es muy viejo (necesitamos >= 18). Reinstalando."
    fi
fi

if $NEED_NODE; then
    log "Instalando Node 20 LTS desde NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
    ok "Node $(node -v) instalado"
fi

if command -v claude >/dev/null; then
    ok "Claude CLI ya instalado: $(claude --version 2>/dev/null || echo '?')"
else
    log "Instalando @anthropic-ai/claude-code globalmente"
    sudo npm install -g @anthropic-ai/claude-code
    ok "Claude CLI instalado: $(claude --version 2>/dev/null || echo '?')"
fi

# ----------------------------------------------------------------------
# 4) Verificacion de creds OAuth (sin facturar API)
# ----------------------------------------------------------------------
CLAUDE_HOME_DIR="${CLAUDE_HOME:-$HOME/.claude}"

if [[ ! -d "$CLAUDE_HOME_DIR" ]] || [[ -z "$(ls -A "$CLAUDE_HOME_DIR" 2>/dev/null || true)" ]]; then
    cat <<EOF

${YELLOW}=================================================================${CLEAR}
${YELLOW} FALTA: claude login${CLEAR}
${YELLOW}=================================================================${CLEAR}
 No encontre creds OAuth en $CLAUDE_HOME_DIR.

 Tenes que loguearte UNA VEZ con tu cuenta Claude Max:

   claude login

 Eso abre el flujo OAuth en el browser. Cuando vuelvas a la terminal,
 ~/.claude/ va a tener las credenciales que despues se montan read-only
 al container del engine.

 Cuando lo hayas hecho, volve a correr este script para validar.
${YELLOW}=================================================================${CLEAR}
EOF
    exit 0
fi

ok "Creds OAuth presentes en $CLAUDE_HOME_DIR"

log "Probando que claude funcione SIN ANTHROPIC_API_KEY (deberia usar Max)"
TMP_OUT=$(mktemp)
if env -u ANTHROPIC_API_KEY claude -p --output-format json --model claude-haiku-4-5 \
        "responde solo con la palabra: ok" > "$TMP_OUT" 2>&1; then
    if command -v jq >/dev/null; then
        RESULT=$(jq -r '.result // empty' < "$TMP_OUT" 2>/dev/null || true)
        COST=$(jq -r '.total_cost_usd // empty' < "$TMP_OUT" 2>/dev/null || true)
        echo "    result      : ${RESULT:-(vacio)}"
        echo "    total_cost_usd: ${COST:-(vacio)}"
        if [[ -n "$COST" && "$COST" != "0" && "$COST" != "0.0" ]]; then
            warn "total_cost_usd=$COST — algo esta facturando API en vez de usar Max."
            warn "Revisa que no haya ANTHROPIC_API_KEY exportada en tu shell."
        else
            ok "Costo 0 — estas usando la suscripcion Max correctamente"
        fi
    else
        cat "$TMP_OUT"
    fi
else
    cat "$TMP_OUT" >&2
    fail "claude CLI fallo. Revisa el output de arriba (probablemente login expirado)."
fi
rm -f "$TMP_OUT"

# ----------------------------------------------------------------------
# 5) Resumen
# ----------------------------------------------------------------------
cat <<EOF

=================================================================
${GREEN} Bootstrap Fase 2 completo${CLEAR}
=================================================================
 venv         : .venv (activar con: source .venv/bin/activate)
 pytest       : $(python -m pytest --version 2>&1 | head -1)
 node         : $(node -v)
 claude       : $(claude --version 2>/dev/null || echo '?')
 creds OAuth  : $CLAUDE_HOME_DIR

 Proximos pasos:

   # Correr los unit tests del provider cuando quieras:
   source .venv/bin/activate
   python -m pytest engine/llm/tests/ -v

   # Levantar el stack con docker compose (rebuild necesario para que
   # la imagen del engine instale Node + claude CLI adentro):
   docker compose build engine
   ./scripts/run_local.sh

   # Smoke test del provider DENTRO del container:
   docker exec adlc-engine python -c "
   from llm.registry import get_provider
   from llm.base import Message
   p = get_provider({'provider': 'claude_cli', 'model_default': 'claude-haiku-4-5'})
   r = p.complete(messages=[Message(role='user', content='hola en una palabra')])
   print('content:', repr(r.content), 'cost:', r.cost_usd)
   "
=================================================================
EOF
