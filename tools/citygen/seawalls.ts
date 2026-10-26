// Sea walls along every wharf, pier and waterfront edge.
//
// The terrain is a 2 m lattice, so on its own a coastline is a jagged
// staircase of slopes down to the harbour floor. Instead the coastline is
// traced from the 1 m DEM itself (after piers are laid, see piers.ts), as
// the boundary between open-water pixels and dry ones, and straightened
// (Douglas-Peucker). Along it goes a vertical wall from under the water up
// to the deck, plus a cap strip running a few metres inland at deck height
// that covers the lattice's ragged edge. Both go into the buildings layer
// (always drawn) and its collider, so a car drives on the cap and drops
// off a clean edge.
import { MeshBuilder, rgb } from './buildings.ts';
import { localToNztm, nztmToLocal, type Local } from './project.ts';
import { pixelLocal, type Raster } from './raster.ts';
import { CHUNK_SIZE, isWet, WATER_LEVEL, type Grid, type TerrainSampler } from './terrain.ts';

/** How far the straightened coastline may stray from the pixel staircase, m. */
const SIMPLIFY = 1.5;
/** Loops shorter than this (single wet or dry pixels, mooring piles) are dropped, m. */
const MIN_LOOP = 8;
/** The wall stands this far out from the traced edge, in front of the terrain's drop. */
const OUTSET = 0.35;
/** The cap reaches this far inland over the lattice's ragged edge. */
const CAP = 4;
const WALL_BOTTOM = WATER_LEVEL - 2;
/** Lowest cap: just clear of the water. */
const MIN_TOP = WATER_LEVEL + 0.3;
const WALL = rgb(0x57544e);
const CAP_COLOUR = rgb(0x9b978d);
const UP = [0, 1, 0] as const;

type Pt = { x: number; z: number };

export function buildSeawalls(dem: Raster, grid: Grid, terrain: TerrainSampler, chunkAt: (x: number, z: number) => MeshBuilder | null) {
  const lines = traceCoast(dem, grid);
  let metres = 0;
  for (const line of lines) metres += emitWall(line, dem, terrain, chunkAt);
  return { lines: lines.length, km: metres / 1000 };
}

// ---------------------------------------------------------------- tracing

/**
 * Coastlines in local metres: chains of pixel edges between wet and dry
 * pixels inside the grid, each kept with the dry side on its left in pixel
 * space, joined end to end and simplified.
 */
