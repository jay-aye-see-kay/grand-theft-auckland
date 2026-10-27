// Roof shapes: pitched roofs fitted to the LiDAR surface model, or from
// `roof:shape` where it's mapped (2% of CBD buildings).
//
// Every roof here is the lowest of a few planes over the footprint: a gable
// is two planes meeting at the ridge, a hip four, a pyramid four meeting at a
// point, a skillion one, a mansard four steep planes capped by a flat one.
// That makes the mesh generic (each plane's share of the footprint is the
// footprint clipped by half-planes, see planeRegions) and the walls' tops
// simply follow the roof (see roofBreaks).
//
// Fitting works in the footprint's minimum-area bounding rectangle: s along
// its long side, t across. The DSM inside the footprint (away from the walls,
// whose edges smear) is compared against a flat roof, a gable with its ridge
// along s or along t, a hip and a free plane; a pitched model wins only if it
// explains the surface much better than flat and its slope is plausible.
// Scores ignore the worst fifth of the samples, so a tree over one corner or
// a chimney doesn't decide the shape.
import type { Local } from './project.ts';
import { sampleLocal, type Raster } from './raster.ts';

/** y = a + bx * x + bz * z, local metres. */
export type Plane = { a: number; bx: number; bz: number };

export type RoofShape = 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'skillion' | 'mansard';

export type RoofFrame = {
  /** Centre and unit axes of the bounding rectangle: u along its long side, v across. */
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  /** Half-length along u and half-width along v, m (L >= W). */
  L: number;
  W: number;
  /** Footprint area / rectangle area. */
  fill: number;
};

export type RoofFit = {
  shape: RoofShape;
  /** Ridge along u (true) or across it, for gables. */
  alongU: boolean;
  /** Rise per metre in from the eave, for gables and hips. */
  slope: number;
  /** Eave height (m above sea level) the fit found, when it came from the DSM. */
  eave: number;
  /** Ridge height above the eave, m. */
  rise: number;
  /** For skillions: the fitted plane (absolute heights). */
  plane?: Plane;
};

// ---------------------------------------------------------------- frame

