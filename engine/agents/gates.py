"""
Gates — validadores deterministicos que corren DESPUES de una phase real
y verifican que el output de la phase respeta los constraints del
`stack_contract` (y, en el futuro, de otros contratos).

Por que deterministicos y no LLM:
  - Las validaciones son de igualdad / pertenencia de strings ("language ==
    stack_contract.language"). No requieren razonamiento.
  - Son baratos (0 tokens) y rapidos (<1ms).
  - Fallan de forma predecible, con un `retry_hint` textual que el
    cycle_executor inyecta al re-ejecutar la phase.

Convencion de la API:
  - Cada gate es una funcion `gate_<nombre>(accumulated_state) -> GateResult`.
  - GateResult.passed indica si la phase puede avanzar.
  - GateResult.retry_hint es el mensaje que se inyecta al state de la phase
    que se reintenta. El agente lo lee naturalmente porque el cycle_executor
    serializa el state completo en el initial_user_message.

Loop-back:
  - El cycle_executor mantiene un contador de retries por phase en el state
    (`_gate_retries.<phase>`). Si el gate falla y el contador < max, vuelve
    a ejecutar la phase. Al tercer fallo levanta CycleExecutionError para
    que el orchestrator marque el run como failed (o en el futuro: HITL).
"""

from __future__ import annotations

import io
import os
import tarfile
import tempfile
from dataclasses import dataclass, field
from typing import Any, Callable


# ----------------------------------------------------------------------
# Tipos
# ----------------------------------------------------------------------
@dataclass
class GateResult:
    passed: bool
    violations: list[str] = field(default_factory=list)
    retry_hint: str = ""

    @classmethod
    def ok(cls) -> "GateResult":
        return cls(passed=True)

    @classmethod
    def fail(cls, violations: list[str], retry_hint: str) -> "GateResult":
        return cls(passed=False, violations=list(violations), retry_hint=retry_hint)


Gate = Callable[[dict[str, Any]], GateResult]


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def _norm(value: Any) -> str:
    """Lowercase + strip para comparaciones tolerantes a casing."""
    return str(value or "").strip().lower()


_NEGATION_MARKERS = (
    "sin ", "no ", "not ", "never ", "without ", "prohibid", "forbidden",
    "ausencia", "absent", "absence", "evitar", "avoid", "cero ",
    "devuelve 0", "wc -l", "grep -", "|| exit", "&& exit",
    # JS/Python validation code patterns que listan libs para chequear ausencia
    "const forbidden", "forbidden=", "forbidden_", ".filter(",
    "found.length", "process.exit", "console.error",
)


def _is_only_negation_context(haystack: str, lib: str) -> bool:
    """True si TODAS las apariciones de `lib` en `haystack` están
    rodeadas de marcadores de negación (dentro de 80 chars antes)."""
    import re
    all_negated = True
    for m in re.finditer(re.escape(lib), haystack):
        window_start = max(0, m.start() - 80)
        before = haystack[window_start : m.start()].lower()
        if not any(marker in before for marker in _NEGATION_MARKERS):
            all_negated = False
            break
    return all_negated


def _get_stack_contract(state: dict[str, Any]) -> dict[str, Any] | None:
    sc = state.get("stack_contract")
    return sc if isinstance(sc, dict) else None


def _check_language_framework(
    phase_tech: dict[str, Any],
    contract: dict[str, Any],
    phase_name: str,
) -> list[str]:
    """
    Compara language / framework del output de una phase contra el contrato.
    Devuelve lista de violations (vacia si matchea).
    """
    violations: list[str] = []

    contract_lang = _norm(contract.get("language"))
    phase_lang = _norm(phase_tech.get("language"))
    # Match tolerante a versiones: "python" matchea "python 3.11" y viceversa.
    if contract_lang and phase_lang:
        if contract_lang not in phase_lang and phase_lang not in contract_lang:
            violations.append(
                f"{phase_name}.tech_stack.language='{phase_tech.get('language')}' "
                f"no coincide con stack_contract.language='{contract.get('language')}'"
            )

    contract_fw = _norm(contract.get("framework"))
    phase_fw = _norm(phase_tech.get("framework"))
    # Framework puede contener multiples palabras ("swiftui + uikit"). Damos
    # por valido el match si el framework del contrato es substring del framework
    # de la phase o viceversa.
    if contract_fw and phase_fw:
        if contract_fw not in phase_fw and phase_fw not in contract_fw:
            violations.append(
                f"{phase_name}.tech_stack.framework='{phase_tech.get('framework')}' "
                f"no coincide con stack_contract.framework='{contract.get('framework')}'"
            )

    # Libs prohibidas del contrato no deben aparecer en las libs de la phase.
    forbidden = [_norm(x) for x in (contract.get("libs_forbidden") or [])]
    phase_libs = [_norm(x) for x in (phase_tech.get("libs") or [])]
    for lib in forbidden:
        if lib and lib in phase_libs:
            violations.append(
                f"{phase_name}.tech_stack.libs incluye '{lib}' que esta en "
                f"stack_contract.libs_forbidden"
            )

    return violations


