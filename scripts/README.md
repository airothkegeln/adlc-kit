# scripts/ — utilidades operacionales

| Script | Para qué sirve | Costo |
|---|---|---|
| `bootstrap_ubuntu.sh` | Instala docker oficial + plugin compose + git + jq en Ubuntu/Debian | $0 |
| `run_local.sh` | Levanta el stack en tu laptop con Docker | $0 |
| `stop_local.sh` | Apaga el stack local | $0 |
| `launch_test_env.sh` | Crea EC2 t4g.small descartable en AWS | ~$0.02/h |
| `teardown_test_env.sh` | Borra todos los recursos de AWS por tag | $0 |
| `user_data.sh` | Cloud-init usado por launch_test_env.sh | — |

## Quickstart local (laptop, recomendado)

### Si tu host ya tiene Docker

```bash
git clone https://github.com/airothkegeln/adlc.git
cd adlc
export ANTHROPIC_API_KEY=sk-ant-...
./scripts/run_local.sh
```

### En un VM Ubuntu/Debian limpio (sin Docker)

```bash
# 1. Clonar el repo
git clone https://github.com/airothkegeln/adlc.git
cd adlc

# 2. Bootstrap: instala docker oficial + plugin compose + git + jq
./scripts/bootstrap_ubuntu.sh

# 3. Aplicar el grupo docker (sin re-loguear)
newgrp docker

# 4. Lanzar
export ANTHROPIC_API_KEY=sk-ant-...
./scripts/run_local.sh
```

> Si llamás a `./scripts/run_local.sh` directamente sin haber corrido el
> bootstrap, en Ubuntu/Debian te ofrece correrlo automáticamente.

### Sizing recomendado para el VM Ubuntu

| Recurso | Mínimo | Recomendado |
|---|---|---|
| RAM | 4 GB | 6 GB |
| vCPU | 2 | 4 |
| Disco | 15 GB | 25 GB |
| OS | Ubuntu 24.04 LTS Server | Ubuntu 24.04 LTS Server |
| Red | NAT con port-forward 8000 → host | NAT con port-forward 8000 → host |

### Apagar

```bash
./scripts/stop_local.sh              # preserva el volumen Postgres
./scripts/stop_local.sh --wipe       # borra todo, incluso datos
```

### Smoke test después del run_local

```bash
# 1. Healthcheck
curl http://localhost:8000/healthz

# 2. Lanzar un run (usa stub_executor por ahora)
curl -X POST http://localhost:8000/runs \
  -H 'content-type: application/json' \
  -d '{"prompt":"machbank onboarding","requester":"test@example.com"}'

# 3. Ver el historial (8 fases del stub_executor)
curl http://localhost:8000/runs/<run_id>/history | jq
```

### Troubleshooting local

| Síntoma | Causa probable | Fix |
|---|---|---|
| `docker: command not found` | Docker no instalado | Docker Desktop (macOS/Win) o `dnf install docker` (Linux) |
| `Cannot connect to the Docker daemon` | Daemon no corriendo | Abrir Docker Desktop / `sudo systemctl start docker` |
| `permission denied` en docker.sock | Usuario no en grupo docker | `sudo usermod -aG docker $USER` y re-loguearse |
| Engine no responde en /healthz | Postgres no terminó de migrar | `docker compose logs migrate` |
| Puerto 8000 ocupado | Otro servicio | Cambiar `ports` en `docker-compose.yml` |
| OOM-killer mata postgres | Poca RAM (<2GB libres) | Cerrar Chrome/IDE/etc, o subir RAM |

---

## Levantar un ambiente de prueba en AWS

Crea una EC2 t4g.small en AWS, le instala docker, clona el repo y arranca
el stack del engine. Solo para validar end-to-end. Cuando termines, mata
todo con el script de teardown.

### Costos

| Recurso | Costo /hora | Costo 4h | Costo 1 día |
|---|---|---|---|
| t4g.small (us-east-1) | $0.0168 | $0.07 | $0.40 |
| EBS gp3 20 GB | $0.0022 | $0.01 | $0.05 |
| **Total** | **$0.019/h** | **$0.08** | **$0.45** |

