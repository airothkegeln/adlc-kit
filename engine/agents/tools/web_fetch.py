"""
WebFetchTool — HTTP GET con allowlist de dominios y truncado de respuesta.

NO hace navegacion ni JS rendering. Es un GET simple. Sirve para leer
docs publicas (api.github.com/repos, raw.githubusercontent.com, MDN, etc.)
cuando el agente quiere bajar un README o un schema.

Allowlist: el dominio del URL (host) debe estar en `allowed_domains`. Si no,
la tool se niega — anti-SSRF basico. NO bloquea IPs internas explicitamente
todavia (TODO si esto va a prod multi-tenant); por ahora confiamos en la
allowlist como unico filtro.

Truncado: si la respuesta excede `max_response_kb`, se trunca y se marca
con un campo `truncated: true`.
"""

from __future__ import annotations

from urllib.parse import urlparse
from typing import Any

import httpx

from ..base import Tool


class WebFetchTool(Tool):
    name = "web_fetch"
    description = (
        "Hace HTTP GET a una URL del allowlist y devuelve el body como texto. "
        "Solo permite dominios pre-aprobados. La respuesta se trunca si excede "
        "el limite de KB."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "URL completa con esquema"},
        },
        "required": ["url"],
    }

    def __init__(
        self,
        allowed_domains: list[str],
        max_response_kb: int = 50,
        timeout_seconds: float = 15.0,
        client: httpx.AsyncClient | None = None,
    ):
        # Normalizamos a lowercase y sin puerto
        self._allowed = {d.lower().strip() for d in allowed_domains if d}
        self._max_bytes = max(1, max_response_kb) * 1024
        self._timeout = timeout_seconds
        self._client = client

    async def run(self, arguments: dict[str, Any]) -> Any:
        url = arguments.get("url")
        if not url or not isinstance(url, str):
            return {"error": "url es obligatorio y debe ser string"}

        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return {"error": f"esquema no soportado: {parsed.scheme}"}

        host = (parsed.hostname or "").lower()
        if not _host_in_allowlist(host, self._allowed):
            return {
                "error": "dominio no permitido",
                "host": host,
                "allowed_domains": sorted(self._allowed),
            }

        client = self._client or httpx.AsyncClient(
            timeout=self._timeout, follow_redirects=True
        )
        try:
            resp = await client.get(url)
        except httpx.HTTPError as e:
            return {"error": f"http error: {e}"}
        finally:
            if self._client is None:
                await client.aclose()

        body = resp.text or ""
        body_bytes = body.encode("utf-8", errors="replace")
        truncated = False
        if len(body_bytes) > self._max_bytes:
            body = body_bytes[: self._max_bytes].decode("utf-8", errors="replace")
            truncated = True

        return {
            "url": url,
            "status_code": resp.status_code,
            "content_type": resp.headers.get("content-type", ""),
            "body": body,
            "truncated": truncated,
            "bytes_total": len(body_bytes),
        }


def _host_in_allowlist(host: str, allowed: set[str]) -> bool:
    """
    Match exacto o por sufijo (subdominio). Ej: si allowed tiene
    'github.com', entonces 'api.github.com' tambien matchea.
    """
    if not host:
        return False
    if host in allowed:
        return True
    return any(host.endswith("." + d) for d in allowed)