def _build_retry_hint(violations: list[str], contract: dict[str, Any]) -> str:
    """Mensaje textual que se inyecta al state para que el agente lo lea."""
    lines = [
        "GATE FAILURE — la salida anterior violo el stack_contract.",
        "Violaciones:",
    ]
    for v in violations:
        lines.append(f"  - {v}")
    lines.append("")
    lines.append("Contrato a respetar (stack_contract):")
    for k in ("language", "framework", "runtime", "libs_required", "libs_forbidden"):
        if k in contract:
            lines.append(f"  {k}: {contract[k]}")
    lines.append("")
    lines.append(
        "Re-escribi tu output usando EXACTAMENTE ese stack. No lo sustituyas "
        "por un equivalente. Si el contrato dice typescript, es typescript; "
        "no python. Si dice fastify, es fastify; no fastapi."
    )
    return "\n".join(lines)


# ----------------------------------------------------------------------
# Gates concretos
# ----------------------------------------------------------------------
def gate_post_spec_dev(state: dict[str, Any]) -> GateResult:
    """
    Corre despues de spec_dev. Spec_dev no escribe tech_stack directamente
    (ese lo escribe architecture), pero SI puede filtrar en acceptance_criteria
    referencias al stack (ej. "test con pytest" vs "test con vitest"). Validamos
    que el feature_intent y los acceptance_criteria no contradigan el contrato.
    """
    contract = _get_stack_contract(state)
    if not contract:
        # No hay contrato => no podemos validar. Dejamos pasar y loggeamos
        # implicitamente via violations vacias. El gate de architecture sera
        # el primer chokepoint si tampoco hay contrato ahi.
        return GateResult.ok()

    violations: list[str] = []
    contract_lang = _norm(contract.get("language"))
    contract_fw = _norm(contract.get("framework"))
    forbidden = [_norm(x) for x in (contract.get("libs_forbidden") or [])]

    # Heuristica: buscar menciones de libs/frameworks prohibidos en los
    # acceptance_criteria y feature_intent. No es perfecto pero cubre el
    # caso obvio (spec_dev describe tests en pytest cuando el contrato es
    # typescript/vitest).
    haystack_parts: list[str] = []
    fi = state.get("feature_intent")
    if isinstance(fi, str):
        haystack_parts.append(fi)
    ac = state.get("acceptance_criteria") or []
    if isinstance(ac, list):
        for item in ac:
            if isinstance(item, dict):
                haystack_parts.append(str(item.get("criterion", "")))
                haystack_parts.append(str(item.get("metric", "")))
            elif isinstance(item, str):
                haystack_parts.append(item)
    haystack = _norm(" \n ".join(haystack_parts))

    for lib in forbidden:
        if lib and lib in haystack:
            # Evitar falsos positivos: si la lib aparece SOLO en contexto
            # negativo (validaciones de ausencia, greps, "sin", "prohibid",
            # "no usar", etc.), no es una violacion real sino un check
            # correcto de que la lib NO se use.
            if _is_only_negation_context(haystack, lib):
                continue
            violations.append(
                f"spec_dev menciona '{lib}' (prohibido por stack_contract.libs_forbidden)"
            )

    # Mismatch obvio: si contract pide typescript/node y el texto dice "pytest"
    # o "python" o "fastapi", o viceversa.
    py_markers = ("pytest", "python -c", "pip install", "fastapi", "uvicorn", "flask")
    ts_markers = ("vitest", "tsx ", "pnpm ", "npm ", "node ", "fastify")
    if contract_lang == "typescript" or contract_lang == "javascript":
        for m in py_markers:
            if m in haystack:
                violations.append(
                    f"spec_dev menciona '{m.strip()}' pero el contrato exige {contract_lang}/{contract_fw}"
                )
                break
    elif contract_lang == "python":
        for m in ts_markers:
            if m in haystack:
                violations.append(
                    f"spec_dev menciona '{m.strip()}' pero el contrato exige {contract_lang}/{contract_fw}"
                )
                break

    if violations:
        return GateResult.fail(violations, _build_retry_hint(violations, contract))
    return GateResult.ok()


