import * as THREE from 'three';
import type { TerrainSamples } from './format.ts';

// Render geometry for one terrain chunk: a vertex-coloured grid in the
// chunk's local frame (0..size on x and z), with a skirt hanging off each
// edge to hide cracks against a neighbour drawn at another level of detail.
// Triangles are split along the same diagonal as Rapier's heightfield
// ((x1, z0) to (x0, z1)), so what you see is exactly what you drive on.

export interface TerrainLayout {
  /** Metres between samples. */
  cell: number;
  /** Cells per chunk side. */
  cells: number;
  /** Extra samples stored beyond each edge. */
  apron: number;
  /** Height of the flattened harbour floor. */
  seaShelf: number;
}

const SKIRT_DEPTH = 4;

// Stylised palette (sRGB hex, converted to linear by THREE.Color).
const GRASS_LOW = new THREE.Color(0x5d8a43);
const GRASS_HIGH = new THREE.Color(0x7f9d4b);
const EARTH = new THREE.Color(0x8c6a45);
const SAND = new THREE.Color(0xb9a77a);
const SEABED = new THREE.Color(0x2f5f72);

/**
 * @param origin chunk's north-west corner in local metres (for world-anchored noise)
 * @param step   samples per vertex: 1 = full 2 m detail; must divide `cells`
 */
export function buildTerrainGeometry(
  samples: TerrainSamples,
  layout: TerrainLayout,
  origin: { x: number; z: number },
  step: number,
): THREE.BufferGeometry {
  const { cell, cells, apron, seaShelf } = layout;
  const { n, heights } = samples;
  if (cells % step) throw new Error(`terrain LOD step ${step} must divide ${cells}`);
  const h = (r: number, c: number) => heights[(r + apron) * n + c + apron];
  const side = cells / step + 1;
  const skirtVerts = 4 * side;
  const count = side * side + skirtVerts;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const normal = new THREE.Vector3();
  const colour = new THREE.Color();

  let v = 0;
  for (let gz = 0; gz < side; gz++) {
    for (let gx = 0; gx < side; gx++, v++) {
      const r = gz * step;
      const c = gx * step;
      const y = h(r, c);
      // Central differences at 2 m, reaching into the apron at the edges, so
      // both chunks on a seam compute identical normals and colours there.
      normal.set(-(h(r, c + 1) - h(r, c - 1)) / (2 * cell), 1, -(h(r + 1, c) - h(r - 1, c)) / (2 * cell)).normalize();
      pos[v * 3] = c * cell;
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = r * cell;
      normal.toArray(nor, v * 3);
      groundColour(origin.x + c * cell, origin.z + r * cell, y, normal.y, seaShelf, colour).toArray(col, v * 3);
    }
  }

  const tris: number[] = [];
  const at = (gx: number, gz: number) => gz * side + gx;
  for (let gz = 0; gz < side - 1; gz++) {
    for (let gx = 0; gx < side - 1; gx++) {
      const p00 = at(gx, gz);
      const p10 = at(gx + 1, gz);
      const p01 = at(gx, gz + 1);
      const p11 = at(gx + 1, gz + 1);
      tris.push(p00, p01, p10, p10, p01, p11);
    }
  }

  // Skirts: copy each edge's vertices straight down, then wind the strip so
  // it faces outwards.
  const edges: { verts: number[]; out: [number, number] }[] = [
    { verts: Array.from({ length: side }, (_, k) => at(k, 0)), out: [0, -1] },
    { verts: Array.from({ length: side }, (_, k) => at(k, side - 1)), out: [0, 1] },
    { verts: Array.from({ length: side }, (_, k) => at(0, k)), out: [-1, 0] },
    { verts: Array.from({ length: side }, (_, k) => at(side - 1, k)), out: [1, 0] },
  ];
  for (const { verts, out } of edges) {
    const first = v;
    for (const top of verts) {
      pos[v * 3] = pos[top * 3];
      pos[v * 3 + 1] = pos[top * 3 + 1] - SKIRT_DEPTH;
      pos[v * 3 + 2] = pos[top * 3 + 2];
      for (let a = 0; a < 3; a++) {
        nor[v * 3 + a] = nor[top * 3 + a];
        col[v * 3 + a] = col[top * 3 + a] * 0.8;
      }
      v++;
    }
    for (let k = 0; k < verts.length - 1; k++) {
      const t0 = verts[k];
      const t1 = verts[k + 1];
      const b0 = first + k;
      const b1 = first + k + 1;
      // Triangle (t0, t1, b0) faces (dz, 0, -dx) for an edge running along (dx, dz).
      const dx = pos[t1 * 3] - pos[t0 * 3];
      const dz = pos[t1 * 3 + 2] - pos[t0 * 3 + 2];
      if (dz * out[0] - dx * out[1] > 0) tris.push(t0, t1, b0, t1, b1, b0);
      else tris.push(t0, b0, t1, t1, b0, b1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(count > 65535 ? new Uint32Array(tris) : new Uint16Array(tris), 1));
  geo.computeBoundingSphere();
  return geo;
}

const _earth = new THREE.Color();

/**
 * Stylised ground colour: green on the flat, browner as it steepens, sandy at
 * the waterline, teal for the harbour floor. Low-frequency noise anchored to
 * world position breaks up large areas and matches across seams.
 */
function groundColour(x: number, z: number, y: number, ny: number, seaShelf: number, out: THREE.Color): THREE.Color {
  if (y <= seaShelf + 0.01) return out.copy(SEABED).multiplyScalar(0.94 + 0.12 * valueNoise(x / 60, z / 60));
  out.copy(GRASS_LOW).lerp(GRASS_HIGH, THREE.MathUtils.clamp(y / 80, 0, 1));
  const steep = THREE.MathUtils.smoothstep(1 - ny, 0.04, 0.3); // ~16 deg starts browning, ~45 deg is bare
  out.lerp(_earth.copy(EARTH), steep);
  if (y < 1.5) out.lerp(SAND, THREE.MathUtils.clamp((1.5 - y) / 1.5, 0, 1) * 0.7);
  const patch = valueNoise(x / 45, z / 45) * 0.6 + valueNoise(x / 11, z / 11) * 0.4;
  return out.multiplyScalar(0.86 + 0.26 * patch);
}

function hash(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1. */
function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
