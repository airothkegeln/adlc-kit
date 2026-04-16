"""
Tests de gates.py — validaciones deterministicas post-phase.

No requieren LLM ni DB. Validan que los gates atrapan las violaciones
concretas que motivaron su existencia (drift de stack tras spec_dev y
architecture).
"""

from __future__ import annotations

from ..gates import (
    GATE_REGISTRY,
    gate_post_architecture,
    gate_post_coding,
    gate_post_spec_dev,
    get_gate,
)


# ----------------------------------------------------------------------
# gate_post_architecture
# ----------------------------------------------------------------------
def test_architecture_gate_passes_when_stack_matches():
    state = {
        "stack_contract": {
            "language": "typescript",
            "framework": "fastify",
            "source": "user_declared",
            "ambiguous": False,
        },
        "tech_stack": {
            "language": "typescript",
            "framework": "fastify",
            "libs": ["vitest", "tsx"],
        },
    }
    result = gate_post_architecture(state)
    assert result.passed
    assert result.violations == []


def test_architecture_gate_fails_when_language_mismatches():
    state = {
        "stack_contract": {
            "language": "typescript",
            "framework": "fastify",
            "source": "user_declared",
            "ambiguous": False,
        },
        "tech_stack": {
            "language": "python",
            "framework": "fastapi",
        },
    }
    result = gate_post_architecture(state)
    assert not result.passed
    assert any("language" in v for v in result.violations)
    assert "typescript" in result.retry_hint.lower()
    assert "fastify" in result.retry_hint.lower()


def test_architecture_gate_fails_on_forbidden_lib():
    state = {
        "stack_contract": {
            "language": "typescript",
            "framework": "fastify",
            "libs_forbidden": ["express"],
            "source": "user_declared",
            "ambiguous": False,
        },
        "tech_stack": {
            "language": "typescript",
            "framework": "fastify",
            "libs": ["express", "vitest"],
        },
    }
    result = gate_post_architecture(state)
    assert not result.passed
    assert any("express" in v for v in result.violations)


def test_architecture_gate_passes_when_no_contract():
    state = {"tech_stack": {"language": "python"}}
    result = gate_post_architecture(state)
    assert result.passed


def test_architecture_gate_fails_when_tech_stack_missing():
    state = {
        "stack_contract": {
            "language": "typescript",
            "framework": "fastify",
            "source": "user_declared",
            "ambiguous": False,
        },
    }
    result = gate_post_architecture(state)
    assert not result.passed


def test_architecture_gate_is_case_insensitive():
    state = {
        "stack_contract": {
            "language": "TypeScript",
            "framework": "Fastify",
            "source": "user_declared",
            "ambiguous": False,
        },
        "tech_stack": {
            "language": "typescript",
            "framework": "fastify",
        },
    }
    assert gate_post_architecture(state).passed


# ----------------------------------------------------------------------
# gate_post_spec_dev
# ----------------------------------------------------------------------
def test_spec_dev_gate_catches_pytest_when_contract_is_ts():
    state = {
        "stack_contract": {
            "language": "typescript",
            "framework": "fastify",
            "source": "user_declared",
            "ambiguous": False,
        },
        "feature_intent": "Endpoint con tests pytest parametrizados",
        "acceptance_criteria": [
            {"criterion": "endpoint retorna 200", "metric": "pytest test"},
        ],
    }
    result = gate_post_spec_dev(state)
    assert not result.passed
    assert any("pytest" in v.lower() for v in result.violations)


def test_spec_dev_gate_catches_vitest_when_contract_is_python():
    state = {
        "stack_contract": {
            "language": "python",
            "framework": "fastapi",
            "source": "user_declared",
            "ambiguous": False,
        },
        "feature_intent": "API con vitest test suite",
        "acceptance_criteria": [],
    }
    result = gate_post_spec_dev(state)
    assert not result.passed


def test_spec_dev_gate_passes_when_consistent():
    state = {
        "stack_contract": {
            "language": "typescript",
            "framework": "fastify",
            "source": "user_declared",
            "ambiguous": False,
        },
        "feature_intent": "Endpoint Fastify validado con Vitest",
        "acceptance_criteria": [
            {"criterion": "endpoint retorna 200", "metric": "vitest run"},
        ],
    }
    assert gate_post_spec_dev(state).passed


def test_spec_dev_gate_catches_forbidden_lib_in_criteria():
    state = {
        "stack_contract": {
            "language": "typescript",
            "framework": "fastify",
            "libs_forbidden": ["express"],
            "source": "user_declared",
            "ambiguous": False,
        },
        "feature_intent": "Usamos express para rutas",
        "acceptance_criteria": [],
    }
    result = gate_post_spec_dev(state)
    assert not result.passed


# ----------------------------------------------------------------------
# gate_post_coding
# ----------------------------------------------------------------------
def test_coding_gate_fails_when_python_files_on_ts_contract():
    state = {
        "stack_contract": {
            "language": "typescript",
            "framework": "fastify",
            "source": "user_declared",
            "ambiguous": False,
        },
        "files_modified": ["main.py", "requirements.txt"],
    }
    result = gate_post_coding(state)
    assert not result.passed


def test_coding_gate_passes_when_ts_files_on_ts_contract():
    state = {
        "stack_contract": {
            "language": "typescript",
            "framework": "fastify",
            "source": "user_declared",
            "ambiguous": False,
        },
        "files_modified": ["src/index.ts", "package.json", "tsconfig.json", "README.md"],
    }
    assert gate_post_coding(state).passed


def test_coding_gate_fails_when_no_readme():
    state = {
        "stack_contract": {
            "language": "typescript",
            "framework": "fastify",
            "source": "user_declared",
            "ambiguous": False,
        },
        "files_modified": ["src/index.ts", "package.json"],
    }
    result = gate_post_coding(state)
    assert not result.passed
    assert any("readme" in v.lower() for v in result.violations)


def test_coding_gate_accepts_readme_in_subfolder():
    state = {
        "stack_contract": {
            "language": "typescript",
            "framework": "fastify",
            "source": "user_declared",
            "ambiguous": False,
        },
        "files_modified": [
            "src/index.ts",
            "package.json",
            "machbank-onboarding-api/README.md",
        ],
    }
    assert gate_post_coding(state).passed


def test_coding_gate_accepts_readme_without_contract():
    # Sin stack_contract, igual exige README.
    state = {"files_modified": ["src/main.py"]}
    result = gate_post_coding(state)
    assert not result.passed
    assert any("readme" in v.lower() for v in result.violations)


def test_coding_gate_fails_when_no_py_on_python_contract():
    state = {
        "stack_contract": {
            "language": "python",
            "framework": "fastapi",
            "source": "user_declared",
            "ambiguous": False,
        },
        "files_modified": ["src/index.ts"],
    }
    result = gate_post_coding(state)
    assert not result.passed


# ----------------------------------------------------------------------
# Registry
# ----------------------------------------------------------------------
def test_registry_has_expected_phases():
    assert "spec" in GATE_REGISTRY
    assert "architecture" in GATE_REGISTRY
    assert "coding" in GATE_REGISTRY


def test_get_gate_returns_none_for_unknown_phase():
    assert get_gate("nonexistent") is None
