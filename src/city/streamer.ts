import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BuildingChunk } from './building-chunk.ts';
import { decodeBuildings, decodeTerrain, type BuildingMesh, type ChunkInfo, type CityManifest, type TerrainSamples } from './format.ts';
import { TerrainChunk, type Lod } from './terrain-chunk.ts';
import type { TerrainLayout } from './terrain-mesh.ts';

// Radius-based chunk loading around a focus point (the player or their car).
// Chunks within LOAD_RADIUS are fetched (nearest first, a few at a time) and
// get a collider as soon as they arrive; beyond UNLOAD_RADIUS they're thrown
// away. Close chunks render at full detail, the rest coarse. Proper
// streaming polish (prefetch by velocity, far skyline) is T13.

const LOAD_RADIUS = 900;
const UNLOAD_RADIUS = 1100;
const DETAIL_IN = 180; // switch to full detail inside this distance...
const DETAIL_OUT = 260; // ...and back to coarse beyond this one
const MAX_IN_FLIGHT = 6;
/** A chunk asked for explicitly (teleport, debug probe) is kept this long even if out of range, ms. */
const PIN_MS = 5000;

type Slot = { info: ChunkInfo; chunk?: TerrainChunk; buildings?: BuildingChunk; loading?: Promise<void>; waiters: (() => void)[]; pinnedUntil: number };

export class ChunkStreamer {
  private readonly base: URL;
  private readonly manifest: CityManifest;
  private readonly scene: THREE.Scene;
  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly layout: TerrainLayout;
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly slots = new Map<string, Slot>();
  private inFlight = 0;
  private focus = { x: 0, z: 0 };
  /** Count of chunk fetches that failed (shown in ?debug). */
  failures = 0;

  constructor(base: URL, manifest: CityManifest, scene: THREE.Scene, world: RAPIER.World, body: RAPIER.RigidBody) {
    this.base = base;
    this.manifest = manifest;
    this.scene = scene;
    this.world = world;
    this.body = body;
    const t = manifest.terrain;
    this.layout = { cell: t.cellSize, cells: manifest.chunkSize / t.cellSize, apron: t.apron, seaShelf: t.seaShelf };
    for (const info of manifest.chunks) this.slots.set(`${info.i},${info.j}`, { info, waiters: [], pinnedUntil: 0 });
  }

  private origin(info: ChunkInfo) {
    const { grid, chunkSize } = this.manifest;
    return { x: grid.x0 + info.i * chunkSize, z: grid.z0 + info.j * chunkSize };
  }

  /** Distance on the ground from a point to a chunk's square (0 inside it). */
  private distance(info: ChunkInfo, x: number, z: number): number {
    const o = this.origin(info);
    const s = this.manifest.chunkSize;
    const dx = Math.max(o.x - x, 0, x - (o.x + s));
    const dz = Math.max(o.z - z, 0, z - (o.z + s));
    return Math.hypot(dx, dz);
  }

  private slotAt(x: number, z: number): Slot | undefined {
    const { grid, chunkSize } = this.manifest;
    const i = Math.floor((x - grid.x0) / chunkSize);
    const j = Math.floor((z - grid.z0) / chunkSize);
    return this.slots.get(`${i},${j}`);
  }

  insideGrid(x: number, z: number): boolean {
    const b = this.manifest.bounds;
    return x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ;
  }

  /** Collision height at a point, NaN if that chunk isn't loaded. */
  heightAt(x: number, z: number): number {
    const chunk = this.slotAt(x, z)?.chunk;
    return chunk ? chunk.heightAt(x, z) : NaN;
  }

  hasCollider(x: number, z: number): boolean {
    return !!this.slotAt(x, z)?.chunk?.hasCollider;
  }

