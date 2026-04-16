#!/bin/bash
# =============================================================================
# stop_local.sh — Apaga el stack ADLC local
# =============================================================================
# Por default preserva el volumen de Postgres (los runs y state_versions
# sobreviven entre reinicios).
#
# Uso:
#   ./scripts/stop_local.sh              # apaga, preserva datos
#   ./scripts/stop_local.sh --wipe       # apaga y borra el volumen Postgres
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ "${1:-}" == "--wipe" ]]; then
    echo "==> docker compose down -v  (BORRA volumen Postgres)"
    docker compose down -v
else
    echo "==> docker compose down  (preserva volumen Postgres)"
    echo "    Para borrar tambien los datos: ./scripts/stop_local.sh --wipe"
    docker compose down
fi

echo "==> OK"
