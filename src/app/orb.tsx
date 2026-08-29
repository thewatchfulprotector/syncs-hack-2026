"use client";

import { useEffect, useRef } from "react";

export type OrbPhase = "idle" | "listening" | "thinking" | "speaking" | "offline";

/** Word-emphasis pulse: the page bumps this as spoken caption chunks land. */
export type OrbPulse = { kickAt: number; emph: number };

const RINGS = 13;
const ACCENT = [31, 59, 224]; // #1F3BE0 — the persona's voice
const USER_ACCENT = [24, 161, 92]; // #18A15C — yours
const REACTIVITY = 1;
const SPEAKER_SHIFT = 1;

type Dot = { rf: number; a: number; n: number };

function buildDots(): Dot[] {
  const dots: Dot[] = [{ rf: 0, a: 0, n: 0.5 }];
  for (let i = 1; i <= RINGS; i++) {
    const rf = i / RINGS;
    const n = 6 * i;
    for (let k = 0; k < n; k++) {
      dots.push({ rf, a: (k / n) * Math.PI * 2, n: ((i * 7 + k * 13) % 97) / 97 });
    }
  }
  return dots;
}

/**
 * The voice orb: rings of dots whose energy band blooms outward from the
 * center with whoever is speaking — green for you, blue for the persona.
 * On a phase hand-off the band glides to its new radius and the color
 * crossfades — no ripple. Ported from the design canvas artboard.
 */
export function Orb({
  phase,
  sampleAmp,
  pulse,
  onClick,
}: {
  phase: OrbPhase;
  /** Live amplitude 0..1 (mic while listening, playback while speaking); null falls back to synthetic motion. */
  sampleAmp: () => number | null;
  pulse: React.RefObject<OrbPulse>;
  onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef<OrbPhase>(phase);

  // the draw loop reads refs only
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dots = buildDots();
    let ctx: CanvasRenderingContext2D | null = null;
    let size = 0;
    let dpr = 1;

    const setup = () => {
      const box = canvas.getBoundingClientRect();
      const next = Math.max(160, Math.round(Math.min(box.width, box.height) || 480));
      const nextDpr = window.devicePixelRatio || 1;
      if (size === next && dpr === nextDpr) return;
      size = next;
      dpr = nextDpr;
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      ctx = canvas.getContext("2d");
    };
    setup();
    const ro = new ResizeObserver(setup);
    ro.observe(canvas);

    let amp = 0.02;
    let pos = 0;
    let ring = 0.055;
    let lastT: number | null = null;
    const col = [10, 10, 10];
    let raf = 0;

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (!ctx) return;
      const phaseNow = phaseRef.current;
      const listening = phaseNow === "listening";
      const off = phaseNow === "offline";

      const live = listening || phaseNow === "speaking" ? sampleAmp() : null;
      let target = 0.02;
      if (off) target = 0;
      else if (listening) {
        // boosted gain so normal speech visibly drives the orb: mic RMS maps
        // speech to ~0.2–0.4, which barely moved the band at 1:1
        target = live != null ? Math.min(1, live * 1.7) : 0.14 + 0.07 * Math.sin(t * 0.004);
      } else if (phaseNow === "speaking") {
        const p = pulse.current;
        const k = Math.max(0, 1 - (t - p.kickAt) / 280);
        const s1 = 0.5 + 0.5 * Math.sin(t * 0.019);
        const s2 = 0.5 + 0.5 * Math.sin(t * 0.031 + 1.7);
        const emph = p.emph;
        const synthetic = 0.2 + 0.48 * emph * (0.55 * s1 + 0.45 * s2) + 0.3 * k * emph;
        target = live != null ? Math.max(live, 0.35 * synthetic) : synthetic;
      } else if (phaseNow === "thinking") target = 0.055 + 0.03 * Math.sin(t * 0.002);
      target = Math.max(0, Math.min(1, target));
      // faster attack while listening so the orb bounces per syllable, with a
      // slightly quicker release so it settles between words instead of smearing
      amp += (target - amp) * (target > amp ? (listening ? 0.5 : 0.3) : (listening ? 0.13 : 0.1));

      const maxR = size * 0.325;
      const unit = size / 560;
      const dt = Math.min(64, t - (lastT == null ? t - 16 : lastT));
      lastT = t;

      const posTarget = listening
        ? SPEAKER_SHIFT * 0.165
        : phaseNow === "speaking"
          ? SPEAKER_SHIFT * -0.105
          : 0;
      pos += (posTarget - pos) * (1 - Math.exp(-dt / 620));

      // quick, clean crossfade on hand-off (~95% in half a second), dt-based
      // so the fade reads the same at any frame rate
      const tgt = listening ? USER_ACCENT : ACCENT;
      const colK = 1 - Math.exp(-dt / 170);
      for (let i = 0; i < 3; i++) col[i] += (tgt[i] - col[i]) * colK;

      // both voices bloom outward from the center with amplitude
      const ringTarget = 0.055 + 0.6 * amp;
      ring += (ringTarget - ring) * (1 - Math.exp(-dt / 240));
      // while listening the band fattens and wobbles with the voice — clear
      // "it hears you" feedback rather than a thin quiet ring
      const band = listening ? 0.06 + 0.13 * amp : 0.05 + 0.075 * amp;
      const wobble = listening ? 0.3 : 0.16;

      const c = size / 2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.translate(0, pos * size);
      ctx.fillStyle = `rgb(${Math.round(col[0])},${Math.round(col[1])},${Math.round(col[2])})`;
      for (const d of dots) {
        const spin = d.a + t * 0.000032 * (1.45 - 0.55 * d.rf);
        const rr =
          d.rf * maxR * (1 + 0.01 * Math.sin(t * 0.0007 + d.rf * 9) + 0.006 * Math.sin(t * 0.0011 - d.rf * 4));
        const x = c + Math.cos(spin) * rr;
        const y = c + Math.sin(spin) * rr;
        const base = unit * (1.7 + 0.6 * (1 - d.rf)) * (1 + 0.07 * Math.sin(t * 0.0009 + d.n * 12.6));
        if (off) {
          if (d.n > 0.62) continue;
          ctx.globalAlpha = 0.2;
          ctx.beginPath();
          ctx.arc(x, y, Math.max(0.7, base * 0.8), 0, 6.2832);
          ctx.fill();
          continue;
        }
        const lobe = 0.42 * Math.sin(spin * 3 + t * 0.0016) + 0.2 * Math.sin(spin * 5 - t * 0.0011);
        const dist = Math.abs(d.rf - ring * (1 + wobble * lobe * amp));
        const g = Math.exp(-Math.pow(dist / band, 2));
        const breathe = 1 + 0.05 * Math.sin(t * 0.0009 + d.rf * 5);
        const rad = base * (1 + 3.2 * g * REACTIVITY * (0.3 + 0.95 * amp)) * breathe;
        const r = Math.max(0.7, rad);
        ctx.globalAlpha = Math.min(1, 0.86 + 0.14 * g);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <canvas
      ref={canvasRef}
      onClick={onClick}
      className="orb-size block min-w-[170px] min-h-[170px] cursor-pointer touch-manipulation select-none"
    />
  );
}
