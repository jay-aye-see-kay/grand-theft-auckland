// DEM -> per-chunk terrain heightfields.
//
// Samples sit on one global 2 m lattice in local metres, so the shared edge
// of two neighbouring chunks is computed from exactly the same points and
// comes out bit-identical: no seams by construction. Each chunk also stores
// a one-sample apron beyond its edges so the game can compute normals that
// are smooth across chunk boundaries without needing the neighbour loaded.
import type { BBox } from './project.ts';
import { lonLatToLocal } from './project.ts';
import { pixelLocal, sampleLocal, type Raster } from './raster.ts';

export const CHUNK_SIZE = 250;
export const CELL_SIZE = 2;
export const APRON = 1;
/** Samples per chunk side including both edges and the apron. */
export const SAMPLES = CHUNK_SIZE / CELL_SIZE + 1 + 2 * APRON;

/**
 * The LiDAR DEM flattens open water to about -1.1 m (the water surface on
 * the survey day). Anything below SEA_CUTOFF is dropped to a flat harbour
 * floor at SEA_SHELF, well under the water plane at WATER_LEVEL: with 2 m
 * between samples, the 10 m drop makes wharf edges and sea walls read as
 * near-vertical walls rather than sloped smears, and a car that drives off
 * one is clearly in the drink.
 */
export const SEA_CUTOFF = -0.5;
export const SEA_SHELF = -8;
/** Mean sea level in NZVD2016 (the LiDAR's datum) is within a few cm of 0 m at Auckland. */
export const WATER_LEVEL = 0;

export type Grid = { x0: number; z0: number; nx: number; nz: number };

/**
 * A chunk grid covering the bbox, centred on it and snapped to the sample
 * lattice (multiples of CELL_SIZE from the origin). Centring keeps the
 * overhang small on every side, so it stays inside the DEM window.
 */
export function chunkGrid(bbox: BBox): Grid {
  const [w, s, e, n] = bbox;
  const corners = [lonLatToLocal(w, s), lonLatToLocal(w, n), lonLatToLocal(e, s), lonLatToLocal(e, n)];
  const minX = Math.min(...corners.map((c) => c.x));
  const maxX = Math.max(...corners.map((c) => c.x));
  const minZ = Math.min(...corners.map((c) => c.z));
  const maxZ = Math.max(...corners.map((c) => c.z));
  const nx = Math.ceil((maxX - minX) / CHUNK_SIZE);
  const nz = Math.ceil((maxZ - minZ) / CHUNK_SIZE);
  const snap = (v: number) => Math.round(v / CELL_SIZE) * CELL_SIZE;
  return {
    x0: snap((minX + maxX) / 2 - (nx * CHUNK_SIZE) / 2),
    z0: snap((minZ + maxZ) / 2 - (nz * CHUNK_SIZE) / 2),
    nx,
    nz,
  };
}

/**
 * Ground height at a lattice point, in integer cm. A 2 m box filter (four
 * bilinear taps half a metre out) keeps LiDAR noise and kerb-edge aliasing
 * out of the 2 m grid. A point is sea if the DEM pixel under any tap is
 * open water (or no data), so the land's lattice points all sit inside the
 * pixel coastline that seawalls.ts builds its walls on, and the terrain's
 * drop to the sea floor stays behind those walls.
 */
export function groundCm(dem: Raster, x: number, z: number): number {
  if (corridor) {
    const c = x / CELL_SIZE;
    const r = z / CELL_SIZE;
    if (Number.isInteger(c) && Number.isInteger(r)) {
      const v = corridor.get(latticeKey(c, r));
      if (v !== undefined) return v;
    }
  }
  return rawGroundCm(dem, x, z);
}

function rawGroundCm(dem: Raster, x: number, z: number): number {
  let sum = 0;
  for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
    if (isWet(pixelLocal(dem, x + dx, z + dz))) return SEA_SHELF * 100;
    sum += sampleLocal(dem, x + dx, z + dz);
  }
  const h = sum / 4;
  return Math.round((h < SEA_CUTOFF ? SEA_SHELF : h) * 100);
}

const latticeKey = (c: number, r: number) => (c + 0x8000) * 0x10000 + (r + 0x8000);

/** Smoothed heights (cm) of lattice points on road corridors, standing in for groundCm there. */
let corridor: Map<number, number> | null = null;

/** Lattice points this far either side (in samples) are fitted when smoothing a corridor point. */
const SMOOTH_REACH = 5;
/** Neighbours more than this far above or below a point (m) are a wall or a different level, not the same street. */
const SMOOTH_STEP = 0.5;

/**
 * Smooths the ground under streets. LiDAR ground is bumpy at the 5-20 cm
 * scale (cambers, gutters, kerbs, manholes), and draped road strips that
 * follow every bump cost several triangles a metre. Real streets are
 * smooth, so the lattice points under each street (`mask`) are replaced by
 * a least-squares plane through their neighbours on the same street within
 * SMOOTH_REACH samples (skipping sea and anything a step away), which
 * keeps slopes, crests and dips at the 10 m scale. Both the terrain chunks
 * (render mesh and collider) and everything draped or seated on them
 * (roads, buildings, parked cars) read the smoothed ground through groundCm.
 */