function hull(points: Local[]): Local[] {
  const p = points.slice().sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length < 3) return p;
  const cross = (o: Local, a: Local, b: Local) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Local[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Local[] = [];
  for (let k = p.length - 1; k >= 0; k--) {
    const q = p[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** The minimum-area rectangle round a ring (rotating calipers over its hull). */
export function roofFrame(ring: Local[], area: number): RoofFrame {
  const h = hull(ring);
  let best: RoofFrame | null = null;
  let bestArea = Infinity;
  for (let k = 0; k < h.length; k++) {
    const a = h[k];
    const b = h[(k + 1) % h.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    let s0 = Infinity;
    let s1 = -Infinity;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const p of h) {
      const s = p.x * ux + p.z * uz;
      const t = -p.x * uz + p.z * ux;
      s0 = Math.min(s0, s);
      s1 = Math.max(s1, s);
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
    }
    const ar = (s1 - s0) * (t1 - t0);
    if (ar < bestArea - 1e-9) {
      bestArea = ar;
      const sm = (s0 + s1) / 2;
      const tm = (t0 + t1) / 2;
      const cx = sm * ux - tm * uz;
      const cz = sm * uz + tm * ux;
      const long = s1 - s0 >= t1 - t0;
      // u is always the long side.
      best = long
        ? { cx, cz, ux, uz, L: (s1 - s0) / 2, W: (t1 - t0) / 2, fill: 0 }
        : { cx, cz, ux: -uz, uz: ux, L: (t1 - t0) / 2, W: (s1 - s0) / 2, fill: 0 };
    }
  }
  best!.fill = Math.min(1, area / Math.max(bestArea, 1e-9));
  return best!;
}

/** (s, t) of a point in the frame: along u, and across (towards v = (-uz, ux)). */
export const frameST = (f: RoofFrame, x: number, z: number) => {
  const dx = x - f.cx;
  const dz = z - f.cz;
  return { s: dx * f.ux + dz * f.uz, t: -dx * f.uz + dz * f.ux };
};

// ---------------------------------------------------------------- planes

/** The plane eave + slope * (d0 + ds * s + dt * t), as a function of x, z. */
function framePlane(f: RoofFrame, eave: number, slope: number, d0: number, ds: number, dt: number): Plane {
  // s = (x - cx) ux + (z - cz) uz; t = -(x - cx) uz + (z - cz) ux.
  const bx = slope * (ds * f.ux - dt * f.uz);
  const bz = slope * (ds * f.uz + dt * f.ux);
  const a = eave + slope * d0 - bx * f.cx - bz * f.cz;
  return { a, bx, bz };
}

/** Steepness of a mansard's lower slopes (rise per metre in). */
const MANSARD_SLOPE = 2.4;

/**
 * The planes of a roof whose eave is at `eave` (m above sea level) and ridge
 * `rise` above it. Their minimum over the footprint is the roof.
 */
export function roofPlanes(f: RoofFrame, fit: Pick<RoofFit, 'shape' | 'alongU' | 'rise' | 'plane'>, eave: number): Plane[] {
  const { L, W } = f;
  const rise = Math.max(0, fit.rise);
  switch (fit.shape) {
    case 'gabled': {
      const half = fit.alongU ? W : L;
      const k = rise / half;
      return fit.alongU
        ? [framePlane(f, eave, k, W, 0, -1), framePlane(f, eave, k, W, 0, 1)]
        : [framePlane(f, eave, k, L, -1, 0), framePlane(f, eave, k, L, 1, 0)];
    }
    case 'hipped':
    case 'pyramidal': {
      const k = rise / W;
      return [framePlane(f, eave, k, W, 0, -1), framePlane(f, eave, k, W, 0, 1), framePlane(f, eave, k, L, -1, 0), framePlane(f, eave, k, L, 1, 0)];
    }
    case 'mansard': {
      const k = MANSARD_SLOPE;
      const sides = [framePlane(f, eave, k, W, 0, -1), framePlane(f, eave, k, W, 0, 1), framePlane(f, eave, k, L, -1, 0), framePlane(f, eave, k, L, 1, 0)];
      return [...sides, { a: eave + Math.min(rise, k * W * 0.8), bx: 0, bz: 0 }];
    }
    case 'skillion': {
      if (fit.plane) return [{ ...fit.plane, a: fit.plane.a - fitEaveOffset(f, fit.plane) + eave }];
      // Falling across the short side.
      return [framePlane(f, eave, rise / (2 * W), W, 0, -1)];
    }
    default:
      return [{ a: eave, bx: 0, bz: 0 }];
  }
}

/** A skillion plane's lowest point over its frame (the eave), so it can be re-seated at another eave height. */
function fitEaveOffset(f: RoofFrame, p: Plane): number {
  let lo = Infinity;
  for (const [i, j] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const s = i * f.L;
    const t = j * f.W;
    const x = f.cx + s * f.ux - t * f.uz;
    const z = f.cz + s * f.uz + t * f.ux;
    lo = Math.min(lo, planeAt(p, x, z));
  }
  return lo;
}

export const planeAt = (p: Plane, x: number, z: number) => p.a + p.bx * x + p.bz * z;

export function roofAt(planes: Plane[], x: number, z: number): number {
  let y = Infinity;
  for (const p of planes) y = Math.min(y, planeAt(p, x, z));
  return y;
}

/**
 * A ring with points added wherever the roof above an edge changes plane
 * (the ridge or a hip crossing a wall), so wall tops that follow the roof
 * are straight between consecutive points.
 */
export function roofBreaks(ring: Local[], planes: Plane[]): Local[] {
  if (planes.length < 2) return ring;
  const out: Local[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    out.push(a);
    const ts: number[] = [];
    for (let i = 0; i < planes.length; i++) {
      for (let j = i + 1; j < planes.length; j++) {
        const fa = planeAt(planes[i], a.x, a.z) - planeAt(planes[j], a.x, a.z);
        const fb = planeAt(planes[i], b.x, b.z) - planeAt(planes[j], b.x, b.z);
        if (fa * fb >= 0) continue;
        const t = fa / (fa - fb);
        if (t < 0.01 || t > 0.99) continue;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        // Only where these two planes are the roof there (not crossing under another).
        if (planeAt(planes[i], x, z) <= roofAt(planes, x, z) + 1e-6) ts.push(t);
      }
    }
    ts.sort((p, q) => p - q);
    let last = -1;
    for (const t of ts) {
      if (t - last < 0.01) continue;
      last = t;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

/**
 * A ring (counter-clockwise, positive area) pushed out by d along each
 * edge's normal, corners mitred: the eaves' outline. Null if a corner is too
 * sharp or the result folds over (very concave footprints keep flush eaves).
 */
export function outsetRing(ring: Local[], d: number): Local[] | null {
  const n = ring.length;
  const out: Local[] = [];
  for (let k = 0; k < n; k++) {
    const p = ring[(k + n - 1) % n];
    const q = ring[k];
    const r = ring[(k + 1) % n];
    const l1 = Math.hypot(q.x - p.x, q.z - p.z);
    const l2 = Math.hypot(r.x - q.x, r.z - q.z);
    // Outward normals for a positive-area ring: (dz, -dx).
    const n1x = (q.z - p.z) / l1;
    const n1z = -(q.x - p.x) / l1;
    const n2x = (r.z - q.z) / l2;
    const n2z = -(r.x - q.x) / l2;
    const bx = n1x + n2x;
    const bz = n1z + n2z;
    const cos = (n1x * n2x + n1z * n2z + 1) / 2;
    if (cos < 0.15) return null;
    const m = d / Math.max(cos, 1e-6);
    const bl = Math.hypot(bx, bz);
    out.push({ x: q.x + (bx / bl) * Math.sqrt(m * d), z: q.z + (bz / bl) * Math.sqrt(m * d) });
  }
  // Every edge must keep its direction (no fold-overs at short edges).
  for (let k = 0; k < n; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % n];
    const a2 = out[k];
    const b2 = out[(k + 1) % n];
    if ((b.x - a.x) * (b2.x - a2.x) + (b.z - a.z) * (b2.z - a2.z) <= 0) return null;
  }
  return out;
}

/** Sutherland-Hodgman: the part of a ring where f(p) <= 0, for f linear. */
function clipRing(ring: Local[], f: (p: Local) => number): Local[] {
  const out: Local[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const fa = f(a);
    const fb = f(b);
    if (fa <= 0) out.push(a);
    if (fa < 0 !== fb < 0 && fa !== fb) {
      const t = fa / (fa - fb);
      if (t > 0 && t < 1) out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

/** Each plane's share of the footprint: where it is the lowest. */
export function planeRegions(ring: Local[], planes: Plane[]): { plane: Plane; ring: Local[] }[] {
  const out: { plane: Plane; ring: Local[] }[] = [];
  for (let i = 0; i < planes.length; i++) {
    let r = ring;
    for (let j = 0; j < planes.length && r.length >= 3; j++) {
      if (j === i) continue;
      const pi = planes[i];
      const pj = planes[j];
      r = clipRing(r, (p) => planeAt(pi, p.x, p.z) - planeAt(pj, p.x, p.z) - 1e-7);
    }
    if (r.length >= 3) out.push({ plane: planes[i], ring: r });
  }
  return out;
}

// ---------------------------------------------------------------- fitting

/** DSM samples are kept this far in from the walls (the wall edge smears across a pixel or two), m. */
const EDGE_CLEAR = 0.9;
/** Fewest samples worth fitting. */
const MIN_SAMPLES = 12;
/** Scores use the best KEEP of the residuals. */
const KEEP = 0.8;

type Sample = { s: number; t: number; y: number };

function distToRing(ring: Local[], x: number, z: number): number {
  let d = Infinity;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2)) : 0;
    d = Math.min(d, Math.hypot(x - a.x - ex * t, z - a.z - ez * t));
  }
  return d;
}

/** Trimmed RMS: root mean square of the best KEEP of the residuals. */
function score(res: number[]): number {
  const s = res.map((r) => r * r).sort((a, b) => a - b);
  const n = Math.max(1, Math.floor(s.length * KEEP));
  let sum = 0;
  for (let k = 0; k < n; k++) sum += s[k];
  return Math.sqrt(sum / n);
}

/** Least squares for y = e + k * g, refitted once on the samples that fit best. Returns [e, k, score]. */
function fit2(xs: Sample[], g: (q: Sample) => number): [number, number, number] {
  let use = xs;
  let e = 0;
  let k = 0;
  for (let pass = 0; pass < 2; pass++) {
    let n = 0;
    let sg = 0;
    let sy = 0;
    let sgg = 0;
    let sgy = 0;
    for (const q of use) {
      const v = g(q);
      n++;
      sg += v;
      sy += q.y;
      sgg += v * v;
      sgy += v * q.y;
    }
    const det = n * sgg - sg * sg;
    if (Math.abs(det) < 1e-9) return [sy / Math.max(1, n), 0, Infinity];
    k = (n * sgy - sg * sy) / det;
    e = (sy - k * sg) / n;
    if (pass === 0) {
      const r = xs.map((q) => Math.abs(q.y - e - k * g(q)));
      const cut = r.slice().sort((a, b) => a - b)[Math.floor(r.length * KEEP)];
      use = xs.filter((_, i) => r[i] <= cut);
    }
  }
  return [e, k, score(xs.map((q) => q.y - e - k * g(q)))];
}

/** Least squares for y = e + a s + b t, refitted once like fit2. Returns [e, a, b, score]. */
function fit3(xs: Sample[]): [number, number, number, number] {
  let use = xs;
  let sol = [0, 0, 0];
  for (let pass = 0; pass < 2; pass++) {
    // Normal equations for [1, s, t].
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const r = [0, 0, 0];
    for (const q of use) {
      const f = [1, q.s, q.t];
      for (let i = 0; i < 3; i++) {
        r[i] += f[i] * q.y;
        for (let j = 0; j < 3; j++) m[i * 3 + j] += f[i] * f[j];
      }
    }
    sol = solve3(m, r) ?? [r[0] / Math.max(1, m[0]), 0, 0];
    if (pass === 0) {
      const res = xs.map((q) => Math.abs(q.y - sol[0] - sol[1] * q.s - sol[2] * q.t));
      const cut = res.slice().sort((a, b) => a - b)[Math.floor(res.length * KEEP)];
      use = xs.filter((_, i) => res[i] <= cut);
    }
  }
  return [sol[0], sol[1], sol[2], score(xs.map((q) => q.y - sol[0] - sol[1] * q.s - sol[2] * q.t))];
}

function solve3(m: number[], r: number[]): number[] | null {
  const det = (a: number[]) => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const d = det(m);
  if (Math.abs(d) < 1e-9) return null;
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const a = m.slice();
    for (let i = 0; i < 3; i++) a[i * 3 + c] = r[i];
    out.push(det(a) / d);
  }
  return out;
}

/** Plausible pitched-roof slopes (rise per metre): about 10 to 55 degrees. */
const SLOPE_MIN = 0.17;
const SLOPE_MAX = 1.45;
/** A pitched model must beat flat by this factor, and fit at least this well (m). */
const BETTER = 0.7;
const GOOD_ENOUGH = 0.7;
/** Below this spread (m) a roof is flat whatever fits best: membrane falls and gutters. */
const RELIEF = 0.15;
/** The least rise worth modelling, m. */
const MIN_RISE = 0.9;
/** Skillions gentler or lower than this are flat roofs draining to a gutter behind the parapet. */
const SKILLION_MIN = 0.12;
const SKILLION_DROP = 1.2;

/** Set to log every fit's scores (tuning). */
export let DEBUG_FIT = false;
export const debugFit = (on: boolean) => (DEBUG_FIT = on);

export type FitInput = { ring: Local[]; area: number; frame: RoofFrame };

/**
 * The roof the DSM shows over a footprint, or null if there isn't enough of
 * it to tell. 'flat' means flat (or too irregular to model).
 */
export function fitRoof(dsm: Raster, input: FitInput): RoofFit | null {
  const { ring, frame: f } = input;
  const xs: Sample[] = [];
  // Denser than the 1 m pixels on small footprints (bilinear samples still
  // add information), and a narrower margin so a cottage keeps its ridge.
  const step = Math.max(0.6, Math.min(2.5, Math.sqrt((4 * f.L * f.W) / 600)));
  const clear = Math.min(EDGE_CLEAR, f.W * 0.3);
  for (let s = -f.L + step / 2; s < f.L; s += step) {
    for (let t = -f.W + step / 2; t < f.W; t += step) {
      const x = f.cx + s * f.ux - t * f.uz;
      const z = f.cz + s * f.uz + t * f.ux;
      if (!inside(ring, x, z) || distToRing(ring, x, z) < clear) continue;
      const y = sampleLocal(dsm, x, z);
      if (Number.isFinite(y)) xs.push({ s, t, y });
    }
  }
  if (xs.length < MIN_SAMPLES) return null;
  const flatY = xs.map((q) => q.y).sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const flatScore = score(xs.map((q) => q.y - flatY));
  const flat: RoofFit = { shape: 'flat', alongU: true, slope: 0, eave: flatY, rise: 0 };
  const { L, W } = f;
  type Cand = { fit: RoofFit; score: number };
  const cands: Cand[] = [];
  const pitched = (shape: RoofShape, alongU: boolean, g: (q: Sample) => number, half: number) => {
    const [e, k, sc] = fit2(xs, g);
    const rise = k * half;
    if (k >= SLOPE_MIN && k <= SLOPE_MAX && rise >= MIN_RISE) cands.push({ fit: { shape, alongU, slope: k, eave: e, rise }, score: sc });
  };
  pitched('gabled', true, (q) => W - Math.abs(q.t), W);
  if (L - W > 0.5) pitched('gabled', false, (q) => L - Math.abs(q.s), L);
  pitched(L - W < 0.15 * L ? 'pyramidal' : 'hipped', true, (q) => Math.min(W - Math.abs(q.t), L - Math.abs(q.s)), W);
  // A free plane: a skillion (mono-pitch), if it really slopes.
  const [e3, a3, b3, sc3] = fit3(xs);
  const grad = Math.hypot(a3, b3);
  if (grad >= SKILLION_MIN && grad <= 0.7) {
    // Its drop across the footprint, and its plane in x, z.
    const drop = 2 * (Math.abs(a3) * L + Math.abs(b3) * W);
    if (drop >= SKILLION_DROP) {
      const bx = a3 * f.ux - b3 * f.uz;
      const bz = a3 * f.uz + b3 * f.ux;
      const plane: Plane = { a: e3 - bx * f.cx - bz * f.cz, bx, bz };
      // Skillions are penalised a little: a plane also fits a gentle gable's half.
      cands.push({ fit: { shape: 'skillion', alongU: true, slope: grad, eave: fitEaveOffset(f, plane), rise: drop, plane }, score: sc3 * 1.15 });
    }
  }
  cands.sort((p, q) => p.score - q.score);
  const best = cands[0];
  if (DEBUG_FIT) console.log(`  n=${xs.length} L=${L.toFixed(1)} W=${W.toFixed(1)} flat=${flatScore.toFixed(2)} ` + cands.map((c) => `${c.fit.shape}${c.fit.alongU ? '' : '/v'} ${c.score.toFixed(2)} k=${c.fit.slope.toFixed(2)}`).join(', '));
  if (!best || best.score > GOOD_ENOUGH || best.score > BETTER * flatScore || flatScore < RELIEF) return flat;
  return best.fit;
}

function inside(r: Local[], x: number, z: number): boolean {
  let ins = false;
  for (let k = 0, l = r.length - 1; k < r.length; l = k++) {
    const a = r[k];
    const b = r[l];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) ins = !ins;
  }
  return ins;
}
