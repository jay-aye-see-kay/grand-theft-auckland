import RAPIER from '@dimforge/rapier3d-compat';
import { inOpening, type Cavity } from './cavity.ts';
import type { GroundSamples, TerrainSamples } from './format.ts';
import { buildTerrainParts, type TerrainCarve, type TerrainLayout, type TerrainParts } from './terrain-mesh.ts';

// One 250 m chunk of ground: height samples, render parts (drawn by
// ChunkMesh, merged with the chunk's buildings and roads) and a Rapier
// heightfield collider, which only chunks near the player have. Where a
// cavity is dug under it (cavity.ts), the collider is the carved ground plus
// a roof over the dug-out part at the original heights.

/** Below the drawn ground by more than this, a point is inside a cavity (heightAt with y). */
const UNDER_ROOF = 1;

export class TerrainChunk {
  readonly i: number;
  readonly j: number;
  /** North-west corner, local metres. */
  readonly x: number;
  readonly z: number;
  readonly size: number;
  private readonly samples: TerrainSamples;
  private readonly layout: TerrainLayout;
  private readonly ground: GroundSamples | undefined;
  private collider: RAPIER.Collider | null = null;
  private roof: RAPIER.Collider | null = null;
  /** Collision heights where a cavity is dug (same layout as the samples), else null. */
  private readonly carved: Float32Array | null = null;
  private readonly carve: TerrainCarve | undefined;

