"""
ClaudeCLIProvider — usa la cuenta Claude Max via la CLI oficial, sin facturar API.

Por que existe:
  - Hay usuarios con suscripcion Claude Max que NO quieren pagar tokens via API.
  - El binario `claude` (instalado con `npm i -g @anthropic-ai/claude-code`) hace
    auth OAuth contra ~/.claude/. Si ANTHROPIC_API_KEY esta en el env, la CLI
    prefiere ese path y factura. Si la stripeamos del env, la CLI usa la
    suscripcion del usuario logueado.
  - Truco validado en news-trader (src/analyzers/claude_analyzer.py:111-116).

Como funciona:
  - Shellea a `claude -p --output-format json --model <m> "<prompt>"`.
  - Limpia ANTHROPIC_API_KEY del env y fuerza HOME al directorio que tiene
    ~/.claude/ con las creds OAuth.
  - El JSON de salida trae `result` (texto), `usage` (tokens) y `total_cost_usd`.

Limitaciones conocidas:
  - La CLI NO expone tool-use nativo al caller (sus tools internas son Read,
    Write, Bash y las maneja el agent loop interno de claude code, no las
    expone como structured calls). Para que el agent runtime de ADLC pueda
    seguir usando un loop de tool-use uniforme, este provider implementa
    tool-use VIA PROMPT: si el caller pasa `tools=[...]`, los inyectamos en
    el system prompt y le pedimos al modelo que responda en JSON estricto
    (`{"tool_use": {...}}` o `{"final_answer": "..."}`). El parseo a ToolCall
    es transparente para el caller.
  - Streaming: la CLI tiene `--output-format stream-json` pero por simplicidad
    este provider hace stream() = complete() y yield del bloque entero. El
    agent runtime de Fase 2 no requiere streaming token a token.
  - Multi-turn: cada complete() flatten-ea el historial completo en un prompt
    string. Es stateless y wasteful pero funciona con el contexto de 1M.

Para reemplazar este provider por otro: ver docs/adding_an_llm_provider.md
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any, Iterator

from .base import (
    LLMProvider,
    LLMResponse,
    Message,
    StreamChunk,
    ToolCall,
    ToolSpec,
)
from .registry import register


# ----------------------------------------------------------------------
# Factory
# ----------------------------------------------------------------------
@register("claude_cli")
def _factory(config: dict) -> "ClaudeCLIProvider":
    return ClaudeCLIProvider(
        binary=config.get("binary", "claude"),
        home=config.get("home"),
        model=config.get("model_default", "claude-opus-4-6"),
        timeout_seconds=config.get("timeout_seconds", 1200),
        extra_args=config.get("extra_args") or [],
    )


# ----------------------------------------------------------------------
# Provider
# ----------------------------------------------------------------------
class ClaudeCLIProvider(LLMProvider):

    def __init__(
        self,
        binary: str = "claude",
        home: str | None = None,
        model: str = "claude-opus-4-6",
        timeout_seconds: int = 1200,
        extra_args: list[str] | None = None,
    ):
        # Resolver path absoluto del binario para no depender del PATH
        # del subprocess (env limpiado).
        resolved = shutil.which(binary) if not os.path.isabs(binary) else binary
        if resolved is None:
            raise FileNotFoundError(
                f"Binario claude '{binary}' no encontrado. "
                f"Instalar con: npm install -g @anthropic-ai/claude-code "
                f"y correr `claude login` para autenticar la cuenta Max."
            )
        self._binary = resolved
        self._home = home or os.environ.get("HOME") or "/root"
        self._model = model
        self._timeout = timeout_seconds
        self._extra_args = list(extra_args or [])

    # ------------------------------------------------------------------
    # interfaz LLMProvider
    # ------------------------------------------------------------------
    @property
    def model_id(self) -> str:
        return self._model

    @property
    def supports_tools(self) -> bool:
        # Tool use simulado via prompt + JSON parsing. Transparente al caller.
        return True

    @property
    def context_window(self) -> int:
        return 1_000_000 if "[1m]" in self._model else 200_000

    def complete(
        self,
        messages: list[Message],
        system: str | None = None,
        tools: list[ToolSpec] | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.0,
        model: str | None = None,
    ) -> LLMResponse:
        effective_model = model or self._model
        prompt = _serialize_messages(messages)
        sys_prompt = (system or "").strip()
        if tools:
            tool_block = _build_tool_instructions(tools)
            sys_prompt = (sys_prompt + "\n\n" + tool_block).strip() if sys_prompt else tool_block

        cmd: list[str] = [
            self._binary,
            "-p",
            "--output-format", "json",
            "--model", effective_model,
            "--max-turns", "1",
            # Deshabilitar TODAS las tools built-in de Claude Code.
            # --tools "" elimina Read/Write/Bash/etc del prompt del modelo.
            "--tools", "",
            # Deshabilitar MCP servers heredados del host (~/.claude.json).
            # Sin esto, los MCPs del usuario (Figma, Notion, etc) se inyectan
            # en el prompt y el modelo intenta llamarlos -> error_max_turns
            # con stop_reason=tool_use. Ademas inflan el cache ~60k tokens.
            # Con --strict-mcp-config + mcpServers vacio, el cache baja a ~6k
            # y el modelo responde solo con texto (nuestro protocolo JSON).
            "--strict-mcp-config",
            "--mcp-config", '{"mcpServers":{}}',
        ]
        if sys_prompt:
            cmd.extend(["--append-system-prompt", sys_prompt])
        cmd.extend(self._extra_args)
        cmd.append(prompt)

        env = _build_env(self._home)

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self._timeout,
                env=env,
            )
        except subprocess.TimeoutExpired as e:
            raise TimeoutError(
                f"claude CLI timeout despues de {self._timeout}s. "
                f"Cmd: {self._binary} -p ..."
            ) from e

        # Intentar parsear JSON incluso con exit != 0 — error_max_turns
        # devuelve exit 1 pero con JSON valido que puede contener texto util.
        try:
            payload: dict[str, Any] = json.loads(result.stdout)
        except (json.JSONDecodeError, ValueError):
            payload = None

        if result.returncode != 0:
            # Si hay JSON con subtype error_max_turns y result no vacío,
            # tratarlo como respuesta parcial en vez de error fatal.
            if payload and payload.get("result") and payload.get("subtype") == "error_max_turns":
                pass  # continuar con el parse normal
            else:
                raise RuntimeError(
                    f"claude CLI fallo (exit {result.returncode}): "
                    f"stderr={result.stderr[:500]} stdout={result.stdout[:500]}"
                )

        if payload is None:
            raise RuntimeError(
                f"claude CLI no devolvio JSON valido: {result.stdout[:500]}"
            )

        # La CLI devuelve un envelope. Nos interesa el campo `result` con el
        # texto final del modelo (despues de su loop interno de tool-use propio).
        text = (payload.get("result") or "").strip()

        # Debug: log raw payload when result is suspiciously empty
        if not text and payload.get("usage", {}).get("output_tokens", 0) > 100:
            import logging
            logging.getLogger("claude_cli").warning(
                "Empty result with %d output_tokens. "
                "subtype=%s stop_reason=%s is_error=%s "
                "result_repr=%r terminal_reason=%s num_turns=%s "
                "stdout_tail=%s",
                payload.get("usage", {}).get("output_tokens", 0),
                payload.get("subtype"),
                payload.get("stop_reason"),
                payload.get("is_error"),
                repr(payload.get("result", ""))[:200],
                payload.get("terminal_reason"),
                payload.get("num_turns"),
                result.stdout[-500:] if len(result.stdout) > 500 else "(see above)",
            )

        usage = payload.get("usage") or {}
        tokens_in = int(usage.get("input_tokens", 0) or 0)
        tokens_out = int(usage.get("output_tokens", 0) or 0)
        cost = float(payload.get("total_cost_usd", 0.0) or 0.0)

        tool_calls: list[ToolCall] = []
        finish_reason = "stop"

        if tools:
            parsed = _try_parse_tool_use(text)
            if parsed is not None:
                tool_calls = [parsed]
                finish_reason = "tool_use"
                # Si el modelo emitio JSON tool_use, vaciamos `content`
                # para mantener el contrato del LLMResponse (igual que el
                # AnthropicProvider con tool_use blocks puros).
                text = ""

        return LLMResponse(
            content=text,
            tool_calls=tool_calls,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd=cost,
            model_id=effective_model,
            finish_reason=finish_reason,
            raw=payload,
        )

    def stream(
        self,
        messages: list[Message],
        system: str | None = None,
        tools: list[ToolSpec] | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.0,
        model: str | None = None,
    ) -> Iterator[StreamChunk]:
        # Implementacion simple: complete() + un solo chunk con todo el texto.
        # Si el agent runtime necesita streaming token a token en el futuro,
        # cambiar a `--output-format stream-json` y parsear JSONL.
        response = self.complete(
            messages=messages,
            system=system,
            tools=tools,
            max_tokens=max_tokens,
            temperature=temperature,
            model=model,
        )
        if response.content:
            yield StreamChunk(delta_text=response.content)
        yield StreamChunk(finish_reason=response.finish_reason)


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def _build_env(home: str) -> dict[str, str]:
    """Env para el subprocess: stripea ANTHROPIC_API_KEY y fuerza HOME."""
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    env["HOME"] = home
    return env


def _serialize_messages(messages: list[Message]) -> str:
    """
    Aplana el historial de Message en un solo prompt string.

    El binario `claude` toma UN argumento de prompt — no expone una API
    multi-turno estructurada. Convertimos:

      Message(role="user", content="...")
      Message(role="assistant", content="...")
      Message(role="tool", tool_call_id="tu_1", content="...")
      Message(role="user", content="...")

    en:

      USER: ...

      ASSISTANT: ...

      TOOL_RESULT[tu_1]: ...

      USER: ...
    """
    parts: list[str] = []
    for m in messages:
        if m.role == "system":
            # System se pasa via --append-system-prompt, no en el prompt body.
            continue
        if m.role == "user":
            parts.append(f"USER: {m.content}")
        elif m.role == "assistant":
            parts.append(f"ASSISTANT: {m.content}")
        elif m.role == "tool":
            tag = m.tool_call_id or "unknown"
            parts.append(f"TOOL_RESULT[{tag}]: {m.content}")
        else:
            parts.append(f"{m.role.upper()}: {m.content}")
    # Cierre fuerte: el CLI `claude -p` es stateless, recibe TODO el historial
    # como un prompt string. Sin este delimitador, el modelo tiende a
    # "continuar el historial" alucinando tool_results fake en un solo turn
    # en vez de responder un JSON unico. Observado en ADLC 2026-04-11.
    parts.append(
        "=== FIN DEL HISTORIAL ===\n"
        "Es tu turno. Responde EXACTAMENTE con UN SOLO objeto JSON: "
        "o un tool_use ({\"tool_use\": {...}}) si necesitas mas info, "
        "o el objeto final del state_patch con las keys que pide el user "
        "message (NO envuelto en final_answer). "
        "NO continues el historial. NO inventes TOOL_RESULT nuevos. "
        "NO escribas prosa antes ni despues del JSON."
    )
    return "\n\n".join(parts)


_TOOL_USE_HEADER = """\
You have access to the following tools. When you need to call a tool, respond with EXACTLY this JSON object and nothing else (no prose, no markdown fences):