def gate_post_architecture(state: dict[str, Any]) -> GateResult:
    """
    Corre despues de architecture. Valida que `tech_stack` escrito por
    architecture respeta exactamente el `stack_contract`. Es el chokepoint
    principal: si architecture pivoteo a otro stack, este gate lo atrapa.
    """
    contract = _get_stack_contract(state)
    if not contract:
        return GateResult.ok()

    tech = state.get("tech_stack")
    if not isinstance(tech, dict):
        return GateResult.fail(
            ["architecture no escribio tech_stack como dict"],
            _build_retry_hint(
                ["architecture.tech_stack ausente o no es dict"], contract
            ),
        )

    violations = _check_language_framework(tech, contract, "architecture")
    if violations:
        return GateResult.fail(violations, _build_retry_hint(violations, contract))
    return GateResult.ok()


def _runs_dir() -> str:
    return os.environ.get("ADLC_RUNS_DIR", "/data/runs")


def _coding_workspace_tar(state: dict[str, Any]) -> str | None:
    """Path al snapshot del workspace de coding. None si falta el run_id."""
    run_id = state.get("_run_id") or state.get("run_id")
    if not run_id:
        return None
    return os.path.join(_runs_dir(), str(run_id), "coding", "workspace.tar.gz")


def _tar_has_readme(tar_path: str) -> bool:
    try:
        with tarfile.open(tar_path, "r:gz") as t:
            for member in t.getmembers():
                name = member.name.lower()
                base = os.path.basename(name)
                if base in ("readme.md", "readme.rst", "readme.txt", "readme"):
                    return True
    except (tarfile.TarError, OSError):
        pass
    return False


