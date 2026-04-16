"""
DockerSandbox — implementación default de la interfaz Sandbox.

Usa docker-py para ejecutar comandos dentro de un container sidecar
(`adlc-sandbox` por default, override con ADLC_SANDBOX_CONTAINER). El
container corre long-lived con `tail -f /dev/null`; cada SandboxRequest:
  1. Limpia el workspace previo (`rm -rf /workspace/*`)
  2. `git clone <repo_url> /workspace/repo`
  3. `git checkout <branch>`
  4. Ejecuta cada comando de la lista en /workspace/repo con timeout
  5. Captura stdout+stderr, diff, files_changed

Requisitos:
  - El host donde corre el engine debe montar /var/run/docker.sock en el
    engine container (ver docker-compose.yml).
  - El container sidecar debe existir. Si no, la tool devuelve error
    claro indicando cómo levantarlo.

Limitaciones conocidas (MVP):
  - Los comandos corren secuencialmente; si uno falla, seguimos y dejamos
    que el caller decida. El exit_code devuelto es el del ÚLTIMO comando.
  - No soporta stdin interactivo; todo por argv.
  - No soporta push al repo — eso va en otra tool (sandbox_push) o en
    una segunda iter del coding agent cuando los specs lo requieran.
  - files_changed se calcula con `git status --porcelain` sobre el repo
    clonado, después de ejecutar los comandos.
"""

from __future__ import annotations

import asyncio
import gzip
import io
import os
import shlex
import shutil
import sys
import tarfile
import time
from typing import Any

from .base import Sandbox, SandboxRequest, SandboxResult


