#!/bin/bash
# =============================================================================
# bootstrap_ubuntu.sh — Instala todos los prerrequisitos en Ubuntu/Debian
# =============================================================================
# Idempotente. Re-ejecutarlo no daña nada — solo agrega lo que falte.
#
# Lo que hace:
#   1. apt update + paquetes basicos (git, curl, jq, ca-certificates)
#   2. Agrega el repo oficial de Docker (NO usa docker.io del repo Ubuntu,
#      que es viejo y no incluye compose plugin v2)
#   3. Instala docker-ce + docker-compose-plugin
#   4. Habilita y arranca el daemon de docker
#   5. Agrega tu usuario al grupo docker
#   6. Te dice los pasos siguientes
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/airothkegeln/adlc/main/scripts/bootstrap_ubuntu.sh | bash
#   # o si ya clonaste el repo:
#   ./scripts/bootstrap_ubuntu.sh
#
# Requiere sudo (te lo va a pedir cuando lo necesite).
# =============================================================================

set -euo pipefail

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
# Sanity checks
# ----------------------------------------------------------------------
if [[ $EUID -eq 0 ]]; then
    warn "Estas corriendo como root. El script funciona pero el usuario que"
    warn "se agrega al grupo docker sera 'root', no util. Mejor correrlo"
    warn "como usuario normal con sudo cuando haga falta."
fi

if [[ ! -f /etc/os-release ]]; then
    fail "No encontre /etc/os-release. Este script es solo para Ubuntu/Debian."
fi

# shellcheck source=/dev/null
. /etc/os-release

if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" && "${ID_LIKE:-}" != *"debian"* ]]; then
    fail "Este script es para Ubuntu/Debian. Detectado: ${ID:-desconocido}"
fi

log "Sistema: ${PRETTY_NAME:-$ID $VERSION_ID}"
log "Arquitectura: $(dpkg --print-architecture)"

# ----------------------------------------------------------------------
# 1) Paquetes basicos
# ----------------------------------------------------------------------
log "Actualizando indices de apt"
sudo apt-get update -qq

log "Instalando paquetes basicos: git, curl, jq, ca-certificates, gnupg, lsb-release"
sudo apt-get install -y -qq \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    git \
    jq

ok "Paquetes basicos OK"

# ----------------------------------------------------------------------
# 2) Repo oficial de Docker
# ----------------------------------------------------------------------
DOCKER_KEYRING="/etc/apt/keyrings/docker.gpg"
DOCKER_LIST="/etc/apt/sources.list.d/docker.list"

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    log "Configurando repo oficial de Docker"
    sudo install -m 0755 -d /etc/apt/keyrings

    if [[ ! -f "$DOCKER_KEYRING" ]]; then
        # Detectar si es Ubuntu o Debian para usar el path correcto
        DOCKER_REPO_OS="$ID"
        if [[ "$ID_LIKE" == *"debian"* && "$ID" != "ubuntu" && "$ID" != "debian" ]]; then
            DOCKER_REPO_OS="debian"
        fi
        curl -fsSL "https://download.docker.com/linux/${DOCKER_REPO_OS}/gpg" \
            | sudo gpg --dearmor -o "$DOCKER_KEYRING"
        sudo chmod a+r "$DOCKER_KEYRING"

        ARCH="$(dpkg --print-architecture)"
        CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
        echo "deb [arch=${ARCH} signed-by=${DOCKER_KEYRING}] https://download.docker.com/linux/${DOCKER_REPO_OS} ${CODENAME} stable" \
            | sudo tee "$DOCKER_LIST" > /dev/null

        sudo apt-get update -qq
    fi

    log "Instalando docker-ce + docker-compose-plugin"
    sudo apt-get install -y -qq \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin
else
    ok "Docker + compose plugin ya instalados"
fi

# ----------------------------------------------------------------------
# 3) Habilitar y arrancar docker
# ----------------------------------------------------------------------
if ! systemctl is-active --quiet docker; then
    log "Habilitando y arrancando el daemon docker"
    sudo systemctl enable --now docker
else
    ok "Daemon docker ya corriendo"
fi

# ----------------------------------------------------------------------
# 4) Agregar usuario al grupo docker
# ----------------------------------------------------------------------
TARGET_USER="${SUDO_USER:-$USER}"

if id -nG "$TARGET_USER" | grep -qw docker; then
    ok "Usuario $TARGET_USER ya esta en el grupo docker"
    NEED_RELOGIN=false
else
    log "Agregando $TARGET_USER al grupo docker"
    sudo usermod -aG docker "$TARGET_USER"
    NEED_RELOGIN=true
fi

# ----------------------------------------------------------------------
# 5) Verificacion
# ----------------------------------------------------------------------
log "Versiones instaladas:"
echo -n "    git:            "; git --version
echo -n "    jq:             "; jq --version
echo -n "    docker:         "; docker --version
echo -n "    docker compose: "; docker compose version

# ----------------------------------------------------------------------
# 6) Resumen y proximos pasos
# ----------------------------------------------------------------------
cat <<EOF

=================================================================
${GREEN} Bootstrap Ubuntu completo${CLEAR}
=================================================================
EOF

if $NEED_RELOGIN; then
    cat <<EOF
${YELLOW} IMPORTANTE: agregue tu usuario al grupo docker, pero los grupos${CLEAR}
${YELLOW} se aplican al iniciar sesion. Para usar docker sin sudo necesitas:${CLEAR}

   Opcion A) Cerrar sesion y volver a entrar:
     exit
     # luego volver a hacer ssh / login

   Opcion B) Refrescar el grupo en esta sesion:
     newgrp docker

   Opcion C) Reiniciar el VM:
     sudo reboot

EOF
fi

cat <<EOF
 Proximo paso:

   # 1. Clonar el repo (si no lo hiciste todavia)
   git clone https://github.com/airothkegeln/adlc.git
   cd adlc

   # 2. Exportar tu API key
   export ANTHROPIC_API_KEY=sk-ant-...

   # 3. Levantar el stack
   ./scripts/run_local.sh

 Para apagarlo cuando termines:
   ./scripts/stop_local.sh
=================================================================
EOF
