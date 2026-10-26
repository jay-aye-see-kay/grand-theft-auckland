import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { BuildingMesh } from './format.ts';

// One chunk's buildings: a single merged, vertex-coloured mesh (one draw
// call) and one static trimesh collider for all of its walls and roofs.

/**
 * Collision groups (membership << 16 | filter). Buildings are in group 1 and
 * collide with everything; queries that want bare terrain (the debug probe)
 * filter on group 0, which buildings aren't in.
 */
export const BUILDING_GROUPS = (0x0002 << 16) | 0xffff;
export const TERRAIN_ONLY_QUERY = (0xffff << 16) | 0x0001;

export class BuildingChunk {
  readonly mesh: THREE.Mesh;
  private collider: RAPIER.Collider | null = null;
  private readonly vertices: Float32Array;
  private readonly colliderIndices: Uint32Array;

  /** @param cx, cz the chunk centre in local metres (the file's origin) */
  constructor(data: BuildingMesh, cx: number, cz: number, material: THREE.Material, name: string) {
    const n = data.xCm.length;
    const pos = new Float32Array(n * 3);
    const base = data.baseCm / 100;
    for (let k = 0; k < n; k++) {
      pos[k * 3] = data.xCm[k] / 100;
      pos[k * 3 + 1] = base + data.yCm[k] / 100;
      pos[k * 3 + 2] = data.zCm[k] / 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colours, 3, true));
    geo.setIndex(new THREE.BufferAttribute(n > 0xffff ? data.indices : Uint16Array.from(data.indices), 1));
    geo.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.position.set(cx, 0, cz);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.name = name;

    // The collider lives on the shared fixed body, so it needs world positions.
    this.vertices = new Float32Array(pos);
    for (let k = 0; k < n; k++) {
      this.vertices[k * 3] += cx;
      this.vertices[k * 3 + 2] += cz;
    }
    this.colliderIndices = data.colliderIndices;
  }

  get hasCollider(): boolean {
    return this.collider !== null;
  }

  addCollider(world: RAPIER.World, body: RAPIER.RigidBody): void {
    if (this.collider || !this.colliderIndices.length) return;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.trimesh(this.vertices, this.colliderIndices)
        .setCollisionGroups(BUILDING_GROUPS)
        .setFriction(0.5)
        .setRestitution(0.05),
      body,
    );
  }

  dispose(scene: THREE.Scene, world: RAPIER.World): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    if (this.collider) world.removeCollider(this.collider, false);
    this.collider = null;
  }
}