### Requisitos en tu laptop

- `aws` CLI configurada con credenciales que permitan EC2 + key pairs + SG
- `jq`
- `ssh` y `scp`
- Bash 4+ (macOS y Linux funcionan; Windows usa WSL)
- Tu Anthropic API key (`sk-ant-...`)

### Paso a paso

```bash
# 1. Clona el repo en tu laptop
git clone https://github.com/airothkegeln/adlc.git
cd adlc

# 2. Exporta tu API key (NUNCA la commitees)
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Lanza el ambiente
./scripts/launch_test_env.sh
```

El script tarda **3-5 minutos**. Al final imprime:

- IP pública de la EC2
- Comando SSH listo para copiar/pegar
- URL del API
- Comando `curl` de smoke test
- Recordatorio del comando de teardown

### Qué crea el script (todo tagged `Project=adlc-test-env`)

| Recurso | Detalle |
|---|---|
| Key pair `adlc-test-<timestamp>-key` | PEM guardado en `./adlc-test-<timestamp>-key.pem` con chmod 400 |
| Security group `adlc-test-<timestamp>-sg` | Inbound 22 + 8000, **solo desde tu IP pública actual** |
| EC2 t4g.small (Amazon Linux 2023 ARM) | Bootstrap automático con docker + git + clone del repo |
| EBS 20 GB gp3 | DeleteOnTermination=true |

### Verificar que funciona

```bash
# Healthcheck
curl http://<IP>:8000/healthz
# {"status":"ok"}

# Lanzar un run con stub_executor (sin LLM real todavía)
curl -X POST http://<IP>:8000/runs \
  -H 'content-type: application/json' \
  -d '{"prompt":"machbank onboarding documentos identidad","requester":"test@example.com"}'
# {"run_id":"run_abc123...","status":"pending",...}

# Ver el historial del project_state después de unos segundos
curl http://<IP>:8000/runs/run_abc123/history | jq
# Debería devolver 8 versiones (las 8 fases del stub_executor)
```

### Matar todo cuando termines

```bash
./scripts/teardown_test_env.sh
```

Esto borra **todos** los recursos tagged `Project=adlc-test-env`:
- Termina la(s) EC2
- Borra los Security Groups
- Borra los Key Pairs

Es **idempotente**: correrlo dos veces no rompe nada.

Para borrar también el archivo `.pem` local:

```bash
./scripts/teardown_test_env.sh --delete-pem
```

### Troubleshooting

**El healthcheck no responde después del launch.**
- SSH a la instancia: `ssh -i ./adlc-test-*.pem ec2-user@<IP>`
- Mira el log de bootstrap: `cat /var/log/adlc-bootstrap.log`
- Mira el estado del compose: `cd /opt/adlc && docker compose ps`
- Logs del engine: `docker compose logs engine | tail -50`

**El script falla en SSH.**
- Tu IP pública pudo haber cambiado entre que generaste el SG y ahora.
  Vuelve a correr el script (te creará otro ambiente con tu IP nueva)
  y matá el viejo con el teardown.

**Olvidé matar el ambiente y pasaron varios días.**
- Corre `./scripts/teardown_test_env.sh` desde cualquier laptop con tus
  credenciales. Encuentra todo por tag, no necesita el state local.

### Por qué no usamos RDS / SES / Secrets Manager todavía

Para validar que el backbone funciona end-to-end, Postgres en docker
dentro de la EC2 es suficiente y gratis. Cuando el ADLC pase de "validar
arquitectura" a "operar sobre datos reales del cliente", ahí migramos a:

- **RDS Postgres** — DB gestionada con backups, encryption at rest, multi-AZ
- **AWS Secrets Manager** — para `LLM_API_KEY` y demás credenciales
- **SES** — para los emails HITL con magic links

Eso ya está documentado en `config/adlc.config.example.yaml` y
`docs/architecture.md`.