def _render_readme_from_state(state: dict[str, Any]) -> str:
    """Sintetiza un README.md desde el state cuando el coding agent no lo creo.
    Usa stack_contract, manual_validation_tasks, y prompt_inicial como fuentes."""
    contract = state.get("stack_contract") or {}
    project_id = contract.get("project_id") or "proyecto"
    stack = contract.get("tech_stack") or {}
    prompt = state.get("prompt_inicial") or state.get("feature_intent", {}).get("summary") or ""
    mv_tasks = state.get("manual_validation_tasks") or []
    files = state.get("files_modified") or []
    tests = state.get("unit_tests") or {}

    lines: list[str] = []
    lines.append(f"# {project_id}")
    lines.append("")
    if prompt:
        lines.append(prompt.strip().split("\n")[0][:500])
        lines.append("")

    lines.append("## Requisitos")
    lines.append("")
    if isinstance(stack, dict) and stack:
        for comp, details in stack.items():
            if isinstance(details, dict):
                bits = [f"**{comp}**:"]
                for k, v in details.items():
                    bits.append(f"{k}={v}")
                lines.append("- " + " ".join(bits))
            else:
                lines.append(f"- **{comp}**: {details}")
    else:
        lines.append("- Revisa los manifests (`package.json`, `Package.swift`, `requirements.txt`, etc.) para versiones exactas.")
    lines.append("")

    lines.append("## Instalacion")
    lines.append("")
    lines.append("```bash")
    lines.append("# ajusta segun el stack del proyecto")
    lines.append("git clone <repo-url> && cd <repo-dir>")
    if any(f.endswith("package.json") for f in files):
        lines.append("pnpm install  # o npm install / yarn install")
    if any(f.endswith("requirements.txt") for f in files):
        lines.append("pip install -r requirements.txt")
    if any(f.endswith("Package.swift") for f in files):
        lines.append("swift package resolve")
    if any(f.endswith("build.gradle") or f.endswith("build.gradle.kts") for f in files):
        lines.append("./gradlew build")
    lines.append("```")
    lines.append("")

    lines.append("## Como ejecutar")
    lines.append("")
    lines.append("Revisa los `scripts` del `package.json` raiz o el README de cada sub-proyecto. Comandos tipicos:")
    lines.append("")
    lines.append("```bash")
    lines.append("pnpm dev       # backend Node/TS")
    lines.append("swift run      # iOS/macOS SwiftPM executable")
    lines.append("./gradlew run  # Android")
    lines.append("```")
    lines.append("")

    lines.append("## Tests")
    lines.append("")
    if isinstance(tests, dict) and tests:
        for suite, info in tests.items():
            if isinstance(info, dict):
                cmd = info.get("run_command") or info.get("command")
                if cmd:
                    lines.append(f"- **{suite}**: `{cmd}`")
    else:
        lines.append("- `pnpm test` / `swift test` / `pytest` segun el stack.")
    lines.append("")

    if mv_tasks:
        lines.append("## Validacion manual")
        lines.append("")
        lines.append("Estas tareas no se pudieron validar automaticamente en el sandbox de ADLC. Corrélas antes de mergear.")
        lines.append("")
        for i, t in enumerate(mv_tasks, 1):
            if not isinstance(t, dict):
                continue
            title = t.get("task") or t.get("id") or f"Tarea {i}"
            lines.append(f"### {i}. {title}")
            why = t.get("why") or t.get("expected_result")
            if why:
                lines.append(f"**Contexto:** {why}")
            cmd = t.get("command")
            if cmd:
                lines.append("```bash")
                lines.append(cmd)
                lines.append("```")
            lines.append("")

    lines.append("## Estructura")
    lines.append("")
    if files:
        lines.append("```")
        for f in sorted(set(files))[:40]:
            lines.append(f)
        lines.append("```")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("_README auto-generado por ADLC post-coding gate: el coding agent no incluyo uno. Revisalo y ajusta lo necesario antes de mergear._")
    lines.append("")
    return "\n".join(lines)


def _inject_readme_into_tar(tar_path: str, readme_content: str) -> bool:
    """Agrega README.md en la raiz del tar.gz. Devuelve True si lo inyecto."""
    if not os.path.exists(tar_path):
        return False
    try:
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".tar.gz")
        os.close(tmp_fd)
        data = readme_content.encode("utf-8")
        with tarfile.open(tar_path, "r:gz") as src, tarfile.open(tmp_path, "w:gz") as dst:
            for member in src.getmembers():
                if os.path.basename(member.name).lower() == "readme.md":
                    continue
                f = src.extractfile(member) if member.isfile() else None
                dst.addfile(member, f)
            info = tarfile.TarInfo(name="repo/README.md")
            info.size = len(data)
            info.mode = 0o644
            dst.addfile(info, io.BytesIO(data))
        os.replace(tmp_path, tar_path)
        return True
    except (tarfile.TarError, OSError):
        return False


def _autoheal_readme(state: dict[str, Any]) -> bool:
    """Si falta README en files_modified, intenta autohealing.
    Returns True si el state quedo coherente (README presente en files_modified).
    Mutate state in-place: files_modified += 'README.md' (si lo sintetizamos/encontramos)."""
    tar = _coding_workspace_tar(state)
    files = state.get("files_modified") or []
    if not isinstance(files, list):
        return False

    # Caso 1: README existe en el tar pero el agente no lo listo → agregarlo.
    if tar and os.path.exists(tar) and _tar_has_readme(tar):
        files.append("README.md")
        state["files_modified"] = files
        return True

    # Caso 2: README no existe. Sintetizar + inyectar en el tar.
    if tar and os.path.exists(tar):
        content = _render_readme_from_state(state)
        if _inject_readme_into_tar(tar, content):
            files.append("README.md")
            state["files_modified"] = files
            state["_autogenerated_readme"] = True
            return True

    return False


