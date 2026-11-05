import { useEffect, useRef } from 'react';

export type OrbPhase = 'listening' | 'thinking' | 'speaking' | 'paused';

type RGB = [number, number, number];

// colours shift with what MJ is doing: cool while listening, violet/pink while thinking, warm while speaking
const PALETTE: Record<OrbPhase, RGB[]> = {
  listening: [[56, 189, 248], [99, 102, 241], [168, 85, 247]],
  thinking: [[168, 85, 247], [236, 72, 153], [99, 102, 241]],
  speaking: [[244, 114, 182], [251, 146, 60], [168, 85, 247]],
  paused: [[100, 110, 130], [80, 90, 112], [112, 102, 132]],
};
const SPEED: Record<OrbPhase, number> = { listening: 1, thinking: 2.4, speaking: 1.5, paused: 0.25 };

const SIZE = 360;
const rgba = (c: RGB, a: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

/**
 * A living, Siri-style orb drawn on a canvas. Its edge ripples and its colour clouds swirl faster and wider
 * with the live loudness of the microphone (listening) or of MJ's voice (speaking).
 */
export function VoiceOrb({ read }: { read: () => { phase: OrbPhase; level: number } }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.height = SIZE * dpr;
    ctx.scale(dpr, dpr);

    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const colors: RGB[] = PALETTE.listening.map((c) => [...c] as RGB);
    let amp = 0;
    let speed = 1;
    let t = 0;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { phase, level } = read();
      amp += ((phase === 'paused' ? 0.02 : Math.min(1, level)) - amp) * 0.18;
      speed += (SPEED[phase] * (calm ? 0.3 : 1) - speed) * 0.06;
      t += dt * speed;
      PALETTE[phase].forEach((target, i) => {
        for (let k = 0; k < 3; k++) colors[i]![k] += (target[k]! - colors[i]![k]!) * 0.05;
      });

      const c = SIZE / 2;
      const R = 74 + amp * 30;
      ctx.clearRect(0, 0, SIZE, SIZE);

      // soft halo
      ctx.globalCompositeOperation = 'lighter';
      const halo = ctx.createRadialGradient(c, c, R * 0.6, c, c, SIZE / 2);
      halo.addColorStop(0, rgba(colors[1]!, 0.35 + amp * 0.3));
      halo.addColorStop(1, rgba(colors[1]!, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, SIZE, SIZE);

      // ripples that travel outward
      for (let k = 0; k < 3; k++) {
        const f = (t * 0.35 + k / 3) % 1;
        ctx.strokeStyle = rgba(colors[k % 3]!, (1 - f) * (0.1 + amp * 0.5));
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(c, c, R * (1.08 + f * 0.55), 0, Math.PI * 2);
        ctx.stroke();
      }

      // the orb's wobbling edge
      const edge = new Path2D();
      const N = 140;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const r = R * (1 + 0.035 * Math.sin(a * 2 + t) + amp * 0.2 * Math.sin(a * 3 + t * 2.3) + amp * 0.12 * Math.sin(a * 5 - t * 1.7) + amp * 0.07 * Math.sin(a * 8 + t * 3.1));
        const x = c + Math.cos(a) * r;
        const y = c + Math.sin(a) * r;
        if (i === 0) edge.moveTo(x, y);
        else edge.lineTo(x, y);
      }
      edge.closePath();

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowColor = rgba(colors[0]!, 0.7);
      ctx.shadowBlur = 36 + amp * 40;
      ctx.fillStyle = 'rgba(8,10,28,1)';
      ctx.fill(edge);
      ctx.shadowBlur = 0;
      ctx.clip(edge);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const ang = t * (0.7 + i * 0.45) + i * 2.1;
        const orbit = R * 0.34 * (1 + amp * 0.9);
        const bx = c + Math.cos(ang) * orbit;
        const by = c + Math.sin(ang * 1.3) * orbit;
        const br = R * (0.95 + 0.15 * Math.sin(t * 1.7 + i));
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, rgba(colors[i]!, 0.95));
        g.addColorStop(1, rgba(colors[i]!, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, SIZE, SIZE);
      }
      // glassy highlight
      const hi = ctx.createRadialGradient(c - R * 0.35, c - R * 0.4, 0, c - R * 0.35, c - R * 0.4, R * 0.9);
      hi.addColorStop(0, 'rgba(255,255,255,0.55)');
      hi.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hi;
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.restore();

      // bright rim
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(colors[0]!, 0.55);
      ctx.lineWidth = 1.5;
      ctx.stroke(edge);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [read]);

  return <canvas ref={ref} className="voice-orb" width={SIZE} height={SIZE} aria-hidden="true" />;
}
