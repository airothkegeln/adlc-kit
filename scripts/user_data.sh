#!/bin/bash
# =============================================================================
# user_data.sh — bootstrap de la EC2 de prueba ADLC
# =============================================================================
# Se ejecuta como root via cloud-init en el primer arranque de la instancia.
# NO debe contener secretos: queda en /var/log/cloud-init-output.log.
#
# Tareas:
#   1. Instalar docker + plugin compose + git
#   2. Habilitar y arrancar docker
#   3. Agregar usuario ec2-user al grupo docker
#   4. Clonar el repo ADLC en /opt/adlc
#   5. Crear .env placeholder (la API key se inyecta despues por SSH)
#
# El script de launch hace SSH despues para inyectar la API key y arrancar
# `docker compose up -d`.
# =============================================================================

set -euo pipefail

LOG=/var/log/adlc-bootstrap.log
exec > >(tee -a "$LOG") 2>&1

echo "[adlc-bootstrap] $(date) — inicio"

# --- Updates basicos ---
dnf update -y

# --- Docker ---
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user

# --- Docker compose plugin (no viene por default en AL2023) ---
mkdir -p /usr/libexec/docker/cli-plugins
COMPOSE_VERSION="v2.29.7"
ARCH=$(uname -m)
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH}" \
    -o /usr/libexec/docker/cli-plugins/docker-compose
chmod +x /usr/libexec/docker/cli-plugins/docker-compose
docker compose version

# --- Clonar el repo ADLC ---
cd /opt
git clone https://github.com/airothkegeln/adlc.git
chown -R ec2-user:ec2-user /opt/adlc
cd /opt/adlc

# --- Preparar configs (sin secretos) ---
sudo -u ec2-user cp .env.example .env
sudo -u ec2-user cp config/adlc.config.example.yaml config/adlc.config.yaml

# Postgres password aleatorio (no queda en logs si no lo imprimimos)
PG_PASS=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
sudo -u ec2-user sed -i "s/adlc_dev_password/${PG_PASS}/g" .env
sudo -u ec2-user sed -i "s/adlc_dev_password/${PG_PASS}/g" config/adlc.config.yaml

# Marcar bootstrap como listo (el script de launch lo polea via SSH)
touch /opt/adlc/.bootstrap_ready
chown ec2-user:ec2-user /opt/adlc/.bootstrap_ready

echo "[adlc-bootstrap] $(date) — terminado OK"
