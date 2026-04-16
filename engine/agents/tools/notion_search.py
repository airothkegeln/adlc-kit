"""
NotionSearchTool — busca pages/databases en Notion via API publica.

API: POST https://api.notion.com/v1/search
Headers: Authorization: Bearer <token>, Notion-Version: 2022-06-28

NO usa el SDK oficial `notion-client` para no agregar otra dependencia.
La API es simple y httpx alcanza.

Filtra por `object: page` para no inundar con databases. Devuelve titulo,
url, ultima edicion y un snippet del primer block (TODO: el snippet hoy
es solo el titulo, hace falta otro call a /v1/blocks para extraer texto).
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from ..base import Tool


NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"


class NotionSearchTool(Tool):
    name = "notion_search"
    description = (
        "Busca pages en un workspace de Notion. Devuelve hits con titulo, "
        "url y last_edited_time. NO devuelve el contenido completo del page."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Texto a buscar"},
            "page_size": {"type": "integer", "default": 5},
        },
        "required": ["query"],
    }

    def __init__(
        self,
        token: str,
        page_size_default: int = 5,
        timeout_seconds: float = 15.0,
        client: httpx.AsyncClient | None = None,
    ):
        if not token:
            raise ValueError("NotionSearchTool requiere un token no vacio")
        self._token = token
        self._page_size_default = page_size_default
        self._timeout = timeout_seconds
        self._client = client

    async def run(self, arguments: dict[str, Any]) -> Any:
        query = arguments.get("query")
        if not query or not isinstance(query, str):
            return {"error": "query es obligatorio y debe ser string"}

        page_size = int(arguments.get("page_size") or self._page_size_default)
        page_size = max(1, min(page_size, 100))

        headers = {
            "Authorization": f"Bearer {self._token}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        }
        body = {
            "query": query,
            "filter": {"value": "page", "property": "object"},
            "page_size": page_size,
        }

        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            resp = await client.post(
                f"{NOTION_API}/search",
                headers=headers,
                json=body,
            )
        finally:
            if self._client is None:
                await client.aclose()

        if resp.status_code == 401:
            return {"error": "notion auth fallo (401). Token invalido."}
        if resp.status_code != 200:
            return {
                "error": f"notion devolvio status {resp.status_code}",
                "body": resp.text[:500],
            }

        payload = _safe_json(resp)
        results = payload.get("results") or []

        hits = []
        for r in results[:page_size]:
            hits.append({
                "id": r.get("id", ""),
                "title": _extract_title(r),
                "url": r.get("url", ""),
                "last_edited_time": r.get("last_edited_time", ""),
            })

        return {"query": query, "hits": hits}


def _extract_title(page: dict[str, Any]) -> str:
    """
    Extrae el titulo de un Notion page object. El campo varia segun
    si es un page de database (`properties.Name.title`) o standalone
    (`properties.title.title`). Caemos a string vacio si no encontramos.
    """
    props = page.get("properties") or {}
    for key in ("Name", "title", "Title"):
        prop = props.get(key)
        if not isinstance(prop, dict):
            continue
        title_arr = prop.get("title") or []
        if title_arr and isinstance(title_arr, list):
            text = title_arr[0].get("plain_text") if isinstance(title_arr[0], dict) else None
            if text:
                return text
    return ""


def _safe_json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, ValueError):
        return {}