export function smoothCorridors(dem: Raster, mask: Set<number>): number {
  const raw = new Map<number, number>();
  const rawAt = (c: number, r: number) => {
    const k = latticeKey(c, r);
    let v = raw.get(k);
    if (v === undefined) raw.set(k, (v = rawGroundCm(dem, c * CELL_SIZE, r * CELL_SIZE)));
    return v;
  };
  const out = new Map<number, number>();
  const keys = [...mask].sort((a, b) => a - b);
  for (const k of keys) {
    const c = Math.floor(k / 0x10000) - 0x8000;
    const r = (k % 0x10000) - 0x8000;
    const h0 = rawAt(c, r);
    if (h0 <= SEA_SHELF * 100) continue;
    // Plane z = a + b dc + d dr through the neighbours; the answer is a.
    let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
    for (let dr = -SMOOTH_REACH; dr <= SMOOTH_REACH; dr++) {
      for (let dc = -SMOOTH_REACH; dc <= SMOOTH_REACH; dc++) {
        if (!mask.has(latticeKey(c + dc, r + dr))) continue;
        const h = rawAt(c + dc, r + dr);
        if (h <= SEA_SHELF * 100 || Math.abs(h - h0) > SMOOTH_STEP * 100) continue;
        n++;
        sx += dc; sy += dr; sz += h;
        sxx += dc * dc; syy += dr * dr; sxy += dc * dr;
        sxz += dc * h; syz += dr * h;
      }
    }
    if (n < 6) continue;
    // Normal equations, solved by Cramer's rule.
    const m = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
    const det = (a: number[][]) =>
      a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const d = det(m);
    if (Math.abs(d) < 1e-6) continue;
    const a = det([[sz, sx, sy], [sxz, sxx, sxy], [syz, sxy, syy]]) / d;
    out.set(k, Math.round(a));
  }
  corridor = out;
  return out.size;
}

/** Lattice points (keys for smoothCorridors) within `radius` of the segment a-b. */
/** Adds lattice point (c, r) to a smoothing mask. */
export function markLattice(mask: Set<number>, c: number, r: number) {
  mask.add(latticeKey(c, r));
}

export function markCapsule(mask: Set<number>, a: { x: number; z: number }, b: { x: number; z: number }, radius: number) {
  const c0 = Math.floor((Math.min(a.x, b.x) - radius) / CELL_SIZE);
  const c1 = Math.ceil((Math.max(a.x, b.x) + radius) / CELL_SIZE);
  const r0 = Math.floor((Math.min(a.z, b.z) - radius) / CELL_SIZE);
  const r1 = Math.ceil((Math.max(a.z, b.z) + radius) / CELL_SIZE);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = c * CELL_SIZE;
      const z = r * CELL_SIZE;
      const f = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2));
      if (Math.hypot(x - a.x - f * dx, z - a.z - f * dz) <= radius) mask.add(latticeKey(c, r));
    }
  }
}

/** Open water (or no data) in the DEM. */
export const isWet = (v: number) => !(v >= SEA_CUTOFF);

export type TerrainChunk = {
  i: number;
  j: number;
  /** SAMPLES*SAMPLES heights in cm, row-major (rows along z), apron included. */
  cm: Int32Array;
  /** Height range inside the chunk proper (no apron), metres. */
  minY: number;
  maxY: number;
};

export function buildTerrainChunk(dem: Raster, grid: Grid, i: number, j: number): TerrainChunk {
  const n = SAMPLES;
  const cm = new Int32Array(n * n);
  const x0 = grid.x0 + i * CHUNK_SIZE - APRON * CELL_SIZE;
  const z0 = grid.z0 + j * CHUNK_SIZE - APRON * CELL_SIZE;
  let lo = Infinity;
  let hi = -Infinity;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = groundCm(dem, x0 + c * CELL_SIZE, z0 + r * CELL_SIZE);
      cm[r * n + c] = v;
      const inside = r >= APRON && r < n - APRON && c >= APRON && c < n - APRON;
      if (inside) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  return { i, j, cm, minY: lo / 100, maxY: hi / 100 };
}

/**
 * The game's collision surface, reproduced offline: lattice heights from
 * groundCm() (memoised) joined by the same two triangles per cell as
 * TerrainChunk.heightAt() and Rapier's heightfield. Chunk corners sit on the
 * global lattice, so one global formula matches every chunk.
 */
export class TerrainSampler {
  private readonly dem: Raster;
  private readonly cache = new Map<number, number>();

  constructor(dem: Raster) {
    this.dem = dem;
  }

  /** Height (m) of lattice point (c, r), i.e. local (c * CELL_SIZE, r * CELL_SIZE). */
  lattice(c: number, r: number): number {
    const key = (c + 0x8000) * 0x10000 + (r + 0x8000);
    let h = this.cache.get(key);
    if (h === undefined) this.cache.set(key, (h = groundCm(this.dem, c * CELL_SIZE, r * CELL_SIZE) / 100));
    return h;
  }

  heightAt(x: number, z: number): number {
    const lx = x / CELL_SIZE;
    const lz = z / CELL_SIZE;
    const c = Math.floor(lx);
    const r = Math.floor(lz);
    const fx = lx - c;
    const fz = lz - r;
    const h00 = this.lattice(c, r);
    const h10 = this.lattice(c + 1, r);
    const h01 = this.lattice(c, r + 1);
    const h11 = this.lattice(c + 1, r + 1);
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }
}