def gate_post_coding(state: dict[str, Any]) -> GateResult:
    """
    Corre despues de coding. Chequeos:
      1. README.md presente en files_modified (obligatorio, independiente del stack).
         Si falta, auto-heal: sintetiza README desde state + inyecta en el tar.
      2. Si el contrato exige node/ts, los files_modified deben tener .ts / package.json.
         Si exige python, .py / requirements.txt. No valida contenido —
         solo extensiones/manifests.
    """
    files = state.get("files_modified")
    if not isinstance(files, list) or not files:
        # Rechazar: un coding phase que no modifico ningun archivo significa
        # que el agente no ejecuto sandbox_run (o lo ejecuto pero no hubo
        # diff). Sin archivos no hay nada que publicar ni validar. El
        # reviewer humano vendria a un repo vacio — es un fracaso silencioso
        # si lo dejamos pasar. Mejor fallar y forzar retry con hint claro.
        violations = [
            "coding.files_modified esta vacio: el coding agent no creo "
            "ningun archivo. Probablemente no llamo a sandbox_run."
        ]
        hint = _build_retry_hint(violations, _get_stack_contract(state) or {})
        hint += (
            "\n\nIMPORTANTE — files_modified vacio. Tu trabajo NO se hizo. "
            "Tenes que LLAMAR A `sandbox_run` para crear los archivos del "
            "primer batch (usa heredocs `cat > path <<'EOF' ... EOF`). "
            "Solo DESPUES de sandbox_run (con exit_code=0 o los archivos "
            "creados) podes dar final_answer con files_modified POBLADO."
        )
        return GateResult.fail(violations, hint)

    paths = [_norm(f) for f in files if isinstance(f, str)]
    joined = " ".join(paths)

    violations: list[str] = []

    # README obligatorio — sin importar stack. Aceptamos README.md, README.rst,
    # README.txt, o un README.md en cualquier subcarpeta (workspaces
    # multi-componente).
    readme_markers = ("readme.md", "readme.rst", "readme.txt", "readme")
    has_readme = any(
        any(p.endswith("/" + m) or p == m for m in readme_markers)
        for p in paths
    )
    if not has_readme:
        # Auto-heal: si el tar del workspace tiene un README (el agente lo
        # creo pero no lo listo), o si podemos sintetizar uno desde el state,
        # lo inyectamos y seguimos. El reviewer igual recibe un README.
        if _autoheal_readme(state):
            has_readme = True
        else:
            violations.append(
                "coding.files_modified no incluye un README.md (requerido: el "
                "humano reviewer debe poder clonar + correr siguiendo el README)"
            )

    # Stack checks (solo si hay contrato).
    contract = _get_stack_contract(state)
    if contract:
        contract_lang = _norm(contract.get("language"))

        if contract_lang in ("typescript", "javascript"):
            has_ts = any(p.endswith(".ts") or p.endswith(".tsx") or p.endswith(".js") for p in paths)
            has_pkg = "package.json" in joined
            if not (has_ts or has_pkg):
                violations.append(
                    "coding.files_modified no contiene archivos .ts/.js ni package.json "
                    "pero el contrato exige typescript/javascript"
                )
            if any(p.endswith(".py") for p in paths) or "requirements.txt" in joined:
                violations.append(
                    "coding.files_modified contiene archivos Python pero el contrato "
                    "exige typescript/javascript"
                )
        elif contract_lang == "python":
            has_py = any(p.endswith(".py") for p in paths)
            if not has_py:
                violations.append(
                    "coding.files_modified no contiene archivos .py pero el contrato exige python"
                )

    if violations:
        hint_contract = contract or {}
        retry_hint = _build_retry_hint(violations, hint_contract)
        if not has_readme:
            retry_hint += (
                "\n\nIMPORTANTE — README.md faltante. Creá un README.md en la "
                "raiz del repo con las secciones: Requisitos, Instalacion, "
                "Como ejecutar, Tests. Usá comandos copy-pasteables. Sin README "
                "el reviewer no puede validar el entregable."
            )
        return GateResult.fail(violations, retry_hint)
    return GateResult.ok()


# ----------------------------------------------------------------------
# Registry
# ----------------------------------------------------------------------
# Mapa phase_name -> gate function. El cycle_executor lo consulta despues
# de cada phase real. Si no hay gate registrado para la phase, se considera
# ok sin checkeo.
GATE_REGISTRY: dict[str, Gate] = {
    "spec": gate_post_spec_dev,
    "architecture": gate_post_architecture,
    "coding": gate_post_coding,
}


def get_gate(phase_name: str) -> Gate | None:
    return GATE_REGISTRY.get(phase_name)
