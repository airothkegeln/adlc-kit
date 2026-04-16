"""
Migration runner — sin dependencias mas alla de asyncpg.

Uso:
    python -m engine.storage.migrate
    # o desde dentro del container:
    python -m storage.migrate

Lee todos los archivos *.sql de engine/storage/migrations/ ordenados por
nombre, aplica los que faltan dentro de una transaccion, y registra cada
version aplicada en la tabla schema_migrations.

Idempotente: correrlo dos veces seguidas no aplica nada la segunda vez.

Para crear una migracion nueva:
    1. Crear engine/storage/migrations/00N_descripcion.sql
    2. Numerar secuencialmente (001, 002, 003, ...)
    3. Las migraciones NUNCA se editan despues de aplicadas en algun ambiente
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import asyncpg


MIGRATIONS_DIR = Path(__file__).parent / "migrations"


async def run_migrations(dsn: str) -> None:
    conn = await asyncpg.connect(dsn)
    try:
        # Bootstrap: tabla de versiones aplicadas
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )

        applied = {
            row["version"]
            for row in await conn.fetch("SELECT version FROM schema_migrations")
        }

        files = sorted(MIGRATIONS_DIR.glob("*.sql"))
        if not files:
            print(f"[migrate] No hay migraciones en {MIGRATIONS_DIR}")
            return

        new_count = 0
        for f in files:
            version = f.stem
            if version in applied:
                print(f"[migrate] {version} — ya aplicada")
                continue

            print(f"[migrate] {version} — aplicando...")
            sql = f.read_text()
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute(
                    "INSERT INTO schema_migrations (version) VALUES ($1)",
                    version,
                )
            new_count += 1
            print(f"[migrate] {version} — OK")

        print(
            f"[migrate] Listo. Total: {len(files)} migraciones, "
            f"{new_count} nuevas, {len(files) - new_count} ya existian."
        )
    finally:
        await conn.close()


def dsn_from_env() -> str:
    user = os.environ.get("POSTGRES_USER", "adlc")
    password = os.environ.get("POSTGRES_PASSWORD", "adlc_dev_password")
    host = os.environ.get("POSTGRES_HOST", "localhost")
    port = os.environ.get("POSTGRES_PORT", "5432")
    db = os.environ.get("POSTGRES_DB", "adlc")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def main() -> int:
    dsn = dsn_from_env()
    # No imprimir el password
    safe_dsn = dsn.replace(
        os.environ.get("POSTGRES_PASSWORD", "adlc_dev_password"), "***"
    )
    print(f"[migrate] Conectando a {safe_dsn}")
    try:
        asyncio.run(run_migrations(dsn))
        return 0
    except Exception as e:
        print(f"[migrate] ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
