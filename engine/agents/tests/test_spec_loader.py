"""
Tests del spec_loader. Validan que parse_agent_spec() acepta el formato
canonico y que load_agent_spec() funciona contra agent_specs/discovery.yaml.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ..spec_loader import SpecValidationError, load_agent_spec, parse_agent_spec


# Localizar agent_specs/discovery.yaml. Hay dos layouts validos:
#   - host (repo clonado): engine/agents/tests/ -> ../../../agent_specs/
#   - container Docker:    /app/agents/tests/  -> /app/agent_specs/
#     (compose monta ./agent_specs:/app/agent_specs:ro)
_HERE = Path(__file__).resolve()
_CANDIDATES = [
    _HERE.parents[3] / "agent_specs" / "discovery.yaml",  # host
    _HERE.parents[2] / "agent_specs" / "discovery.yaml",  # container
]
DISCOVERY_YAML = next((p for p in _CANDIDATES if p.exists()), _CANDIDATES[0])


def test_load_discovery_yaml_real():
    """El archivo del repo se carga sin errores y mapea bien los campos clave."""
    spec = load_agent_spec(DISCOVERY_YAML)
    assert spec.name == "discovery"
    assert spec.phase == "discovery"
    assert spec.tier == "reasoning"
    assert "github_search" in spec.tools_whitelist
    assert "gaps_identified" in spec.writes
    assert spec.guardrails.max_iterations == 8
    assert "gaps_identified" in spec.guardrails.required_outputs
    assert spec.budget.max_cost_usd == 2.00
    assert spec.hitl_enabled is False
    assert "Discovery Agent" in spec.system_prompt


def test_parse_inline_minimal():
    raw = {
        "agent": "test_agent",
        "phase": "discovery",
        "tier": "fast",
        "system_prompt": "haz algo",
    }
    spec = parse_agent_spec(raw)
    assert spec.name == "test_agent"
    assert spec.tier == "fast"
    assert spec.guardrails.max_iterations == 10  # default
    assert spec.budget.max_cost_usd == 1.0       # default
    assert spec.tools_whitelist == []
    assert spec.writes == []


def test_parse_missing_required_fails():
    with pytest.raises(SpecValidationError, match="agent"):
        parse_agent_spec({"phase": "x", "tier": "y", "system_prompt": "z"})


def test_load_nonexistent_path_fails():
    with pytest.raises(SpecValidationError, match="no existe"):
        load_agent_spec("/tmp/no_such_spec_file.yaml")


def test_validation_rules_accepts_str_and_dict():
    raw = {
        "agent": "x", "phase": "x", "tier": "fast", "system_prompt": "p",
        "guardrails": {
            "validation": [
                "regla string",
                {"rule": "regla dict"},
            ],
        },
    }
    spec = parse_agent_spec(raw)
    assert spec.guardrails.validation_rules == ["regla string", "regla dict"]


def test_validation_rules_malformed_raises():
    raw = {
        "agent": "x", "phase": "x", "tier": "fast", "system_prompt": "p",
        "guardrails": {"validation": [42]},
    }
    with pytest.raises(SpecValidationError, match="mal formada"):
        parse_agent_spec(raw)


def test_capability_matrix_split():
    raw = {
        "agent": "x", "phase": "x", "tier": "fast", "system_prompt": "p",
        "capability_matrix": {
            "llm": ["razonar", "decidir"],
            "deterministic": ["calcular"],
        },
    }
    spec = parse_agent_spec(raw)
    assert spec.capability_matrix_llm == ["razonar", "decidir"]
    assert spec.capability_matrix_deterministic == ["calcular"]
