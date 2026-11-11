/* ==========================================================================
   The Slow Pot — a karva drawn as a surface of revolution on a 2D canvas.

   One profile curve (radius as a function of height, 12 control points,
   monotone cubic interpolation) is swept around the vertical axis.
   The body is rasterised slice by slice, bottom to top (painter's order is
   correct for a camera slightly above the pot), into a reusable pixel
   buffer. Every pixel is lit with a lit-cylinder model: warm key light from
   upper left, soft rim light from behind right, wrapped diffuse for the
   clay's softness, a wet specular streak broken up by throwing rings, and
   a rotating grain texture so the turning of the wheel reads.
   The buffer is then composited onto the stage canvas with a spotlight
   pool, the wheel head, a contact shadow, ember glow, heat shimmer and
   sparks — all pre-rendered sprites, so a frame allocates nothing.
   ========================================================================== */

const TAU = Math.PI * 2;
const PHI = 0.2;                       // camera elevation ~11.5°
const SINP = Math.sin(PHI);
const TANP = Math.tan(PHI);
const COSP = Math.cos(PHI);

/* ---------- profile keyframes ------------------------------------------ */
// normalised heights of the 12 control points (base → lip)
const CT = new Float32Array([0, 0.045, 0.13, 0.25, 0.37, 0.49, 0.6, 0.7, 0.785, 0.86, 0.93, 1]);
const NK = CT.length;

// h = height in pot units (finished karva = 1), wall = wall thickness,
// open = how far the clay has been opened (0 = closed lump)
const KEYS = [
  { h: 0.40, open: 0, wall: 0.08,  r: [0.39, 0.43, 0.462, 0.475, 0.47, 0.445, 0.405, 0.35, 0.285, 0.21, 0.125, 0.0] }, // 0 lump
  { h: 0.33, open: 1, wall: 0.075, r: [0.37, 0.384, 0.39, 0.391, 0.39, 0.388, 0.385, 0.381, 0.377, 0.372, 0.368, 0.362] }, // 1 opened, low cylinder
  { h: 0.70, open: 1, wall: 0.05,  r: [0.285, 0.292, 0.294, 0.292, 0.288, 0.284, 0.279, 0.274, 0.27, 0.266, 0.263, 0.265] }, // 2 walls rise
  { h: 0.86, open: 1, wall: 0.04,  r: [0.25, 0.315, 0.395, 0.45, 0.468, 0.452, 0.415, 0.365, 0.315, 0.275, 0.255, 0.252] }, // 3 belly swells
  { h: 0.95, open: 1, wall: 0.032, r: [0.232, 0.305, 0.4, 0.463, 0.488, 0.475, 0.425, 0.33, 0.228, 0.172, 0.158, 0.162] }, // 4 shoulder closes
  { h: 1.00, open: 1, wall: 0.026, r: [0.222, 0.298, 0.4, 0.468, 0.495, 0.482, 0.432, 0.332, 0.214, 0.153, 0.163, 0.212] }  // 5 lip turns out
];
export const KEY_COUNT = KEYS.length;

/** The finished karva profile as an SVG path (used for photo masks). */
export function karvaPath(w, h) {
  const k = KEYS[KEYS.length - 1];
  const pts = [];
  const steps = 64;
  const R = new Float32Array(k.r), M = new Float32Array(NK);
  tangents(R, M);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([evalCurve(R, M, t), t]);
  }
  const s = h / 1.02, cx = w / 2;
  let d = `M${cx} ${h}`;
  for (const [r, t] of pts) d += `L${(cx + r * s).toFixed(1)} ${(h - t * s).toFixed(1)}`;
  for (let i = pts.length - 1; i >= 0; i--) d += `L${(cx - pts[i][0] * s).toFixed(1)} ${(h - pts[i][1] * s).toFixed(1)}`;
  return d + 'Z';
}

/* Fritsch–Butland monotone tangents: no overshoot, so the belly never bulges
   past its control point and the neck never pinches below zero. */
function tangents(R, M) {
  for (let i = 0; i < NK; i++) {
    if (i === 0) { M[i] = (R[1] - R[0]) / (CT[1] - CT[0]); continue; }
    if (i === NK - 1) { M[i] = (R[i] - R[i - 1]) / (CT[i] - CT[i - 1]); continue; }
    const d0 = (R[i] - R[i - 1]) / (CT[i] - CT[i - 1]);
    const d1 = (R[i + 1] - R[i]) / (CT[i + 1] - CT[i]);
    M[i] = d0 * d1 <= 0 ? 0 : 2 / (1 / d0 + 1 / d1);
  }
}
function evalCurve(R, M, t) {
  let i = 0;
  while (i < NK - 2 && t > CT[i + 1]) i++;
  const h = CT[i + 1] - CT[i];
  const s = (t - CT[i]) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * R[i] + (s3 - 2 * s2 + s) * h * M[i] +
         (-2 * s3 + 3 * s2) * R[i + 1] + (s3 - s2) * h * M[i + 1];
}