  update(x: number, z: number): void {
    this.focus = { x, z };
    const wanted: Slot[] = [];
    for (const slot of this.slots.values()) {
      const d = this.distance(slot.info, x, z);
      if (slot.chunk) {
        if (d > UNLOAD_RADIUS && performance.now() > slot.pinnedUntil) {
          slot.chunk.dispose(this.scene, this.world);
          slot.chunk = undefined;
          slot.buildings?.dispose(this.scene, this.world);
          slot.buildings = undefined;
          continue;
        }
        const lod: Lod = d < DETAIL_IN ? 0 : d > DETAIL_OUT ? 1 : (slot.chunk.lod ?? 1);
        slot.chunk.setLod(lod, this.scene, this.material);
      } else if (!slot.loading && d < LOAD_RADIUS) {
        wanted.push(slot);
      }
    }
    wanted.sort((a, b) => this.distance(a.info, x, z) - this.distance(b.info, x, z));
    for (const slot of wanted) {
      if (this.inFlight >= MAX_IN_FLIGHT) break;
      this.load(slot);
    }
  }

  /** Loads the chunk under (x, z) right away (ahead of the queue) and resolves when it has collision. */
  ensureLoaded(x: number, z: number): Promise<void> {
    const slot = this.slotAt(x, z);
    if (slot) slot.pinnedUntil = performance.now() + PIN_MS;
    if (!slot || slot.chunk) return Promise.resolve();
    const done = new Promise<void>((resolve) => slot.waiters.push(resolve));
    if (!slot.loading) this.load(slot);
    return done;
  }

  /** Loads every chunk within `radius` of (x, z) and resolves when they all have collision. */
  ensureAround(x: number, z: number, radius: number): Promise<void> {
    const near = [...this.slots.values()].filter((s) => this.distance(s.info, x, z) <= radius);
    near.sort((a, b) => this.distance(a.info, x, z) - this.distance(b.info, x, z));
    return Promise.all(near.map((s) => {
      const o = this.origin(s.info);
      return this.ensureLoaded(o.x + 1, o.z + 1);
    })).then(() => {});
  }

  private load(slot: Slot): void {
    this.inFlight++;
    const file = slot.info.files.terrain;
    const bfile = slot.info.files.buildings;
    // Terrain and buildings arrive together, so a chunk never has ground
    // without its walls (or the other way round).
    slot.loading = Promise.all([fetchTerrain(new URL(file, this.base)), bfile ? fetchBuildings(new URL(bfile, this.base)) : null])
      .then(([samples, buildings]) => {
        // It may have drifted out of range while downloading; keep it anyway
        // if someone is waiting on it.
        if (this.distance(slot.info, this.focus.x, this.focus.z) > UNLOAD_RADIUS && !slot.waiters.length) return;
        const o = this.origin(slot.info);
        const chunk = new TerrainChunk(slot.info.i, slot.info.j, o.x, o.z, samples, this.layout);
        chunk.addCollider(this.world, this.body);
        const d = this.distance(slot.info, this.focus.x, this.focus.z);
        chunk.setLod(d < DETAIL_IN ? 0 : 1, this.scene, this.material);
        slot.chunk = chunk;
        if (buildings) {
          const s = this.manifest.chunkSize;
          const b = new BuildingChunk(buildings, o.x + s / 2, o.z + s / 2, this.material, `buildings ${slot.info.i},${slot.info.j}`);
          b.addCollider(this.world, this.body);
          this.scene.add(b.mesh);
          slot.buildings = b;
        }
      })
      .catch((err) => {
        this.failures++;
        console.warn(`chunk ${file}: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        this.inFlight--;
        slot.loading = undefined;
        for (const resolve of slot.waiters.splice(0)) resolve();
      });
  }

  stats() {
    let loaded = 0;
    let detailed = 0;
    let buildingChunks = 0;
    for (const s of this.slots.values()) {
      if (s.chunk) loaded++;
      if (s.buildings) buildingChunks++;
      if (s.chunk?.lod === 0) detailed++;
    }
    return { chunks: this.slots.size, loaded, detailed, buildingChunks, inFlight: this.inFlight, failures: this.failures };
  }
}

async function fetchTerrain(url: URL): Promise<TerrainSamples> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const inflated = res.body.pipeThrough(new DecompressionStream('deflate'));
  return decodeTerrain(new Uint8Array(await new Response(inflated).arrayBuffer()));
}

async function fetchBuildings(url: URL): Promise<BuildingMesh> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const inflated = res.body.pipeThrough(new DecompressionStream('deflate'));
  return decodeBuildings(new Uint8Array(await new Response(inflated).arrayBuffer()));
}
