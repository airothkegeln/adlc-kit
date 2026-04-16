"""
Tools stub para tests del runtime.

Estas tools NO hablan con sistemas externos. Sirven para validar el
agent runtime end-to-end sin depender de credenciales (GitHub, Notion,
Linear) o conectividad. Las tools reales viven en otros archivos y
hacen lazy import de SDKs externos.
"""

from __future__ import annotations

from typing import Any

from ..base import Tool


class EchoTool(Tool):
    """Devuelve los argumentos tal cual los recibe. Util para validar wiring."""

    name = "echo"
    description = "Devuelve los argumentos sin modificarlos. Util para tests."
    input_schema = {
        "type": "object",
        "properties": {
            "message": {"type": "string", "description": "Texto a hacer eco"},
        },
        "required": ["message"],
    }

    async def run(self, arguments: dict[str, Any]) -> Any:
        return {"echoed": arguments.get("message", "")}


class NoopSearchTool(Tool):
    """
    Stub de github_search / notion_search / linear_search.

    Devuelve resultados canned segun el query, asi un agente que la use
    puede ejecutar varias llamadas con queries distintas y obtener
    respuestas distintas (importante para testear loops multi-iter).
    """

    name = "noop_search"
    description = (
        "Busca en una base de conocimiento mockeada. "
        "Devuelve hasta 3 hits canned por query."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Texto a buscar"},
            "limit": {"type": "integer", "description": "Max resultados", "default": 3},
        },
        "required": ["query"],
    }

    # Mapping query → resultados canned. Las queries que no matchean
    # devuelven []. Modificable en tests via subclass o monkey-patch.
    canned_hits: dict[str, list[dict[str, str]]] = {
        "onboarding": [
            {
                "title": "Onboarding empresas — flujo actual",
                "url": "https://example.invalid/onboarding-empresas",
                "snippet": "Documento que describe el flujo actual de carga de identidad.",
            },
            {
                "title": "Tickets relacionados",
                "url": "https://example.invalid/tickets/onboarding",
                "snippet": "5 tickets abiertos sobre onboarding.",
            },
        ],
        "validacion identidad": [
            {
                "title": "Compliance: validacion de identidad CMF",
                "url": "https://example.invalid/cmf-id",
                "snippet": "Requisitos regulatorios CMF Chile.",
            },
        ],
    }

    async def run(self, arguments: dict[str, Any]) -> Any:
        query = (arguments.get("query") or "").lower()
        limit = int(arguments.get("limit") or 3)
        # Match laxo: si alguna key del canned_hits esta contenida en la query
        for key, hits in self.canned_hits.items():
            if key in query:
                return {"query": query, "hits": hits[:limit]}
        return {"query": query, "hits": []}
