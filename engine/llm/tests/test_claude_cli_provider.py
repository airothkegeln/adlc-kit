"""
Tests del ClaudeCLIProvider con subprocess mockeado.

NO requieren binario `claude` ni sesion OAuth real. Verifican:
  - El provider implementa la interfaz LLMProvider completa
  - Build correcto del cmd con --append-system-prompt y --model
  - Stripping de ANTHROPIC_API_KEY y override de HOME
  - Parsing del envelope JSON de la CLI (result, usage, total_cost_usd)
  - Serializacion de mensajes multi-turno (USER/ASSISTANT/TOOL_RESULT)
  - Inyeccion del bloque de tool-use instructions cuando se pasan tools
  - Parseo de tool_use JSON desde el texto del modelo (con y sin fences)
  - Pasthrough de errores: returncode != 0, JSON invalido, timeout

Para integracion real (requiere `claude login` previo en el host):
    pytest engine/llm/tests/test_claude_cli_real.py
"""

from __future__ import annotations

import inspect
import json
import os
import subprocess
from dataclasses import dataclass

import pytest

from ..base import LLMProvider, Message, ToolSpec


# ----------------------------------------------------------------------
# Fixtures / helpers
# ----------------------------------------------------------------------
@dataclass
class _FakeCompleted:
    returncode: int
    stdout: str
    stderr: str = ""


class _SubprocessSpy:
    """Captura el ultimo subprocess.run y devuelve un resultado canned."""

    def __init__(self, response: _FakeCompleted | Exception):
        self.response = response
        self.last_cmd: list[str] | None = None
        self.last_env: dict[str, str] | None = None
        self.last_kwargs: dict | None = None

    def __call__(self, cmd, **kwargs):
        self.last_cmd = list(cmd)
        self.last_env = dict(kwargs.get("env") or {})
        self.last_kwargs = kwargs
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


@pytest.fixture
def cli_envelope_text():
    """JSON envelope que devolveria `claude -p --output-format json` con texto."""
    return json.dumps({
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": "Hola mundo",
        "session_id": "sess_123",
        "total_cost_usd": 0.0042,
        "usage": {"input_tokens": 120, "output_tokens": 60},
    })


@pytest.fixture
def cli_envelope_tool_use():
    """Envelope cuyo `result` es un JSON tool_use que el provider debe parsear."""
    inner = json.dumps({
        "tool_use": {
            "id": "tu_42",
            "name": "github_search",
            "input": {"query": "machbank onboarding"},
        }
    })
    return json.dumps({
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": inner,
        "total_cost_usd": 0.001,
        "usage": {"input_tokens": 200, "output_tokens": 30},
    })


@pytest.fixture
def patch_which(monkeypatch):
    """shutil.which siempre encuentra el binario."""
    import shutil
    monkeypatch.setattr(shutil, "which", lambda name: f"/usr/local/bin/{name}")


# ----------------------------------------------------------------------
# Interfaz
# ----------------------------------------------------------------------
def test_provider_implements_interface(patch_which):
    from ..claude_cli_provider import ClaudeCLIProvider
    abstract = {
        n for n, m in inspect.getmembers(LLMProvider, predicate=inspect.isfunction)
        if getattr(m, "__isabstractmethod__", False)
    }
    missing = abstract - set(dir(ClaudeCLIProvider))
    assert not missing, f"Faltan miembros abstractos: {missing}"


def test_supports_tools_and_context_window(patch_which):
    from ..claude_cli_provider import ClaudeCLIProvider
    p_std = ClaudeCLIProvider(model="claude-opus-4-6")
    p_1m = ClaudeCLIProvider(model="claude-opus-4-6[1m]")
    assert p_std.supports_tools is True
    assert p_std.context_window == 200_000
    assert p_1m.context_window == 1_000_000
    assert p_std.model_id == "claude-opus-4-6"


def test_binary_not_found_raises(monkeypatch):
    import shutil
    monkeypatch.setattr(shutil, "which", lambda name: None)
    from ..claude_cli_provider import ClaudeCLIProvider
    with pytest.raises(FileNotFoundError, match="claude"):
        ClaudeCLIProvider(binary="claude")


# ----------------------------------------------------------------------
# complete() — texto plano
# ----------------------------------------------------------------------
def test_complete_parses_envelope(monkeypatch, patch_which, cli_envelope_text):
    from ..claude_cli_provider import ClaudeCLIProvider
    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout=cli_envelope_text))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider(model="claude-opus-4-6", home="/home/test")
    r = p.complete(
        messages=[Message(role="user", content="Hola")],
        system="Eres un asistente",
    )

    assert r.content == "Hola mundo"
    assert r.tokens_in == 120
    assert r.tokens_out == 60
    assert r.cost_usd == 0.0042
    assert r.finish_reason == "stop"
    assert r.tool_calls == []
    assert r.model_id == "claude-opus-4-6"


