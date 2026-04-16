"""
Factory del ToolRegistry — un solo lugar que arma el registry para los agentes.

Lee la config (`tools:` block) y el env. Por cada tool del catalogo:
  - Si esta enabled en config Y las creds estan disponibles → registra la
    tool real.
  - Si no → registra una DisabledTool con el motivo, asi el agent runtime
    arranca sin editar la spec y el LLM puede recibir un tool_result claro
    si igual intenta usar la tool.

Para agregar una nueva tool al catalogo:
  1. Crear engine/agents/tools/<mi_tool>.py implementando Tool
  2. Importarla aca
  3. Agregar entrada al CATALOG con su builder
  4. Documentar el bloque correspondiente en config/adlc.config.example.yaml
"""

from __future__ import annotations

import os
from typing import Any, Callable

from ..base import Tool, ToolRegistry
from .disabled import DisabledTool
from .git_publish import GitPublishTool
from .github_repo_tree import GithubRepoTreeTool
from .github_search import GithubSearchTool
from .linear_search import LinearSearchTool
from .notion_search import NotionSearchTool
from .sandbox_run import SandboxRunTool
from .stubs import EchoTool, NoopSearchTool
from .web_fetch import WebFetchTool


# Cada builder devuelve (tool, motivo_disabled). Si tool es None, se registra
# una DisabledTool con el motivo.
ToolBuilder = Callable[[dict, dict], "tuple[Tool | None, str]"]


def _build_github_search(cfg: dict, env: dict) -> tuple[Tool | None, str]:
    if not cfg.get("enabled", True):
        return None, "deshabilitada en config"
    token_env = cfg.get("token_env", "GITHUB_TOKEN")
    token = env.get(token_env, "")
    if not token:
        return None, f"falta env var {token_env}"
    return (
        GithubSearchTool(
            token=token,
            per_page_default=int(cfg.get("default_per_page", 5)),
            timeout_seconds=float(cfg.get("timeout_seconds", 15)),
        ),
        "",
    )


def _build_github_repo_tree(cfg: dict, env: dict) -> tuple[Tool | None, str]:
    if not cfg.get("enabled", True):
        return None, "deshabilitada en config"
    token_env = cfg.get("token_env", "GITHUB_TOKEN")
    token = env.get(token_env, "")
    if not token:
        return None, f"falta env var {token_env}"
    return (
        GithubRepoTreeTool(
            token=token,
            max_entries_default=int(cfg.get("default_max_entries", 200)),
            timeout_seconds=float(cfg.get("timeout_seconds", 15)),
        ),
        "",
    )


def _build_notion_search(cfg: dict, env: dict) -> tuple[Tool | None, str]:
    if not cfg.get("enabled", True):
        return None, "deshabilitada en config"
    token_env = cfg.get("token_env", "NOTION_TOKEN")
    token = env.get(token_env, "")
    if not token:
        return None, f"falta env var {token_env}"
    return (
        NotionSearchTool(
            token=token,
            page_size_default=int(cfg.get("default_page_size", 5)),
            timeout_seconds=float(cfg.get("timeout_seconds", 15)),
        ),
        "",
    )


def _build_linear_search(cfg: dict, env: dict) -> tuple[Tool | None, str]:
    if not cfg.get("enabled", True):
        return None, "deshabilitada en config"
    token_env = cfg.get("token_env", "LINEAR_TOKEN")
    token = env.get(token_env, "")
    if not token:
        return None, f"falta env var {token_env}"
    return (
        LinearSearchTool(
            token=token,
            first_default=int(cfg.get("default_first", 5)),
            timeout_seconds=float(cfg.get("timeout_seconds", 15)),
        ),
        "",
    )


def _build_sandbox_run(cfg: dict, env: dict) -> tuple[Tool | None, str]:
    if not cfg.get("enabled", True):
        return None, "deshabilitada en config"
    # La tool valida el container sidecar lazy al primer .run(). Aca solo
    # confirmamos que la env var este presente o usamos el default.
    container = env.get("ADLC_SANDBOX_CONTAINER", "adlc-sandbox")
    try:
        # Si docker-py no esta instalada, fallamos aca con un motivo claro
        import docker  # type: ignore  # noqa: F401
    except ImportError:
        return None, "docker-py no instalada (pip install docker>=7)"
    return (
        SandboxRunTool(
            sandbox=None,  # usa DockerSandbox() con el default del env
        ),
        "",
    )