/* ---------- shared textures (built once, lazily) ----------------------- */
const NW = 1024, NH = 512;             // fine grain, wraps around the pot
const LW = 128, LH = 64;               // low-frequency mottling
let GRAIN = null, MOTTLE = null, RING = null, ASIN = null;
const RN = 1024, AN = 2048;

function rand(seed) {                  // small deterministic PRNG
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function buildTextures() {
  if (GRAIN) return;
  const rnd = rand(7);
  // fine grain: white noise, softened with a [1 2 1] blur both ways
  const a = new Float32Array(NW * NH);
  for (let i = 0; i < a.length; i++) a[i] = rnd() * 2 - 1;
  const b = new Float32Array(NW * NH);
  for (let y = 0; y < NH; y++) {
    const row = y * NW;
    for (let x = 0; x < NW; x++) {
      b[row + x] = (a[row + ((x + NW - 1) & (NW - 1))] + 2 * a[row + x] + a[row + ((x + 1) & (NW - 1))]) * 0.25;
    }
  }
  for (let y = 0; y < NH; y++) {
    const up = ((y + NH - 1) % NH) * NW, dn = ((y + 1) % NH) * NW, row = y * NW;
    for (let x = 0; x < NW; x++) a[row + x] = (b[up + x] + 2 * b[row + x] + b[dn + x]) * 0.5;
  }
  GRAIN = a;

  // mottling: three octaves of tileable value noise
  MOTTLE = new Float32Array(LW * LH);
  let amp = 1, tot = 0;
  for (const cells of [4, 8, 16]) {
    const cy = cells / 2;
    const lat = new Float32Array(cells * cy);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd() * 2 - 1;
    for (let y = 0; y < LH; y++) {
      const fy = (y / LH) * cy, iy = fy | 0, ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
      const y0 = (iy % cy) * cells, y1 = ((iy + 1) % cy) * cells;
      for (let x = 0; x < LW; x++) {
        const fx = (x / LW) * cells, ix = fx | 0, tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
        const x0 = ix % cells, x1 = (ix + 1) % cells;
        const v = (lat[y0 + x0] * (1 - sx) + lat[y0 + x1] * sx) * (1 - sy) +
                  (lat[y1 + x0] * (1 - sx) + lat[y1 + x1] * sx) * sy;
        MOTTLE[y * LW + x] += v * amp;
      }
    }
    tot += amp; amp *= 0.55;
  }
  for (let i = 0; i < MOTTLE.length; i++) MOTTLE[i] /= tot;

  // throwing-ring bump: an asymmetric ridge (the potter's finger leaves a
  // soft crest and a sharper groove), stored as the slope of the bump
  RING = new Float32Array(RN);
  for (let i = 0; i < RN; i++) {
    const p = (i / RN) * TAU;
    RING[i] = Math.cos(p) + 0.35 * Math.cos(2 * p + 0.6) + 0.12 * Math.cos(5 * p);
  }
  ASIN = new Float32Array(AN + 1);
  for (let i = 0; i <= AN; i++) ASIN[i] = Math.asin(Math.max(-1, Math.min(1, (i / AN) * 2 - 1)));
}

/* ---------- sprites ---------------------------------------------------- */
function sprite(size, paint) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  paint(c.getContext('2d'), size);
  return c;
}
function radial(stops) {
  return (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    for (const [o, c] of stops) gr.addColorStop(o, c);
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  };
}
let SPR = null;
function buildSprites() {
  if (SPR) return;
  SPR = {
    pool: sprite(256, radial([[0, 'rgba(255,214,160,0.34)'], [0.35, 'rgba(255,196,130,0.16)'], [0.7, 'rgba(255,180,110,0.04)'], [1, 'rgba(255,180,110,0)']])),
    shadow: sprite(128, radial([[0, 'rgba(4,3,2,0.95)'], [0.45, 'rgba(4,3,2,0.7)'], [0.8, 'rgba(4,3,2,0.15)'], [1, 'rgba(4,3,2,0)']])),
    ember: sprite(256, radial([[0, 'rgba(255,170,90,0.9)'], [0.25, 'rgba(233,119,47,0.55)'], [0.6, 'rgba(180,70,25,0.16)'], [1, 'rgba(120,40,10,0)']])),
    spark: sprite(32, radial([[0, 'rgba(255,240,200,1)'], [0.25, 'rgba(255,190,110,0.85)'], [0.6, 'rgba(233,119,47,0.25)'], [1, 'rgba(233,119,47,0)']])),
    wheel: sprite(512, (g, s) => {
      const c = s / 2;
      const gr = g.createRadialGradient(c, c * 0.9, 0, c, c, c);
      gr.addColorStop(0, '#2a211c'); gr.addColorStop(0.7, '#1a1411'); gr.addColorStop(0.97, '#120e0c'); gr.addColorStop(1, 'rgba(14,11,9,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(c, c, c, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(239,230,216,0.035)';
      for (let r = 40; r < c - 8; r += 22) { g.lineWidth = 1 + (r % 3); g.beginPath(); g.arc(c, c, r, 0, TAU); g.stroke(); }
      g.strokeStyle = 'rgba(255,214,160,0.16)'; g.lineWidth = 3;
      g.beginPath(); g.arc(c, c, c - 6, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
    })
  };
}

/* ---------- renderer --------------------------------------------------- */
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const ease = (t) => t * t * (3 - 2 * t);

// light directions in view space (x right, y up, z toward camera)
function norm3(x, y, z) { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; }
const L1 = norm3(-0.62, 0.56, 0.55);   // warm key, upper left, in front
const HV = norm3(L1[0], L1[1], L1[2] + 1);
const L2 = norm3(0.92, 0.3, -0.28);    // rim, behind right
const L3 = norm3(0.75, -0.05, 0.66);   // faint fill, right

const SPARKS = 48;

export class PotRenderer {
  constructor(canvas, opts = {}) {
    buildTextures();
    buildSprites();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d');
    this.maxDpr = opts.maxDpr || 2;
    this.budget = opts.budget || 7.5;     // ms per body render before we drop resolution
    this.rs = 1;                          // internal pixels per CSS pixel for the body
    this.rsCap = 1;
    this.cssW = 0; this.cssH = 0; this.dpr = 1;
    this.bufW = 0; this.bufH = 0; this.img = null; this.buf = null;
    this.dirty = [0, 0, 0, 0];
    // geometry scratch (sized on allocation)
    this.sR = null; this.sD = null; this.sX = null;
    this.pYF = null; this.pJF = null; this.pYB = null; this.pJB = null;
    this.R = new Float32Array(NK); this.M = new Float32Array(NK);
    this.sparks = new Float32Array(SPARKS * 6);
    this.time = 0;
    this.ema = 4;
    this.still = false;
    this.needsDraw = true;
    // public state ----------------------------------------------------
    this.s = {
      k: 5,            // shape position along the keyframes (0..5)
      wet: 0,          // 0 dry / 1 glistening slip
      fired: 1,        // 0 raw clay / 1 terracotta
      heat: 0,         // ember glow, shimmer, sparks
      glaze: 0,        // celadon coverage (0..1 of the circumference)
      glazeAt: 0,      // angle of the glaze centre
      spiral: 0,       // throwing spiral: rings appear to climb as it turns
      wobble: 0,       // off-centre sway while being thrown
      wheel: 0,        // visibility of the wheel head
      spot: 1,         // spotlight pool strength
      cx: 0.5, base: 0.75, unit: 300, // placement (fractions / CSS px)
      alpha: 1,
      baseSpin: 0.32,  // rad/s
      rot: 0.6
    };
    this.spinVel = 0;
    this.shape = { h: 1, open: 1, wall: 0.03 };
  }

  /* -- sizing ------------------------------------------------------ */
  resize(maxUnitCss) {
    const c = this.canvas;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    this.cssW = w; this.cssH = h; this.dpr = dpr;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    // the body buffer is sized for the largest pot this canvas will show
    const small = Math.min(w, h) < 520;
    this.rsCap = Math.min(dpr, small ? 1.6 : 2);
    if (this.rs > this.rsCap || this.rs < 0.6) this.rs = Math.min(this.rsCap, 1.25);
    const P = maxUnitCss * this.rsCap;
    const bw = Math.ceil(P * 1.12) + 8, bh = Math.ceil(P * 1.2) + 8;
    if (bw > this.bufW || bh > this.bufH) {
      this.bufW = bw; this.bufH = bh;
      this.off.width = bw; this.off.height = bh;
      this.img = this.offCtx.createImageData(bw, bh);
      this.buf = new Uint32Array(this.img.data.buffer);
      this.sR = new Float32Array(bh + 4); this.sD = new Float32Array(bh + 4); this.sX = new Float32Array(bh + 4);
      this.pYF = new Int32Array(bw); this.pJF = new Int32Array(bw);
      this.pYB = new Int32Array(bw); this.pJB = new Int32Array(bw);
      this.dirty[0] = 0; this.dirty[1] = 0; this.dirty[2] = bw; this.dirty[3] = bh;
    }
    this.needsDraw = true;
  }

  /* -- spin by hand ------------------------------------------------ */
  attachSpin(el, onFirst) {
    let id = null, lx = 0, ly = 0, lt = 0, horizontal = null, first = true;
    el.style.touchAction = 'pan-y';
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      id = e.pointerId; lx = e.clientX; ly = e.clientY; lt = performance.now(); horizontal = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      if (horizontal === null) {
        if (Math.abs(dx) + Math.abs(dy) < 6) return;
        horizontal = Math.abs(dx) > Math.abs(dy);
        if (!horizontal) { id = null; return; }
        try { el.setPointerCapture(id); } catch (_) {}
        el.classList.add('is-spinning');
        if (first && onFirst) { first = false; onFirst(); }
      }
      const now = performance.now(), dt = Math.max(8, now - lt);
      // a drag across the pot's width ≈ half a turn
      const k = Math.PI / Math.max(120, this.s.unit);
      this.s.rot -= dx * k;
      this.spinVel = this.spinVel * 0.4 + (-dx * k / (dt / 1000)) * 0.6;
      lx = e.clientX; ly = e.clientY; lt = now;
      this.needsDraw = true;
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null; el.classList.remove('is-spinning');
      if (performance.now() - lt > 90) this.spinVel *= 0.2;   // released while still
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {                    // arrow keys spin too
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        this.spinVel += e.key === 'ArrowLeft' ? 4 : -4; this.needsDraw = true; e.preventDefault();
      }
    });
  }

  /* -- shape from keyframe position ------------------------------- */
  _shape(time) {
    const k = Math.max(0, Math.min(KEYS.length - 1, this.s.k));
    const i = Math.min(KEYS.length - 2, k | 0);
    const f = ease(k - i);
    const A = KEYS[i], B = KEYS[i + 1], R = this.R;
    for (let j = 0; j < NK; j++) R[j] = A.r[j] + (B.r[j] - A.r[j]) * f;
    // the clay breathes a little while it is being thrown
    const wob = this.s.wobble;
    if (wob > 0) {
      for (let j = 1; j < NK; j++) R[j] *= 1 + wob * 0.012 * Math.sin(time * 2.1 + j * 1.7);
    }
    tangents(R, this.M);
    const sh = this.shape;
    sh.h = A.h + (B.h - A.h) * f;
    sh.open = A.open + (B.open - A.open) * f;
    sh.wall = A.wall + (B.wall - A.wall) * f;
  }

  /* -- the body ---------------------------------------------------- */
  _body(P) {
    const s = this.s, sh = this.shape;
    const W = this.bufW, buf = this.buf, R = this.R, M = this.M;
    const sR = this.sR, sD = this.sD, sX = this.sX;
    const pYF = this.pYF, pJF = this.pJF, pYB = this.pYB, pJB = this.pJB;
    const Hpx = sh.h * P;
    const NS = Math.min(sR.length - 2, Math.ceil(Hpx));
    const cx = W / 2;
    const baseY = this.bufH - 4 - Math.ceil(0.52 * P * SINP);

    // clear last frame's rectangle only
    const d = this.dirty;
    const p0 = d[0], p1 = d[1], p2 = d[2], p3 = d[3];   // last frame's rect, cleared on the canvas too
    for (let y = d[1]; y < d[1] + d[3]; y++) buf.fill(0, y * W + d[0], y * W + d[0] + d[2]);

    // slice table: radius, slope dr/dh, sideways sway
    const time = this.time, wob = s.wobble;
    let maxR = 0;
    for (let j = 0; j <= NS; j++) {
      const t = Math.min(1, j / Hpx);
      const r = evalCurve(R, M, t);
      sR[j] = r;
      if (r > maxR) maxR = r;
      sX[j] = wob > 0 ? wob * 0.006 * P * Math.sin(time * 1.6 + t * 3.2) * t : 0;
    }
    for (let j = 0; j <= NS; j++) {
      const a = sR[Math.max(0, j - 1)], b = sR[Math.min(NS, j + 1)];
      sD[j] = (b - a) / (((Math.min(NS, j + 1) - Math.max(0, j - 1)) || 1) / P);
    }
    pJF.fill(-9); pYB.fill(1 << 30);

    // material ---------------------------------------------------------
    const wet = s.wet, fired = s.fired, heat = s.heat, glaze = s.glaze;
    const wetSpec = wet * 0.9, broad = 0.05 + wet * 0.22;
    // albedo (linear)
    const aR = 0.301 + (0.47 - 0.301) * fired, aG = 0.186 + (0.118 - 0.186) * fired, aB = 0.124 + (0.04 - 0.124) * fired;
    const wetDark = 1 - wet * 0.3;
    const gR = 0.27, gG = 0.42, gB = 0.31;              // celadon
    const keyI = 2.0 - fired * 0.1;
    const rot = s.rot, gAt = s.glazeAt;
    const gThresh = 1 - 2 * glaze;
    const spiral = s.spiral;
    const ringF = 23;                                   // throwing rings per unit height
    const ringAmp = 0.1 + wet * 0.08 - fired * 0.03;
    const flick = 0.85 + 0.15 * Math.sin(time * 7.3) * Math.sin(time * 3.1 + 1);
    const invNW = NW / TAU;
    const hiScale = NW / (TAU * 0.48);                 // grain texels per unit height
    let minX = W, maxX = 0, minY = this.bufH, maxY = 0;

    // per-slice values the shader reads (kept outside to avoid allocation)
    let _slope = 0, _inv = 1, _ringBase = 0, _ao = 1, _vRow = 0, _mRow = 0, _glazeH = 0, _heatH = 0;
    const PI = Math.PI;
    const shade = (u, ct, ang, back) => {
      const tu = ((ang * invNW) | 0) & (NW - 1);
      const g = GRAIN[_vRow * NW + tu];
      const mo = MOTTLE[_mRow + (tu >> 3)];
      const ph = _ringBase + spiral * ang * 0.32 + mo * 0.25;
      const rb = RING[((ph * RN) | 0) & (RN - 1)] * ringAmp + g * 0.05;
      const nyW = -_slope * _inv + rb, nzW = (back ? -ct : ct) * _inv;
      const nX = u * _inv;
      const nY = nyW * COSP - nzW * SINP;
      const nZ = nyW * SINP + nzW * COSP;
      const il = 1 / Math.sqrt(nX * nX + nY * nY + nZ * nZ);
      const X = nX * il, Y = nY * il, Z = nZ * il;
      let dk = X * L1[0] + Y * L1[1] + Z * L1[2];
      dk = (dk + 0.12) / 1.12; if (dk < 0) dk = 0;
      dk = dk * dk * (1.6 - 0.6 * dk);                 // a touch of falloff toward the core shadow
      let rim = X * L2[0] + Y * L2[1] + Z * L2[2]; if (rim < 0) rim = 0;
      const edge = Z < 0 ? 1 : 1 - Z; rim *= edge * edge;
      let fl = X * L3[0] + Y * L3[1] + Z * L3[2]; if (fl < 0) fl = 0;
      let sp = X * HV[0] + Y * HV[1] + Z * HV[2]; if (sp < 0) sp = 0;
      const s2 = sp * sp, s4 = s2 * s2, s8 = s4 * s4, s16 = s8 * s8, s32 = s16 * s16, s64 = s32 * s32;
      const bounce = Y < 0 ? -Y * 0.1 : 0;
      const tone = (1 + g * 0.1 + mo * 0.13) * wetDark * (1 - fired * 0.28 * (mo > 0.1 ? mo : 0));
      let ar = aR * tone, ag = aG * tone, ab = aB * tone;
      let spec = s64 * wetSpec * (0.55 + rb * 2.6) + s8 * broad * 0.3;
      let gm = 0;
      if (glaze > 0) {
        const c = Math.cos(ang - gAt) + mo * 0.2 + g * 0.02;
        gm = (c - gThresh) * 8; gm = gm < 0 ? 0 : gm > 1 ? 1 : gm;
        gm *= _glazeH;
        if (gm > 0) {
          const pool = 1 - Math.max(0, rb) * 1.8;      // glaze pools darker in the grooves
          ar += (gR * pool - ar) * gm; ag += (gG * pool - ag) * gm; ab += (gB * pool - ab) * gm;
          spec += gm * (s64 * s32 * 1.6 + s64 * 0.16 + s8 * 0.04);
        }
      }
      const lit = dk * keyI;
      let cr = ar * (0.03 + lit + fl * 0.1 + bounce * 1.4) * _ao + rim * 0.36 + spec;
      let cg = ag * (0.027 + lit * 0.84 + fl * 0.1 + bounce * 0.8) * _ao + rim * 0.29 + spec * 0.92;
      let cb = ab * (0.025 + lit * 0.64 + fl * 0.12 + bounce * 0.5) * _ao + rim * 0.23 + spec * 0.78;
      if (_heatH > 0.002) {
        const e = _heatH * flick * (0.6 + 0.4 * (1 + mo)) * (1 - gm);
        cr += e * 0.5; cg += e * 0.15; cb += e * 0.03;
      }
      cr = Math.sqrt(cr / (1 + cr * 0.18) * 1.18);
      cg = Math.sqrt(cg / (1 + cg * 0.18) * 1.18);
      cb = Math.sqrt(cb / (1 + cb * 0.18) * 1.18);
      return ((cb >= 1 ? 255 : (cb * 255) | 0) << 16) | ((cg >= 1 ? 255 : (cg * 255) | 0) << 8) | (cr >= 1 ? 255 : (cr * 255) | 0);
    };

    // an anti-aliased edge pixel is blended over clay already drawn beneath it
    const put = (i, px, cov) => {
      const q = buf[i];
      if ((q >>> 24) < 250) { buf[i] = px; return; }
      const k = cov, m = 1 - cov;
      const r = (px & 255) * k + (q & 255) * m, g = ((px >> 8) & 255) * k + ((q >> 8) & 255) * m, b = ((px >> 16) & 255) * k + ((q >> 16) & 255) * m;
      buf[i] = 0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
    };

    for (let j = 0; j < NS; j++) {
      const r = sR[j] * P;
      if (r < 0.35) continue;
      const slope = sD[j];
      _slope = slope; _inv = 1 / Math.sqrt(1 + slope * slope);
      const h = j / P;                                   // pot units
      const cxj = cx + sX[j];
      const yc = baseY - j * COSP;
      const xl = cxj - r, xr = cxj + r;
      const x0 = Math.floor(xl), x1 = Math.ceil(xr) - 1;
      if (x0 < minX) minX = x0;
      if (x1 > maxX) maxX = x1;
      _ao = 0.45 + 0.55 * smooth(0, 0.08, h);
      _vRow = ((h * hiScale) | 0) & (NH - 1);
      _mRow = (((h * hiScale) >> 3) & (LH - 1)) * LW;
      _ringBase = h * ringF + 0.55 * Math.sin(h * 9.1) + 0.3 * Math.sin(h * 23.7 + 1.3);
      _glazeH = smooth(0.05, 0.09, h);                 // glaze stops short of the foot
      _heatH = heat * Math.exp(-h * 4.5);
      // the back of a narrowing surface (dome, shoulder) is visible from above
      const backLim = slope < 0 ? -slope * TANP : -1;

      for (let x = x0; x <= x1; x++) {
        let cov = 1;
        if (x === x0) cov = Math.min(1, x0 + 1 - xl);
        if (x === x1) cov = Math.min(cov, xr - x1);
        if (cov <= 0.02) continue;
        const A = ((cov * 255) | 0) << 24;
        let u = (x + 0.5 - cxj) / r;
        if (u < -1) u = -1; else if (u > 1) u = 1;
        const ct = Math.sqrt(1 - u * u);
        const th = ASIN[((u + 1) * 0.5 * AN) | 0];   // angle on the pot, -π/2..π/2

        if (ct < backLim) {
          // only ever extends the column upward: the back surface is what
          // shows above everything drawn so far
          const yi = (yc - r * ct * SINP) | 0;
          const top = pYB[x];
          if (yi < top) {
            const px = shade(u, ct, PI - th + rot, true);
            const yb = top - yi < 64 ? top - 1 : yi + 1;
            buf[yi * W + x] = A | px;
            for (let yy = yi + 1; yy <= yb; yy++) buf[yy * W + x] = 0xff000000 | px;
            pYB[x] = yi;
            if (yi < minY) minY = yi;
          }
        }

        const px = A | shade(u, ct, th + rot, false);
        const yi = (yc + r * ct * SINP) | 0;
        const pv = pYF[x];
        let ya = yi, yb = yi + 1;
        if (pJF[x] === j - 1 && pv - yi < 48 && yi - pv < 48) { if (pv - 1 > yb) yb = pv - 1; if (pv < ya) ya = pv; }
        if (cov < 1) for (let yy = ya; yy <= yb; yy++) put(yy * W + x, px, cov); else for (let yy = ya; yy <= yb; yy++) buf[yy * W + x] = px;
        pYF[x] = yi; pJF[x] = j;
        if (ya < pYB[x]) pYB[x] = ya;
        if (ya < minY) minY = ya;
        if (yb > maxY) maxY = yb;
      }
    }


    // seal pinholes: where a narrowing surface is rasterised from its back
    // arc, single slices can leave short transparent gaps inside the body.
    // Close any short vertical run of empty pixels that has clay above and
    // below it (long runs are real — the air beside the neck).
    {
      const maxGap = Math.max(5, (P * 0.012) | 0);
      const y0 = Math.max(0, minY), y1 = Math.min(this.bufH - 1, maxY);
      for (let x = Math.max(0, minX); x <= Math.min(W - 1, maxX); x++) {
        let lastSolid = -1;
        for (let y = y0; y <= y1; y++) {
          const p = buf[y * W + x];
          const a = p >>> 24;
          if (a > 200) {
            if (lastSolid >= 0 && y - lastSolid > 1 && y - lastSolid <= maxGap) {
              const fillPx = p | 0xff000000;
              for (let yy = lastSolid + 1; yy < y; yy++) buf[yy * W + x] = fillPx;
            }
            lastSolid = y;
          }
        }
      }
    }

    // the lip and the dark inside of the mouth -------------------------
    const rT = sR[NS - 1] * P;
    const ri = Math.max(0, rT - sh.wall * P) * sh.open;
    if (rT > 1.5 && sh.open > 0.02) {
      const cxT = cx + sX[NS - 1];
      const yT = baseY - (NS - 1) * COSP;
      const bO = rT * SINP, bI = ri * SINP;
      const yA = Math.floor(yT - bO), yB = Math.ceil(yT + bO);
      const litR = aR * (1 - glaze * 0.3), litG = aG, litB = aB;
      for (let yy = yA; yy <= yB; yy++) {
        const dy = (yy + 0.5 - yT) / bO;
        if (dy <= -1 || dy >= 1) continue;
        const half = rT * Math.sqrt(1 - dy * dy);
        const xa = cxT - half, xb = cxT + half;
        const dyi = bI > 0.5 ? (yy + 0.5 - yT) / bI : 2;
        const halfI = dyi > -1 && dyi < 1 ? ri * Math.sqrt(1 - dyi * dyi) : -1;
        for (let x = Math.floor(xa); x <= Math.ceil(xb) - 1; x++) {
          let cov = 1;
          if (x < xa) cov = x + 1 - xa;
          if (x + 1 > xb) cov = Math.min(cov, xb - x);
          if (cov <= 0.02) continue;
          const ux = (x + 0.5 - cxT);
          let cr, cg, cb;
          if (halfI > 0 && ux > -halfI && ux < halfI) {
            // inside: the back inner wall catches a little of the key light
            const v = (dyi + 1) * 0.5;              // 0 back … 1 front
            const side = 0.55 + 0.45 * (ux / ri);
            const b = 0.02 + 0.32 * (1 - v) * (1 - v) * side;
            cr = litR * b; cg = litG * b; cb = litB * b;
          } else {
            // top of the lip: faces up, lit from the left, thin highlight
            const side = 0.5 - 0.5 * (ux / rT);
            const b = 0.55 + 0.9 * side;
            const shine = (1 - Math.abs(dy)) * (0.04 + wet * 0.25) * side;
            cr = litR * b + shine; cg = litG * b + shine * 0.92; cb = litB * b + shine * 0.8;
          }
          cr = Math.sqrt(cr / (1 + cr * 0.18) * 1.18);
          cg = Math.sqrt(cg / (1 + cg * 0.18) * 1.18);
          cb = Math.sqrt(cb / (1 + cb * 0.18) * 1.18);
          buf[yy * W + x] = (((cov * 255) | 0) << 24) | ((cb >= 1 ? 255 : (cb * 255) | 0) << 16) |
            ((cg >= 1 ? 255 : (cg * 255) | 0) << 8) | (cr >= 1 ? 255 : (cr * 255) | 0);
        }
      }
      if (yA < minY) minY = yA;
    }

    minX = Math.max(0, minX - 1); maxX = Math.min(W - 1, maxX + 1);
    minY = Math.max(0, minY - 1); maxY = Math.min(this.bufH - 1, maxY + 1);
    if (p2 && p3) this.offCtx.clearRect(p0 - 2, p1 - 2, p2 + 4, p3 + 4);
    if (maxX < minX || maxY < minY) { d[0] = d[1] = d[2] = d[3] = 0; return null; }
    d[0] = minX; d[1] = minY; d[2] = maxX - minX + 1; d[3] = maxY - minY + 1;
    this.offCtx.putImageData(this.img, 0, 0, d[0], d[1], d[2], d[3]);
    return { cx, baseY, maxR: maxR * P };
  }

  /* -- one frame ---------------------------------------------------- */
  frame(now, dt) {
    if (!this.buf || !this.cssW) return;
    const s = this.s;
    if (this.still) {
      if (!this.needsDraw) return;
    } else {
      this.time += dt;
      // the wheel: base speed plus hand spin, relaxing back with inertia
      this.spinVel *= Math.exp(-dt * 1.6);
      s.rot += (s.baseSpin + this.spinVel) * dt;
    }
    this.needsDraw = false;
    const t0 = performance.now();
    this._shape(this.time);
    const P = s.unit * this.rs;
    const info = this._body(P);
    const took = performance.now() - t0;
    this._adapt(took);

    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!info || s.alpha <= 0.002) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cxC = s.cx * this.cssW, baseC = s.base * this.cssH, U = s.unit;
    const scale = 1 / this.rs;                     // body px → CSS px
    const rBase = this.R[0] * U, rMax = info.maxR * scale;
    ctx.globalAlpha = s.alpha;

    // spotlight pool on the wheel / table
    if (s.spot > 0.01) {
      const pw = U * 2.3, ph = pw * SINP * 2.2;
      ctx.globalAlpha = s.alpha * s.spot;
      ctx.drawImage(SPR.pool, cxC - pw / 2, baseC - ph / 2, pw, ph);
    }
    // wheel head
    if (s.wheel > 0.01) {
      const ww = U * 1.5, wh = ww * SINP;
      ctx.globalAlpha = s.alpha * s.wheel;
      ctx.save();
      ctx.translate(cxC, baseC + U * 0.01);
      ctx.scale(1, SINP);
      ctx.rotate(s.rot * 0.5);
      ctx.drawImage(SPR.wheel, -ww / 2, -ww / 2, ww, ww);
      ctx.restore();
      void wh;
    }
    // contact shadow
    ctx.globalAlpha = s.alpha * 0.9;
    const sw = Math.max(rBase, rMax * 0.7) * 2.6, shh = sw * SINP * 1.25;
    ctx.drawImage(SPR.shadow, cxC - sw / 2, baseC - shh / 2 + 1, sw, shh);

    // ember glow from beneath
    const heat = s.heat;
    if (heat > 0.01) {
      const fl = 0.85 + 0.15 * Math.sin(this.time * 5.7) * Math.sin(this.time * 2.3);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = s.alpha * heat * 0.9 * fl;
      const ew = U * 2.0, eh = U * 1.1;
      ctx.drawImage(SPR.ember, cxC - ew / 2, baseC - eh * 0.55, ew, eh);
      ctx.globalAlpha = s.alpha * heat * 0.45 * fl;
      ctx.drawImage(SPR.ember, cxC - ew * 0.8, baseC - U * 1.1, ew * 1.6, U * 1.5);
      ctx.globalCompositeOperation = 'source-over';
    }

    // sparks drift up from the fire, behind the pot
    if (!this.still) this._sparks(ctx, dt, cxC, baseC, U, heat);

    // the pot itself (with heat shimmer when hot)
    ctx.globalAlpha = s.alpha;
    const d = this.dirty;
    const dx = cxC + (d[0] - info.cx) * scale;
    const dy = baseC + (d[1] - info.baseY) * scale;
    const dw = d[2] * scale, dh = d[3] * scale;
    if (heat > 0.06 && !this.still) {
      const strips = 28, sh = d[3] / strips;
      for (let i = 0; i < strips; i++) {
        const off = Math.sin(this.time * 4.2 + i * 0.9) * heat * 1.6 * (i / strips);
        ctx.drawImage(this.off, d[0], d[1] + i * sh, d[2], sh + 0.6, dx + off, dy + i * sh * scale, dw, (sh + 0.6) * scale);
      }
    } else {
      ctx.drawImage(this.off, d[0], d[1], d[2], d[3], dx, dy, dw, dh);
    }

    ctx.globalAlpha = 1;
  }

  _sparks(ctx, dt, cx, base, U, heat) {
    const S = this.sparks;
    let alive = 0;
    for (let i = 0; i < SPARKS; i++) {
      const o = i * 6;
      if (S[o + 4] <= 0) {
        if (heat > 0.2 && Math.random() < heat * dt * 1.4) {
          S[o] = cx + (Math.random() < 0.5 ? -1 : 1) * U * (0.2 + Math.random() * 0.5);
          S[o + 1] = base - Math.random() * U * 0.2;
          S[o + 2] = (S[o] - cx) * 0.12 + (Math.random() - 0.5) * 10;
          S[o + 3] = -(26 + Math.random() * 40);
          S[o + 5] = S[o + 4] = 2.4 + Math.random() * 2.6;
        }
        continue;
      }
      alive++;
      S[o + 4] -= dt;
      S[o + 2] += Math.sin(this.time * 1.7 + i) * 6 * dt;
      S[o] += S[o + 2] * dt;
      S[o + 1] += S[o + 3] * dt;
    }
    if (!alive) return;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < SPARKS; i++) {
      const o = i * 6, life = S[o + 4];
      if (life <= 0) continue;
      const k = life / S[o + 5];
      const a = Math.min(1, k * 2.2) * Math.min(1, (1 - k) * 6) * (0.6 + 0.4 * Math.sin(this.time * 19 + i));
      const sz = 5 + 5 * k;
      ctx.globalAlpha = a * this.s.alpha;
      ctx.drawImage(SPR.spark, S[o] - sz / 2, S[o + 1] - sz / 2, sz, sz);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _adapt(ms) {
    if (this.still) return;
    this.ema = this.ema * 0.9 + ms * 0.1;
    if (this.ema > this.budget && this.rs > 0.7) { this.rs = Math.max(0.7, this.rs * 0.9); this.ema = this.budget * 0.8; }
    else if (this.ema < this.budget * 0.45 && this.rs < this.rsCap) { this.rs = Math.min(this.rsCap, this.rs * 1.04); this.ema = this.budget * 0.6; }
  }
}

/* ---------- one shared clock for every visible pot ------------------- */
const active = new Set();
let raf = 0, last = 0;
function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
  last = now;
  for (const r of active) {
    if (r.beforeFrame) r.beforeFrame(dt);
    r.frame(now, dt);
  }
  raf = active.size && !document.hidden ? requestAnimationFrame(tick) : 0;
}
export function run(renderer, on) {
  if (on) active.add(renderer); else active.delete(renderer);
  if (active.size && !raf && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(tick); }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && active.size && !raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
});