def test_complete_builds_cmd_with_system_and_model(
    monkeypatch, patch_which, cli_envelope_text
):
    from ..claude_cli_provider import ClaudeCLIProvider
    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout=cli_envelope_text))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider(model="claude-haiku-4-5", home="/home/test")
    p.complete(
        messages=[Message(role="user", content="Ping")],
        system="System X",
    )

    cmd = spy.last_cmd
    assert cmd is not None
    assert cmd[0].endswith("/claude")
    assert "-p" in cmd
    assert "--output-format" in cmd and cmd[cmd.index("--output-format") + 1] == "json"
    assert "--model" in cmd and cmd[cmd.index("--model") + 1] == "claude-haiku-4-5"
    assert "--append-system-prompt" in cmd
    assert "System X" in cmd[cmd.index("--append-system-prompt") + 1]
    # El prompt body es el ultimo arg. Incluye el historial serializado +
    # el cierre fuerte "=== FIN DEL HISTORIAL ===" que evita que el modelo
    # continue el historial alucinando tool_results.
    body = cmd[-1]
    assert body.startswith("USER: Ping")
    assert "=== FIN DEL HISTORIAL ===" in body


def test_complete_strips_anthropic_api_key_and_sets_home(
    monkeypatch, patch_which, cli_envelope_text
):
    from ..claude_cli_provider import ClaudeCLIProvider
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-leak")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")

    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout=cli_envelope_text))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider(home="/home/ec2-user")
    p.complete(messages=[Message(role="user", content="x")])

    env = spy.last_env
    assert env is not None
    assert "ANTHROPIC_API_KEY" not in env, "La API key se filtro al subprocess"
    assert env["HOME"] == "/home/ec2-user"
    # Otras vars del env del proceso siguen disponibles (PATH p.ej.)
    assert env.get("PATH") == "/usr/bin:/bin"


def test_complete_serializes_multi_turn(monkeypatch, patch_which, cli_envelope_text):
    from ..claude_cli_provider import ClaudeCLIProvider
    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout=cli_envelope_text))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider()
    p.complete(messages=[
        Message(role="user", content="hola"),
        Message(role="assistant", content="usando tool"),
        Message(role="tool", content='{"results": []}', tool_call_id="tu_1"),
        Message(role="user", content="seguime"),
    ])

    body = spy.last_cmd[-1]
    assert "USER: hola" in body
    assert "ASSISTANT: usando tool" in body
    assert "TOOL_RESULT[tu_1]: " in body
    assert "USER: seguime" in body
    # Orden preservado
    assert body.index("USER: hola") < body.index("ASSISTANT: usando tool") \
        < body.index("TOOL_RESULT[tu_1]") < body.index("USER: seguime")


def test_complete_skips_system_role_in_body(monkeypatch, patch_which, cli_envelope_text):
    from ..claude_cli_provider import ClaudeCLIProvider
    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout=cli_envelope_text))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider()
    p.complete(messages=[
        Message(role="system", content="ignorame"),
        Message(role="user", content="hola"),
    ])
    body = spy.last_cmd[-1]
    assert "ignorame" not in body
    assert "USER: hola" in body


# ----------------------------------------------------------------------
# Tool use via prompt
# ----------------------------------------------------------------------
def test_complete_injects_tool_instructions_when_tools_present(
    monkeypatch, patch_which, cli_envelope_text
):
    from ..claude_cli_provider import ClaudeCLIProvider
    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout=cli_envelope_text))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider()
    p.complete(
        messages=[Message(role="user", content="Buscar")],
        system="Sos discovery",
        tools=[
            ToolSpec(
                name="github_search",
                description="Busca codigo en GitHub",
                input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
            ),
        ],
    )

    sys_prompt_arg = spy.last_cmd[spy.last_cmd.index("--append-system-prompt") + 1]
    assert "Sos discovery" in sys_prompt_arg
    assert "tool_use" in sys_prompt_arg
    assert "final_answer" in sys_prompt_arg
    assert "github_search" in sys_prompt_arg
    assert "Busca codigo en GitHub" in sys_prompt_arg


def test_complete_parses_tool_use_from_result(
    monkeypatch, patch_which, cli_envelope_tool_use
):
    from ..claude_cli_provider import ClaudeCLIProvider
    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout=cli_envelope_tool_use))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider()
    r = p.complete(
        messages=[Message(role="user", content="Buscar")],
        tools=[
            ToolSpec(
                name="github_search",
                description="x",
                input_schema={"type": "object"},
            ),
        ],
    )
    assert r.finish_reason == "tool_use"
    assert r.content == ""
    assert len(r.tool_calls) == 1
    tc = r.tool_calls[0]
    assert tc.id == "tu_42"
    assert tc.name == "github_search"
    assert tc.arguments == {"query": "machbank onboarding"}


