"""
GithubRepoTreeTool — lista todos los archivos de un repo via la git trees API.

A diferencia de `github_search` (que usa /search/code y depende del indice de
busqueda de GitHub, el cual NO indexa repos nuevos inmediatamente), esta tool
usa /repos/:owner/:repo/git/trees/:sha?recursive=1 que lee directamente el
arbol git del branch default. Funciona desde el primer commit.

Uso tipico desde el agente discovery: obtener el inventario completo del
target_repo para detectar que archivos existen, y combinarlo con `web_fetch`
o `github_search` para leer el contenido de los que parezcan relevantes.

API: GET https://api.github.com/repos/:owner/:repo -> default_branch + sha
     GET https://api.github.com/repos/:owner/:repo/git/trees/:sha?recursive=1
Auth: PAT como github_search.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from ..base import Tool


GITHUB_API = "https://api.github.com"


class GithubRepoTreeTool(Tool):
    name = "github_repo_tree"
    description = (
        "Lista todos los archivos de un repositorio de GitHub usando la git "
        "trees API. Util cuando github_search devuelve 0 hits porque el repo "
        "no esta indexado aun (comun en fixtures nuevos). Devuelve el arbol "
        "completo con path, type (blob|tree) y size."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "repo": {
                "type": "string",
                "description": "Repositorio en formato 'owner/name'.",
            },
            "path_prefix": {
                "type": "string",
                "description": (
                    "Opcional: filtrar paths que empiecen con este prefijo "
                    "(ej. 'docs/' o 'src/onboarding/')."
                ),
            },
            "max_entries": {
                "type": "integer",
                "description": "Maximo de entries a devolver (default 200)",
                "default": 200,
            },
        },
        "required": ["repo"],
    }

    def __init__(
        self,
        token: str,
        max_entries_default: int = 200,
        timeout_seconds: float = 15.0,
        client: httpx.AsyncClient | None = None,
    ):
        if not token:
            raise ValueError("GithubRepoTreeTool requiere un token no vacio")
        self._token = token
        self._max_entries_default = max_entries_default
        self._timeout = timeout_seconds
        self._client = client

    async def run(self, arguments: dict[str, Any]) -> Any:
        repo = arguments.get("repo")
        if not repo or not isinstance(repo, str) or "/" not in repo:
            return {"error": "repo es obligatorio con formato 'owner/name'"}

        path_prefix = arguments.get("path_prefix") or ""
        max_entries = int(arguments.get("max_entries") or self._max_entries_default)
        max_entries = max(1, min(max_entries, 500))

        headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            # 1. Obtener el branch default y su SHA
            resp = await client.get(
                f"{GITHUB_API}/repos/{repo}",
                headers=headers,
            )
            if resp.status_code == 404:
                return {"error": f"repo '{repo}' no existe o no es accesible"}
            if resp.status_code == 401:
                return {"error": "github auth fallo (401). Token invalido."}
            if resp.status_code != 200:
                return {
                    "error": f"github devolvio status {resp.status_code} al leer repo",
                    "body": resp.text[:500],
                }
            repo_info = _safe_json(resp)
            default_branch = repo_info.get("default_branch") or "main"

            # 2. Obtener el SHA del branch
            resp = await client.get(
                f"{GITHUB_API}/repos/{repo}/branches/{default_branch}",
                headers=headers,
            )
            if resp.status_code != 200:
                return {
                    "error": f"no pude leer branch {default_branch}",
                    "status": resp.status_code,
                }
            branch_info = _safe_json(resp)
            tree_sha = (branch_info.get("commit") or {}).get("sha")
            if not tree_sha:
                return {"error": "no encontre commit SHA del branch default"}

            # 3. Leer el tree recursivo
            resp = await client.get(
                f"{GITHUB_API}/repos/{repo}/git/trees/{tree_sha}",
                headers=headers,
                params={"recursive": "1"},
            )
        finally:
            if self._client is None:
                await client.aclose()

        if resp.status_code != 200:
            return {
                "error": f"github devolvio status {resp.status_code} al leer tree",
                "body": resp.text[:500],
            }

        payload = _safe_json(resp)
        tree = payload.get("tree") or []

        entries = []
        for t in tree:
            p = t.get("path", "")
            if path_prefix and not p.startswith(path_prefix):
                continue
            entries.append({
                "path": p,
                "type": t.get("type", ""),  # "blob" | "tree"
                "size": t.get("size"),
            })
            if len(entries) >= max_entries:
                break

        return {
            "repo": repo,
            "branch": default_branch,
            "truncated": bool(payload.get("truncated")),
            "total": len(tree),
            "returned": len(entries),
            "entries": entries,
        }


def _safe_json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, ValueError):
        return {}
