"""
Eval — deterministic quality scoring for agent outputs.

Evalúa el state_patch de cada agente contra las reglas declaradas en su
AgentSpec (writes, guardrails.validation_rules, guardrails.required_outputs).

Checks son determinísticos (sin LLM). Cada check tiene peso y produce un
score 0-100 ponderado. El resultado incluye violations para debugging.

Extensión futura: LLM-as-judge para checks semánticos (ej. "la hipótesis
es realmente testeable"). Eso va en una fase posterior.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agents.base import AgentSpec


@dataclass
class EvalCheck:
    """Un check individual del eval."""
    name: str
    passed: bool
    detail: str
    weight: float = 1.0


@dataclass
class EvalResult:
    """Resultado agregado del eval de un agente."""
    agent: str
    phase: str
    score: float                              # 0-100
    checks: list[EvalCheck] = field(default_factory=list)
    violations: list[str] = field(default_factory=list)


def evaluate_agent_output(spec: AgentSpec, state_patch: dict[str, Any]) -> EvalResult:
    """
    Evalúa el state_patch de un agente contra su spec.
    Devuelve EvalResult con score 0-100 y breakdown de checks.
    """
    checks: list[EvalCheck] = []
    violations: list[str] = []

    # 1. Completeness: all writes fields present and non-empty
    checks.extend(_check_completeness(spec, state_patch, violations))

    # 2. Type & structure checks per agent
    checks.extend(_check_structure(spec, state_patch, violations))

    # 3. Range checks for numeric fields
    checks.extend(_check_ranges(spec, state_patch, violations))

    # 4. Depth checks (minimum richness of nested structures)
    checks.extend(_check_depth(spec, state_patch, violations))

    # Score: weighted average of passed checks
    score = _compute_score(checks)

    return EvalResult(
        agent=spec.name,
        phase=spec.phase,
        score=score,
        checks=checks,
        violations=violations,
    )


# ----------------------------------------------------------------------
# Check implementations
# ----------------------------------------------------------------------

def _check_completeness(
    spec: AgentSpec, patch: dict[str, Any], violations: list[str]
) -> list[EvalCheck]:
    """All declared writes fields present and non-empty."""
    checks = []
    for field_name in spec.writes:
        present = field_name in patch
        non_empty = present and _is_non_empty(patch[field_name])
        if not present:
            violations.append(f"Campo '{field_name}' ausente en output")
            checks.append(EvalCheck(
                name=f"completeness:{field_name}",
                passed=False,
                detail=f"Campo '{field_name}' no está en el state_patch",
                weight=2.0,
            ))
        elif not non_empty:
            violations.append(f"Campo '{field_name}' está vacío")
            checks.append(EvalCheck(
                name=f"completeness:{field_name}",
                passed=False,
                detail=f"Campo '{field_name}' presente pero vacío",
                weight=2.0,
            ))
        else:
            checks.append(EvalCheck(
                name=f"completeness:{field_name}",
                passed=True,
                detail=f"Campo '{field_name}' presente y no vacío",
                weight=2.0,
            ))
    return checks


def _check_structure(
    spec: AgentSpec, patch: dict[str, Any], violations: list[str]
) -> list[EvalCheck]:
    """Type and structure checks specific to each agent."""
    checks = []
    agent = spec.name

    # Per-agent structural expectations
    structure_rules = AGENT_STRUCTURE_RULES.get(agent, {})
    for field_name, expected_type in structure_rules.items():
        if field_name not in patch:
            continue  # completeness already handles missing
        val = patch[field_name]
        passed = _check_type(val, expected_type)
        detail = (
            f"'{field_name}' es {expected_type}" if passed
            else f"'{field_name}' debería ser {expected_type}, es {type(val).__name__}"
        )
        if not passed:
            violations.append(detail)
        checks.append(EvalCheck(
            name=f"structure:{field_name}",
            passed=passed,
            detail=detail,
            weight=1.5,
        ))

    # Sub-field checks (dict keys that must exist)
    subfield_rules = AGENT_SUBFIELD_RULES.get(agent, {})
    for field_name, required_keys in subfield_rules.items():
        if field_name not in patch or not isinstance(patch[field_name], dict):
            continue
        val = patch[field_name]
        for key in required_keys:
            present = key in val
            detail = (
                f"'{field_name}.{key}' presente" if present
                else f"'{field_name}.{key}' ausente"
            )
            if not present:
                violations.append(detail)
            checks.append(EvalCheck(
                name=f"subfield:{field_name}.{key}",
                passed=present,
                detail=detail,
                weight=1.0,
            ))

    return checks


def _check_ranges(
    spec: AgentSpec, patch: dict[str, Any], violations: list[str]
) -> list[EvalCheck]:
    """Numeric range checks for known scored fields."""
    checks = []
    agent = spec.name
    range_rules = AGENT_RANGE_RULES.get(agent, {})

    for path, (lo, hi) in range_rules.items():
        val = _get_nested(patch, path)
        if val is None:
            continue  # completeness handles missing
        try:
            num = float(val)
        except (TypeError, ValueError):
            violations.append(f"'{path}' no es numérico: {val!r}")
            checks.append(EvalCheck(
                name=f"range:{path}",
                passed=False,
                detail=f"'{path}' no es numérico",
                weight=1.5,
            ))
            continue

        in_range = lo <= num <= hi
        detail = (
            f"'{path}' = {num} (rango [{lo}, {hi}])" if in_range
            else f"'{path}' = {num} fuera de rango [{lo}, {hi}]"
        )
        if not in_range:
            violations.append(detail)
        checks.append(EvalCheck(
            name=f"range:{path}",
            passed=in_range,
            detail=detail,
            weight=1.5,
        ))

    return checks


def _check_depth(
    spec: AgentSpec, patch: dict[str, Any], violations: list[str]
) -> list[EvalCheck]:
    """Minimum richness of list/dict fields."""
    checks = []
    agent = spec.name
    depth_rules = AGENT_DEPTH_RULES.get(agent, {})

    for field_name, min_items in depth_rules.items():
        if field_name not in patch:
            continue
        val = patch[field_name]
        if isinstance(val, list):
            count = len(val)
        elif isinstance(val, dict):
            count = len(val)
        elif isinstance(val, str):
            # For string fields, count sentences/items (rough)
            count = len([s for s in val.split(".") if s.strip()]) if val.strip() else 0
        else:
            continue

        passed = count >= min_items
        detail = (
            f"'{field_name}' tiene {count} items (min {min_items})" if passed
            else f"'{field_name}' tiene {count} items, requiere min {min_items}"
        )
        if not passed:
            violations.append(detail)
        checks.append(EvalCheck(
            name=f"depth:{field_name}",
            passed=passed,
            detail=detail,
            weight=1.0,
        ))

    return checks


# ----------------------------------------------------------------------
# Per-agent rule tables
# ----------------------------------------------------------------------

# Expected types: "list", "dict", "str", "number"
AGENT_STRUCTURE_RULES: dict[str, dict[str, str]] = {
    "discovery": {
        "existing_docs": "list",
        "related_tickets": "list",
        "codebase_references": "list",
        "gaps_identified": "list",
    },
    "hypothesis": {
        "hypothesis": "str",
        "success_criteria": "list",
        "impact_score": "dict",
    },
    "mapping": {
        "human_agent_map": "dict",
        "scope_boundaries": "dict",
    },
    "spec_dev": {
        "feature_intent": "str",
        "capability_matrix": "dict",
        "acceptance_criteria": "list",
    },
    "architecture": {
        "tech_stack": "dict",
        "patterns": "list",
        "infra_constraints": "dict",
    },
    "business": {
        "business_case": "str",
        "go_no_go": "dict",
        "eval_score": "dict",
    },
    "coding": {
        "files_modified": "list",
        "unit_tests": "dict",
        "pr_reference": "str",
    },
    "validation": {
        "test_results": "dict",
        "static_analysis": "dict",
        "deploy_status": "str",
    },
}

# Required sub-keys within dict fields
AGENT_SUBFIELD_RULES: dict[str, dict[str, list[str]]] = {
    "hypothesis": {
        "impact_score": ["score", "justification"],
    },
    "mapping": {
        "human_agent_map": ["human", "agent"],
        "scope_boundaries": ["in_scope", "out_of_scope"],
    },
    "spec_dev": {
        "capability_matrix": ["llm", "tool", "deterministic"],
    },
    "architecture": {
        "tech_stack": ["language", "framework"],
    },
    "business": {
        "go_no_go": ["decision", "reasons"],
        "eval_score": ["total", "breakdown"],
    },
    "coding": {
        "unit_tests": ["exit_code"],
    },
    "validation": {
        "test_results": ["exit_code", "passed_count"],
        "static_analysis": ["status"],
    },
}

# Numeric range checks: "field.subfield" -> (min, max)
AGENT_RANGE_RULES: dict[str, dict[str, tuple[float, float]]] = {
    "hypothesis": {
        "impact_score.score": (1, 10),
    },
    "business": {
        "eval_score.total": (0, 100),
        "eval_score.breakdown.impact": (0, 25),
        "eval_score.breakdown.risk": (0, 25),
        "eval_score.breakdown.cost": (0, 25),
        "eval_score.breakdown.fit": (0, 25),
    },
}

# Minimum items in list/dict fields
AGENT_DEPTH_RULES: dict[str, dict[str, int]] = {
    "discovery": {
        "gaps_identified": 1,
    },
    "hypothesis": {
        "success_criteria": 2,
    },
    "mapping": {
        "human_agent_map": 2,  # needs both 'human' and 'agent' keys
    },
    "spec_dev": {
        "acceptance_criteria": 3,
        "capability_matrix": 3,  # 3 keys: llm, tool, deterministic
    },
    "architecture": {
        "patterns": 1,
    },
    "business": {
        "go_no_go": 2,  # decision + reasons
    },
}

# Allowed enum values for categorical fields
AGENT_ENUM_RULES: dict[str, dict[str, list[str]]] = {
    "business": {
        "go_no_go.decision": ["go", "no_go", "needs_more_context"],
    },
    "validation": {
        "deploy_status": ["ready", "blocked", "blocked_coverage", "failed"],
    },
}


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------

def _is_non_empty(val: Any) -> bool:
    if val is None:
        return False
    if isinstance(val, str):
        return bool(val.strip())
    if isinstance(val, (list, dict)):
        return len(val) > 0
    return True  # numbers, booleans are non-empty


def _check_type(val: Any, expected: str) -> bool:
    type_map = {
        "list": list,
        "dict": dict,
        "str": str,
        "number": (int, float),
    }
    return isinstance(val, type_map.get(expected, object))


def _get_nested(d: dict, path: str) -> Any:
    """Get a value from a nested dict using dot-separated path."""
    parts = path.split(".")
    current = d
    for part in parts:
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _compute_score(checks: list[EvalCheck]) -> float:
    """Weighted average of check results, 0-100."""
    if not checks:
        return 100.0  # no checks = trivially perfect
    total_weight = sum(c.weight for c in checks)
    if total_weight == 0:
        return 100.0
    earned = sum(c.weight for c in checks if c.passed)
    return round(earned / total_weight * 100, 2)
