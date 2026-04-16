"""
Loader de AgentSpec desde archivos YAML en agent_specs/.

El formato del YAML esta documentado en agent_specs/README.md y en el
ejemplo agent_specs/discovery.yaml. Este loader es el unico lugar que
sabe del formato concreto — el resto del runtime consume `AgentSpec`.

Si el formato del YAML evoluciona, se actualiza este loader y nada mas.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .base import AgentSpec, Budget, Guardrails


REQUIRED_TOP_LEVEL = ("agent", "phase", "tier", "system_prompt")


class SpecValidationError(ValueError):
    """Error de validacion al cargar un agent_spec YAML."""


def load_agent_spec(path: str | Path) -> AgentSpec:
    """
    Carga un YAML de agent_spec y devuelve un AgentSpec validado.

    Lanza SpecValidationError si el archivo no existe o le faltan campos
    obligatorios.
    """
    p = Path(path)
    if not p.exists():
        raise SpecValidationError(f"Agent spec no existe: {p}")

    raw = yaml.safe_load(p.read_text())
    if not isinstance(raw, dict):
        raise SpecValidationError(f"Agent spec {p} no es un dict YAML")

    return parse_agent_spec(raw)


def parse_agent_spec(raw: dict[str, Any]) -> AgentSpec:
    """
    Convierte un dict (ya parseado por yaml.safe_load) en un AgentSpec.
    Separado de load_agent_spec para que los tests puedan parsear specs
    inline sin tocar el filesystem.
    """
    missing = [k for k in REQUIRED_TOP_LEVEL if k not in raw]
    if missing:
        raise SpecValidationError(f"Faltan campos obligatorios: {missing}")

    capability_matrix = raw.get("capability_matrix") or {}
    if not isinstance(capability_matrix, dict):
        raise SpecValidationError("capability_matrix debe ser un dict con keys 'llm' y 'deterministic'")

    guardrails_raw = raw.get("guardrails") or {}
    if not isinstance(guardrails_raw, dict):
        raise SpecValidationError("guardrails debe ser un dict")

    validation_rules = []
    for rule in guardrails_raw.get("validation") or []:
        # validation puede ser una lista de strings o de dicts {rule: ...}
        if isinstance(rule, str):
            validation_rules.append(rule)
        elif isinstance(rule, dict) and "rule" in rule:
            validation_rules.append(str(rule["rule"]))
        else:
            raise SpecValidationError(f"Regla de validacion mal formada: {rule}")

    guardrails = Guardrails(
        max_iterations=int(guardrails_raw.get("max_iterations", 10)),
        required_outputs=list(guardrails_raw.get("required_outputs") or []),
        forbidden_actions=list(guardrails_raw.get("forbidden_actions") or []),
        validation_rules=validation_rules,
    )

    budget_raw = raw.get("budget") or {}
    if not isinstance(budget_raw, dict):
        raise SpecValidationError("budget debe ser un dict")

    budget = Budget(
        max_cost_usd=float(budget_raw.get("max_cost_usd", 1.0)),
        timeout_minutes=int(budget_raw.get("timeout_minutes", 10)),
    )

    hitl_raw = raw.get("hitl") or {}
    if not isinstance(hitl_raw, dict):
        raise SpecValidationError("hitl debe ser un dict")

    failure_modes_raw = raw.get("failure_modes") or []
    failure_modes: list[dict[str, str]] = []
    for fm in failure_modes_raw:
        if not isinstance(fm, dict):
            raise SpecValidationError(f"failure_mode mal formado: {fm}")
        failure_modes.append({str(k): str(v) for k, v in fm.items()})

    return AgentSpec(
        name=str(raw["agent"]),
        phase=str(raw["phase"]),
        tier=str(raw["tier"]),
        description=str(raw.get("description", "")).strip(),
        model=str(raw.get("model", "")),
        max_tokens=int(raw.get("max_tokens", 4096)),
        temperature=float(raw.get("temperature", 0.0)),
        system_prompt=str(raw["system_prompt"]).strip(),
        tools_whitelist=list(raw.get("tools_whitelist") or []),
        capability_matrix_llm=list(capability_matrix.get("llm") or []),
        capability_matrix_deterministic=list(capability_matrix.get("deterministic") or []),
        reads=list(raw.get("reads") or []),
        writes=list(raw.get("writes") or []),
        guardrails=guardrails,
        budget=budget,
        hitl_enabled=bool(hitl_raw.get("enabled", False)),
        failure_modes=failure_modes,
        spec_version="",
    )
