"""
Agent Runtime — ejecuta UN agente end-to-end con tool-use loop.

run_agent() es el corazon. Recibe AgentSpec + LLMProvider + ToolRegistry +
AgentRunContext y corre el loop de tool-use hasta que el modelo devuelve
una respuesta sin tool_calls (= final answer) o se excede algun budget /
guardrail.

NO sabe nada del orquestador, de la DB, ni de phases. Es una funcion pura
en el sentido de que sus dependencias entran por parametro. El orquestador
es responsable de invocarla por cada agente del ciclo y persistir los
state_patch resultantes.

Limitaciones actuales (Paso 2 de Fase 2):
  - Single-shot: una invocacion = un agente. La orquestacion del ciclo
    completo (8 agentes en orden) se cablea en el Paso 4.
  - Tools sincronas/async pero secuenciales: si el modelo emite varios
    tool_calls en un mismo turn, los corremos uno por uno. Anthropic
    permite paralelas; lo dejamos para una iteracion futura cuando un
    agente lo justifique.
  - Timeout por minutos del budget no implementado todavia: contamos
    iteraciones y costo, pero no wall-clock. Lo agregamos cuando un test
    real lo demande.
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any

from llm.base import LLMProvider, Message, ToolCall, ToolSpec
from observability.base import Tracer
from observability.run_log_buffer import run_log

from .base import (
    STATUS_BUDGET_EXCEEDED,
    STATUS_COMPLETED,
    STATUS_GUARDRAIL_VIOLATION,
    STATUS_ITERATION_EXCEEDED,
    STATUS_LLM_ERROR,
    STATUS_TOOL_ERROR,
    AgentResult,
    AgentRunContext,
    AgentSpec,
    Tool,
    ToolRegistry,
    TranscriptEntry,
)


# ----------------------------------------------------------------------
# Public API
# ----------------------------------------------------------------------
async def run_agent(
    spec: AgentSpec,
    provider: LLMProvider,
    tools: ToolRegistry,
    context: AgentRunContext,
    tracer: Tracer | None = None,
) -> AgentResult:
    """
    Ejecuta un agente end-to-end. Ver docstring del modulo.

    Devuelve AgentResult — nunca lanza excepciones por errores esperables
    (budget, iteration, tool failure). Las excepciones inesperadas se
    propagan: el orquestador las captura y marca el run como failed.
    """
    # Filtrar las tools del registry segun la whitelist del spec.
    # Si una tool de la whitelist no esta registrada, ToolRegistry.filter
    # lanza KeyError — eso es intencional, queremos fallar fuerte porque
    # significa un error de configuracion del deploy, no del agente.
    allowed_tools = tools.filter(spec.tools_whitelist)
    tool_specs = _tools_to_specs(allowed_tools)
    tool_by_name = {t.name: t for t in allowed_tools}

    # Mensaje inicial: serializamos el initial_state como JSON dentro
    # del primer USER turn. El system prompt va aparte (lo maneja el provider).
    user_payload = _build_initial_user_message(spec, context)
    messages: list[Message] = [Message(role="user", content=user_payload)]

    transcript: list[TranscriptEntry] = []
    total_tokens_in = 0
    total_tokens_out = 0
    total_cost_usd = 0.0
    iteration = 0
    max_iterations = max(1, spec.guardrails.max_iterations)
    max_cost = spec.budget.max_cost_usd

    final_text: str | None = None

    while iteration < max_iterations:
        iteration += 1

        run_log(
            context.run_id,
            f"[runtime] {spec.name} iter={iteration}/{max_iterations} "
            f"msgs={len(messages)} tools={len(tool_specs)}",
        )

        llm_start = time.monotonic()
        try:
            response = provider.complete(
                messages=messages,
                system=spec.system_prompt,
                tools=tool_specs if tool_specs else None,
                max_tokens=spec.max_tokens,
                temperature=spec.temperature,
                model=spec.model or None,
            )
        except Exception as e:
            if tracer:
                tracer.event("llm_error", run_id=context.run_id, agent=spec.name, iteration=iteration, error=str(e)[:200])
            return AgentResult(
                status=STATUS_LLM_ERROR,
                state_patch={},
                iterations_used=iteration,
                total_tokens_in=total_tokens_in,
                total_tokens_out=total_tokens_out,
                total_cost_usd=total_cost_usd,
                transcript=transcript,
                error_message=f"LLM call fallo en iter {iteration}: {e}",
            )
        llm_elapsed_ms = int((time.monotonic() - llm_start) * 1000)

        total_tokens_in += response.tokens_in
        total_tokens_out += response.tokens_out
        total_cost_usd += response.cost_usd

        n_calls = len(response.tool_calls)
        run_log(
            context.run_id,
            f"[runtime] {spec.name} iter={iteration} llm_ok "
            f"tokens_in={response.tokens_in} tokens_out={response.tokens_out} "
            f"cost=${response.cost_usd:.4f} tool_calls={n_calls}",
        )

        # Emit LLM call metrics
        if tracer:
            tracer.metric("llm_tokens_in", response.tokens_in, run_id=context.run_id, agent=spec.name, iteration=iteration)
            tracer.metric("llm_tokens_out", response.tokens_out, run_id=context.run_id, agent=spec.name, iteration=iteration)
            tracer.metric("llm_cost_usd", response.cost_usd, run_id=context.run_id, agent=spec.name, iteration=iteration)
            tracer.metric("llm_latency_ms", llm_elapsed_ms, run_id=context.run_id, agent=spec.name, iteration=iteration)

        transcript.append(TranscriptEntry(
            iteration=iteration,
            role="llm",
            content=response.content,
            tokens_in=response.tokens_in,
            tokens_out=response.tokens_out,
            cost_usd=response.cost_usd,
        ))

        # Budget check despues de cada llamada (no antes — la llamada
        # actual ya consumio costo y queremos contarlo)
        if total_cost_usd > max_cost:
            if tracer:
                tracer.event("budget_exceeded", run_id=context.run_id, agent=spec.name, total_cost_usd=total_cost_usd, max_cost=max_cost)
            return AgentResult(
                status=STATUS_BUDGET_EXCEEDED,
                state_patch={},
                iterations_used=iteration,
                total_tokens_in=total_tokens_in,
                total_tokens_out=total_tokens_out,
                total_cost_usd=total_cost_usd,
                transcript=transcript,
                error_message=(
                    f"Budget excedido: {total_cost_usd:.4f} USD > "
                    f"{max_cost:.4f} USD (cap del agente {spec.name})"
                ),
            )

        # Caso 1: el modelo pidio tool_use → ejecutar y seguir
        if response.tool_calls:
            # Append del assistant turn que pidio el tool_use
            assistant_turn = _serialize_assistant_with_tool_calls(
                response.content, response.tool_calls
            )
            messages.append(Message(role="assistant", content=assistant_turn))

            for tc in response.tool_calls:
                run_log(
                    context.run_id,
                    f"[runtime] {spec.name} iter={iteration} tool_call "
                    f"name={tc.name} args={json.dumps(tc.arguments, ensure_ascii=False)[:200]}",
                )
                tool_start = time.monotonic()
                tool_result_str, tool_failed = await _execute_tool(
                    tc, tool_by_name
                )
                tool_elapsed_ms = int((time.monotonic() - tool_start) * 1000)
                run_log(
                    context.run_id,
                    f"[runtime] {spec.name} iter={iteration} tool_result "
                    f"name={tc.name} failed={tool_failed} len={len(tool_result_str)}",
                )
                if tracer:
                    tracer.event(
                        "tool_executed",
                        run_id=context.run_id,
                        agent=spec.name,
                        tool_name=tc.name,
                        iteration=iteration,
                        failed=tool_failed,
                        duration_ms=tool_elapsed_ms,
                        result_len=len(tool_result_str),
                    )
                transcript.append(TranscriptEntry(
                    iteration=iteration,
                    role="tool",
                    content=tool_result_str,
                    tool_name=tc.name,
                    tool_arguments=tc.arguments,
                ))
                messages.append(Message(
                    role="tool",
                    content=tool_result_str,
                    tool_call_id=tc.id,
                    name=tc.name,
                ))
                if tool_failed:
                    if tracer:
                        tracer.event("tool_error", run_id=context.run_id, agent=spec.name, tool_name=tc.name, iteration=iteration)
                    return AgentResult(
                        status=STATUS_TOOL_ERROR,
                        state_patch={},
                        iterations_used=iteration,
                        total_tokens_in=total_tokens_in,
                        total_tokens_out=total_tokens_out,
                        total_cost_usd=total_cost_usd,
                        transcript=transcript,
                        error_message=tool_result_str,
                    )
            continue  # siguiente iter del while

        # Caso 2: no hay tool_calls → es la respuesta final
        # Guard: si el modelo consumió tokens pero devolvió text vacío
        # (extended thinking sin respuesta visible), no lo tratamos como
        # final_answer — le pedimos que produzca el JSON requerido.
        if not (response.content or "").strip() and response.tokens_out > 50:
            run_log(
                context.run_id,
                f"[runtime] {spec.name} iter={iteration} empty_result_with_tokens "
                f"tokens_out={response.tokens_out} — requesting JSON output",
            )
            if tracer:
                tracer.event(
                    "empty_result_retry",
                    run_id=context.run_id,
                    agent=spec.name,
                    iteration=iteration,
                    tokens_out=response.tokens_out,
                )
            messages.append(Message(role="assistant", content=""))
            nudge = (
                "Tu respuesta anterior estaba vacía. DEBES responder con el "
                "OBJETO JSON requerido. No incluyas texto fuera del JSON."
            )
            if spec.writes:
                nudge += " Campos requeridos: " + ", ".join(spec.writes)
            messages.append(Message(role="user", content=nudge))
            continue  # siguiente iter del while

        final_text = response.content
        break

    # Salida del while: o final_text seteado, o iteration_exceeded.
    # Si iteration_exceeded y la última respuesta fue tool_use, hacer UN
    # intento final pidiendo el JSON sin tools (grace nudge).
    if final_text is None:
        run_log(
            context.run_id,
            f"[runtime] {spec.name} iteration_exceeded — attempting grace nudge for JSON output",
        )
        grace_nudge = (
            "Has agotado tus iteraciones de tools. DEBES responder AHORA con "
            "el OBJETO JSON final requerido, usando SOLO la información que ya "
            "recopilaste. NO intentes usar tools. Responde ÚNICAMENTE con un "
            "JSON válido."
        )
        if spec.writes:
            grace_nudge += " Campos obligatorios: " + ", ".join(spec.writes)
        messages.append(Message(role="user", content=grace_nudge))
        try:
            grace_response = provider.complete(
                messages=messages,
                system=spec.system_prompt,
                tools=None,  # SIN tools para forzar texto
                max_tokens=spec.max_tokens,
                model=spec.model,
            )
            total_tokens_in += grace_response.tokens_in
            total_tokens_out += grace_response.tokens_out
            total_cost_usd += grace_response.cost_usd
            grace_text = (grace_response.content or "").strip()
            run_log(
                context.run_id,
                f"[runtime] {spec.name} grace_nudge got {len(grace_text)} chars, "
                f"cost=${grace_response.cost_usd:.4f}",
            )
            if grace_text:
                final_text = grace_text
                transcript.append(TranscriptEntry(
                    iteration=iteration + 1,
                    role="llm",
                    content=grace_text[:500],
                ))
        except Exception as e:
            run_log(
                context.run_id,
                f"[runtime] {spec.name} grace_nudge failed: {e}",
            )

    if final_text is None:
        if tracer:
            tracer.event("iteration_exceeded", run_id=context.run_id, agent=spec.name, iterations_used=iteration, max_iterations=max_iterations)
        return AgentResult(
            status=STATUS_ITERATION_EXCEEDED,
            state_patch={},
            iterations_used=iteration,
            total_tokens_in=total_tokens_in,
            total_tokens_out=total_tokens_out,
            total_cost_usd=total_cost_usd,
            transcript=transcript,
            error_message=(
                f"max_iterations ({max_iterations}) alcanzado sin final_answer "
                f"para el agente {spec.name}"
            ),
        )

    # Parsear final_text como state_patch (JSON)
    state_patch = _parse_final_answer(final_text)

    # Auto-wrap: varios agentes tienen writes=[K] (una sola key top-level
    # que envuelve un objeto anidado, ej. stack_contract). Los LLMs tienden
    # a devolver las keys internas planas ({language, framework, ...}) en
    # vez del objeto envuelto ({stack_contract: {language, ...}}), aun con
    # prompts explicitos. Cuando el patron es inequivoco — un solo required
    # output, un solo writes, ambos iguales, y la key no aparece en el
    # patch — envolvemos el patch entero bajo esa key.
    if (
        len(spec.guardrails.required_outputs) == 1
        and len(spec.writes) == 1
        and spec.guardrails.required_outputs[0] == spec.writes[0]
        and spec.writes[0] not in state_patch
        and state_patch
        and not any(k.startswith("raw_") for k in state_patch)
    ):
        wrap_key = spec.writes[0]
        run_log(
            context.run_id,
            f"[runtime] {spec.name} auto-wrap: {sorted(state_patch.keys())} -> {{{wrap_key}: ...}}",
        )
        state_patch = {wrap_key: state_patch}

    # Validar required_outputs. Si faltan y el patch tiene raw_text con
    # tool_use embebido, hacer un grace nudge pidiendo JSON sin tools.
    missing = [k for k in spec.guardrails.required_outputs if k not in state_patch]
    if missing and "raw_text" in state_patch and "tool_use" in state_patch.get("raw_text", ""):
        run_log(
            context.run_id,
            f"[runtime] {spec.name} raw_text contains tool_use — grace nudge for JSON",
        )
        grace_nudge = (
            "Tu respuesta anterior contenía una llamada a tool en vez del JSON "
            "final. DEBES responder AHORA con el OBJETO JSON requerido usando "
            "la información que ya tienes. NO uses tools. Responde SOLO con JSON."
        )
        if spec.writes:
            grace_nudge += " Campos obligatorios: " + ", ".join(spec.writes)
        messages.append(Message(role="assistant", content=final_text or ""))
        messages.append(Message(role="user", content=grace_nudge))
        try:
            retry_resp = provider.complete(
                messages=messages,
                system=spec.system_prompt,
                tools=None,
                max_tokens=spec.max_tokens,
                model=spec.model,
            )
            total_cost_usd += retry_resp.cost_usd
            retry_text = (retry_resp.content or "").strip()
            if retry_text:
                state_patch = _parse_final_answer(retry_text)
                missing = [k for k in spec.guardrails.required_outputs if k not in state_patch]
                run_log(
                    context.run_id,
                    f"[runtime] {spec.name} grace_nudge_retry keys={sorted(state_patch.keys())} missing={missing}",
                )
        except Exception as e:
            run_log(context.run_id, f"[runtime] {spec.name} grace_nudge_retry failed: {e}")

    if missing:
        if tracer:
            tracer.event("guardrail_violation", run_id=context.run_id, agent=spec.name, missing_outputs=missing)
        return AgentResult(
            status=STATUS_GUARDRAIL_VIOLATION,
            state_patch=state_patch,
            iterations_used=iteration,
            total_tokens_in=total_tokens_in,
            total_tokens_out=total_tokens_out,
            total_cost_usd=total_cost_usd,
            transcript=transcript,
            error_message=(
                f"required_outputs faltantes en el state_patch: {missing}. "
                f"Keys presentes: {sorted(state_patch.keys())}. "
                f"raw_text[:800]={state_patch.get('raw_text','')[:800]!r}. "
                f"El agente {spec.name} debe escribir todos los campos declarados."
            ),
        )

    return AgentResult(
        status=STATUS_COMPLETED,
        state_patch=state_patch,
        iterations_used=iteration,
        total_tokens_in=total_tokens_in,
        total_tokens_out=total_tokens_out,
        total_cost_usd=total_cost_usd,
        transcript=transcript,
    )


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def _tools_to_specs(tools: list[Tool]) -> list[ToolSpec]:
    return [
        ToolSpec(
            name=t.name,
            description=t.description,
            input_schema=t.input_schema,
        )
        for t in tools
    ]


def _build_initial_user_message(spec: AgentSpec, context: AgentRunContext) -> str:
    """
    Construye el primer USER turn del loop. Inyecta:
      - el state inicial filtrado por los `reads` del spec (si existen)
      - instrucciones de formato del final_answer

    El system_prompt del spec se pasa por separado al provider — no va aca.
    """
    # Si reads esta declarado, filtramos. Si no, pasamos todo el state.
    if spec.reads:
        filtered = {k: context.initial_state.get(k) for k in spec.reads if k in context.initial_state}
    else:
        filtered = dict(context.initial_state)

    final_format_instructions = (
        "\n\nCuando tengas la respuesta final (no necesites mas tools), "
        "responde con un OBJETO JSON que contenga TODOS los siguientes campos:\n"
        + "\n".join(f"  - {w}" for w in spec.writes)
        + "\n\nEl JSON debe ser parseable. No incluyas texto fuera del JSON."
        if spec.writes
        else ""
    )

    return (
        f"Run ID: {context.run_id}\n"
        f"Requester: {context.requester or '(no especificado)'}\n\n"
        f"Project state inicial:\n```json\n{json.dumps(filtered, indent=2, ensure_ascii=False)}\n```"
        f"{final_format_instructions}"
    )


def _serialize_assistant_with_tool_calls(
    content: str, tool_calls: list[ToolCall]
) -> str:
    """
    Serializacion textual del assistant turn cuando incluye tool_calls.
    Necesario porque el contrato de Message del LLMProvider solo guarda
    `content` como string. Esta serializacion es informativa — el provider
    no la re-parsea, solo la incluye en el historial enviado al modelo
    para que tenga contexto de su decision previa.
    """
    parts = []
    if content:
        parts.append(content)
    for tc in tool_calls:
        parts.append(
            f"[tool_use id={tc.id} name={tc.name}] "
            f"{json.dumps(tc.arguments, ensure_ascii=False)}"
        )
    return "\n".join(parts)


async def _execute_tool(
    tc: ToolCall, tool_by_name: dict[str, Tool]
) -> tuple[str, bool]:
    """
    Ejecuta una tool call. Devuelve (resultado_serializado, fallo_bool).

    Errores de la tool se devuelven como string + flag. El runtime decide
    si abortar o pasarle el error al LLM como tool_result (para que pueda
    auto-corregir). En esta version, ABORTAMOS al primer error de tool —
    es mas seguro y mas facil de debuggear hasta que veamos casos reales
    donde valga la pena el self-recovery.
    """
    if tc.name not in tool_by_name:
        return (
            f"ERROR: tool '{tc.name}' no esta en la whitelist del agente. "
            f"Disponibles: {list(tool_by_name)}",
            True,
        )

    tool = tool_by_name[tc.name]
    try:
        result = await tool.run(tc.arguments)
    except Exception as e:
        return (f"ERROR ejecutando tool '{tc.name}': {e}", True)

    try:
        return (json.dumps(result, ensure_ascii=False, default=str), False)
    except (TypeError, ValueError) as e:
        return (f"ERROR serializando resultado de '{tc.name}': {e}", True)


def _parse_final_answer(text: str) -> dict[str, Any]:
    """
    Intenta parsear el texto final del LLM como JSON. Si falla, devuelve
    {"raw_text": text} para que el caller pueda inspeccionarlo.

    Tolera:
      - Fences markdown ```json ... ```
      - JSON embebido dentro de prosa (busca el primer '{' … último '}')
      - Múltiples bloques fenced (toma el primero que parsee como dict)
    """
    s = (text or "").strip()
    if not s:
        return {}

    # --- Estrategia 1: texto completo es JSON puro ---
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except (json.JSONDecodeError, ValueError):
        pass

    # --- Estrategia 2: extraer de fences markdown ```json ... ``` ---
    import re
    fence_pattern = re.compile(r"```(?:json)?\s*\n(.*?)```", re.DOTALL)
    for match in fence_pattern.finditer(s):
        candidate = match.group(1).strip()
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                return obj
        except (json.JSONDecodeError, ValueError):
            continue

    # --- Estrategia 3: buscar el primer '{' y el último '}' ---
    first_brace = s.find("{")
    last_brace = s.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        candidate = s[first_brace : last_brace + 1]
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                return obj
        except (json.JSONDecodeError, ValueError):
            pass

    return {"raw_text": text}
