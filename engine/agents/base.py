"""
Agent Runtime — interfaces puras.

Define el contrato del runtime de agentes ADLC. Un agente es un proceso que:
  1. Recibe un fragmento del project_state como input.
  2. Ejecuta un loop de tool-use contra un LLM (via LLMProvider) usando
     solo las tools de su whitelist.
  3. Aplica budgets (cost cap, max iterations, timeout) y guardrails
     (required_outputs, forbidden_actions, validation rules).
  4. Devuelve un state_patch con los campos que va a mergear al project_state.

Las implementaciones concretas viven en:
  - engine/agents/spec_loader.py   ← carga AgentSpec desde YAML
  - engine/agents/runtime.py       ← run_agent() ejecuta el loop
  - engine/agents/tools/           ← Tool implementations (stubs + reales)

NO importar nada de proveedores LLM, storage o frameworks externos en este
archivo. Es la capa de contrato.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


# ----------------------------------------------------------------------
# AgentSpec — definicion declarativa cargada desde YAML
# ----------------------------------------------------------------------
@dataclass
class Guardrails:
    max_iterations: int = 10
    required_outputs: list[str] = field(default_factory=list)
    forbidden_actions: list[str] = field(default_factory=list)
    validation_rules: list[str] = field(default_factory=list)


@dataclass
class Budget:
    max_cost_usd: float = 1.0
    timeout_minutes: int = 10


@dataclass
class AgentSpec:
    name: str                       # ej: "discovery"
    phase: str                      # ej: "discovery" (puede coincidir o no con name)
    tier: str                       # "reasoning" | "fast"
    description: str
    model: str                      # override del model_default del provider
    max_tokens: int
    temperature: float
    system_prompt: str
    tools_whitelist: list[str]
    capability_matrix_llm: list[str]
    capability_matrix_deterministic: list[str]
    reads: list[str]
    writes: list[str]
    guardrails: Guardrails
    budget: Budget
    hitl_enabled: bool
    failure_modes: list[dict[str, str]]
    spec_version: str = ""          # commit SHA del YAML, lo setea el loader si esta disponible


# ----------------------------------------------------------------------
# Tool — interfaz para funcionalidades externalizables
# ----------------------------------------------------------------------
class Tool(ABC):
    """
    Una Tool es una funcion deterministica que el agente puede invocar
    via tool_use. Las Tool implementaciones son inyectables —
    test pueden registrar stubs, prod registra MCPs reales.

    Subclases declaran name, description, input_schema como class attrs
    y implementan run().
    """

    name: str
    description: str
    input_schema: dict[str, Any]

    @abstractmethod
    async def run(self, arguments: dict[str, Any]) -> Any:
        """
        Ejecuta la tool. Recibe los argumentos parseados del JSON del
        modelo. Devuelve cualquier objeto JSON-serializable que se va
        a inyectar como tool_result en el siguiente turn del loop.
        """
        ...


class ToolRegistry:
    """
    Registry de tools disponibles para los agentes. Las tools se
    registran al inicio del proceso (api/main.py) y se pasan al runtime
    como dependencia.
    """

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"Tool '{tool.name}' ya esta registrada")
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool:
        if name not in self._tools:
            raise KeyError(
                f"Tool '{name}' no esta registrada. Disponibles: {list(self._tools)}"
            )
        return self._tools[name]

    def filter(self, whitelist: list[str]) -> list[Tool]:
        """
        Devuelve las tools registradas cuyo nombre esta en la whitelist.
        Si una tool de la whitelist no esta registrada → KeyError.
        Esto es intencional: el agente NO debe arrancar si su whitelist
        referencia tools inexistentes.
        """
        return [self.get(name) for name in whitelist]

    def names(self) -> list[str]:
        return list(self._tools)


# ----------------------------------------------------------------------
# Runtime — input y output
# ----------------------------------------------------------------------
@dataclass
class AgentRunContext:
    """Contexto inyectado por el orquestador al ejecutar un agente."""

    run_id: str
    initial_state: dict[str, Any]   # fragmento del project_state que el agente lee
    requester: str = ""
    extra_context: dict[str, Any] = field(default_factory=dict)


# Statuses posibles del AgentResult
STATUS_COMPLETED = "completed"
STATUS_ITERATION_EXCEEDED = "iteration_exceeded"
STATUS_BUDGET_EXCEEDED = "budget_exceeded"
STATUS_GUARDRAIL_VIOLATION = "guardrail_violation"
STATUS_TOOL_ERROR = "tool_error"
STATUS_LLM_ERROR = "llm_error"


@dataclass
class TranscriptEntry:
    """Una entrada del transcript del loop. Util para debugging y observabilidad."""

    iteration: int
    role: str                          # "llm" | "tool" | "system"
    content: str
    tool_name: str | None = None
    tool_arguments: dict[str, Any] | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0


@dataclass
class AgentResult:
    """Resultado de un run de un agente."""

    status: str                        # ver STATUS_* constants
    state_patch: dict[str, Any]        # campos a mergear al project_state
    iterations_used: int
    total_tokens_in: int
    total_tokens_out: int
    total_cost_usd: float
    transcript: list[TranscriptEntry] = field(default_factory=list)
    error_message: str = ""

    @property
    def ok(self) -> bool:
        return self.status == STATUS_COMPLETED
