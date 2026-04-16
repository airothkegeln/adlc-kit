"""
SandboxRunTool — tool expuesta al coding agent.

Envía un job completo al DockerSandbox: clonar un repo, ejecutar una
lista de comandos shell adentro, y devolver stdout + stderr + exit_code
+ diff + files_changed. El agente de coding usa esto para:
  1. git clone del target_repo
  2. Escribir archivos via heredoc o sed
  3. Build: Android -> `./gradlew assembleDebug`; iOS -> `swift build`
  4. Tests: Android -> `./gradlew test`; iOS -> `swift test`
  5. Confirmar acceptance_criteria

No escribe archivos directamente desde el engine — el agente describe
TODO como comandos shell. Esto simplifica el security model: una sola
tool, una sola superficie, el estado del workspace vive adentro del
sandbox y no se filtra al engine.
"""

from __future__ import annotations

import os
import sys
from typing import Any

from sandbox.base import Sandbox, SandboxRequest
from sandbox.context import current_phase, current_run_id
from sandbox.docker_sandbox import DockerSandbox

from ..base import Tool


def _runs_dir() -> str:
    """Root dir donde persistimos artefactos por run. Configurable por env."""
    return os.environ.get("ADLC_RUNS_DIR", "/data/runs")


class SandboxRunTool(Tool):
    name = "sandbox_run"
    description = (
        "Ejecuta un job en el container sandbox aislado: clona el target_repo, "
        "corre una lista de comandos shell en el repo clonado, devuelve stdout, "
        "stderr, exit_code, diff (git diff) y files_changed. Usalo para "
        "implementar features: escribir archivos con heredocs o sed, correr "
        "`./gradlew test` (Android) o `swift test` (iOS). Cada invocacion CLONA DE CERO el "
        "repo — no hay persistencia entre calls. Para proyectos grandes, usá "
        "múltiples calls acumulativas (cada call incluye archivos previos + nuevos). "
        "Mantené cada array de commands por debajo de 30 commands."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "repo_url": {
                "type": "string",
                "description": (
                    "URL HTTPS del repo a clonar (ej. https://github.com/owner/repo.git). "
                    "Si se pasa vacio '', el sandbox hace git init sobre un "
                    "dir vacio — solo tiene sentido combinado con "
                    "overlay_archive_phase (caso greenfield)."
                ),
            },
            "branch": {
                "type": "string",
                "description": "Branch a checkoutar. Si no existe, se hace fallback al default.",
                "default": "main",
            },
            "commands": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Lista de comandos shell a ejecutar secuencialmente EN /workspace/repo. "
                    "Si uno falla (exit != 0), la ejecucion se detiene y devuelve el estado. "
                    "Usa heredocs o tee para crear archivos multi-linea, ej. "
                    "\"cat > src/onboarding/new.py <<'EOF'\\n<codigo>\\nEOF\"."
                ),
            },
            "timeout_seconds": {
                "type": "integer",
                "description": "Timeout por comando individual (default 600).",
                "default": 600,
            },
            "overlay_archive_phase": {
                "type": "string",
                "description": (
                    "Opcional. Nombre de una phase previa del mismo run "
                    "(ej. 'coding'). Si se pasa, despues del clone el sandbox "
                    "extrae el tar.gz persistido por esa phase en "
                    "$ADLC_RUNS_DIR/<run_id>/<phase>/workspace.tar.gz "
                    "SOBRE /workspace/repo — es decir, el repo termina con "
                    "los archivos del remoto + los cambios de esa phase "
                    "aplicados encima. Usalo para validar (ej. `./gradlew test` o `swift test`) el "
                    "artefacto que el coding genero sin tener que re-crearlo."
                ),
            },
        },
        "required": ["commands"],
    }

    def __init__(self, sandbox: Sandbox | None = None):
        self._sandbox = sandbox or DockerSandbox()

    async def run(self, arguments: dict[str, Any]) -> Any:
        repo_url = arguments.get("repo_url") or ""
        if not isinstance(repo_url, str):
            return {"error": "repo_url debe ser string (puede estar vacio en greenfield)"}

        commands = arguments.get("commands") or []
        if not isinstance(commands, list) or not commands:
            return {"error": "commands debe ser una lista no vacia"}

        branch = arguments.get("branch") or "main"
        timeout = int(arguments.get("timeout_seconds") or 600)

        overlay_phase = arguments.get("overlay_archive_phase")
        overlay_path: str | None = None
        if overlay_phase:
            run_id = current_run_id.get(None)
            if not run_id:
                return {
                    "error": (
                        "overlay_archive_phase requiere un run_id en contexto "
                        "(esta tool debe correr dentro del cycle_executor)"
                    )
                }
            overlay_path = os.path.join(
                _runs_dir(), run_id, str(overlay_phase), "workspace.tar.gz"
            )

        # En greenfield (repo_url vacio) el overlay es la UNICA fuente
        # de archivos. Sin overlay no hay nada para correr.
        if not repo_url and not overlay_path:
            return {
                "error": (
                    "o pasas repo_url (brownfield) o overlay_archive_phase "
                    "(greenfield). Si no, /workspace/repo queda vacio."
                )
            }

        req = SandboxRequest(
            repo_url=repo_url,
            branch=branch,
            commands=[str(c) for c in commands],
            timeout_seconds=timeout,
            overlay_archive_path=overlay_path,
        )
        print(
            f"[sandbox_run] start repo={repo_url} branch={branch} "
            f"n_commands={len(req.commands)} timeout={timeout}s",
            file=sys.stderr, flush=True,
        )
        for i, c in enumerate(req.commands):
            first_line = c.strip().split("\n", 1)[0][:120]
            print(f"[sandbox_run]   cmd[{i}] {first_line}", file=sys.stderr, flush=True)

        result = await self._sandbox.run(req)

        print(
            f"[sandbox_run] done exit={result.exit_code} "
            f"duration={result.duration_ms}ms files_changed={len(result.files_changed)} "
            f"stdout_len={len(result.stdout)} stderr_len={len(result.stderr)}",
            file=sys.stderr, flush=True,
        )

        # Snapshot del workspace para que phases posteriores (publish) puedan
        # leer el artefacto. Snapshotea SIEMPRE que estemos dentro de un phase
        # del cycle_executor (contextvars seteadas), INDEPENDIENTE del exit_code.
        # Motivo: el ultimo comando del coding suele ser un smoke test que
        # arranca el server y curl-ea. Si el smoke falla (exit!=0), los archivos
        # igual quedan en disco y tienen que publicarse — validation va a
        # marcar deploy_status=blocked, pero el artefacto debe existir para
        # que cualquier flujo posterior pueda inspeccionarlo.
        # Sobrescribe el tar.gz anterior — la ultima call de la phase gana.
        archive_path: str | None = None
        run_id = current_run_id.get(None)
        phase = current_phase.get(None)
        if run_id and phase:
            dest = os.path.join(_runs_dir(), run_id, phase, "workspace.tar.gz")
            try:
                await self._sandbox.snapshot(dest)
                archive_path = dest
                result.workspace_archive_path = dest
                print(
                    f"[sandbox_run] snapshot OK dest={dest} exit_code={result.exit_code}",
                    file=sys.stderr, flush=True,
                )
            except Exception as e:
                print(
                    f"[sandbox_run] snapshot FALLO (no bloqueante): {e}",
                    file=sys.stderr, flush=True,
                )
        else:
            print(
                f"[sandbox_run] snapshot SKIPPED — contextvars ausentes "
                f"(run_id={run_id!r}, phase={phase!r})",
                file=sys.stderr, flush=True,
            )

        return {
            "exit_code": result.exit_code,
            "stdout": result.stdout[:8000],   # cap para no saturar el contexto
            "stderr": result.stderr[:4000],
            "duration_ms": result.duration_ms,
            "files_changed": result.files_changed,
            "diff_preview": result.diff[:4000],  # cap mas pequeño
            "ok": result.exit_code == 0,
            "workspace_archive_path": archive_path,
        }
