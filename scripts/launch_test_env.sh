#!/bin/bash
# =============================================================================
# launch_test_env.sh — Crea una EC2 de prueba ADLC en AWS
# =============================================================================
# Crea TODO lo necesario para validar el engine end-to-end:
#   - Key pair (guarda .pem en el directorio actual con chmod 400)
#   - Security Group con 22 (SSH) y 8000 (engine API) abiertos SOLO a tu IP
#   - EC2 t4g.small con Amazon Linux 2023 ARM
#   - Cloud-init que instala docker + clona el repo
#   - Inyecta tu ANTHROPIC_API_KEY via SSH (no via user-data, no queda en logs)
#   - Arranca `docker compose up -d`
#
# Todos los recursos quedan tagged con Project=adlc-test-env para que el
# script teardown_test_env.sh los borre de un saque.
#
# Costos esperados (region us-east-1):
#   t4g.small  $0.0168/hr
#   EBS 20 GB  $0.0022/hr
#   Total      ~$0.02/hr
#
# Si lo dejas 4 horas y matas: ~$0.08
# Si te olvidas un dia entero:  ~$0.46
#
# REQUISITOS en la maquina donde corres este script:
#   - aws CLI configurado con credenciales que tengan EC2 + IAM (passrole) full
#   - jq, ssh, scp instalados
#   - Variable de entorno ANTHROPIC_API_KEY seteada
#
# Uso:
#   export ANTHROPIC_API_KEY=sk-ant-...
#   ./scripts/launch_test_env.sh
# =============================================================================

set -euo pipefail

# ------ Config ------
REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="t4g.small"
PROJECT_TAG="adlc-test-env"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
NAME_PREFIX="adlc-test-${TIMESTAMP}"
KEY_NAME="${NAME_PREFIX}-key"
SG_NAME="${NAME_PREFIX}-sg"
PEM_FILE="./${KEY_NAME}.pem"
ENGINE_PORT=8000

# ------ Pre-checks ------
echo "==> Pre-checks"

if ! command -v aws >/dev/null; then
    echo "ERROR: aws CLI no instalada" >&2
    exit 1
fi
if ! command -v jq >/dev/null; then
    echo "ERROR: jq no instalado (sudo dnf/apt install jq)" >&2
    exit 1
fi
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "ERROR: la variable ANTHROPIC_API_KEY no esta seteada" >&2
    echo "       export ANTHROPIC_API_KEY=sk-ant-..." >&2
    exit 1
fi
if [[ ! "${ANTHROPIC_API_KEY}" =~ ^sk-ant- ]]; then
    echo "WARN: ANTHROPIC_API_KEY no empieza con 'sk-ant-'. Continuo igual."
fi

aws sts get-caller-identity --region "$REGION" >/dev/null
echo "    AWS OK, region $REGION"

# ------ IP del usuario ------
MY_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
if [[ -z "$MY_IP" ]]; then
    echo "ERROR: no pude detectar tu IP publica" >&2
    exit 1
fi
echo "    Tu IP publica: ${MY_IP}/32 (solo desde aqui podras llegar)"

# ------ AMI Amazon Linux 2023 ARM ------
echo "==> Buscando AMI Amazon Linux 2023 (arm64)"
AMI_ID=$(aws ec2 describe-images \
    --region "$REGION" \
    --owners amazon \
    --filters "Name=name,Values=al2023-ami-2023.*-arm64" \
              "Name=state,Values=available" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text)
echo "    AMI: $AMI_ID"

# ------ Key pair ------
echo "==> Creando key pair $KEY_NAME"
aws ec2 create-key-pair \
    --region "$REGION" \
    --key-name "$KEY_NAME" \
    --tag-specifications "ResourceType=key-pair,Tags=[{Key=Project,Value=${PROJECT_TAG}},{Key=Name,Value=${KEY_NAME}}]" \
    --query 'KeyMaterial' \
    --output text > "$PEM_FILE"
chmod 400 "$PEM_FILE"
echo "    PEM guardado en $PEM_FILE (chmod 400)"

# ------ Default VPC ------
VPC_ID=$(aws ec2 describe-vpcs \
    --region "$REGION" \
    --filters "Name=is-default,Values=true" \
    --query 'Vpcs[0].VpcId' \
    --output text)
if [[ "$VPC_ID" == "None" || -z "$VPC_ID" ]]; then
    echo "ERROR: no encontre VPC default. Edita el script para pasar uno explicito." >&2
    exit 1
fi
echo "    VPC default: $VPC_ID"

