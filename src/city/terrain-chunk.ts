import RAPIER from '@dimforge/rapier3d-compat';
import type { GroundSamples, TerrainSamples } from './format.ts';
import { buildTerrainParts, type TerrainLayout, type TerrainParts } from './terrain-mesh.ts';

// One 250 m chunk of ground: height samples, render parts (drawn by
// ChunkMesh, merged with the chunk's buildings and roads) and a Rapier
// heightfield collider, which only chunks near the player have.

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

  constructor(i: number, j: number, x: number, z: number, samples: TerrainSamples, layout: TerrainLayout, ground?: GroundSamples) {
    this.i = i;
    this.j = j;
    this.x = x;
    this.z = z;
    this.samples = samples;
    this.layout = layout;
    this.ground = ground;
    this.size = layout.cells * layout.cell;
  }

  /** Sample (row along z, column along x) inside the chunk, apron excluded. */
  private h(r: number, c: number): number {
    const { apron } = this.layout;
    return this.samples.heights[(r + apron) * this.samples.n + c + apron];
  }

  /**
   * Height of the collision surface at a local point inside this chunk:
   * the same two triangles per cell that Rapier's heightfield uses.
   */
  heightAt(x: number, z: number): number {
    const { cell, cells } = this.layout;
    const lx = (x - this.x) / cell;
    const lz = (z - this.z) / cell;
    const c = Math.min(Math.max(Math.floor(lx), 0), cells - 1);
    const r = Math.min(Math.max(Math.floor(lz), 0), cells - 1);
    const fx = lx - c;
    const fz = lz - r;
    const h00 = this.h(r, c);
    const h10 = this.h(r, c + 1);
    const h01 = this.h(r + 1, c);
    const h11 = this.h(r + 1, c + 1);
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** Render parts: coarse only, or also the 2 m tiles (see buildTerrainParts). */
  parts(near: boolean): TerrainParts {
    return buildTerrainParts(this.samples, this.layout, this, this.ground, near);
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
    for (let c = 0; c < side; c++) for (let r = 0; r < side; r++) heights[r + c * side] = this.h(r, c);
    const half = this.size / 2;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.heightfield(cells, cells, heights, { x: this.size, y: 1, z: this.size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
        .setTranslation(this.x + half, 0, this.z + half)
        .setFriction(0.9),
      body,
    );
  }

  removeCollider(world: RAPIER.World): void {
    if (this.collider) world.removeCollider(this.collider, false);
    this.collider = null;
  }
}
