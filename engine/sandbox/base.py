"""
Sandbox — interfaz aislada para ejecución segura de coding agents.

Default: DockerSandbox (containers efímeros en la misma máquina).
Reemplazable por E2B, Daytona, Modal, Firecracker, etc.

REGLAS NO-NEGOCIABLES:
  - Coding agents NUNCA corren en el host del orquestador
  - Sandbox sin red salvo proxy a GitHub (whitelist)
  - Memoria y CPU acotados
  - Timeout duro
  - Filesystem efímero, destruido al terminar
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class SandboxRequest:
    repo_url: str
    branch: str
    commands: list[str]
    timeout_seconds: int = 600
    env: dict[str, str] = field(default_factory=dict)
    # Si se provee, despues del clone se extrae este tar.gz (del filesystem
    # del engine) sobre /workspace/repo, strippeando el prefix 'repo/' que
    # docker get_archive agrega. Usado por validation para re-hidratar el
    # workspace del coding antes de correr tests.
    overlay_archive_path: str | None = None


@dataclass
class SandboxResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    files_changed: list[str] = field(default_factory=list)
    diff: str = ""
    # Path en el host-del-engine donde quedo el tar.gz del workspace
    # tras un snapshot. None si no se capturo (ej. health_check fallo
    # antes, o la invocacion se hizo fuera del cycle_executor).
    workspace_archive_path: str | None = None


class Sandbox(ABC):

    @abstractmethod
    async def run(self, request: SandboxRequest) -> SandboxResult:
        """Ejecuta los comandos en un entorno aislado y devuelve el resultado."""
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        """Verifica que el backend de sandbox esté disponible."""
        ...

    @abstractmethod
    async def snapshot(self, dest_path: str) -> None:
        """
        Persiste el workspace actual del sandbox como tar.gz en dest_path.

        Se llama tras un run() exitoso, antes de que el siguiente run() haga
        rm -rf /workspace/*. El archivo sobrevive fuera del sandbox para que
        phases posteriores (publish) puedan leer el artefacto del coding.

        dest_path: path absoluto en el filesystem del engine. El caller
        debe asegurar que el parent dir exista — la impl solo escribe.
        """
        ...
