# =============================================================================
# ADLC Engine — imagen base Python 3.11
# =============================================================================
# Sirve para correr migraciones, el orquestador y el API. El comando default
# corre migraciones y queda esperando — el comando real lo override
# docker-compose por servicio.
# =============================================================================

FROM python:3.11-slim

WORKDIR /app

# Dependencias de sistema:
#   - build-essential / libpq-dev: para psycopg
#   - curl, ca-certificates, gnupg: para bajar Node desde NodeSource
#   - git: lo usa el orquestador para commitear project_state al repo target
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential libpq-dev \
        curl ca-certificates gnupg git \
    && rm -rf /var/lib/apt/lists/*

# Node 20 LTS + Claude CLI oficial (@anthropic-ai/claude-code).
# Necesario para el provider `claude_cli`, que shellea al binario `claude`
# usando las creds OAuth de la cuenta Claude Max del usuario (montadas como
# volumen ~/.claude:/root/.claude:ro desde el host en docker-compose.yml).
# Si tu provider activo es `anthropic` (API key), podes borrar este bloque.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code \
    && claude --version

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

# Default: corre migraciones. docker-compose override por servicio.
CMD ["python", "-m", "storage.migrate"]
