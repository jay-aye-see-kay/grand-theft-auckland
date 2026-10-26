// DEM -> per-chunk terrain heightfields.
//
// Samples sit on one global 2 m lattice in local metres, so the shared edge
// of two neighbouring chunks is computed from exactly the same points and
// comes out bit-identical: no seams by construction. Each chunk also stores
// a one-sample apron beyond its edges so the game can compute normals that
// are smooth across chunk boundaries without needing the neighbour loaded.
import type { BBox } from './project.ts';
import { lonLatToLocal } from './project.ts';
import { sampleLocal, type Raster } from './raster.ts';

export const CHUNK_SIZE = 250;
export const CELL_SIZE = 2;
export const APRON = 1;
/** Samples per chunk side including both edges and the apron. */
export const SAMPLES = CHUNK_SIZE / CELL_SIZE + 1 + 2 * APRON;

/**
 * The LiDAR DEM flattens open water to about -1.1 m (the water surface on
 * the survey day). Until T7 adds a water plane, anything below SEA_CUTOFF is
 * dropped to a flat harbour floor at SEA_SHELF, so the coastline reads as a
 * clean step and the car can't drive "on" the sea.
 */
export const SEA_CUTOFF = -0.5;
export const SEA_SHELF = -2;

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
 * out of the 2 m grid. No-data counts as sea.
 */
export function groundCm(dem: Raster, x: number, z: number): number {
  let sum = 0;
  let count = 0;
  for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
    const v = sampleLocal(dem, x + dx, z + dz);
    if (!Number.isNaN(v)) {
      sum += v;
      count++;
    }
  }
  const h = count ? sum / count : SEA_SHELF;
  return Math.round((h < SEA_CUTOFF ? SEA_SHELF : h) * 100);
}

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
