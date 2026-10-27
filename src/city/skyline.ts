import * as THREE from 'three';
import { cityMaterial } from './city-material.ts';
import { decodeSkyline, type CityManifest } from './format.ts';
import { SHADE_ONE } from './facades.ts';

// The far skyline: every tall building (40 m and up, the Sky Tower among
// them) in one always-loaded mesh, one draw call, so the towers and the Sky
// Tower stand over the rooftops from anywhere on the map, long after their
// own chunks have unloaded. Each chunk's share is a run of the index
// buffer; a chunk's run is left out while that chunk's own mesh is loaded
// (it draws the same buildings in full), so nothing is drawn twice. It has
// its own longer haze (cityMaterial) and no colliders.

export class Skyline {
  readonly mesh: THREE.Mesh;
  private readonly runs = new Map<string, { start: number; count: number }>();
  private readonly all: Uint32Array;
  private readonly index: THREE.BufferAttribute;
  private shown = '';
  /** Triangles drawn now and in all (for ?debug and the smoke test). */
  drawn = 0;
  total = 0;

  constructor(bytes: Uint8Array, manifest: CityManifest, atlas: THREE.Texture, haze: { colour: THREE.Color; near: number; far: number }) {
    const parts = decodeSkyline(bytes);
    const n = parts.reduce((k, p) => k + p.mesh.xCm.length, 0);
    const pos = new Float32Array(n * 3);
    const nor = new Int8Array(n * 3);
    const col = new Uint8Array(n * 3);
    const shade = new Uint8Array(n).fill(SHADE_ONE);
    const uv = new Int16Array(n * 2);
    const tile = new Uint8Array(n);
    const idx: number[] = [];
    const { grid, chunkSize } = manifest;
    let v = 0;
    for (const { i, j, mesh: m } of parts) {
      const cx = grid.x0 + (i + 0.5) * chunkSize;
      const cz = grid.z0 + (j + 0.5) * chunkSize;
      const count = m.xCm.length;
      for (let k = 0; k < count; k++) {
        pos[(v + k) * 3] = cx + m.xCm[k] / 100;
        pos[(v + k) * 3 + 1] = (m.baseCm + m.yCm[k]) / 100;
        pos[(v + k) * 3 + 2] = cz + m.zCm[k] / 100;
      }
      nor.set(m.normals.subarray(0, count * 3), v * 3);
      col.set(m.colours.subarray(0, count * 3), v * 3);
      if (m.detail) {
        shade.set(m.detail.shade, v);
        tile.set(m.detail.tile, v);
        for (let k = 0; k < count; k++) {
          uv[(v + k) * 2] = m.detail.u[k];
          uv[(v + k) * 2 + 1] = m.detail.v[k];
        }
      }
      this.runs.set(`${i},${j}`, { start: idx.length, count: m.indices.length });
      for (const t of m.indices) idx.push(t + v);
      v += count;
    }
    this.all = Uint32Array.from(idx);
    this.total = this.all.length / 3;
    this.index = new THREE.BufferAttribute(new Uint32Array(this.all.length), 1);
    this.index.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    geo.setAttribute('roadLayer', new THREE.BufferAttribute(new Uint8Array(n), 1));
    geo.setAttribute('aShade', new THREE.BufferAttribute(shade, 1));
    geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aTile', new THREE.BufferAttribute(tile, 1));
    geo.setIndex(this.index);
    geo.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geo, cityMaterial(atlas, haze));
    this.mesh.name = 'skyline';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /** Draws every chunk's run except those whose own mesh is loaded. Cheap when nothing changed. */
  update(loaded: (key: string) => boolean): void {
    const hidden = [...this.runs.keys()].filter(loaded);
    const key = hidden.join(';');
    if (key === this.shown) return;
    this.shown = key;
    const out = this.index.array as Uint32Array;
    let n = 0;
    for (const [k, r] of this.runs) {
      if (loaded(k)) continue;
      out.set(this.all.subarray(r.start, r.start + r.count), n);
      n += r.count;
    }
    this.drawn = n / 3;
    this.mesh.geometry.setDrawRange(0, n);
    this.index.clearUpdateRanges();
    this.index.addUpdateRange(0, n);
    this.index.needsUpdate = true;
  }

  /** Whether chunk (i, j) has buildings in the skyline. */
  has(i: number, j: number): boolean {
    return this.runs.has(`${i},${j}`);
  }
}
