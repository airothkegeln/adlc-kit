"""
GitPublishTool — publica el artefacto del coding phase a GitHub.

Dos modos:
  - greenfield: crea un repo publico nuevo en la cuenta del token y sube
    el workspace como commit inicial. Devuelve repo_url.
  - brownfield: clona target_repo, crea una branch adlc/<run_id>, aplica
    el workspace del coding (sobrescribe archivos), pushea la branch y
    abre un PR. Devuelve pr_url.

Fuente del artefacto: el tar.gz escrito por SandboxRunTool en
$ADLC_RUNS_DIR/<run_id>/coding/workspace.tar.gz (ver sandbox/context.py).
Leemos run_id desde la contextvar que setea el cycle_executor.

Por que NO usa el sandbox:
  El sandbox hace rm -rf al inicio de cada run() — si esta tool corriera
  alla, validation (que corre DESPUES de coding y ANTES de publish) ya
  habria borrado el workspace. La tool trabaja en /tmp/publish-<run_id>/
  del engine container, totalmente desacoplada del sandbox.

Auth GitHub:
  Usa GITHUB_TOKEN del env. Para greenfield necesita scope `repo` (crear
  repos) o al menos `public_repo`. Para brownfield necesita scope `repo`
  (push + pulls). Si es fine-grained PAT: Contents RW, Pull Requests RW,
  Administration RW (ultima solo greenfield).
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import Any

import httpx

from sandbox.context import current_run_id

from ..base import Tool


GITHUB_API = "https://api.github.com"


def _runs_dir() -> str:
    return os.environ.get("ADLC_RUNS_DIR", "/data/runs")


def _slugify(raw: str, max_len: int = 40) -> str:
    """Heuristica simple: lower, alfanum + guion, trim. Sin LLM call."""
    s = raw.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    if len(s) > max_len:
        s = s[:max_len].rstrip("-")
    return s or "adlc-project"


def _parse_owner_repo(repo_url: str) -> tuple[str, str]:
    """
    Extrae (owner, repo) de varios formatos:
      - https://github.com/owner/repo.git
      - https://github.com/owner/repo
      - git@github.com:owner/repo.git
      - owner/repo
    """
    s = repo_url.strip()
    if s.endswith(".git"):
        s = s[:-4]
    if s.startswith("git@github.com:"):
        s = s[len("git@github.com:"):]
    elif s.startswith("https://github.com/"):
        s = s[len("https://github.com/"):]
    elif s.startswith("http://github.com/"):
        s = s[len("http://github.com/"):]
    parts = s.split("/")
    if len(parts) < 2:
        raise ValueError(f"no pude parsear owner/repo de '{repo_url}'")
    return parts[0], parts[1]


async def _run_cmd(
    cmd: list[str],
    cwd: str,
    env: dict[str, str] | None = None,
    timeout: float = 120.0,
) -> tuple[int, str, str]:
    """Ejecuta un comando en cwd y devuelve (rc, stdout, stderr)."""
    full_env = os.environ.copy()
    if env:
        full_env.update(env)

    loop = asyncio.get_running_loop()

    def _blocking():
        try:
            p = subprocess.run(
                cmd, cwd=cwd, env=full_env, capture_output=True,
                text=True, timeout=timeout,
            )
            return p.returncode, p.stdout, p.stderr
        except subprocess.TimeoutExpired as e:
            return 124, e.stdout or "", (e.stderr or "") + f"\n[timeout {timeout}s]"

    rc, out, err = await loop.run_in_executor(None, _blocking)
    print(
        f"[git_publish] $ {' '.join(cmd)}  (cwd={cwd}) -> rc={rc}",
        file=sys.stderr, flush=True,
    )
    if rc != 0:
        print(f"[git_publish]   stderr: {err[:500]}", file=sys.stderr, flush=True)
    return rc, out, err


def _extract_tar(tar_path: str, dest_dir: str) -> None:
    """
    Desempaca tar_path (tar.gz) en dest_dir. El tar viene de docker
    get_archive, que empaqueta el contenido adentro de un dir raiz
    llamado 'repo/' (el basename del path capturado, /workspace/repo).
    Devolvemos el contenido SIN ese wrapper para que dest_dir quede
    con los archivos al top level.

    IMPORTANTE: skippeamos cualquier entrada .git/ del tar. El sandbox
    hace `git init` en /workspace/repo, asi que el snapshot incluye un
    .git interno — si lo extraemos, pisa el .git del publish (greenfield:
    HEAD apunta a master en vez de main → push falla con "src refspec
    main does not match any"; brownfield: clobberia el clone del target).

    Tambien skippeamos directorios de dependencias/build (node_modules,
    .pnpm-store, .build, .swiftpm, dist, build, __pycache__, .venv, etc.).
    El sandbox a menudo corre `pnpm install` o `swift build` durante
    validation, dejando estos dirs en el snapshot. Subirlos al repo es
    indeseable (pesados, regenerables) y ademas pnpm crea symlinks que
    rompen `tarfile.extract` cuando el target del symlink no esta en el
    tar (KeyError: linkname '...' not found).

    Por ultimo, capturamos errores per-member para que un symlink roto
    aislado no aborte todo el publish.
    """
    SKIP_TOP_DIRS = {
        ".git",
        "node_modules",
        ".pnpm-store",
        ".yarn",
        ".npm",
        ".build",
        ".swiftpm",
        "dist",
        "build",
        "__pycache__",
        ".venv",
        "venv",
        ".next",
        ".nuxt",
        ".cache",
        "target",
        ".gradle",
        ".idea",
        ".vscode",
        "DerivedData",
    }
    os.makedirs(dest_dir, exist_ok=True)
    skipped_count = 0
    failed_count = 0
    with tarfile.open(tar_path, "r:gz") as tf:
        members = tf.getmembers()
        # Detectar el prefix comun (ej. 'repo/')
        top = None
        for m in members:
            parts = m.name.split("/", 1)
            if parts[0]:
                if top is None:
                    top = parts[0]
                elif top != parts[0]:
                    top = None
                    break
        for m in members:
            name = m.name
            if top and (name == top or name.startswith(top + "/")):
                name = name[len(top):].lstrip("/")
                if not name:
                    continue
            # Skippear dirs de build/deps en CUALQUIER nivel del path.
            # Ej. 'machbank-onboarding-api/node_modules/...' tiene que matchear.
            segments = name.split("/")
            if any(seg in SKIP_TOP_DIRS for seg in segments):
                skipped_count += 1
                continue
            m.name = name
            try:
                tf.extract(m, dest_dir, filter="data")
            except (KeyError, OSError) as e:
                # Symlink roto u otro problema con un member individual:
                # no abortar el publish entero.
                failed_count += 1
                print(
                    f"[git_publish] skip member {name!r}: {e}",
                    file=sys.stderr, flush=True,
                )
    if skipped_count or failed_count:
        print(
            f"[git_publish] extract: skipped {skipped_count} build/dep "
            f"entries, {failed_count} entries fallaron",
            file=sys.stderr, flush=True,
        )


class GitPublishTool(Tool):
    name = "git_publish"
    description = (
        "Publica el workspace del coding phase a GitHub. Dos modos: "
        "'greenfield' crea un repo publico nuevo y pushea el workspace "
        "como commit inicial; 'brownfield' clona target_repo, crea una "
        "branch adlc/<run_id>, aplica el workspace sobre el repo, y "
        "abre un PR. Devuelve repo_url (greenfield) o pr_url (brownfield). "
        "El artefacto se lee de un tar.gz persistido por el coding phase."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["greenfield", "brownfield"],
                "description": "'greenfield' crea repo nuevo; 'brownfield' abre PR contra target_repo.",
            },
            "slug": {
                "type": "string",
                "description": (
                    "Nombre del repo para greenfield. Sera auto-sanitizado "
                    "a [a-z0-9-]. Si ya existe en la cuenta se le appendea "
                    "'-2', '-3', ... hasta encontrar uno libre. El run_id "
                    "queda registrado como trailer en el commit y como "
                    "topic 'adlc-run-<short>' en el repo (filtrable). "
                    "Requerido en greenfield."
                ),
            },
            "target_repo": {
                "type": "string",
                "description": (
                    "URL o 'owner/repo' del repo destino (brownfield). "
                    "Ejemplo: https://github.com/airothkegeln/adlc-fixture-machbank-mini.git"
                ),
            },
            "commit_message": {
                "type": "string",
                "description": "Mensaje del commit. Requerido.",
            },
            "pr_title": {
                "type": "string",
                "description": "Titulo del PR (brownfield). Default: el commit_message.",
            },
            "pr_body": {
                "type": "string",
                "description": "Body del PR (brownfield). Markdown.",
            },
            "base_branch": {
                "type": "string",
                "description": "Branch base del PR (brownfield). Default: main.",
                "default": "main",
            },
            "description": {
                "type": "string",
                "description": "Descripcion del repo (greenfield). Opcional.",
            },
        },
        "required": ["mode", "commit_message"],
    }

    def __init__(
        self,
        token: str,
        timeout_seconds: float = 60.0,
        client: httpx.AsyncClient | None = None,
    ):
        self._token = token
        self._timeout = timeout_seconds
        self._client = client  # si se pasa, el caller lo cierra

    async def run(self, arguments: dict[str, Any]) -> Any:
        mode = arguments.get("mode")
        commit_message = arguments.get("commit_message") or ""
        if mode not in ("greenfield", "brownfield"):
            return {"ok": False, "error": f"mode invalido: {mode}"}
        if not commit_message.strip():
            return {"ok": False, "error": "commit_message es obligatorio"}

        run_id = current_run_id.get(None)
        if not run_id:
            return {
                "ok": False,
                "error": (
                    "current_run_id no seteado — git_publish solo corre "
                    "dentro del cycle_executor"
                ),
            }

        tar_path = os.path.join(_runs_dir(), run_id, "coding", "workspace.tar.gz")
        if not os.path.exists(tar_path):
            return {
                "ok": False,
                "error": (
                    f"no encontre el artefacto del coding en {tar_path}. "
                    "Chequear que la phase coding haya corrido OK y que "
                    "sandbox_run haya snapshoteado el workspace."
                ),
            }

        work_dir = tempfile.mkdtemp(prefix=f"publish-{run_id[:8]}-")
        try:
            if mode == "greenfield":
                return await self._greenfield(
                    arguments, run_id, tar_path, work_dir, commit_message
                )
            return await self._brownfield(
                arguments, run_id, tar_path, work_dir, commit_message
            )
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    # ------------------------------------------------------------------
    # Greenfield
    # ------------------------------------------------------------------
    async def _greenfield(
        self, args: dict, run_id: str, tar_path: str,
        work_dir: str, commit_message: str,
    ) -> dict[str, Any]:
        raw_slug = args.get("slug") or ""
        if not raw_slug.strip():
            return {"ok": False, "error": "slug es obligatorio en greenfield"}
        base_slug = _slugify(raw_slug)
        description = args.get("description") or f"ADLC greenfield run {run_id[:8]}"
        run_short = run_id[:8]
        run_topic = f"adlc-run-{run_short}"

        # 1. POST /user/repos — retry con sufijo -2, -3, ... ante colision.
        # GitHub devuelve 422 con "name already exists on this account".
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        owns_client = self._client is None
        try:
            slug = base_slug
            payload = None
            last_resp_text = ""
            last_status = 0
            for attempt in range(1, 11):
                candidate = base_slug if attempt == 1 else f"{base_slug}-{attempt}"
                resp = await client.post(
                    f"{GITHUB_API}/user/repos",
                    headers={
                        "Authorization": f"Bearer {self._token}",
                        "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                    json={
                        "name": candidate,
                        "description": description[:350],
                        "private": False,
                        "auto_init": False,
                    },
                )
                if resp.status_code < 300:
                    slug = candidate
                    payload = resp.json()
                    break
                last_status = resp.status_code
                last_resp_text = resp.text
                # Solo retry si es 422 por nombre existente
                if resp.status_code == 422 and "already exists" in resp.text.lower():
                    continue
                break
        finally:
            if owns_client:
                await client.aclose()

        if payload is None:
            return {
                "ok": False,
                "error": (
                    f"POST /user/repos fallo {last_status}: "
                    f"{last_resp_text[:400]}"
                ),
            }
        repo_url = payload["clone_url"]
        html_url = payload["html_url"]
        owner = payload["owner"]["login"]
        default_branch = payload.get("default_branch") or "main"

        # 2. Desempacar y git init
        _extract_tar(tar_path, work_dir)

        push_url = self._push_url(owner, slug)
        git_env = self._git_env()
        commit_with_trailer = _with_run_trailer(commit_message, run_id)

        for cmd in [
            ["git", "init", "-b", default_branch],
            ["git", "add", "-A"],
            ["git", "commit", "-m", commit_with_trailer],
            ["git", "remote", "add", "origin", push_url],
            ["git", "push", "-u", "origin", default_branch],
        ]:
            rc, out, err = await _run_cmd(cmd, cwd=work_dir, env=git_env)
            if rc != 0:
                return {
                    "ok": False,
                    "error": f"git step fallo: {' '.join(cmd[:2])} -> {err[:400]}",
                    "repo_url": html_url,  # el repo quedo creado aunque el push falle
                }

        # commit sha del HEAD
        rc, out, _ = await _run_cmd(
            ["git", "rev-parse", "HEAD"], cwd=work_dir, env=git_env
        )
        commit_sha = out.strip() if rc == 0 else None

        # 3. Setear topic adlc-run-<short> para que el repo sea filtrable
        # via GitHub search (`topic:adlc-run-<short>`). Best-effort: si
        # falla no abortamos el publish — el trailer del commit ya provee
        # busqueda via `gh search commits`.
        topic_ok = await self._set_topics(owner, slug, [run_topic, "adlc"])

        return {
            "ok": True,
            "mode": "greenfield",
            "repo_url": html_url,
            "clone_url": repo_url,
            "owner": owner,
            "repo": slug,
            "branch": default_branch,
            "commit_sha": commit_sha,
            "run_topic": run_topic,
            "topic_set": topic_ok,
        }

    # ------------------------------------------------------------------
    # Brownfield
    # ------------------------------------------------------------------
    async def _brownfield(
        self, args: dict, run_id: str, tar_path: str,
        work_dir: str, commit_message: str,
    ) -> dict[str, Any]:
        target_repo = args.get("target_repo") or ""
        if not target_repo.strip():
            return {"ok": False, "error": "target_repo es obligatorio en brownfield"}

        try:
            owner, repo = _parse_owner_repo(target_repo)
        except ValueError as e:
            return {"ok": False, "error": str(e)}

        base_branch = args.get("base_branch") or "main"
        branch_name = f"adlc/{run_id[:8]}"
        pr_title = args.get("pr_title") or commit_message.split("\n", 1)[0][:120]
        pr_body = args.get("pr_body") or f"Run ADLC `{run_id}` — auto-generated PR."

        clone_url = self._push_url(owner, repo)
        repo_dir = os.path.join(work_dir, repo)
        git_env = self._git_env()

        # 1. Clone + branch
        rc, _, err = await _run_cmd(
            ["git", "clone", "--depth", "50", "--branch", base_branch,
             clone_url, repo_dir],
            cwd=work_dir, env=git_env, timeout=180.0,
        )
        if rc != 0:
            # Fallback sin --branch por si el default name difiere
            rc, _, err = await _run_cmd(
                ["git", "clone", "--depth", "50", clone_url, repo_dir],
                cwd=work_dir, env=git_env, timeout=180.0,
            )
            if rc != 0:
                return {"ok": False, "error": f"clone fallo: {err[:400]}"}

        rc, _, err = await _run_cmd(
            ["git", "checkout", "-b", branch_name], cwd=repo_dir, env=git_env
        )
        if rc != 0:
            return {"ok": False, "error": f"checkout -b fallo: {err[:300]}"}

        # 2. Aplicar el workspace sobre el checkout.
        # Estrategia: desempacar el tar en un dir separado, rsync-style copy
        # sobre repo_dir (preservando .git). No borramos archivos — el
        # coding agent decide que sobrescribir; archivos no tocados quedan.
        overlay_dir = os.path.join(work_dir, "_overlay")
        _extract_tar(tar_path, overlay_dir)
        _copy_overlay(overlay_dir, repo_dir)

        # 3. Commit + push
        commit_with_trailer = _with_run_trailer(commit_message, run_id)
        for cmd in [
            ["git", "add", "-A"],
            ["git", "commit", "-m", commit_with_trailer],
        ]:
            rc, out, err = await _run_cmd(cmd, cwd=repo_dir, env=git_env)
            if rc != 0:
                # `git commit` devuelve 1 si no hay cambios. git imprime el
                # mensaje en stdout, no en stderr, asi que chequeamos ambos.
                combined = (out + err).lower()
                if cmd[1] == "commit" and "nothing to commit" in combined:
                    return {
                        "ok": False,
                        "error": "el overlay no introdujo cambios al repo",
                    }
                return {
                    "ok": False,
                    "error": f"{' '.join(cmd)} fallo: {err[:300]}",
                }

        rc, _, err = await _run_cmd(
            ["git", "push", "-u", "origin", branch_name],
            cwd=repo_dir, env=git_env, timeout=180.0,
        )
        if rc != 0:
            return {"ok": False, "error": f"push fallo: {err[:400]}"}

        rc, out, _ = await _run_cmd(
            ["git", "rev-parse", "HEAD"], cwd=repo_dir, env=git_env
        )
        commit_sha = out.strip() if rc == 0 else None

        # 4. Abrir PR
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        owns_client = self._client is None
        try:
            resp = await client.post(
                f"{GITHUB_API}/repos/{owner}/{repo}/pulls",
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                json={
                    "title": pr_title,
                    "head": branch_name,
                    "base": base_branch,
                    "body": pr_body,
                },
            )
        finally:
            if owns_client:
                await client.aclose()

        if resp.status_code >= 300:
            return {
                "ok": False,
                "error": f"POST /pulls fallo {resp.status_code}: {resp.text[:400]}",
                "branch": branch_name,
                "commit_sha": commit_sha,
            }
        pr = resp.json()
        return {
            "ok": True,
            "mode": "brownfield",
            "pr_url": pr["html_url"],
            "pr_number": pr["number"],
            "branch": branch_name,
            "base_branch": base_branch,
            "commit_sha": commit_sha,
            "owner": owner,
            "repo": repo,
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _push_url(self, owner: str, repo: str) -> str:
        return f"https://x-access-token:{self._token}@github.com/{owner}/{repo}.git"

    async def _set_topics(
        self, owner: str, repo: str, topics: list[str]
    ) -> bool:
        """PUT /repos/{owner}/{repo}/topics. Best-effort, devuelve bool."""
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        owns_client = self._client is None
        try:
            resp = await client.put(
                f"{GITHUB_API}/repos/{owner}/{repo}/topics",
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                json={"names": topics},
            )
            ok = resp.status_code < 300
            if not ok:
                print(
                    f"[git_publish] set_topics fallo {resp.status_code}: "
                    f"{resp.text[:200]}",
                    file=sys.stderr, flush=True,
                )
            return ok
        except Exception as e:
            print(f"[git_publish] set_topics exception: {e}", file=sys.stderr, flush=True)
            return False
        finally:
            if owns_client:
                await client.aclose()

    def _git_env(self) -> dict[str, str]:
        """Identidad deterministica para commits del ADLC."""
        return {
            "GIT_AUTHOR_NAME": "ADLC Bot",
            "GIT_AUTHOR_EMAIL": "adlc-bot@users.noreply.github.com",
            "GIT_COMMITTER_NAME": "ADLC Bot",
            "GIT_COMMITTER_EMAIL": "adlc-bot@users.noreply.github.com",
            "GIT_TERMINAL_PROMPT": "0",
        }


def _with_run_trailer(message: str, run_id: str) -> str:
    """
    Appendea un trailer 'ADLC-Run-ID: <run_id>' al final del mensaje
    (formato git trailer estandar). Permite buscar via:
      gh search commits 'ADLC-Run-ID: <run_id>'
      git log --all --grep 'ADLC-Run-ID: <run_id>'
    Idempotente: si ya esta el trailer, no lo duplica.
    """
    body = (message or "").rstrip()
    trailer = f"ADLC-Run-ID: {run_id}"
    if trailer in body:
        return body
    # Asegurar linea en blanco antes del bloque de trailers (convencion git)
    if "\n\n" in body or "\n" not in body:
        return f"{body}\n\n{trailer}\n"
    return f"{body}\n\n{trailer}\n"


def _copy_overlay(src: str, dst: str) -> None:
    """
    Copia archivos de src a dst preservando el .git/ existente en dst.
    Sobrescribe archivos coincidentes. NO borra archivos de dst que no
    existen en src (decision del agente que paso por el sandbox).

    Defensa: si por algun motivo src contiene un .git/ (ej. si la ruta
    viene de un extract viejo sin el filter nuevo), lo saltamos para
    no pisar el .git del clone de brownfield.
    """
    for root, dirs, files in os.walk(src):
        # Prunar .git para no recorrerlo
        if ".git" in dirs:
            dirs.remove(".git")
        rel = os.path.relpath(root, src)
        out_root = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(out_root, exist_ok=True)
        for fn in files:
            shutil.copy2(os.path.join(root, fn), os.path.join(out_root, fn))
