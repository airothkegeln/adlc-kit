"""
DisabledTool — placeholder cuando una tool no tiene credenciales o esta apagada.

Patron: el factory siempre registra una entrada para cada tool del catalogo,
incluso si las creds faltan. Si faltan, registra una DisabledTool envoltura
que devuelve un mensaje de error claro al ser invocada. Asi:

  - El agent runtime puede arrancar sin editar la spec (la whitelist no
    referencia un nombre que no existe en el registry).
  - Si el LLM intenta usar la tool, recibe el error como tool_result y
    puede adaptarse o seguir sin esa info.
  - El usuario puede correr el agente con creds parciales y ver que
    funciona y que no, sin trial-and-error de configuracion.
"""

from __future__ import annotations

from typing import Any

from ..base import Tool


class DisabledTool(Tool):
    """
    Tool que envuelve a una tool real cuyas credenciales o config faltan.

    Conserva el mismo `name`, `description`, `input_schema` que la tool real
    para que el LLM la vea identica en el system prompt — pero al ejecutarse
    devuelve un dict con `disabled: true` y la razon.
    """

    def __init__(self, name: str, description: str, reason: str,
                 input_schema: dict[str, Any] | None = None):
        self.name = name
        self.description = (
            f"{description}\n\n[DISABLED en este deploy: {reason}]"
        )
        self.input_schema = input_schema or {"type": "object"}
        self._reason = reason

    async def run(self, arguments: dict[str, Any]) -> Any:
        return {
            "disabled": True,
            "tool": self.name,
            "reason": self._reason,
            "message": (
                f"La tool '{self.name}' no esta disponible en este deploy "
                f"({self._reason}). Continua sin sus resultados."
            ),
        }
