#!/bin/bash
# =============================================================================
# teardown_test_env.sh — Borra todos los recursos del ADLC test env
# =============================================================================
# Encuentra todo lo tagged Project=adlc-test-env y lo borra:
#   - EC2 instances (terminate)
#   - Security groups
#   - Key pairs
#
# Idempotente: correrlo dos veces no rompe nada.
#
# Uso:
#   ./scripts/teardown_test_env.sh
#
# Para borrar tambien el archivo .pem local:
#   ./scripts/teardown_test_env.sh --delete-pem
# =============================================================================

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
PROJECT_TAG="adlc-test-env"
DELETE_PEM=false

if [[ "${1:-}" == "--delete-pem" ]]; then
    DELETE_PEM=true
fi

echo "==> Region: $REGION"
echo "==> Buscando recursos tagged Project=$PROJECT_TAG"

# ------ EC2 instances ------
INSTANCE_IDS=$(aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=tag:Project,Values=${PROJECT_TAG}" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[*].Instances[*].InstanceId' \
    --output text || true)

if [[ -n "$INSTANCE_IDS" ]]; then
    echo "==> Terminando instancias: $INSTANCE_IDS"
    aws ec2 terminate-instances --region "$REGION" --instance-ids $INSTANCE_IDS >/dev/null
    echo "    Esperando termination..."
    aws ec2 wait instance-terminated --region "$REGION" --instance-ids $INSTANCE_IDS
    echo "    OK"
else
    echo "==> No hay instancias activas con ese tag"
fi

# ------ Security groups ------
SG_IDS=$(aws ec2 describe-security-groups \
    --region "$REGION" \
    --filters "Name=tag:Project,Values=${PROJECT_TAG}" \
    --query 'SecurityGroups[*].GroupId' \
    --output text || true)

if [[ -n "$SG_IDS" ]]; then
    for SG in $SG_IDS; do
        echo "==> Borrando SG $SG"
        # Reintenta hasta que la termination de instancia libere el SG
        for i in $(seq 1 12); do
            if aws ec2 delete-security-group --region "$REGION" --group-id "$SG" 2>&1; then
                break
            fi
            echo "    aun en uso, reintentando en 5s..."
            sleep 5
        done
    done
else
    echo "==> No hay security groups con ese tag"
fi

# ------ Key pairs ------
KEY_NAMES=$(aws ec2 describe-key-pairs \
    --region "$REGION" \
    --filters "Name=tag:Project,Values=${PROJECT_TAG}" \
    --query 'KeyPairs[*].KeyName' \
    --output text || true)

if [[ -n "$KEY_NAMES" ]]; then
    for KEY in $KEY_NAMES; do
        echo "==> Borrando key pair $KEY"
        aws ec2 delete-key-pair --region "$REGION" --key-name "$KEY"
        if $DELETE_PEM && [[ -f "./${KEY}.pem" ]]; then
            rm -f "./${KEY}.pem"
            echo "    PEM local borrado: ./${KEY}.pem"
        fi
    done
else
    echo "==> No hay key pairs con ese tag"
fi

echo
echo "================================================================="
echo " Teardown completo. Sin recursos pendientes con Project=${PROJECT_TAG}"
echo "================================================================="
if ! $DELETE_PEM; then
    echo " NOTA: los archivos .pem locales NO se borraron."
    echo "       Para borrarlos tambien: ./scripts/teardown_test_env.sh --delete-pem"
fi