function traceCoast(dem: Raster, grid: Grid): Pt[][] {
  const nw = localToNztm(grid.x0 - 4, grid.z0 - 4);
  const se = localToNztm(grid.x0 + grid.nx * CHUNK_SIZE + 4, grid.z0 + grid.nz * CHUNK_SIZE + 4);
  const c0 = Math.max(0, Math.floor((nw.e - dem.west) / dem.res));
  const c1 = Math.min(dem.width - 1, Math.ceil((se.e - dem.west) / dem.res));
  const r0 = Math.max(0, Math.floor((dem.north - nw.n) / dem.res));
  const r1 = Math.min(dem.height - 1, Math.ceil((dem.north - se.n) / dem.res));
  const wet = (r: number, c: number) => isWet(dem.data[r * dem.width + c]);
  // Directed edges between pixel corners (corner id = r * W + c), dry on the left.
  const W = dem.width + 1;
  const next = new Map<number, number[]>();
  const add = (ar: number, ac: number, br: number, bc: number) => {
    const a = ar * W + ac;
    if (!next.has(a)) next.set(a, []);
    next.get(a)!.push(br * W + bc);
  };
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (wet(r, c)) continue;
      // Rows run south and columns east, so with a dry pixel at (r, c):
      if (c < c1 && wet(r, c + 1)) add(r + 1, c + 1, r, c + 1); // wet to the east: walk north
      if (c > c0 && wet(r, c - 1)) add(r, c, r + 1, c); // wet to the west: walk south
      if (r < r1 && wet(r + 1, c)) add(r + 1, c, r + 1, c + 1); // wet to the south: walk east
      if (r > r0 && wet(r - 1, c)) add(r, c + 1, r, c); // wet to the north: walk west
    }
  }
  const lines: Pt[][] = [];
  const corner = (id: number): Pt => {
    const r = Math.floor(id / W);
    const c = id - r * W;
    return nztmToLocal(dem.west + c * dem.res, dem.north - r * dem.res);
  };
  // Start from chain ends first (open lines at the window edge), then loops.
  const indeg = new Map<number, number>();
  for (const outs of next.values()) for (const b of outs) indeg.set(b, (indeg.get(b) ?? 0) + 1);
  const starts = [...next.keys()].sort((a, b) => a - b);
  const take = (a: number): number | undefined => {
    const outs = next.get(a);
    if (!outs?.length) return undefined;
    const b = outs.shift()!;
    if (!outs.length) next.delete(a);
    return b;
  };
  for (const pass of [0, 1]) {
    for (const s of starts) {
      if (pass === 0 && (indeg.get(s) ?? 0) > 0) continue;
      while (next.has(s)) {
        const ids = [s];
        for (let b = take(s); b !== undefined; b = take(b)) {
          ids.push(b);
          if (b === s) break;
        }
        const pts = ids.map(corner);
        const closed = ids[0] === ids[ids.length - 1];
        let len = 0;
        for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
        if (len < MIN_LOOP) continue;
        lines.push(closed ? simplifyLoop(pts) : simplify(pts, SIMPLIFY));
      }
    }
  }
  return lines.filter((l) => l.length >= 2);
}

/** Douglas-Peucker. */
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  let worst = -1;
  let at = 0;
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k];
    const d = len > 1e-9 ? Math.abs((b.x - a.x) * (a.z - p.z) - (a.x - p.x) * (b.z - a.z)) / len : Math.hypot(p.x - a.x, p.z - a.z);
    if (d > worst) {
      worst = d;
      at = k;
    }
  }
  if (worst <= tol) return [a, b];
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}

/** A closed loop (first point repeated at the end), split at its farthest point so both halves simplify well. */
function simplifyLoop(pts: Pt[]): Pt[] {
  let far = 0;
  let fd = -1;
  for (let k = 0; k < pts.length; k++) {
    const d = Math.hypot(pts[k].x - pts[0].x, pts[k].z - pts[0].z);
    if (d > fd) {
      fd = d;
      far = k;
    }
  }
  return [...simplify(pts.slice(0, far + 1), SIMPLIFY).slice(0, -1), ...simplify(pts.slice(far), SIMPLIFY)];
}

// ---------------------------------------------------------------- meshing