{"tool_use": {"id": "<unique-id>", "name": "<tool-name>", "input": {<arguments>}}}

When you have the final answer and do NOT need any more tools, respond with the final JSON object defined by the caller's protocol directly — the object whose fields match what the user message asks you to produce. Do NOT wrap it in {"final_answer": ...} or any other envelope. Just the raw JSON object of the final answer.

Strict rules:
  - Output ONE JSON object per turn. No commentary before or after.
  - Use double quotes (valid JSON).
  - The "input" field must match the tool's input_schema exactly.
  - Do not invent tools. Only use the ones listed below.
  - The final answer JSON must NOT contain a top-level "tool_use" key (otherwise it would be interpreted as another tool call).

Available tools:
"""


def _build_tool_instructions(tools: list[ToolSpec]) -> str:
    lines = [_TOOL_USE_HEADER]
    for t in tools:
        lines.append(f"- name: {t.name}")
        lines.append(f"  description: {t.description}")
        lines.append(f"  input_schema: {json.dumps(t.input_schema)}")
    return "\n".join(lines)


def _try_parse_tool_use(text: str) -> ToolCall | None:
    """
    Intenta parsear el texto del modelo como un JSON `tool_use`.
    Devuelve None si el texto no es un tool_use parseable (puede ser
    final_answer o texto libre).
    """
    s = text.strip()
    if not s:
        return None

    # Strip markdown fences si el modelo no respeto las reglas.
    if s.startswith("```"):
        # ```json\n...\n```
        first_nl = s.find("\n")
        if first_nl != -1:
            s = s[first_nl + 1:]
        if s.endswith("```"):
            s = s[: -3]
        s = s.strip()

    try:
        obj = json.loads(s)
    except (json.JSONDecodeError, ValueError):
        return None

    if not isinstance(obj, dict):
        return None

    tu = obj.get("tool_use")
    if not isinstance(tu, dict):
        return None

    name = tu.get("name")
    if not isinstance(name, str) or not name:
        return None

    return ToolCall(
        id=str(tu.get("id") or "tu_unknown"),
        name=name,
        arguments=dict(tu.get("input") or {}),
    )
