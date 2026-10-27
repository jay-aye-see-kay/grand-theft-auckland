// What stands on a flat roof, read from the LiDAR surface model: towers on
// podiums mapped as a single outline, and rooftop plant (lift overruns,
// plant rooms, water tanks).
//
// The DSM inside the footprint is sampled on a grid. If it has two clear
// levels (a podium and something much taller over a compact part of it),
// the tallest connected patch becomes a tower: the footprint clipped to the
// patch's convex hull, standing on the podium. Smaller raised patches on
// the roof become boxes fitted to each patch's minimum-area rectangle.
import type { Local } from './project.ts';
import { sampleLocal, type Raster } from './raster.ts';
import { roofFrame } from './roofs.ts';

export type PlantBox = { cx: number; cz: number; hx: number; hz: number; angle: number; height: number };

export type Rooftop = {
  /** A tower over part of the footprint: its outline, and its top and the podium's (m above sea level). */
  tower?: { ring: Local[]; top: number; podium: number };
  /** Boxes on the main roof, heights above it. */
  plant: PlantBox[];
};

/** Grid spacing for the DSM samples, m (coarser on big footprints). */
const STEP_MIN = 1.5;
const MAX_SAMPLES = 2500;
/** Samples are kept this far in from the walls, m. */
const EDGE_CLEAR = 1;
/** A tower must stand at least this far above the podium, m. */
const TIER_MIN = 8;
/** ...cover between these fractions of the roof, and fill most of its hull. */
const TOWER_MIN_FRACTION = 0.12;
const TOWER_MAX_FRACTION = 0.75;
const TOWER_FILL = 0.7;
const TOWER_MIN_AREA = 80;
/** Plant is between these heights above the roof, m, and between these areas, m². */
const PLANT_MIN = 1.6;
const PLANT_MAX = 9;
const PLANT_MIN_AREA = 5;
const PLANT_MAX_AREA = 260;
const PLANT_MAX_COUNT = 4;

type Cell = { i: number; j: number; x: number; z: number; y: number };

function inRing(r: Local[], x: number, z: number): boolean {
  let ins = false;
  for (let k = 0, l = r.length - 1; k < r.length; l = k++) {
    const a = r[k];
    const b = r[l];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) ins = !ins;
  }
  return ins;
}

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

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

/** 4-connected components of the cells passing `keep`, largest first. */
function components(cells: Map<number, Cell>, keep: (c: Cell) => boolean): Cell[][] {
  const key = (i: number, j: number) => i * 100003 + j;
  const seen = new Set<number>();
  const out: Cell[][] = [];
  // Map iteration order is insertion order (row-major), so this is deterministic.
  for (const [k, c] of cells) {
    if (seen.has(k) || !keep(c)) continue;
    const comp: Cell[] = [];
    const stack = [c];
    seen.add(k);
    while (stack.length) {
      const q = stack.pop()!;
      comp.push(q);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = key(q.i + di, q.j + dj);
        const n = cells.get(nk);
        if (n && !seen.has(nk) && keep(n)) {
          seen.add(nk);
          stack.push(n);
        }
      }
    }
    out.push(comp);
  }
  return out.sort((a, b) => b.length - a.length || a[0].i - b[0].i || a[0].j - b[0].j);
}

/** Corners of a component's cells (for hulls and rectangles). */
function cellCorners(comp: Cell[], step: number): Local[] {
  const h = step / 2;
  const pts: Local[] = [];
  for (const c of comp) for (const [dx, dz] of [[-h, -h], [h, -h], [h, h], [-h, h]]) pts.push({ x: c.x + dx, z: c.z + dz });
  return pts;
}

