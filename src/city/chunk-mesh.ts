import * as THREE from 'three';
import type { BuildingChunk } from './building-chunk.ts';
import type { TerrainParts } from './terrain-mesh.ts';
import { SHADE_ONE } from './facades.ts';


// A chunk's static scenery (ground, roads and buildings) as one mesh: one
// draw call per chunk however much is in it. They share one material (the
// road material, whose depth bias is zero for anything on layer 0), so the
// merge costs nothing visually. What's drawn is chosen by rewriting the
// index buffer: roads only within ROAD_DRAW (see streamer.ts), and near the
// player each 50 m tile of ground at 2 m or 10 m detail. The vertex buffers
// change only when the chunk switches between its near and far terrain parts.

export class ChunkMesh {
  readonly mesh: THREE.Mesh;
  private readonly roads: BuildingChunk | undefined;
  private readonly buildings: BuildingChunk | undefined;
  /** Chunk half-size: terrain parts are in the north-west corner's frame, the rest in the centre's. */
  private readonly half: number;
  private parts: TerrainParts | null = null;
  private index: THREE.BufferAttribute | null = null;
  private terrainBase = 0;
  /** What's drawn now, as a number (see update), NaN for nothing yet. */
  private selection = NaN;
  /** Which tile groups are drawn, as a string of 0s and 1s. */
  private groupKey = '';
  /** The terrain colour set in the buffer (see TerrainParts). */
  private colours: Uint8Array | null = null;