def _build_git_publish(cfg: dict, env: dict) -> tuple[Tool | None, str]:
    if not cfg.get("enabled", True):
        return None, "deshabilitada en config"
    token_env = cfg.get("token_env", "GITHUB_TOKEN")
    token = env.get(token_env, "")
    if not token:
        return None, f"falta env var {token_env}"
    return (
        GitPublishTool(
            token=token,
            timeout_seconds=float(cfg.get("timeout_seconds", 60)),
        ),
        "",
    )


def _build_web_fetch(cfg: dict, env: dict) -> tuple[Tool | None, str]:
    if not cfg.get("enabled", True):
        return None, "deshabilitada en config"
    allowed = cfg.get("allowed_domains") or []
    if not allowed:
        return None, "allowed_domains vacio"
    return (
        WebFetchTool(
            allowed_domains=list(allowed),
            max_response_kb=int(cfg.get("max_response_kb", 50)),
            timeout_seconds=float(cfg.get("timeout_seconds", 15)),
        ),
        "",
    )


# Catalogo: nombre canonico → (descripcion para DisabledTool, builder, schema_min)
# La descripcion y el schema se usan SOLO para DisabledTool cuando la tool real
# no se pudo construir.
CATALOG: dict[str, dict[str, Any]] = {
    "github_search": {
        "description": "Busca codigo en repositorios de GitHub.",
        "schema": GithubSearchTool.input_schema,
        "builder": _build_github_search,
    },
    "github_repo_tree": {
        "description": "Lista archivos de un repo GitHub via git trees API.",
        "schema": GithubRepoTreeTool.input_schema,
        "builder": _build_github_repo_tree,
    },
    "notion_search": {
        "description": "Busca pages en un workspace de Notion.",
        "schema": NotionSearchTool.input_schema,
        "builder": _build_notion_search,
    },
    "linear_search": {
        "description": "Busca issues en Linear.",
        "schema": LinearSearchTool.input_schema,
        "builder": _build_linear_search,
    },
    "web_fetch": {
        "description": "HTTP GET con allowlist de dominios.",
        "schema": WebFetchTool.input_schema,
        "builder": _build_web_fetch,
    },
    "sandbox_run": {
        "description": "Ejecuta un job en el container sandbox aislado.",
        "schema": SandboxRunTool.input_schema,
        "builder": _build_sandbox_run,
    },
    "git_publish": {
        "description": "Publica el workspace del coding phase a GitHub (greenfield o brownfield PR).",
        "schema": GitPublishTool.input_schema,
        "builder": _build_git_publish,
    },
}


def build_tool_registry(
    config: dict | None = None,
    env: dict | None = None,
    include_stubs: bool = False,
) -> tuple[ToolRegistry, dict[str, str]]:
    """
    Construye un ToolRegistry leyendo el bloque `tools:` de la config y
    el env del proceso.

    config: dict del bloque `tools:` (ej. config['tools'] del adlc.config.yaml).
            Si es None, asume todas enabled con defaults.
    env: dict de env vars (default: os.environ).
    include_stubs: si True, registra tambien EchoTool y NoopSearchTool del
                   modulo stubs. Util para tests y smoke tests del runtime
                   sin tocar APIs reales.

    Devuelve:
      (registry, status_dict) donde status_dict mapea nombre_tool -> "ok"
      o "disabled: <motivo>". Sirve para que el caller logee el estado.
    """
    config = config or {}
    env = env if env is not None else dict(os.environ)

    registry = ToolRegistry()
    status: dict[str, str] = {}

    for name, entry in CATALOG.items():
        tool_cfg = config.get(name) or {}
        builder: ToolBuilder = entry["builder"]
        try:
            tool, reason = builder(tool_cfg, env)
        except Exception as e:
            tool, reason = None, f"builder fallo: {e}"

        if tool is not None:
            registry.register(tool)
            status[name] = "ok"
        else:
            registry.register(DisabledTool(
                name=name,
                description=entry["description"],
                reason=reason or "no configurada",
                input_schema=entry["schema"],
            ))
            status[name] = f"disabled: {reason or 'no configurada'}"

    if include_stubs:
        registry.register(EchoTool())
        registry.register(NoopSearchTool())
        status["echo"] = "ok"
        status["noop_search"] = "ok"

    return registry, status