/** Wall and cap along one coastline. Returns its length in metres. */
function emitWall(line: Pt[], dem: Raster, terrain: TerrainSampler, chunkAt: (x: number, z: number) => MeshBuilder | null): number {
  const closed = line.length > 2 && line[0].x === line[line.length - 1].x && line[0].z === line[line.length - 1].z;
  const pts = closed ? line.slice(0, -1) : line;
  const n = pts.length;
  if (n < 2) return 0;
  const segs = closed ? n : n - 1;
  // Each segment's normal towards the water: whichever side the DEM says is wet.
  const out: Pt[] = [];
  for (let k = 0; k < segs; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % n];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = (b.z - a.z) / len;
    const nz = -(b.x - a.x) / len;
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    let score = 0;
    for (const t of [0.7, 1.5]) score += (isWet(pixelLocal(dem, mx + nx * t, mz + nz * t)) ? 1 : 0) - (isWet(pixelLocal(dem, mx - nx * t, mz - nz * t)) ? 1 : 0);
    out.push(score >= 0 ? { x: nx, z: nz } : { x: -nx, z: -nz });
  }
  // Per-vertex mitred normals.
  const vn: Pt[] = [];
  const vm: number[] = [];
  for (let k = 0; k < n; k++) {
    const prev = closed ? out[(k + segs - 1) % segs] : out[Math.max(0, k - 1)];
    const cur = closed ? out[k % segs] : out[Math.min(segs - 1, k)];
    let x = prev.x + cur.x;
    let z = prev.z + cur.z;
    const l = Math.hypot(x, z);
    if (l < 1e-3) {
      x = cur.x;
      z = cur.z;
    } else {
      x /= l;
      z /= l;
    }
    vn.push({ x, z });
    vm.push(1 / Math.max(x * cur.x + z * cur.z, 0.7));
  }
  // The cap stops short of the water on the far side of a narrow pier or pontoon.
  const reach = pts.map((p, k) => {
    for (let t = 0.5; t <= CAP; t += 0.25) {
      if (isWet(pixelLocal(dem, p.x - vn[k].x * t * vm[k], p.z - vn[k].z * t * vm[k]))) return Math.max(0.3, t - 0.5);
    }
    return CAP;
  });
  // Deck height: the highest ground across the cap, so the cap covers it.
  const top = pts.map((p, k) => {
    let h = MIN_TOP;
    for (let t = 0; t <= reach[k] + 0.5; t += 0.5) h = Math.max(h, terrain.heightAt(p.x - vn[k].x * t * vm[k], p.z - vn[k].z * t * vm[k]));
    return h + 0.05;
  });
  const wallAt = (k: number): Local => ({ x: pts[k].x + vn[k].x * OUTSET * vm[k], z: pts[k].z + vn[k].z * OUTSET * vm[k] });
  const capAt = (k: number): Local => ({ x: pts[k].x - vn[k].x * reach[k] * vm[k], z: pts[k].z - vn[k].z * reach[k] * vm[k] });
  let metres = 0;
  for (let k = 0; k < segs; k++) {
    const k1 = (k + 1) % n;
    const a = wallAt(k);
    const b = wallAt(k1);
    const mb = chunkAt((a.x + b.x) / 2, (a.z + b.z) / 2);
    if (!mb) continue;
    metres += Math.hypot(b.x - a.x, b.z - a.z);
    const o = out[k];
    const wn = [o.x, 0, o.z];
    // Wall, facing the water.
    const a0 = mb.vertex(a.x, WALL_BOTTOM, a.z, wn, WALL);
    const b0 = mb.vertex(b.x, WALL_BOTTOM, b.z, wn, WALL);
    const a1 = mb.vertex(a.x, top[k], a.z, wn, WALL);
    const b1 = mb.vertex(b.x, top[k1], b.z, wn, WALL);
    // (a0, b0, a1) faces (-dz, 0, dx) for the edge a -> b (counter-clockwise is front).
    const faces = (b.x - a.x) * o.z - (b.z - a.z) * o.x > 0;
    const wall = faces ? [a0, b0, a1, a1, b0, b1] : [a0, a1, b0, a1, b1, b0];
    mb.idx.push(...wall);
    mb.colliderIdx.push(...wall);
    // Cap: from the wall's top edge inland, at deck height.
    const ca = capAt(k);
    const cb = capAt(k1);
    const ta = mb.vertex(a.x, top[k], a.z, UP, CAP_COLOUR);
    const tb = mb.vertex(b.x, top[k1], b.z, UP, CAP_COLOUR);
    const ia = mb.vertex(ca.x, top[k], ca.z, UP, CAP_COLOUR);
    const ib = mb.vertex(cb.x, top[k1], cb.z, UP, CAP_COLOUR);
    // Up-facing: cross((q - p), (r - p)).y > 0 with this module's (x, z) convention, as buildings.ts.
    const up = (p: Local, q: Local, r: Local) => (q.z - p.z) * (r.x - p.x) - (q.x - p.x) * (r.z - p.z) > 0;
    const cap = up(a, b, ca) ? [ta, tb, ia, tb, ib, ia] : [ta, ia, tb, tb, ia, ib];
    mb.idx.push(...cap);
    mb.colliderIdx.push(...cap);
  }
  return metres;
}
