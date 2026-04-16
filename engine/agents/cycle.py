"""
Cycle config — lista canonica de phases del ciclo ADLC.

Define el ORDEN y la implementacion (real vs stub) de cada phase. El
cycle_executor consume esta config para iterar el ciclo end-to-end.

Estado actual del buildout (Fase 6):
  - discovery → real (agent_specs/discovery.yaml)
  - hypothesis → real (agent_specs/hypothesis.yaml) — HITL gate
  - mapping → real (agent_specs/mapping.yaml)
  - spec_dev → real (agent_specs/spec_dev.yaml)
  - architecture → real (agent_specs/architecture.yaml)
  - business → real (agent_specs/business.yaml)
  - coding → real (agent_specs/coding.yaml) — usa sandbox_run + DockerSandbox
  - validation → real (agent_specs/validation.yaml)
  TODOS los agentes del ciclo son ahora LLM reales.

A medida que escribimos los YAMLs de las phases siguientes, vamos
flipping `spec_path` de None a la ruta del YAML. NO requiere cambios
en el cycle_executor.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class PhaseConfig:
    """
    Una phase del ciclo ADLC.

    name: identificador canonico (`discovery`, `hypothesis`, etc.).
    phase: alias usado en el state_version.phase (puede ser distinto del name
           si queremos varios agentes en la misma "phase logica").
    agent_name: nombre del agente que ejecuta esta phase. Va al state_version.agent.
    spec_path: ruta relativa al agent_specs/ del YAML del agente. Si es None,
               usamos el stub_phase_executor en vez del runtime real.
    stub_output_keys: campos que el stub agrega al accumulated_state. Solo
                      relevante si spec_path es None.
    """
    name: str
    phase: str
    agent_name: str
    spec_path: str | None
    stub_output_keys: list[str] = field(default_factory=list)


# Orden canonico de las 8 phases del ciclo ADLC. NO reordenar sin justificar.
# Cuando escribamos los YAMLs de las phases siguientes, solo cambiamos
# `spec_path` de None a la ruta correspondiente.
CANONICAL_PHASES: list[PhaseConfig] = [
    PhaseConfig(
        name="discovery",
        phase="discovery",
        agent_name="discovery",
        spec_path="discovery.yaml",
        stub_output_keys=[],
    ),
    PhaseConfig(
        name="hypothesis",
        phase="hypothesis",
        agent_name="hypothesis",
        spec_path="hypothesis.yaml",
        stub_output_keys=["hypothesis", "success_criteria", "impact_score"],
    ),
    PhaseConfig(
        name="mapping",
        phase="mapping",
        agent_name="mapping",
        spec_path="mapping.yaml",
        stub_output_keys=["human_agent_map", "scope_boundaries"],
    ),
    PhaseConfig(
        name="stack_contract",
        phase="stack_contract",
        agent_name="stack_contract",
        spec_path="stack_contract.yaml",
        stub_output_keys=["stack_contract"],
    ),
    PhaseConfig(
        name="spec_dev",
        phase="spec",
        agent_name="spec_dev",
        spec_path="spec_dev.yaml",
        stub_output_keys=["feature_intent", "capability_matrix", "acceptance_criteria"],
    ),
    PhaseConfig(
        name="architecture",
        phase="architecture",
        agent_name="architecture",
        spec_path="architecture.yaml",
        stub_output_keys=["tech_stack", "patterns", "infra_constraints"],
    ),
    PhaseConfig(
        name="business",
        phase="business",
        agent_name="business",
        spec_path="business.yaml",
        stub_output_keys=["business_case", "go_no_go", "eval_score"],
    ),
    PhaseConfig(
        name="coding",
        phase="coding",
        agent_name="coding",
        spec_path="coding.yaml",
        stub_output_keys=["files_modified", "unit_tests", "pr_reference"],
    ),
    PhaseConfig(
        name="validation",
        phase="validation",
        agent_name="validation",
        spec_path="validation.yaml",
        stub_output_keys=["test_results", "static_analysis", "deploy_status"],
    ),
    PhaseConfig(
        name="publish",
        phase="publish",
        agent_name="publish",
        spec_path="publish.yaml",
        stub_output_keys=["publish_status", "publish_details"],
    ),
]


def resolve_specs_root() -> Path:
    """
    Localiza el directorio agent_specs/. Hay dos layouts validos:
      - host (repo clonado):  engine/agents/cycle.py → ../../../agent_specs/
      - container Docker:     /app/agents/cycle.py  → /app/agent_specs/
        (compose monta ./agent_specs:/app/agent_specs:ro)
    """
    here = Path(__file__).resolve()
    # Calcular candidatos sin IndexError — parents puede ser corto en container
    max_parents = len(here.parents)
    candidates = []
    for n in (3, 2, 1):  # host=3, container=2, fallback=1
        if n < max_parents:
            candidates.append(here.parents[n] / "agent_specs")
    for c in candidates:
        if c.exists():
            return c
    # Si ninguno existe, devolvemos el primero como default y dejamos
    # que el spec_loader tire el error claro al intentar cargar.
    return candidates[0] if candidates else here.parent / "agent_specs"
