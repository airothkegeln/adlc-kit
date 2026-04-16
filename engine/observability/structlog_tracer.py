"""
StructlogTracer — implementación concreta del Tracer ABC.

Emite JSON structured logs a stderr (visible en `docker logs`) y alimenta
el RunLogBuffer para que la UI pueda streamear métricas en tiempo real.

Acumula métricas in-memory para exposición via GET /metrics:
  - Contadores por agente: tokens_in, tokens_out, cost_usd, duration_ms
  - Contadores globales: total de spans, eventos, errores
  - Historial de spans recientes (ring buffer, últimos 200)

Thread-safety: NO requerido (asyncio single-thread). Si se migra a
multi-worker, proteger _metrics con Lock.

Reemplazable por Langfuse, LangSmith, Phoenix, OpenTelemetry — solo
cambiar el driver en config.
"""

from __future__ import annotations

import json
import sys
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from typing import Any

from .base import Tracer
from .run_log_buffer import RunLogBuffer


class StructlogTracer(Tracer):

    def __init__(self, run_id: str | None = None):
        # run_id default: se puede setear per-span o per-event via kwargs
        self._default_run_id = run_id

        # --- Acumuladores in-memory ---
        # Por agente: {"discovery": {"tokens_in": 0, "tokens_out": 0, ...}}
        self._agent_metrics: dict[str, dict[str, float]] = defaultdict(
            lambda: {
                "tokens_in": 0,
                "tokens_out": 0,
                "cost_usd": 0.0,
                "duration_ms": 0,
                "llm_calls": 0,
                "tool_calls": 0,
                "errors": 0,
            }
        )

        # Globales
        self._total_events = 0
        self._total_spans = 0
        self._total_errors = 0

        # Ring buffer de spans recientes (para /metrics detail)
        self._recent_spans: deque[dict[str, Any]] = deque(maxlen=200)

    # ------------------------------------------------------------------
    # Tracer ABC
    # ------------------------------------------------------------------
    def event(self, name: str, **fields: Any) -> None:
        self._total_events += 1

        if "error" in name or fields.get("failed"):
            self._total_errors += 1
            agent = fields.get("agent", "unknown")
            self._agent_metrics[agent]["errors"] += 1

        entry = {"type": "event", "name": name, "ts": time.time(), **fields}
        self._emit(entry, fields)

    @contextmanager
    def span(self, name: str, **fields: Any):
        self._total_spans += 1
        start = time.monotonic()
        ts_start = time.time()

        entry = {"type": "span_start", "name": name, "ts": ts_start, **fields}
        self._emit(entry, fields)

        try:
            yield
        except Exception:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            err_entry = {
                "type": "span_error",
                "name": name,
                "duration_ms": elapsed_ms,
                "ts": time.time(),
                **fields,
            }
            self._emit(err_entry, fields)
            self._total_errors += 1
            raise
        else:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            end_entry = {
                "type": "span_end",
                "name": name,
                "duration_ms": elapsed_ms,
                "ts": time.time(),
                **fields,
            }
            self._emit(end_entry, fields)
            self._recent_spans.append(end_entry)

    def metric(self, name: str, value: float, **tags: Any) -> None:
        agent = tags.get("agent", "global")

        # Acumular en agent_metrics si es una métrica conocida
        key_map = {
            "llm_tokens_in": "tokens_in",
            "llm_tokens_out": "tokens_out",
            "llm_cost_usd": "cost_usd",
            "phase_duration_ms": "duration_ms",
            "phase_tokens_in": "tokens_in",
            "phase_tokens_out": "tokens_out",
            "phase_cost_usd": "cost_usd",
        }

        acc_key = key_map.get(name)
        if acc_key:
            self._agent_metrics[agent][acc_key] += value

        if name in ("llm_cost_usd", "phase_cost_usd"):
            self._agent_metrics[agent]["llm_calls"] += 1

        entry = {"type": "metric", "name": name, "value": value, "ts": time.time(), **tags}
        self._emit(entry, tags)

    # ------------------------------------------------------------------
    # Snapshot para GET /metrics
    # ------------------------------------------------------------------
    def get_metrics_snapshot(self) -> dict[str, Any]:
        """Devuelve snapshot de métricas para el endpoint /metrics."""
        total_cost = sum(m["cost_usd"] for m in self._agent_metrics.values())
        total_tokens_in = sum(m["tokens_in"] for m in self._agent_metrics.values())
        total_tokens_out = sum(m["tokens_out"] for m in self._agent_metrics.values())

        return {
            "totals": {
                "cost_usd": round(total_cost, 6),
                "tokens_in": int(total_tokens_in),
                "tokens_out": int(total_tokens_out),
                "events": self._total_events,
                "spans": self._total_spans,
                "errors": self._total_errors,
            },
            "by_agent": {
                agent: {k: round(v, 6) if isinstance(v, float) else int(v) for k, v in metrics.items()}
                for agent, metrics in self._agent_metrics.items()
            },
            "recent_spans": list(self._recent_spans)[-20:],
        }

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------
    def _emit(self, entry: dict[str, Any], fields: dict[str, Any]) -> None:
        """Emite a stderr como JSON y al RunLogBuffer si hay run_id."""
        run_id = fields.get("run_id") or self._default_run_id

        # Formato legible para logs
        compact = self._format_log_line(entry)
        print(compact, file=sys.stderr, flush=True)

        if run_id:
            RunLogBuffer.append(run_id, compact)

    def _format_log_line(self, entry: dict[str, Any]) -> str:
        """Formato compacto legible: [obs] type=name key=val key=val"""
        etype = entry.get("type", "?")
        name = entry.get("name", "?")

        parts = [f"[obs] {etype}={name}"]

        # Campos útiles en orden de prioridad
        for key in ("agent", "phase", "iteration", "model", "duration_ms",
                     "value", "status", "tool_name", "failed", "run_id"):
            if key in entry and key not in ("type", "name", "ts"):
                val = entry[key]
                if isinstance(val, float):
                    parts.append(f"{key}={val:.4f}")
                else:
                    parts.append(f"{key}={val}")

        return " ".join(parts)
