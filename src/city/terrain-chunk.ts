import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { GroundSamples, TerrainSamples } from './format.ts';
import { buildTerrainGeometry, type TerrainLayout } from './terrain-mesh.ts';

// One 250 m chunk of ground: height samples, a render mesh per level of
// detail (one draw call each, only one visible at a time) and a Rapier
// heightfield collider.

/** Vertex step per level of detail: 0 = every 2 m sample, 1 = every 10 m. */
export const LOD_STEPS = [1, 5] as const;
export type Lod = 0 | 1;

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
  private readonly meshes: (THREE.Mesh | undefined)[] = [];
  private collider: RAPIER.Collider | null = null;
  lod: Lod | null = null;

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

  /** Show the given level of detail, building its mesh on first use. */
  setLod(lod: Lod, scene: THREE.Scene, material: THREE.Material): void {
    if (this.lod === lod) return;
    if (this.lod !== null) this.meshes[this.lod]!.visible = false;
    let mesh = this.meshes[lod];
    if (!mesh) {
      mesh = new THREE.Mesh(buildTerrainGeometry(this.samples, this.layout, this, LOD_STEPS[lod], this.ground), material);
      mesh.position.set(this.x, 0, this.z);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = `terrain ${this.i},${this.j} lod${lod}`;
      this.meshes[lod] = mesh;
      scene.add(mesh);
    }
    mesh.visible = true;
    this.lod = lod;
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

  dispose(scene: THREE.Scene, world: RAPIER.World): void {
    for (const mesh of this.meshes) {
      if (!mesh) continue;
      scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.length = 0;
    this.lod = null;
    if (this.collider) world.removeCollider(this.collider, false);
    this.collider = null;
  }
}