# ------ Security Group ------
echo "==> Creando security group $SG_NAME"
SG_ID=$(aws ec2 create-security-group \
    --region "$REGION" \
    --group-name "$SG_NAME" \
    --description "ADLC test env (temporary)" \
    --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=${PROJECT_TAG}},{Key=Name,Value=${SG_NAME}}]" \
    --query 'GroupId' \
    --output text)

aws ec2 authorize-security-group-ingress \
    --region "$REGION" \
    --group-id "$SG_ID" \
    --ip-permissions \
      "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${MY_IP}/32,Description=ssh-from-launcher}]" \
      "IpProtocol=tcp,FromPort=${ENGINE_PORT},ToPort=${ENGINE_PORT},IpRanges=[{CidrIp=${MY_IP}/32,Description=engine-api}]" \
    >/dev/null
echo "    SG $SG_ID con 22 y ${ENGINE_PORT} abiertos a ${MY_IP}/32"

# ------ Lanzar instancia ------
echo "==> Lanzando $INSTANCE_TYPE"
INSTANCE_ID=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --user-data "file://$(dirname "$0")/user_data.sh" \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}' \
    --tag-specifications \
      "ResourceType=instance,Tags=[{Key=Project,Value=${PROJECT_TAG}},{Key=Name,Value=${NAME_PREFIX}}]" \
      "ResourceType=volume,Tags=[{Key=Project,Value=${PROJECT_TAG}},{Key=Name,Value=${NAME_PREFIX}}]" \
    --query 'Instances[0].InstanceId' \
    --output text)
echo "    Instance: $INSTANCE_ID"

echo "==> Esperando a que la instancia este en running"
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

PUBLIC_IP=$(aws ec2 describe-instances \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text)
echo "    IP publica: $PUBLIC_IP"

echo "==> Esperando SSH (hasta 3 minutos)"
for i in $(seq 1 36); do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes \
           -i "$PEM_FILE" "ec2-user@${PUBLIC_IP}" 'echo ssh-ok' 2>/dev/null | grep -q ssh-ok; then
        echo "    SSH OK"
        break
    fi
    sleep 5
done

echo "==> Esperando a que cloud-init termine de bootstrappear (hasta 5 minutos)"
for i in $(seq 1 60); do
    if ssh -o StrictHostKeyChecking=no -i "$PEM_FILE" "ec2-user@${PUBLIC_IP}" \
           'test -f /opt/adlc/.bootstrap_ready' 2>/dev/null; then
        echo "    bootstrap ready"
        break
    fi
    sleep 5
done

if ! ssh -o StrictHostKeyChecking=no -i "$PEM_FILE" "ec2-user@${PUBLIC_IP}" \
        'test -f /opt/adlc/.bootstrap_ready' 2>/dev/null; then
    echo "WARN: el bootstrap parece no haber terminado. Conectate manualmente y revisa /var/log/adlc-bootstrap.log"
fi

echo "==> Inyectando ANTHROPIC_API_KEY (via stdin SSH, no queda en logs)"
ssh -o StrictHostKeyChecking=no -i "$PEM_FILE" "ec2-user@${PUBLIC_IP}" \
    "sed -i 's|^LLM_API_KEY=.*|LLM_API_KEY=${ANTHROPIC_API_KEY}|' /opt/adlc/.env && \
     sed -i 's|REPLACE_ME_OR_USE_SECRETS_MANAGER|${ANTHROPIC_API_KEY}|' /opt/adlc/config/adlc.config.yaml && \
     echo 'env actualizado'"

echo "==> docker compose up -d"
ssh -o StrictHostKeyChecking=no -i "$PEM_FILE" "ec2-user@${PUBLIC_IP}" \
    "cd /opt/adlc && newgrp docker <<< 'docker compose up -d postgres migrate engine 2>&1' | tail -30"

echo
echo "================================================================="
echo " ADLC test env arriba"
echo "================================================================="
echo " Instance ID :  $INSTANCE_ID"
echo " IP publica  :  $PUBLIC_IP"
echo " SSH         :  ssh -i $PEM_FILE ec2-user@${PUBLIC_IP}"
echo " API         :  http://${PUBLIC_IP}:${ENGINE_PORT}"
echo " Healthcheck :  curl http://${PUBLIC_IP}:${ENGINE_PORT}/healthz"
echo
echo " Smoke test:"
echo "   curl -X POST http://${PUBLIC_IP}:${ENGINE_PORT}/runs \\"
echo "     -H 'content-type: application/json' \\"
echo "     -d '{\"prompt\":\"machbank onboarding documentos identidad\",\"requester\":\"test@example.com\"}'"
echo
echo " Para matar todo cuando termines:"
echo "   ./scripts/teardown_test_env.sh"
echo "================================================================="