def test_complete_parses_tool_use_with_markdown_fences(
    monkeypatch, patch_which
):
    from ..claude_cli_provider import ClaudeCLIProvider
    inner = '```json\n{"tool_use": {"id": "x", "name": "f", "input": {"a": 1}}}\n```'
    envelope = json.dumps({
        "result": inner,
        "usage": {"input_tokens": 1, "output_tokens": 1},
        "total_cost_usd": 0.0,
    })
    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout=envelope))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider()
    r = p.complete(
        messages=[Message(role="user", content="x")],
        tools=[ToolSpec(name="f", description="d", input_schema={})],
    )
    assert r.finish_reason == "tool_use"
    assert r.tool_calls[0].name == "f"
    assert r.tool_calls[0].arguments == {"a": 1}


def test_complete_no_tools_means_text_only_even_if_result_is_json(
    monkeypatch, patch_which, cli_envelope_tool_use
):
    """Si no se pasaron tools, el JSON tool_use queda como texto plano."""
    from ..claude_cli_provider import ClaudeCLIProvider
    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout=cli_envelope_tool_use))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider()
    r = p.complete(messages=[Message(role="user", content="x")])
    assert r.finish_reason == "stop"
    assert r.tool_calls == []
    assert "tool_use" in r.content  # el JSON pasa como texto


def test_complete_final_answer_json_returns_text(monkeypatch, patch_which):
    """Si el modelo emite final_answer (no tool_use), el provider devuelve stop."""
    from ..claude_cli_provider import ClaudeCLIProvider
    inner = json.dumps({"final_answer": "listo"})
    envelope = json.dumps({
        "result": inner,
        "usage": {"input_tokens": 1, "output_tokens": 1},
        "total_cost_usd": 0.0,
    })
    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout=envelope))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider()
    r = p.complete(
        messages=[Message(role="user", content="x")],
        tools=[ToolSpec(name="f", description="d", input_schema={})],
    )
    # final_answer no es tool_use → finish_reason=stop, content preservado
    assert r.finish_reason == "stop"
    assert r.tool_calls == []
    assert "final_answer" in r.content


# ----------------------------------------------------------------------
# Errores
# ----------------------------------------------------------------------
def test_complete_raises_on_nonzero_exit(monkeypatch, patch_which):
    from ..claude_cli_provider import ClaudeCLIProvider
    spy = _SubprocessSpy(_FakeCompleted(returncode=1, stdout="", stderr="login required"))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider()
    with pytest.raises(RuntimeError, match="login required"):
        p.complete(messages=[Message(role="user", content="x")])


def test_complete_raises_on_invalid_json(monkeypatch, patch_which):
    from ..claude_cli_provider import ClaudeCLIProvider
    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout="not json"))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider()
    with pytest.raises(RuntimeError, match="JSON"):
        p.complete(messages=[Message(role="user", content="x")])


def test_complete_raises_on_timeout(monkeypatch, patch_which):
    from ..claude_cli_provider import ClaudeCLIProvider
    spy = _SubprocessSpy(subprocess.TimeoutExpired(cmd="claude", timeout=10))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider(timeout_seconds=10)
    with pytest.raises(TimeoutError, match="10s"):
        p.complete(messages=[Message(role="user", content="x")])


# ----------------------------------------------------------------------
# stream()
# ----------------------------------------------------------------------
def test_stream_yields_text_then_finish(monkeypatch, patch_which, cli_envelope_text):
    from ..claude_cli_provider import ClaudeCLIProvider
    spy = _SubprocessSpy(_FakeCompleted(returncode=0, stdout=cli_envelope_text))
    monkeypatch.setattr(subprocess, "run", spy)

    p = ClaudeCLIProvider()
    chunks = list(p.stream(messages=[Message(role="user", content="x")]))
    assert len(chunks) == 2
    assert chunks[0].delta_text == "Hola mundo"
    assert chunks[1].finish_reason == "stop"


# ----------------------------------------------------------------------
# Registry integration
# ----------------------------------------------------------------------
def test_registry_resolves_claude_cli(patch_which):
    from ..registry import get_provider
    from ..claude_cli_provider import ClaudeCLIProvider
    p = get_provider({"provider": "claude_cli", "model_default": "claude-opus-4-6"})
    assert isinstance(p, ClaudeCLIProvider)
    assert p.model_id == "claude-opus-4-6"
