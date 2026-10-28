import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BUILDING_GROUPS } from '../city/building-chunk.ts';
import type { Cavity } from '../city/cavity.ts';
import { cityMaterial } from '../city/city-material.ts';
import type { CityManifest, LandmarkInfo } from '../city/format.ts';
import { buildLandmarkAtlas, CUTOUT } from './atlas.ts';
import { Builder, type ColliderSpec } from './builder.ts';

// Hand-made landmark models (T9), built in code at load time and placed
// from the manifest's landmark records (overrides/<area>.json marks the OSM
// building with `landmark` and hides its generic shape with `hide`). Each
// landmark is one mesh, one draw call, in the city's vertex format and
// shader with its own small atlas (atlas.ts): full detail within `near`
// metres of the player, a plain far version beyond, nothing past
// `drawDistance` (the Sky Tower is always drawn, with the far skyline's
// long haze). Colliders are a few boxes and cylinders each, always present
// (they're cheap), on the city's fixed body.

export interface LandmarkModel {
  /** Manifest landmark id ('sky-tower'). */
  id: string;
  name: string;
  /** Full detail inside this distance (m, from the player, horizontal). */
  near: number;
  /** Not drawn beyond this (m). */
  drawDistance: number;
  /** Use the far skyline's haze instead of the scene's fog. */
  haze?: boolean;
  /** Height of the model above its base, m (for checks). */
  height: number;
  /** Writes the near (or far) model and, for the near one, its colliders. */
  build(b: Builder, far: boolean, records: LandmarkInfo[]): void;
  /** Ground it digs out (an underground car park): see src/city/cavity.ts. */
  cavity?(records: LandmarkInfo[]): Cavity;
}

export interface LandmarkState {
  id: string;
  name: string;
  x: number;
  z: number;
  base: number;
  height: number;
  /** Top of the drawn model, m above sea level. */
  top: number;
  lod: 'near' | 'far' | 'hidden';
  triangles: { near: number; far: number };
  colliders: number;
  /** Whether the OSM shape it replaces is hidden in the city mesh. */
  replaces: boolean;
}

interface Entry {
  model: LandmarkModel;
  records: LandmarkInfo[];
  mesh: THREE.Mesh;
  near: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  x: number;
  z: number;
  lod: LandmarkState['lod'];
  colliders: RAPIER.Collider[];
}

export class Landmarks {
  private readonly entries: Entry[] = [];
  private readonly time = { value: 0 };
  /** Ground the landmarks dig out, for the terrain (ChunkStreamer.cavities). */
  readonly cavities: Cavity[] = [];

  constructor(
    manifest: CityManifest,
    models: LandmarkModel[],
    scene: THREE.Scene,
    world: RAPIER.World,
    body: RAPIER.RigidBody,
    haze: { colour: THREE.Color; near: number; far: number },
    maxAnisotropy = 1,
  ) {
    const atlas = buildLandmarkAtlas(maxAnisotropy);
    const landmark = { cutout: CUTOUT, time: this.time };
    const fogged = cityMaterial(atlas, { landmark });
    const hazed = cityMaterial(atlas, { landmark, haze });
    for (const model of models) {
      const records = (manifest.landmarks ?? []).filter((l) => l.id === model.id);
      if (!records.length) continue;
      const nb = new Builder();
      model.build(nb, false, records);
      const fb = new Builder();
      model.build(fb, true, records);
      const near = nb.geometry();
      const far = fb.geometry();
      const mesh = new THREE.Mesh(far, model.haze ? hazed : fogged);
      mesh.name = `landmark ${model.id}`;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.visible = false;
      mesh.userData.parts = {};
      scene.add(mesh);
      const colliders = nb.colliders.map((c) => world.createCollider(colliderDesc(c), body));
      const x = records.reduce((s, r) => s + r.x, 0) / records.length;
      const z = records.reduce((s, r) => s + r.z, 0) / records.length;
      this.entries.push({ model, records, mesh, near, far, x, z, lod: 'hidden', colliders });
      if (model.cavity) this.cavities.push(model.cavity(records));
    }
  }

  /** Per frame: picks each landmark's detail by distance from (x, z), and ticks the lights. */
  update(x: number, z: number): void {
    this.time.value = performance.now() / 1000;
    for (const e of this.entries) {
      const d = Math.hypot(e.x - x, e.z - z);
      // A little hysteresis so standing on the line doesn't flicker.
      const slack = e.lod === 'near' ? 30 : 0;
      const lod: Entry['lod'] = d < e.model.near + slack ? 'near' : d < e.model.drawDistance ? 'far' : 'hidden';
      if (lod === e.lod) continue;
      e.lod = lod;
      e.mesh.visible = lod !== 'hidden';
      if (lod !== 'hidden') e.mesh.geometry = lod === 'near' ? e.near : e.far;
    }
  }

  list(): LandmarkState[] {
    return this.entries.map((e) => {
      const base = Math.min(...e.records.map((r) => r.base));
      const top = e.near.boundingBox!.max.y;
      return {
        id: e.model.id,
        name: e.model.name,
        x: e.x,
        z: e.z,
        base,
        height: e.model.height,
        top,
        lod: e.lod,
        triangles: { near: (e.near.index?.count ?? 0) / 3, far: (e.far.index?.count ?? 0) / 3 },
        colliders: e.colliders.length,
        replaces: e.records.every((r) => r.hidden),
      };
    });
  }
}

function colliderDesc(c: ColliderSpec): RAPIER.ColliderDesc {
  const desc =
    c.kind === 'box'
      ? RAPIER.ColliderDesc.cuboid(c.half[0], c.half[1], c.half[2]).setRotation(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.rotY),
        )
      : c.kind === 'cylinder'
        ? RAPIER.ColliderDesc.cylinder(c.halfHeight, c.radius)
        : RAPIER.ColliderDesc.trimesh(Float32Array.from(c.vertices), Uint32Array.from(c.indices));
  if (c.kind !== 'mesh') desc.setTranslation(c.centre[0], c.centre[1], c.centre[2]);
  return desc
    .setCollisionGroups(BUILDING_GROUPS)
    .setFriction(0.5)
    .setRestitution(0.05);
}
