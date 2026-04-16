"""
RunLogBuffer — buffer en memoria de logs por run_id para streaming a la UI.

Uso:
    from observability.run_log_buffer import RunLogBuffer, run_log

    run_log(run_id="run_abc", msg="[executor] arrancando discovery")
    # Prints a stderr y agrega al buffer del run

    lines, next_since = RunLogBuffer.get_since("run_abc", since=0)
    # Devuelve (lineas_nuevas, cursor_nuevo_para_proximo_call)

Characteristicas:
  - Singleton (class-level dict, un proceso = un buffer)
  - maxlen=500 por run (descarta las más viejas, el cursor sigue monotónico)
  - Cursor absoluto: el cliente pasa since=N, recibe next=M, la próxima
    vez pasa since=M. Si una línea entre N y M fue descartada (buffer
    overflow), el cliente no se da cuenta — just lee lo que está disponible.
  - Thread-safe NO requerido (asyncio single-thread).
"""

from __future__ import annotations

import sys
from collections import deque
from typing import Deque


class RunLogBuffer:
    _buffers: dict[str, Deque[tuple[int, str]]] = {}
    _counters: dict[str, int] = {}
    _maxlen: int = 500

    @classmethod
    def append(cls, run_id: str, line: str) -> None:
        if run_id not in cls._buffers:
            cls._buffers[run_id] = deque(maxlen=cls._maxlen)
            cls._counters[run_id] = 0
        seq = cls._counters[run_id]
        cls._counters[run_id] = seq + 1
        cls._buffers[run_id].append((seq, line))

    @classmethod
    def get_since(cls, run_id: str, since: int = 0) -> tuple[list[str], int]:
        """
        Devuelve las líneas con seq >= since, junto con el próximo cursor
        para el siguiente poll.
        """
        buf = cls._buffers.get(run_id)
        if not buf:
            return [], since
        new = [(s, l) for s, l in buf if s >= since]
        next_cursor = cls._counters[run_id]
        return [l for _, l in new], next_cursor

    @classmethod
    def clear(cls, run_id: str) -> None:
        cls._buffers.pop(run_id, None)
        cls._counters.pop(run_id, None)


def run_log(run_id: str | None, msg: str) -> None:
    """
    Log helper: escribe a stderr (para `docker logs`) y al buffer de run_id
    (para el endpoint `GET /runs/{id}/logs` que consume la UI).
    """
    print(msg, file=sys.stderr, flush=True)
    if run_id:
        RunLogBuffer.append(run_id, msg)
