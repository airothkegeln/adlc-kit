"""
LinearSearchTool — busca issues en Linear via GraphQL.

API: POST https://api.linear.app/graphql
Auth: header `Authorization: <token>` (sin "Bearer", asi lo quiere Linear)

GraphQL query: filtramos issues por title que contenga la query (case
insensitive). Devolvemos id, identifier (ABC-123), title, url, state, team.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from ..base import Tool


LINEAR_API = "https://api.linear.app/graphql"

_SEARCH_QUERY = """
query SearchIssues($query: String!, $first: Int!) {
  issues(
    filter: { title: { containsIgnoreCase: $query } }
    first: $first
    orderBy: updatedAt
  ) {
    nodes {
      id
      identifier
      title
      url
      state { name }
      team { key name }
    }
  }
}
""".strip()


class LinearSearchTool(Tool):
    name = "linear_search"
    description = (
        "Busca issues en Linear cuyo titulo contenga la query (case insensitive). "
        "Devuelve hasta N issues con identifier, titulo, estado, url y team."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Texto a buscar en titulos"},
            "first": {"type": "integer", "default": 5},
        },
        "required": ["query"],
    }

    def __init__(
        self,
        token: str,
        first_default: int = 5,
        timeout_seconds: float = 15.0,
        client: httpx.AsyncClient | None = None,
    ):
        if not token:
            raise ValueError("LinearSearchTool requiere un token no vacio")
        self._token = token
        self._first_default = first_default
        self._timeout = timeout_seconds
        self._client = client

    async def run(self, arguments: dict[str, Any]) -> Any:
        query = arguments.get("query")
        if not query or not isinstance(query, str):
            return {"error": "query es obligatorio y debe ser string"}

        first = int(arguments.get("first") or self._first_default)
        first = max(1, min(first, 50))

        headers = {
            "Authorization": self._token,  # Linear NO usa "Bearer"
            "Content-Type": "application/json",
        }
        body = {
            "query": _SEARCH_QUERY,
            "variables": {"query": query, "first": first},
        }

        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            resp = await client.post(LINEAR_API, headers=headers, json=body)
        finally:
            if self._client is None:
                await client.aclose()

        if resp.status_code == 401:
            return {"error": "linear auth fallo (401). Token invalido."}
        if resp.status_code != 200:
            return {
                "error": f"linear devolvio status {resp.status_code}",
                "body": resp.text[:500],
            }

        payload = _safe_json(resp)
        if "errors" in payload and payload["errors"]:
            return {"error": "graphql errors", "details": payload["errors"][:3]}

        nodes = ((payload.get("data") or {}).get("issues") or {}).get("nodes") or []
        hits = []
        for n in nodes[:first]:
            hits.append({
                "id": n.get("id", ""),
                "identifier": n.get("identifier", ""),
                "title": n.get("title", ""),
                "url": n.get("url", ""),
                "state": (n.get("state") or {}).get("name", ""),
                "team": (n.get("team") or {}).get("key", ""),
            })

        return {"query": query, "hits": hits}


def _safe_json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, ValueError):
        return {}
