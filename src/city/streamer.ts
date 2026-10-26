import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BuildingChunk, roadMaterial } from './building-chunk.ts';
import {
  decodeBuildings,
  decodeGround,
  decodeTerrain,
  GROUND_APRON,
  SURFACES,
  type BuildingMesh,
  type ChunkInfo,
  type CityManifest,
  type GroundSamples,
  type Surface,
  type TerrainSamples,
} from './format.ts';
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
/**
 * Road meshes are drawn only this close: beyond it they're a few pixels
 * wide and the terrain's land-use tint already shows the streets, so each
 * far chunk saves a draw call.
 */
const ROAD_DRAW = 500;
/** A chunk asked for explicitly (teleport, debug probe) is kept this long even if out of range, ms. */
const PIN_MS = 5000;

type Slot = {
  info: ChunkInfo;
  chunk?: TerrainChunk;
  buildings?: BuildingChunk;
  roads?: BuildingChunk;
  ground?: GroundSamples;
  loading?: Promise<void>;
  waiters: (() => void)[];
  pinnedUntil: number;
};

export class ChunkStreamer {
  private readonly base: URL;
  private readonly manifest: CityManifest;
  private readonly scene: THREE.Scene;
  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly layout: TerrainLayout;
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly roadMaterial = roadMaterial();
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

  /** Surface class under a point (nearest 2 m ground sample), null if that chunk isn't loaded. */
  surfaceAt(x: number, z: number): Surface | null {
    const slot = this.slotAt(x, z);
    const g = slot?.ground;
    if (!slot?.chunk || !g) return null;
    const o = this.origin(slot.info);
    const cell = this.manifest.terrain.cellSize;
    const c = Math.round((x - o.x) / cell) + GROUND_APRON;
    const r = Math.round((z - o.z) / cell) + GROUND_APRON;
    return SURFACES[g.classes[r * g.n + c]] ?? null;
  }

  /**
   * The nearest loaded lattice point to (x, z), within `maxDist`, that
   * `ok(x, z, surface, height)` accepts, searching outwards in square rings
   * of lattice points. Null if none (or nothing loaded nearby).
   */
  nearest(x: number, z: number, maxDist: number, ok: (x: number, z: number, surface: Surface, height: number) => boolean): { x: number; z: number } | null {
    const cell = this.manifest.terrain.cellSize;
    const c0 = Math.round(x / cell);
    const r0 = Math.round(z / cell);
    let best: { x: number; z: number; d: number } | null = null;
    for (let ring = 0; ring * cell <= maxDist; ring++) {
      // Once a hit is closer than anything this ring can hold, it's the answer.
      if (best && best.d < (ring - 1) * cell) break;
      for (let dr = -ring; dr <= ring; dr++) {
        const edge = Math.abs(dr) === ring;
        for (let dc = -ring; dc <= ring; dc += edge ? 1 : 2 * ring) {
          const px = (c0 + dc) * cell;
          const pz = (r0 + dr) * cell;
          const d = Math.hypot(px - x, pz - z);
          if (d > maxDist || (best && d >= best.d)) continue;
          const surface = this.surfaceAt(px, pz);
          if (surface === null) continue;
          if (ok(px, pz, surface, this.heightAt(px, pz))) best = { x: px, z: pz, d };
          if (ring === 0) break;
        }
      }
    }
    return best && { x: best.x, z: best.z };
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
          slot.roads?.dispose(this.scene, this.world);
          slot.roads = undefined;
          slot.ground = undefined;
          continue;
        }
        const lod: Lod = d < DETAIL_IN ? 0 : d > DETAIL_OUT ? 1 : (slot.chunk.lod ?? 1);
        slot.chunk.setLod(lod, this.scene, this.material);
        if (slot.roads) slot.roads.mesh.visible = d < ROAD_DRAW;
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
    const { buildings: bfile, roads: rfile, ground: gfile } = slot.info.files;
    // A chunk's layers arrive together, so it never has ground without its
    // walls or roads (or the other way round).
    slot.loading = Promise.all([
      fetchTerrain(new URL(file, this.base)),
      bfile ? fetchBuildings(new URL(bfile, this.base)) : null,
      rfile ? fetchBuildings(new URL(rfile, this.base)) : null,
      gfile ? fetchGround(new URL(gfile, this.base)) : null,
    ])
      .then(([samples, buildings, roads, ground]) => {
        // It may have drifted out of range while downloading; keep it anyway
        // if someone is waiting on it.
        if (this.distance(slot.info, this.focus.x, this.focus.z) > UNLOAD_RADIUS && !slot.waiters.length) return;
        const o = this.origin(slot.info);
        const chunk = new TerrainChunk(slot.info.i, slot.info.j, o.x, o.z, samples, this.layout, ground ?? undefined);
        slot.ground = ground ?? undefined;
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
        if (roads) {
          const s = this.manifest.chunkSize;
          const r = new BuildingChunk(roads, o.x + s / 2, o.z + s / 2, this.roadMaterial, `roads ${slot.info.i},${slot.info.j}`);
          r.addCollider(this.world, this.body); // bridge decks
          r.mesh.visible = d < ROAD_DRAW;
          this.scene.add(r.mesh);
          slot.roads = r;
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
    let roadChunks = 0;
    for (const s of this.slots.values()) {
      if (s.chunk) loaded++;
      if (s.buildings) buildingChunks++;
      if (s.roads) roadChunks++;
      if (s.chunk?.lod === 0) detailed++;
    }
    return { chunks: this.slots.size, loaded, detailed, buildingChunks, roadChunks, inFlight: this.inFlight, failures: this.failures };
  }
}

async function fetchTerrain(url: URL): Promise<TerrainSamples> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const inflated = res.body.pipeThrough(new DecompressionStream('deflate'));
  return decodeTerrain(new Uint8Array(await new Response(inflated).arrayBuffer()));
}

async function fetchGround(url: URL): Promise<GroundSamples> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const inflated = res.body.pipeThrough(new DecompressionStream('deflate'));
  return decodeGround(new Uint8Array(await new Response(inflated).arrayBuffer()));
}

async function fetchBuildings(url: URL): Promise<BuildingMesh> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const inflated = res.body.pipeThrough(new DecompressionStream('deflate'));
  return decodeBuildings(new Uint8Array(await new Response(inflated).arrayBuffer()));
}