  constructor(i: number, j: number, x: number, z: number, samples: TerrainSamples, layout: TerrainLayout, ground?: GroundSamples, cavities: Cavity[] = []) {
    this.i = i;
    this.j = j;
    this.x = x;
    this.z = z;
    this.samples = samples;
    this.layout = layout;
    this.ground = ground;
    this.size = layout.cells * layout.cell;
    const { cell, apron } = layout;
    const n = samples.n;
    const lo = -apron * cell;
    const hi = (n - 1 - apron) * cell;
    const mine = cavities.filter((c) => c.bounds.maxX >= x + lo && c.bounds.minX <= x + hi && c.bounds.maxZ >= z + lo && c.bounds.minZ <= z + hi);
    if (!mine.length) return;
    const original = (px: number, pz: number) => {
      const c = Math.min(Math.max(Math.round((px - x) / cell) + apron, 0), n - 1);
      const r = Math.min(Math.max(Math.round((pz - z) / cell) + apron, 0), n - 1);
      return samples.heights[r * n + c];
    };
    const carved = Float32Array.from(samples.heights);
    let any = false;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const px = x + (c - apron) * cell;
        const pz = z + (r - apron) * cell;
        for (const cav of mine) {
          const b = cav.bounds;
          if (px < b.minX || px > b.maxX || pz < b.minZ || pz > b.maxZ) continue;
          const v = cav.carve(px, pz, original);
          if (v === null) continue;
          carved[r * n + c] = v;
          any = true;
        }
      }
    }
    if (!any) return;
    this.carved = carved;
    this.carve = {
      heights: carved,
      open: (px, pz) => mine.some((cav) => inOpening(cav, px, pz)),
      colour: mine[0].openingColour,
    };
  }

  /** Sample (row along z, column along x) inside the chunk, apron excluded: the ground as drawn. */
  private h(r: number, c: number): number {
    const { apron } = this.layout;
    return this.samples.heights[(r + apron) * this.samples.n + c + apron];
  }

  /** The same, for the collider (the carved ground where a cavity is dug). */
  private hc(r: number, c: number): number {
    if (!this.carved) return this.h(r, c);
    const { apron } = this.layout;
    return this.carved[(r + apron) * this.samples.n + c + apron];
  }

  /**
   * Height of the ground at a local point inside this chunk: the same two
   * triangles per cell that Rapier's heightfield uses. Over a cavity that's
   * the roof, unless `y` is given and well below it: then it's the cavity's
   * floor (a car in the car park isn't lost underground).
   */
  heightAt(x: number, z: number, y?: number): number {
    const top = this.surface(x, z, (r, c) => this.h(r, c));
    if (!this.carved || y === undefined || y > top - UNDER_ROOF) return top;
    return this.surface(x, z, (r, c) => this.hc(r, c));
  }

  private surface(x: number, z: number, h: (r: number, c: number) => number): number {
    const { cell, cells } = this.layout;
    const lx = (x - this.x) / cell;
    const lz = (z - this.z) / cell;
    const c = Math.min(Math.max(Math.floor(lx), 0), cells - 1);
    const r = Math.min(Math.max(Math.floor(lz), 0), cells - 1);
    const fx = lx - c;
    const fz = lz - r;
    const h00 = h(r, c);
    const h10 = h(r, c + 1);
    const h01 = h(r + 1, c);
    const h11 = h(r + 1, c + 1);
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** Render parts: coarse only, or also the 2 m tiles (see buildTerrainParts). */
  parts(near: boolean): TerrainParts {
    return buildTerrainParts(this.samples, this.layout, this, this.ground, near, this.carve);
  }

  get hasCollider(): boolean {
    return this.collider !== null;
  }

  addCollider(world: RAPIER.World, body: RAPIER.RigidBody): void {
    if (this.collider) return;
    const { cells } = this.layout;
    // Rapier wants a column-major matrix: rows run along z, columns along x,
    // so entry (row r, column c) lives at r + c * (cells + 1). The shape is
    // centred on its translation and `scale` is its full extent.
    const side = cells + 1;
    const heights = new Float32Array(side * side);
    for (let c = 0; c < side; c++) for (let r = 0; r < side; r++) heights[r + c * side] = this.hc(r, c);
    const half = this.size / 2;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.heightfield(cells, cells, heights, { x: this.size, y: 1, z: this.size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
        .setTranslation(this.x + half, 0, this.z + half)
        .setFriction(0.9),
      body,
    );
    if (this.carved) this.roof = this.addRoof(world, body);
  }

  /**
   * The ground over a cavity: every cell the carving lowered, at its
   * original heights and split along the heightfield's diagonal, except the
   * openings.
   */
  private addRoof(world: RAPIER.World, body: RAPIER.RigidBody): RAPIER.Collider | null {
    const { cell, cells } = this.layout;
    const verts: number[] = [];
    const index: number[] = [];
    const ids = new Map<number, number>();
    const vert = (r: number, c: number) => {
      const key = r * (cells + 1) + c;
      let k = ids.get(key);
      if (k === undefined) {
        k = verts.length / 3;
        verts.push(this.x + c * cell, this.h(r, c), this.z + r * cell);
        ids.set(key, k);
      }
      return k;
    };
    const lowered = (r: number, c: number) => this.hc(r, c) < this.h(r, c) - 0.01;
    for (let r = 0; r < cells; r++) {
      for (let c = 0; c < cells; c++) {
        if (!lowered(r, c) && !lowered(r, c + 1) && !lowered(r + 1, c) && !lowered(r + 1, c + 1)) continue;
        if (this.carve!.open(this.x + (c + 0.5) * cell, this.z + (r + 0.5) * cell)) continue;
        const p00 = vert(r, c);
        const p10 = vert(r, c + 1);
        const p01 = vert(r + 1, c);
        const p11 = vert(r + 1, c + 1);
        // Counter-clockwise from above (y up, z south), split (x1, z0) to (x0, z1).
        index.push(p00, p01, p10, p10, p01, p11);
      }
    }
    if (!index.length) return null;
    return world.createCollider(RAPIER.ColliderDesc.trimesh(Float32Array.from(verts), Uint32Array.from(index), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.9), body);
  }

  removeCollider(world: RAPIER.World): void {
    if (this.collider) world.removeCollider(this.collider, false);
    if (this.roof) world.removeCollider(this.roof, false);
    this.collider = null;
    this.roof = null;
  }
}