class DockerSandbox(Sandbox):
    """
    Implementación que usa un container Docker long-lived como sandbox.

    El engine habla con él via docker-py (lib `docker`) sobre el socket
    montado en /var/run/docker.sock. Cada request limpia y re-inicializa
    el workspace adentro del container.
    """

    def __init__(
        self,
        container_name: str | None = None,
        workspace_dir: str = "/workspace",
        default_timeout_seconds: int = 600,
    ):
        self._container_name = (
            container_name
            or os.environ.get("ADLC_SANDBOX_CONTAINER", "adlc-sandbox")
        )
        self._workspace = workspace_dir
        self._default_timeout = default_timeout_seconds
        self._client = None  # lazy: no se importa docker-py hasta que se usa

    # ------------------------------------------------------------------
    # interfaz Sandbox
    # ------------------------------------------------------------------
    async def health_check(self) -> bool:
        """True si el container sidecar existe y está corriendo."""
        try:
            client = self._get_client()
            container = client.containers.get(self._container_name)
            return container.status == "running"
        except Exception:
            return False

    async def run(self, request: SandboxRequest) -> SandboxResult:
        """
        Ejecuta el job completo en el container sidecar. Ver docstring
        del módulo para el orden de pasos.
        """
        start_ts = time.monotonic()
        try:
            client = self._get_client()
            container = client.containers.get(self._container_name)
        except Exception as e:
            return SandboxResult(
                exit_code=127,
                stdout="",
                stderr=(
                    f"DockerSandbox: container '{self._container_name}' no accesible: {e}. "
                    f"Verificar que el servicio `sandbox` este up (docker compose up -d sandbox) "
                    f"y que /var/run/docker.sock este montado en el engine."
                ),
                duration_ms=int((time.monotonic() - start_ts) * 1000),
            )

        if container.status != "running":
            return SandboxResult(
                exit_code=127,
                stdout="",
                stderr=(
                    f"DockerSandbox: container '{self._container_name}' en estado "
                    f"'{container.status}' (se esperaba 'running')."
                ),
                duration_ms=int((time.monotonic() - start_ts) * 1000),
            )

        repo_dir = f"{self._workspace}/repo"
        timeout = request.timeout_seconds or self._default_timeout

        # 1. Limpiar workspace previo
        stdout, stderr, rc = await self._exec(
            container, f"rm -rf {shlex.quote(repo_dir)}", cwd=self._workspace, timeout=30
        )
        if rc != 0:
            return SandboxResult(
                exit_code=rc, stdout=stdout, stderr=f"[clean] {stderr}",
                duration_ms=int((time.monotonic() - start_ts) * 1000),
            )

        # 2. Preparar repo_dir: clone del remoto (brownfield) o init vacio
        # (greenfield — repo_url vacio significa "no hay remoto todavia,
        # el workspace se arma 100% desde overlay").
        if request.repo_url:
            clone_cmd = (
                f"git clone --depth 1 --branch {shlex.quote(request.branch)} "
                f"{shlex.quote(request.repo_url)} {shlex.quote(repo_dir)}"
            )
            stdout, stderr, rc = await self._exec(
                container, clone_cmd, cwd=self._workspace, timeout=120
            )
            if rc != 0:
                # Fallback: sin --branch (por si el default branch es distinto)
                stdout, stderr, rc = await self._exec(
                    container,
                    f"git clone --depth 1 {shlex.quote(request.repo_url)} {shlex.quote(repo_dir)}",
                    cwd=self._workspace, timeout=120,
                )
                if rc != 0:
                    return SandboxResult(
                        exit_code=rc, stdout=stdout, stderr=f"[clone] {stderr}",
                        duration_ms=int((time.monotonic() - start_ts) * 1000),
                    )
        else:
            # No-clone: mkdir + git init para que git status/diff despues
            # no exploten. Requiere overlay_archive_path para tener algo
            # que ejecutar — si no, commands contra dir vacio es no-op.
            stdout, stderr, rc = await self._exec(
                container,
                f"mkdir -p {shlex.quote(repo_dir)} && git init {shlex.quote(repo_dir)}",
                cwd=self._workspace, timeout=30,
            )
            if rc != 0:
                return SandboxResult(
                    exit_code=rc, stdout=stdout, stderr=f"[init] {stderr}",
                    duration_ms=int((time.monotonic() - start_ts) * 1000),
                )

        # 2b. Overlay opcional: extrae un tar.gz del engine sobre /workspace/repo,
        # strippeando el prefix 'repo/' que docker get_archive agrego al empacar.
        # Usado por validation para rehidratar el workspace del coding.
        if request.overlay_archive_path:
            ok, ov_err = await self._apply_overlay(
                container, request.overlay_archive_path, repo_dir
            )
            if not ok:
                return SandboxResult(
                    exit_code=1, stdout="", stderr=f"[overlay] {ov_err}",
                    duration_ms=int((time.monotonic() - start_ts) * 1000),
                )

        # 3. Ejecutar cada comando en /workspace/repo
        full_stdout: list[str] = []
        full_stderr: list[str] = []
        last_rc = 0
        for cmd in request.commands:
            out, err, rc = await self._exec(
                container, cmd, cwd=repo_dir, timeout=timeout, env=request.env,
            )
            full_stdout.append(f"$ {cmd}\n{out}")
            if err:
                full_stderr.append(f"$ {cmd}\n{err}")
            last_rc = rc
            if rc != 0:
                # Seguimos ejecutando — dejamos que el caller decida si continuar,
                # pero marcamos el exit_code como no-cero.
                break

        # 4. Capturar files_changed + diff del repo
        diff_out, _, _ = await self._exec(
            container, "git diff", cwd=repo_dir, timeout=30
        )
        status_out, _, _ = await self._exec(
            container, "git status --porcelain", cwd=repo_dir, timeout=30
        )
        files_changed = _parse_git_status(status_out)

        duration_ms = int((time.monotonic() - start_ts) * 1000)
        return SandboxResult(
            exit_code=last_rc,
            stdout="\n".join(full_stdout),
            stderr="\n".join(full_stderr),
            duration_ms=duration_ms,
            files_changed=files_changed,
            diff=diff_out,
        )

    async def snapshot(self, dest_path: str) -> None:
        """
        Empaqueta /workspace/repo en un tar.gz en dest_path (host del engine).

        Implementacion: docker-py `container.get_archive(path)` devuelve un
        stream de tar SIN gzip. Lo pasamos por gzip al escribir a disco para
        mantener el artefacto compacto. Corremos el IO en un executor thread
        porque el stream es sincronico.

        No fallamos si el workspace esta vacio — escribimos un tar.gz vacio
        valido para que el caller no tenga que chequear existencia.
        """
        try:
            client = self._get_client()
            container = client.containers.get(self._container_name)
        except Exception as e:
            raise RuntimeError(
                f"DockerSandbox.snapshot: container '{self._container_name}' "
                f"no accesible: {e}"
            ) from e

        repo_dir = f"{self._workspace}/repo"

        def _blocking_snapshot():
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            try:
                stream, _stat = container.get_archive(repo_dir)
            except Exception as e:
                # repo_dir no existe (ej. el run fallo antes del clone) —
                # escribimos un tar.gz vacio y salimos sin error.
                print(
                    f"[docker_sandbox] snapshot: {repo_dir} no existe ({e}) — "
                    f"tar vacio en {dest_path}",
                    file=sys.stderr, flush=True,
                )
                with gzip.open(dest_path, "wb") as gz:
                    with tarfile.open(fileobj=gz, mode="w"):
                        pass
                return

            # Concatenamos el stream de tar crudo a un buffer y luego lo
            # gzipeamos a disco. Evitamos mantener todo en RAM si el repo
            # es grande? Para el MVP un repo tipico son MB, aceptable.
            buf = io.BytesIO()
            for chunk in stream:
                buf.write(chunk)
            buf.seek(0)
            with gzip.open(dest_path, "wb") as gz:
                shutil.copyfileobj(buf, gz)

        loop = asyncio.get_running_loop()
        snap_start = time.monotonic()
        await loop.run_in_executor(None, _blocking_snapshot)
        elapsed_ms = int((time.monotonic() - snap_start) * 1000)
        size = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
        print(
            f"[docker_sandbox] snapshot wrote {dest_path} "
            f"({size}b, {elapsed_ms}ms)",
            file=sys.stderr, flush=True,
        )

    async def _apply_overlay(
        self, container, overlay_path: str, repo_dir: str
    ) -> tuple[bool, str]:
        """
        Mete overlay_path (tar.gz en el engine) dentro del sandbox y lo
        desempaca sobre repo_dir. Devuelve (ok, error_msg).

        Mecanica:
          1. Leer el archivo local.
          2. Envolverlo en un tar one-entry con nombre 'overlay.tar.gz'
             y mandarlo a /tmp via container.put_archive (que espera un
             tar, no gzip).
          3. Correr `tar xzf /tmp/overlay.tar.gz -C repo_dir --strip-components=1`.
          4. Limpiar /tmp/overlay.tar.gz.
        """
        if not os.path.exists(overlay_path):
            return False, f"overlay_archive_path no existe: {overlay_path}"

        loop = asyncio.get_running_loop()

        def _put():
            with open(overlay_path, "rb") as f:
                data = f.read()
            inner = io.BytesIO()
            with tarfile.open(fileobj=inner, mode="w") as tf:
                info = tarfile.TarInfo(name="overlay.tar.gz")
                info.size = len(data)
                info.mode = 0o644
                tf.addfile(info, io.BytesIO(data))
            inner.seek(0)
            return container.put_archive("/tmp", inner.read())

        ok = await loop.run_in_executor(None, _put)
        if not ok:
            return False, "container.put_archive devolvio False"

        # Extraer. --strip-components=1 porque get_archive empaco con
        # prefix 'repo/' (basename de /workspace/repo).
        _, err, rc = await self._exec(
            container,
            f"tar xzf /tmp/overlay.tar.gz -C {shlex.quote(repo_dir)} --strip-components=1 && rm -f /tmp/overlay.tar.gz",
            cwd=self._workspace, timeout=60,
        )
        if rc != 0:
            return False, f"tar xzf fallo: {err[:400]}"
        print(
            f"[docker_sandbox] overlay applied from {overlay_path} -> {repo_dir}",
            file=sys.stderr, flush=True,
        )
        return True, ""

    # ------------------------------------------------------------------
    # Helpers internos
    # ------------------------------------------------------------------
    def _get_client(self):
        """Lazy init del docker client. Importa docker-py solo cuando se usa."""
        if self._client is None:
            import docker  # type: ignore
            self._client = docker.from_env()
        return self._client

    async def _exec(
        self,
        container,
        command: str,
        cwd: str,
        timeout: int,
        env: dict[str, str] | None = None,
    ) -> tuple[str, str, int]:
        """
        Ejecuta un comando en el container via exec_run.

        docker-py.exec_run es sync → corremos en un executor thread para
        no bloquear el loop asyncio. Wrapeamos con `timeout` en el container
        usando `timeout N sh -c "..."`.

        Devuelve (stdout, stderr, exit_code). docker-py retorna stderr
        combinado con stdout cuando demux=False; usamos demux=True para
        separarlos.
        """
        timeout_cmd = f"timeout {timeout} sh -c {shlex.quote(command)}"
        first_line = command.strip().split("\n", 1)[0][:100]
        print(
            f"[docker_sandbox] exec cwd={cwd} timeout={timeout}s  $ {first_line}",
            file=sys.stderr, flush=True,
        )
        exec_start = time.monotonic()

        def _blocking_exec():
            return container.exec_run(
                cmd=["sh", "-c", timeout_cmd],
                workdir=cwd,
                environment=env or {},
                demux=True,   # separar stdout y stderr
                tty=False,
            )

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _blocking_exec)
        exit_code = result.exit_code
        stdout_bytes, stderr_bytes = result.output
        stdout = _decode(stdout_bytes)
        stderr = _decode(stderr_bytes)
        elapsed_ms = int((time.monotonic() - exec_start) * 1000)
        print(
            f"[docker_sandbox] exec exit={exit_code} elapsed={elapsed_ms}ms "
            f"stdout={len(stdout)}b stderr={len(stderr)}b",
            file=sys.stderr, flush=True,
        )
        return stdout, stderr, exit_code


def _decode(b: Any) -> str:
    if b is None:
        return ""
    if isinstance(b, bytes):
        return b.decode("utf-8", errors="replace")
    return str(b)


def _parse_git_status(status_out: str) -> list[str]:
    """
    Parsea la salida de `git status --porcelain` y devuelve los paths
    que cambiaron (incluye untracked, modified, added, etc).
    """
    files = []
    for line in status_out.splitlines():
        if not line.strip():
            continue
        # Formato: "XY path" donde X,Y son flags de estado. Pueden haber
        # rename "-> newpath", ignoramos esa complicación en el MVP.
        parts = line.strip().split(None, 1)
        if len(parts) == 2:
            files.append(parts[1].strip())
    return files
