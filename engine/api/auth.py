"""
ADLC API auth — single shared API key via env var.

Single-tenant per instalación: no usuarios ni roles. La instalación tiene
**una** API key compartida que se setea en `ADLC_API_KEY`. La UI la guarda
en `localStorage` y la envía como `Authorization: Bearer <key>` en cada
request HTTP, y como query param `?api_key=<key>` en el WebSocket (los
WebSocket del browser no aceptan headers custom).

Si `ADLC_API_KEY` no está seteada → modo dev: la API queda abierta y se
loggea un WARNING ruidoso al startup. `/healthz` reporta `auth_required:
false` para que la UI no muestre el prompt de la key.

`/healthz` está exenta de auth para que health checks (load balancers,
docker healthcheck, scripts de smoke) no necesiten conocer la key.

Comparación constant-time con `hmac.compare_digest` para evitar timing
side-channels en la verificación.
"""

from __future__ import annotations

import hmac
import os
import sys

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


def get_api_key_from_env() -> str | None:
    """
    Lee ADLC_API_KEY del environment. Devuelve None si no está seteada o
    está vacía. El startup imprime WARNING en ese caso.
    """
    key = os.environ.get("ADLC_API_KEY", "").strip()
    return key or None


def verify_api_key(provided: str | None, expected: str) -> bool:
    """Constant-time comparison. False si provided es None o no matchea."""
    if not provided:
        return False
    return hmac.compare_digest(provided, expected)


class ApiKeyMiddleware(BaseHTTPMiddleware):
    """
    Middleware HTTP que exige `Authorization: Bearer <ADLC_API_KEY>` en
    todas las rutas excepto `/healthz`. Si `api_key` es None, pasa todo
    derecho (modo dev). Las rutas WebSocket se autentican adentro del
    endpoint usando `?api_key=` (este middleware solo ve HTTP).
    """

    EXEMPT_PATHS = frozenset({"/healthz"})

    def __init__(self, app, api_key: str | None):
        super().__init__(app)
        self.api_key = api_key

    async def dispatch(self, request: Request, call_next):
        if self.api_key is None:
            return await call_next(request)
        if request.url.path in self.EXEMPT_PATHS:
            return await call_next(request)

        auth = request.headers.get("authorization", "")
        if not auth.lower().startswith("bearer "):
            return JSONResponse(
                {"error": "missing bearer token", "detail": "Authorization: Bearer <ADLC_API_KEY> required"},
                status_code=401,
            )
        token = auth[7:].strip()
        if not verify_api_key(token, self.api_key):
            return JSONResponse(
                {"error": "invalid api key"},
                status_code=401,
            )
        return await call_next(request)


def warn_if_no_api_key(api_key: str | None) -> None:
    """Imprime WARNING en stderr si la API corre en modo dev abierto."""
    if api_key is None:
        print(
            "[api] WARNING: ADLC_API_KEY no está seteada — la API corre en modo "
            "dev ABIERTO sin autenticación. Cualquiera con acceso a la red "
            "puede crear runs, aprobar HITLs y abortar runs. NO usar en "
            "producción ni exponer a internet sin firewall.",
            file=sys.stderr,
        )