  constructor(name: string, cx: number, cz: number, half: number, material: THREE.Material, roads?: BuildingChunk, buildings?: BuildingChunk) {
    this.roads = roads;
    this.buildings = buildings;
    this.half = half;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = name;
    this.mesh.position.set(cx, 0, cz);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /** Whether the near (tiled) terrain parts are in the vertex buffers. */
  get near(): boolean {
    return !!this.parts?.tiles;
  }

  get tilesPerSide(): number {
    return this.parts?.tilesPerSide ?? 0;
  }

  /** Replaces the terrain parts, rebuilding the vertex buffers (and, on the next update, the index). */
  setTerrain(parts: TerrainParts): void {
    this.parts = parts;
    const features = [this.roads, this.buildings].filter((b): b is BuildingChunk => !!b);
    const count = features.reduce((n, b) => n + b.count, 0) + parts.count;
    const pos = new Float32Array(count * 3);
    const nor = new Int8Array(count * 3);
    const col = new Uint8Array(count * 3);
    const layer = new Uint8Array(count);
    // Surface detail (see facades.ts): baked light, atlas UVs and tile.
    const shade = new Uint8Array(count).fill(SHADE_ONE);
    const uv = new Int16Array(count * 2);
    const tile = new Uint8Array(count);
    let v = 0;
    for (const b of features) {
      pos.set(b.pos, v * 3);
      nor.set(b.normals.subarray(0, b.count * 3), v * 3);
      col.set(b.colours.subarray(0, b.count * 3), v * 3);
      if (b.layers) layer.set(b.layers.subarray(0, b.count), v);
      const d = b.detail;
      if (d) {
        shade.set(d.shade.subarray(0, b.count), v);
        tile.set(d.tile.subarray(0, b.count), v);
        for (let k = 0; k < b.count; k++) {
          uv[(v + k) * 2] = d.u[k];
          uv[(v + k) * 2 + 1] = d.v[k];
        }
      }
      v += b.count;
    }
    this.terrainBase = v;
    // The ground's grain or pavers, mapped from world x/z (no UVs needed).
    tile.set(parts.tile, v);
    for (let k = 0; k < parts.count; k++) {
      pos[(v + k) * 3] = parts.pos[k * 3] - this.half;
      pos[(v + k) * 3 + 1] = parts.pos[k * 3 + 1];
      pos[(v + k) * 3 + 2] = parts.pos[k * 3 + 2] - this.half;
    }
    nor.set(parts.nor, v * 3);
    col.set(parts.col, v * 3);

    // Room for the most that can ever be drawn at once.
    let terrainMax = parts.far.length;
    if (parts.tiles) {
      let tiles = 0;
      for (const t of parts.tiles) {
        tiles += Math.max(...[0, 1].map((l) => t.ground[l].length + t.skirts[l].reduce((n, s) => n + s.length, 0)));
      }
      terrainMax = Math.max(terrainMax, tiles);
    }
    const capacity = features.reduce((n, b) => n + b.indices.length, 0) + terrainMax;
    this.index = new THREE.BufferAttribute(count > 0xffff ? new Uint32Array(capacity) : new Uint16Array(capacity), 1);
    this.index.setUsage(THREE.DynamicDrawUsage);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    geo.setAttribute('roadLayer', new THREE.BufferAttribute(layer, 1));
    geo.setAttribute('aShade', new THREE.BufferAttribute(shade, 1));
    geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aTile', new THREE.BufferAttribute(tile, 1));
    geo.setIndex(this.index);
    geo.computeBoundingSphere();
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.selection = NaN;
    this.colours = null;
  }

  /** Tiles per side of the buildings' grouped detail (trees), 0 if none. */
  get groupSide(): number {
    return this.buildings?.groups?.side ?? 0;
  }

  /**
   * Picks what to draw: roads or not, buildings' detail (0 none, 1 near-only,
   * 2 fine as well), per tile 0 (2 m) or 1 (coarse) (`tiles` null draws the
   * far parts), and which of the buildings' tile groups (trees) to draw
   * (`groups[t]` set; null for none). Cheap when nothing changed.
   */
  update(roads: boolean, tiles: Uint8Array | null, detail: 0 | 1 | 2 = 2, groups: Uint8Array | null = null): void {
    const parts = this.parts;
    const index = this.index;
    if (!parts || !index) return;
    const near = tiles && parts.tiles ? tiles : null;
    // Bit 0: roads, bits 1-2: building detail; then one bit per tile (set =
    // coarse), or negative for far (-1 - the same three bits).
    const flags = (roads ? 1 : 0) + detail * 2;
    let selection = -1 - flags;
    if (near) {
      selection = flags;
      for (let t = 0; t < near.length; t++) if (near[t]) selection += 2 ** (t + 3);
    }
    const groupKey = groups ? groups.join('') : '';
    if (selection === this.selection && groupKey === this.groupKey) return;
    this.groupKey = groupKey;
    // The coarse ground shows the streets only when the road strips aren't
    // drawn, and the tree canopy only when the trees aren't (else their shade).
    const colours = groups ? parts.colShaded : roads ? parts.colPlain : parts.col;
    if (colours !== this.colours) {
      this.colours = colours;
      const colour = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      (colour.array as Uint8Array).set(colours, this.terrainBase * 3);
      colour.needsUpdate = true;
    }
    this.selection = selection;
    const out = index.array as Uint16Array | Uint32Array;
    let n = 0;
    const put = (list: Uint32Array, base: number) => {
      for (let k = 0; k < list.length; k++) out[n++] = list[k] + base;
    };
    // Roads come first in the vertex buffers, then buildings.
    if (roads && this.roads) put(this.roads.indices, 0);
    const nRoads = n;
    if (this.buildings) {
      const b = this.buildings;
      const base = this.roads?.count ?? 0;
      put(b.indices.subarray(0, detail === 2 ? b.groupsFrom : detail === 1 ? b.fineFrom : b.nearOnly), base);
      if (groups && b.groups) {
        const from = b.groups.from;
        for (let t = 0; t < groups.length; t++) if (groups[t]) put(b.indices.subarray(from[t], from[t + 1]), base);
      }
    }
    const nBuildings = n - nRoads;
    if (!near) put(parts.far, this.terrainBase);
    else {
      const side = parts.tilesPerSide;
      // Tiles where the coarse ground is as good as the 2 m are always coarse.
      const lodAt = (r: number, c: number) => {
        if (r < 0 || c < 0 || r >= side || c >= side) return -1;
        return near[r * side + c] || parts.tiles![r * side + c].flat ? 1 : 0;
      };
      for (let r = 0; r < side; r++) {
        for (let c = 0; c < side; c++) {
          const lod = lodAt(r, c) as 0 | 1;
          const tile = parts.tiles![r * side + c];
          put(tile.ground[lod], this.terrainBase);
          // Skirts on the chunk's edge, and where a detailed tile meets a coarse one
          // (the coarse ground is never above the detailed, so its skirts aren't needed there).
          const neighbours = [lodAt(r - 1, c), lodAt(r + 1, c), lodAt(r, c - 1), lodAt(r, c + 1)];
          for (let e = 0; e < 4; e++) {
            if (neighbours[e] === -1 || (lod === 0 && neighbours[e] === 1)) put(tile.skirts[lod][e], this.terrainBase);
          }
        }
      }
    }
    // Triangles per layer, for ?debug's breakdown.
    this.mesh.userData.parts = { roads: nRoads / 3, buildings: nBuildings / 3, terrain: (n - nRoads - nBuildings) / 3 };
    this.mesh.geometry.setDrawRange(0, n);
    index.clearUpdateRanges();
    index.addUpdateRange(0, n);
    index.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.parts = null;
    this.index = null;
  }
}
