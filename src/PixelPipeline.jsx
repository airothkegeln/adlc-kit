// =============================================================================
// PixelPipeline — línea de producción pixel-art de los agentes ADLC
// =============================================================================
// Muestra los 9 agentes del ciclo como personajes pixel-art en una fila.
// Cada uno trabaja en su escritorio cuando su fase está activa, y entrega el
// avance al siguiente (caminando hacia la derecha) cuando completa.
//
// Reusa los spritesheets del proyecto webmachbank (ver src/sprites.js).
// =============================================================================

import { useEffect, useRef } from "react";
import { CHARS, FLOORS, FURN } from "./sprites.js";

const FRAME_W = 16;
const FRAME_H = 32;
const DIR_ROW = { DOWN: 0, UP: 1, RIGHT: 2, LEFT: 2 };
const WORK_FRAMES = [3, 4];
const WALK_FRAMES = [0, 1, 2, 1];

// Layout del canvas: 9 estaciones horizontales.
const STATIONS = 9;
const STATION_W = 96;       // ancho por estación (px lógicos, pre-scale)
const CANVAS_W = STATIONS * STATION_W;
const CANVAS_H = 120;
const SCALE = 2;            // zoom pixel-art (nearest neighbor)
const FLOOR_Y = 72;         // y del piso (en coords lógicas)
const CHAR_Y = FLOOR_Y - FRAME_H + 4; // personaje parado sobre el piso

// Fases ADLC — deben matchear con engine/agent_specs/
const PHASES = [
  { id: "discovery",    label: "Discovery" },
  { id: "hypothesis",   label: "Hypothesis" },
  { id: "mapping",      label: "Mapping" },
  { id: "spec",         label: "Spec" },
  { id: "architecture", label: "Architecture" },
  { id: "business",     label: "Business" },
  { id: "coding",       label: "Coding" },
  { id: "validation",   label: "Validation" },
  { id: "publish",      label: "Publish" },
];

// Carga una imagen base64 como <img> en memoria.
function loadB64(b64) {
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  return img;
}