function convexHull(points: Local[]): Local[] {
  const p = points.slice().sort((a, b) => a.x - b.x || a.z - b.z);
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

/** Drops a convex ring's vertices while each removal costs less than `area` m² (smallest first). */
function simplifyConvex(ring: Local[], area: number): Local[] {
  const r = ring.slice();
  const cost = (k: number) => {
    const a = r[(k + r.length - 1) % r.length];
    const b = r[k];
    const c = r[(k + 1) % r.length];
    return Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2;
  };
  while (r.length > 4) {
    let best = -1;
    let bestCost = area;
    for (let k = 0; k < r.length; k++) {
      const c = cost(k);
      if (c < bestCost) [best, bestCost] = [k, c];
    }
    if (best < 0) break;
    r.splice(best, 1);
  }
  return r;
}

const ringArea = (r: Local[]) => {
  let a = 0;
  for (let k = 0; k < r.length; k++) {
    const p = r[k];
    const q = r[(k + 1) % r.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
};

/** A ring clipped to a convex, counter-clockwise (positive area) polygon. */
function clipToConvex(ring: Local[], hull: Local[]): Local[] {
  let out = ring;
  for (let k = 0; k < hull.length && out.length >= 3; k++) {
    const a = hull[k];
    const b = hull[(k + 1) % hull.length];
    // Inside is to the left of a->b for a positive-area hull.
    const f = (p: Local) => -((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x));
    const next: Local[] = [];
    for (let m = 0; m < out.length; m++) {
      const p = out[m];
      const q = out[(m + 1) % out.length];
      const fp = f(p);
      const fq = f(q);
      if (fp <= 0) next.push(p);
      if (fp < 0 !== fq < 0 && fp !== fq) {
        const t = fp / (fp - fq);
        if (t > 0 && t < 1) next.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
      }
    }
    out = next;
  }
  return out;
}

export type RooftopInput = {
  ring: Local[];
  area: number;
  /** The ground under the building (m above sea level). */
  base: number;
  /** Allow a tower split (off for buildings mapped with parts, which describe their own tiers). */
  towers: boolean;
  /** The building's top from its tags (m above sea level), if mapped: a tower must agree with it. */
  tagTop: number | null;
};

/** A mapped height must be within these fractions of a found tower's (above the base). */
const TAG_AGREE = [0.75, 1.4];
/** A podium stands at least this far above the ground, m. */
const PODIUM_MIN = 3;

/** Reads the roof of a flat-roofed footprint (its outer ring, area in m²). */
export function readRooftop(dsm: Raster, input: RooftopInput): Rooftop {
  const { ring, area, base: ground, towers, tagTop } = input;
  const out: Rooftop = { plant: [] };
  if (area < 60) return out;
  const f = roofFrame(ring, area);
  const step = Math.max(STEP_MIN, Math.sqrt((4 * f.L * f.W) / MAX_SAMPLES));
  const cells = new Map<number, Cell>();
  const ni = Math.ceil((2 * f.L) / step);
  const nj = Math.ceil((2 * f.W) / step);
  for (let i = 0; i < ni; i++) {
    for (let j = 0; j < nj; j++) {
      const s = -f.L + (i + 0.5) * step;
      const t = -f.W + (j + 0.5) * step;
      const x = f.cx + s * f.ux - t * f.uz;
      const z = f.cz + s * f.uz + t * f.ux;
      if (!inRing(ring, x, z) || distToRing(ring, x, z) < EDGE_CLEAR) continue;
      const y = sampleLocal(dsm, x, z);
      if (Number.isFinite(y)) cells.set(i * 100003 + j, { i, j, x, z, y });
    }
  }
  if (cells.size < 12) return out;
  const ys = [...cells.values()].map((c) => c.y).sort((a, b) => a - b);
  const cellArea = step * step;
  let roof = NaN;
  let tower: Cell[] | null = null;
  if (towers) {
    const lo = quantile(ys, 0.2);
    const hi = quantile(ys, 0.92);
    if (hi - lo >= TIER_MIN) {
      const mid = (lo + hi) / 2;
      const comp = components(cells, (c) => c.y > mid)[0];
      const frac = comp ? comp.length / cells.size : 0;
      const lowFrac = ys.filter((y) => y <= mid).length / ys.length;
      if (comp && frac >= TOWER_MIN_FRACTION && frac <= TOWER_MAX_FRACTION && lowFrac >= 0.25 && comp.length * cellArea >= TOWER_MIN_AREA) {
        const hull = convexHull(cellCorners(comp, step));
        const hullArea = ringArea(hull);
        // Clip to the patch's rectangle when it's boxy (most towers), else to its hull
        // with the staircase steps of the cell grid shaved off: few walls either way.
        const rf = roofFrame(hull, hullArea);
        const rect = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => ({ x: rf.cx + i * rf.L * rf.ux - j * rf.W * rf.uz, z: rf.cz + i * rf.L * rf.uz + j * rf.W * rf.ux }));
        if (ringArea(rect) < 0) rect.reverse();
        const clipped = clipToConvex(ring, (comp.length * cellArea) / ringArea(rect) >= TOWER_FILL ? rect : simplifyConvex(hull, step * step));
        if (clipped.length >= 3 && (comp.length * cellArea) / hullArea >= TOWER_FILL && ringArea(clipped) > TOWER_MIN_AREA * 0.8) {
          const towerYs = comp.map((c) => c.y).sort((a, b) => a - b);
          const podium = quantile(ys.filter((y) => y <= mid), 0.5);
          const top = quantile(towerYs, 0.5);
          const ratio = tagTop === null ? 1 : (tagTop - ground) / Math.max(1, top - ground);
          if (top - podium >= TIER_MIN && podium - ground >= PODIUM_MIN && ratio >= TAG_AGREE[0] && ratio <= TAG_AGREE[1]) {
            out.tower = { ring: clipped.filter((q, k) => Math.hypot(q.x - clipped[(k + 1) % clipped.length].x, q.z - clipped[(k + 1) % clipped.length].z) > 0.05), top, podium };
            tower = comp;
            roof = podium;
          }
        }
      }
    }
  }
  // Plant on the (podium) roof: patches standing PLANT_MIN..PLANT_MAX above it, away from the tower.
  const inTower = new Set(tower ?? []);
  // The DSM's own roof level near the drawn one (drawn heights can come from tags).
  const base = out.tower ? roof : quantile(ys, 0.4);
  const raised = components(cells, (c) => !inTower.has(c) && c.y - base >= PLANT_MIN && c.y - base <= PLANT_MAX);
  for (const comp of raised) {
    if (out.plant.length >= PLANT_MAX_COUNT) break;
    const a = comp.length * cellArea;
    if (a < PLANT_MIN_AREA || a > PLANT_MAX_AREA || a > area * 0.35) continue;
    const corners = cellCorners(comp, step);
    const hull = convexHull(corners);
    const rf = roofFrame(hull, Math.max(ringArea(hull), 1));
    // Shrink a little: the cells overstate the box by up to half a step.
    const hx = Math.max(0.8, rf.L - step * 0.25);
    const hz = Math.max(0.8, rf.W - step * 0.25);
    const hs = comp.map((c) => c.y - base).sort((p, q) => p - q);
    out.plant.push({ cx: rf.cx, cz: rf.cz, hx, hz, angle: Math.atan2(rf.uz, rf.ux), height: Math.min(PLANT_MAX, Math.max(PLANT_MIN, quantile(hs, 0.6))) });
  }
  return out;
}
