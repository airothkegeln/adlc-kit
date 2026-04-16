"""
GithubSearchTool — busca codigo en repos de GitHub via la REST API.

API: GET https://api.github.com/search/code?q=<query>
Auth: PAT clasico en `Authorization: Bearer <token>`. Requiere scope `repo`
para repos privados, ningun scope para publicos.

Rate limits del search code (autenticado): 30 req/min. Es bajo — el agente
no debe spamear. La whitelist + max_iterations del runtime ya lo limitan.

Para reemplazar este token-based auth por GitHub App: implementar otra
tool en este mismo modulo y registrarla con un nombre alternativo
(`github_search_app`) o swap por config. La interfaz `Tool` no cambia.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from ..base import Tool


GITHUB_API = "https://api.github.com"


class GithubSearchTool(Tool):
    name = "github_search"
    description = (
        "Busca codigo en repositorios de GitHub. Devuelve hasta N hits con "
        "path, repo, snippet y url. Soporta query strings de la search API "
        "(ej. 'onboarding repo:owner/repo language:python')."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "Query string de la GitHub search API. Soporta filtros "
                    "como repo:, language:, path:, in:file."
                ),
            },
            "per_page": {
                "type": "integer",
                "description": "Cantidad de resultados (max 30)",
                "default": 5,
            },
        },
        "required": ["query"],
    }

    def __init__(
        self,
        token: str,
        per_page_default: int = 5,
        timeout_seconds: float = 15.0,
        client: httpx.AsyncClient | None = None,
    ):
        if not token:
            raise ValueError("GithubSearchTool requiere un token no vacio")
        self._token = token
        self._per_page_default = per_page_default
        self._timeout = timeout_seconds
        # Inyectable para tests con MockTransport
        self._client = client

    async def run(self, arguments: dict[str, Any]) -> Any:
        query = arguments.get("query")
        if not query or not isinstance(query, str):
            return {"error": "query es obligatorio y debe ser string"}

        per_page = int(arguments.get("per_page") or self._per_page_default)
        per_page = max(1, min(per_page, 30))

        headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        params = {"q": query, "per_page": per_page}

        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            resp = await client.get(
                f"{GITHUB_API}/search/code",
                headers=headers,
                params=params,
            )
        finally:
            if self._client is None:
                await client.aclose()

        if resp.status_code == 401:
            return {"error": "github auth fallo (401). Token invalido o expirado."}
        if resp.status_code == 403:
            return {
                "error": "github 403 (rate limit o permisos insuficientes)",
                "details": _safe_json(resp).get("message", ""),
            }
        if resp.status_code != 200:
            return {
                "error": f"github devolvio status {resp.status_code}",
                "body": resp.text[:500],
            }

        payload = _safe_json(resp)
        items = payload.get("items") or []

        hits = []
        for it in items[:per_page]:
            hits.append({
                "path": it.get("path", ""),
                "repo": (it.get("repository") or {}).get("full_name", ""),
                "url": it.get("html_url", ""),
                "score": it.get("score", 0.0),
            })

        return {
            "query": query,
            "total_count": payload.get("total_count", 0),
            "hits": hits,
        }


def _safe_json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, ValueError):
        return {}
