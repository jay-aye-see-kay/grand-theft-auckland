import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BuildingChunk, roadMaterial } from './building-chunk.ts';
import { ChunkMesh } from './chunk-mesh.ts';
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
import { TerrainChunk } from './terrain-chunk.ts';
import type { TerrainLayout } from './terrain-mesh.ts';

// Radius-based chunk loading around a focus point (the player or their car).
// Chunks within LOAD_RADIUS are fetched (nearest first, a few at a time);
// beyond UNLOAD_RADIUS they're thrown away. Each chunk is one draw call
// (ChunkMesh). Ground within DETAIL_IN of the focus is drawn at full 2 m
// detail, 50 m tile by tile; the rest is coarse, and fog hides the switch.
// Only chunks within COLLIDE_IN have colliders (terrain heightfield,
// buildings, bridge decks); further out nothing is close enough to touch
// them, and cars standing there freeze until they're back in range (see
// GameMap.hasGround). Proper streaming polish (prefetch by velocity, far
// skyline) is T13.

const LOAD_RADIUS = 900;
const UNLOAD_RADIUS = 1100;
/** Ground tiles switch to 2 m detail inside this distance, and back to coarse beyond DETAIL_OUT, m. */
const DETAIL_IN = 90;
const DETAIL_OUT = 120;
/** Colliders are added inside this distance and removed beyond COLLIDE_OUT, m. */
const COLLIDE_IN = 300;
const COLLIDE_OUT = 400;
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
  mesh?: ChunkMesh;
  /** Per 50 m tile: 0 = 2 m detail, 1 = coarse. */
  tiles?: Uint8Array;
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
  private readonly material = roadMaterial();
  private readonly slots = new Map<string, Slot>();
  private inFlight = 0;
  private readonly focus = { x: 0, z: 0 };
  private readonly wanted: Slot[] = [];
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
    this.focus.x = x;
    this.focus.z = z;
    const now = performance.now();
    const wanted = this.wanted;
    wanted.length = 0;
    for (const slot of this.slots.values()) {
      const d = this.distance(slot.info, x, z);
      const pinned = now < slot.pinnedUntil;
      if (slot.chunk) {
        if (d > UNLOAD_RADIUS && !pinned) {
          this.unload(slot);
          continue;
        }
        if (d < COLLIDE_IN || pinned) this.addColliders(slot);
        else if (d > COLLIDE_OUT) this.removeColliders(slot);
        this.updateMesh(slot, d);
      } else if (!slot.loading && d < LOAD_RADIUS) {
        wanted.push(slot);
      }
    }
    if (!wanted.length || this.inFlight >= MAX_IN_FLIGHT) return;
    wanted.sort((a, b) => this.distance(a.info, x, z) - this.distance(b.info, x, z));
    for (const slot of wanted) {
      if (this.inFlight >= MAX_IN_FLIGHT) break;
      this.load(slot);
    }
  }

  /** Near terrain (2 m tiles) for chunks with any tile in detail range; roads within ROAD_DRAW. */
  private updateMesh(slot: Slot, d: number): void {
    const mesh = slot.mesh!;
    const chunk = slot.chunk!;
    if (!mesh.near && d < DETAIL_IN) mesh.setTerrain(chunk.parts(true));
    else if (mesh.near && d > DETAIL_OUT + 50) mesh.setTerrain(chunk.parts(false));
    let tiles: Uint8Array | null = null;
    if (mesh.near) {
      const side = mesh.tilesPerSide;
      const size = this.manifest.chunkSize / side;
      tiles = slot.tiles && slot.tiles.length === side * side ? slot.tiles : (slot.tiles = new Uint8Array(side * side).fill(1));
      for (let r = 0; r < side; r++) {
        for (let c = 0; c < side; c++) {
          const tx = chunk.x + c * size;
          const tz = chunk.z + r * size;
          const td = Math.hypot(Math.max(tx - this.focus.x, 0, this.focus.x - tx - size), Math.max(tz - this.focus.z, 0, this.focus.z - tz - size));
          const k = r * side + c;
          if (td < DETAIL_IN) tiles[k] = 0;
          else if (td > DETAIL_OUT) tiles[k] = 1;
        }
      }
    }
    mesh.update(d < ROAD_DRAW, tiles);
  }

  private addColliders(slot: Slot): void {
    if (slot.chunk?.hasCollider) return;
    slot.chunk?.addCollider(this.world, this.body);
    slot.buildings?.addCollider(this.world, this.body);
    slot.roads?.addCollider(this.world, this.body); // bridge decks
  }

  private removeColliders(slot: Slot): void {
    if (!slot.chunk?.hasCollider) return;
    slot.chunk.removeCollider(this.world);
    slot.buildings?.removeCollider(this.world);
    slot.roads?.removeCollider(this.world);
  }

  private unload(slot: Slot): void {
    this.removeColliders(slot);
    if (slot.mesh) {
      this.scene.remove(slot.mesh.mesh);
      slot.mesh.dispose();
    }
    slot.chunk = slot.buildings = slot.roads = slot.mesh = slot.tiles = slot.ground = undefined;
  }

  /** Loads the chunk under (x, z) right away (ahead of the queue) and resolves when it has collision. */
  ensureLoaded(x: number, z: number): Promise<void> {
    const slot = this.slotAt(x, z);
    if (slot) slot.pinnedUntil = performance.now() + PIN_MS;
    if (slot?.chunk) this.addColliders(slot);
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
        const half = this.manifest.chunkSize / 2;
        const chunk = new TerrainChunk(slot.info.i, slot.info.j, o.x, o.z, samples, this.layout, ground ?? undefined);
        slot.ground = ground ?? undefined;
        slot.chunk = chunk;
        slot.buildings = buildings ? new BuildingChunk(buildings, o.x + half, o.z + half) : undefined;
        slot.roads = roads ? new BuildingChunk(roads, o.x + half, o.z + half) : undefined;
        const d = this.distance(slot.info, this.focus.x, this.focus.z);
        const mesh = new ChunkMesh(`chunk ${slot.info.i},${slot.info.j}`, o.x + half, o.z + half, half, this.material, slot.roads, slot.buildings);
        mesh.setTerrain(chunk.parts(d < DETAIL_IN));
        slot.mesh = mesh;
        this.scene.add(mesh.mesh);
        if (d < COLLIDE_IN || slot.waiters.length || performance.now() < slot.pinnedUntil) this.addColliders(slot);
        this.updateMesh(slot, d);
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
    let colliders = 0;
    let buildingChunks = 0;
    let roadChunks = 0;
    for (const s of this.slots.values()) {
      if (s.chunk) loaded++;
      if (s.chunk?.hasCollider) colliders++;
      if (s.buildings) buildingChunks++;
      if (s.roads) roadChunks++;
      if (s.mesh?.near && s.tiles?.includes(0)) detailed++;
    }
    return { chunks: this.slots.size, loaded, detailed, colliders, buildingChunks, roadChunks, inFlight: this.inFlight, failures: this.failures };
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