export default function PixelPipeline({ run, dark = false }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const imgsRef = useRef(null);
  const stateRef = useRef(null);

  // Init imágenes una vez
  useEffect(() => {
    const imgs = {
      chars: CHARS.map(loadB64),
      floor: loadB64(FLOORS[0]),
      desk: FURN?.desk_front ? loadB64(FURN.desk_front) : null,
    };
    imgsRef.current = imgs;

    // Estado interno por agente: posición (x flotante), frame, dir, status.
    stateRef.current = PHASES.map((p, i) => ({
      id: p.id,
      label: p.label,
      charIdx: i % CHARS.length,
      homeX: i * STATION_W + (STATION_W - FRAME_W) / 2,
      x: i * STATION_W + (STATION_W - FRAME_W) / 2,
      frame: 0,
      fTimer: 0,
      dir: "DOWN",
      status: "pending",       // pending | working | handoff | done
      handoffT: 0,
    }));
  }, []);

  // Re-calcula el status de cada agente cuando cambia el run.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const completed = new Set(run?.completed_phases || []);
    // La fase activa es la primera NO completada si el run sigue running.
    const finished = ["completed", "failed", "aborted"].includes(run?.status);
    const running = run?.status === "running" || run?.status === "pending" || run?.status === "awaiting_hitl";
    const firstPendingIdx = PHASES.findIndex(p => !completed.has(p.id));

    for (let i = 0; i < st.length; i++) {
      const a = st[i];
      if (completed.has(a.id)) {
        // Si la acaba de completar en este tick, disparar handoff una sola vez.
        if (a.status === "working") {
          a.status = "handoff";
          a.handoffT = 0;
          a.dir = "RIGHT";
        } else if (a.status !== "handoff") {
          a.status = "done";
        }
      } else if (running && i === firstPendingIdx) {
        a.status = "working";
        a.dir = "DOWN";
      } else if (finished) {
        a.status = "pending";
      } else {
        a.status = "pending";
      }
    }
  }, [run?.completed_phases?.length, run?.status]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = CANVAS_W * SCALE;
    canvas.height = CANVAS_H * SCALE;
    canvas.style.width = "100%";
    canvas.style.maxWidth = CANVAS_W + "px";
    canvas.style.imageRendering = "pixelated";

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    let last = performance.now();

    function drawFloor() {
      const img = imgsRef.current?.floor;
      // fondo
      ctx.fillStyle = dark ? "#14121a" : "#f4efe4";
      ctx.fillRect(0, 0, CANVAS_W * SCALE, CANVAS_H * SCALE);
      // pared superior
      ctx.fillStyle = dark ? "#1c1830" : "#e8dfd0";
      ctx.fillRect(0, 0, CANVAS_W * SCALE, FLOOR_Y * SCALE);
      // piso tileado
      if (img?.complete) {
        for (let x = 0; x < CANVAS_W; x += 16) {
          ctx.drawImage(img, x * SCALE, FLOOR_Y * SCALE, 16 * SCALE, 16 * SCALE);
        }
      }
      // línea de base
      ctx.fillStyle = dark ? "#2a2540" : "#d9cfbd";
      ctx.fillRect(0, (FLOOR_Y + 16) * SCALE, CANVAS_W * SCALE, 2 * SCALE);
    }

    function drawDesks() {
      const desk = imgsRef.current?.desk;
      for (let i = 0; i < STATIONS; i++) {
        const cx = i * STATION_W + STATION_W / 2;
        if (desk?.complete) {
          const dw = desk.naturalWidth;
          const dh = desk.naturalHeight;
          ctx.drawImage(
            desk,
            (cx - dw / 2) * SCALE,
            (FLOOR_Y - dh + 4) * SCALE,
            dw * SCALE,
            dh * SCALE
          );
        } else {
          // fallback: rect como desk
          ctx.fillStyle = dark ? "#3a2f55" : "#8c7a5a";
          ctx.fillRect((cx - 14) * SCALE, (FLOOR_Y - 10) * SCALE, 28 * SCALE, 10 * SCALE);
        }
      }
    }

    function drawLabels() {
      const st = stateRef.current || [];
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      for (let i = 0; i < STATIONS; i++) {
        const a = st[i];
        const cx = i * STATION_W + STATION_W / 2;
        const labelY = FLOOR_Y + 34;
        // Badge de estado (emoji/icono)
        let badge = "·";
        let badgeColor = dark ? "#8a84a0" : "#6a6074";
        if (a?.status === "working") { badge = "●"; badgeColor = "#00a853"; }
        else if (a?.status === "handoff") { badge = "►"; badgeColor = "#e8a53a"; }
        else if (a?.status === "done") { badge = "✓"; badgeColor = "#5b8def"; }
        ctx.font = `bold ${11 * SCALE}px -apple-system, 'Segoe UI', sans-serif`;
        ctx.fillStyle = badgeColor;
        ctx.fillText(badge, cx * SCALE, (labelY - 12) * SCALE);

        // Label de la fase — bold + stroke de contraste para que se lea
        // sobre cualquier fondo.
        ctx.font = `bold ${11 * SCALE}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
        const label = (a?.label || "").toUpperCase();
        // halo
        ctx.lineWidth = 3 * SCALE;
        ctx.strokeStyle = dark ? "rgba(20,18,26,0.9)" : "rgba(255,255,255,0.92)";
        ctx.strokeText(label, cx * SCALE, labelY * SCALE);
        // texto
        ctx.fillStyle = dark ? "#f1eef8" : "#1c1830";
        ctx.fillText(label, cx * SCALE, labelY * SCALE);
      }
      ctx.textAlign = "left";
    }

    function drawChar(a) {
      const img = imgsRef.current?.chars?.[a.charIdx];
      if (!img?.complete) return;
      let frames;
      if (a.status === "working") frames = WORK_FRAMES;
      else if (a.status === "handoff") frames = WALK_FRAMES;
      else frames = [0];
      const fIdx = frames[Math.floor(a.frame) % frames.length];
      const row = DIR_ROW[a.dir] ?? 0;
      const flip = a.dir === "LEFT";

      const alpha = a.status === "pending" ? 0.25 : a.status === "done" ? 0.55 : 1;
      ctx.globalAlpha = alpha;

      // sombra
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect((a.x + 2) * SCALE, (CHAR_Y + FRAME_H - 2) * SCALE, (FRAME_W - 4) * SCALE, 2 * SCALE);

      if (flip) {
        ctx.save();
        ctx.translate((a.x + FRAME_W) * SCALE, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(img, fIdx * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H,
          0, CHAR_Y * SCALE, FRAME_W * SCALE, FRAME_H * SCALE);
        ctx.restore();
      } else {
        ctx.drawImage(img, fIdx * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H,
          a.x * SCALE, CHAR_Y * SCALE, FRAME_W * SCALE, FRAME_H * SCALE);
      }
      ctx.globalAlpha = 1;
    }

    function update(dt) {
      const st = stateRef.current;
      if (!st) return;
      for (let i = 0; i < st.length; i++) {
        const a = st[i];
        a.fTimer += dt;
        // velocidad de frame según estado
        if (a.status === "working") a.frame = a.fTimer * 3;
        else if (a.status === "handoff") a.frame = a.fTimer * 7;
        else a.frame = 0;

        if (a.status === "handoff") {
          // Camina hasta la estación siguiente, luego queda done.
          const targetX = Math.min(
            a.homeX + STATION_W,
            (STATIONS - 1) * STATION_W + (STATION_W - FRAME_W) / 2
          );
          const spd = 24; // px/s
          a.x = Math.min(a.x + spd * dt, targetX);
          a.handoffT += dt;
          if (a.x >= targetX || a.handoffT > 2.5) {
            a.status = "done";
            a.dir = "DOWN";
            a.x = a.homeX;
          }
        } else {
          // volver suavemente al home si se movió
          if (Math.abs(a.x - a.homeX) > 0.1) {
            a.x += (a.homeX - a.x) * Math.min(1, dt * 4);
          }
        }
      }
    }

    function loop(now) {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      update(dt);
      drawFloor();
      drawDesks();
      // personajes ordenados por Y (todos mismo Y, ok por orden)
      const st = stateRef.current || [];
      for (const a of st) drawChar(a);
      drawLabels();
      rafRef.current = requestAnimationFrame(loop);
    }

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [dark]);

  return (
    <div style={{ width: "100%", overflowX: "auto", padding: "8px 0" }}>
      <canvas ref={canvasRef} aria-label="ADLC pixel pipeline" />
    </div>
  );
}
