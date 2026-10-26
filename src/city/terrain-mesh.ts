import * as THREE from 'three';
import { GROUND_APRON, PAVED_SINK, SURFACE_ID, underPaving, type GroundSamples, type TerrainSamples } from './format.ts';

// Render geometry for one terrain chunk, as parts for ChunkMesh to merge:
// vertex-coloured grids in the chunk's local frame (0..size on x and z).
// Triangles are split along the same diagonal as Rapier's heightfield
// ((x1, z0) to (x0, z1)).
//
// Far away a chunk is one coarse grid (every 5th sample, 10 m), lowered
// where needed so it never bulges over the real ground (coarseSink), with a
// skirt hanging off each edge to hide cracks against neighbours. Near the
// player it's cut into 50 m tiles, each drawn at full 2 m detail or coarse
// (ChunkMesh picks per tile by distance), with skirts only where a detailed
// tile meets a coarse one or the chunk's edge. The collider is always the
// full 2 m heightfield, so near the player what you see is what you drive on,
// except under road strips, which cover it: there the ground is drawn a few
// cm lower (PAVED_SINK) so the strips can be simplified.

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
/** Coarse grid: every this many samples. Must divide the tile and the chunk. */
export const COARSE_STEP = 5;
/** Tile side for per-tile detail, cells (50 m). */
export const TILE_CELLS = 25;
/** How far under road strips the detailed ground is drawn (at least PAVED_SINK). */
const HIDDEN_AIM = PAVED_SINK + 0.03;

// Stylised palette (sRGB hex, converted to linear by THREE.Color).
const GRASS_LOW = new THREE.Color(0x5d8a43);
const GRASS_HIGH = new THREE.Color(0x7f9d4b);
const EARTH = new THREE.Color(0x8c6a45);
const SAND = new THREE.Color(0xb9a77a);
const SEABED = new THREE.Color(0x24363a);
/** Basalt and concrete of the sea walls and wharf edges. */
const SEAWALL = new THREE.Color(0x5d5a54);
// Land use (see SURFACES in format.ts). Roads, footpaths and paving match the
// roads layer's colours, so coarse terrain far away still shows the streets.
const PAVED = new THREE.Color(0x8e8b84);
const TREES = new THREE.Color(0x456b36);
const PAVING = new THREE.Color(0xa69a88);
const FOOTPATH = new THREE.Color(0xa3a19b);
const ASPHALT = new THREE.Color(0x35383d);

/**
 * Vertices (chunk frame) and triangle lists. `far` draws the whole chunk
 * coarse; `tiles` (near parts only) has, per tile and level of detail
 * (0 = 2 m, 1 = coarse), its ground and a skirt per edge (north, south,
 * west, east).
 */
export interface TerrainParts {
  pos: Float32Array;
  nor: Int8Array;
  col: Uint8Array;
  count: number;
  far: Uint32Array;
  tiles?: { ground: [Uint32Array, Uint32Array]; skirts: [Uint32Array[], Uint32Array[]] }[];
  /** Tiles per chunk side (tile t = row * tilesPerSide + column). */
  tilesPerSide: number;
}

/** Collects vertices in compact attribute formats. */
class Verts {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  get count() {
    return this.pos.length / 3;
  }
  add(x: number, y: number, z: number, n: THREE.Vector3, c: THREE.Color, shade = 1): number {
    this.pos.push(x, y, z);
    this.nor.push(Math.round(n.x * 127), Math.round(n.y * 127), Math.round(n.z * 127));
    this.col.push(Math.round(Math.min(1, c.r * shade) * 255), Math.round(Math.min(1, c.g * shade) * 255), Math.round(Math.min(1, c.b * shade) * 255));
    return this.count - 1;
  }
  /** A copy of vertex k, dropped by `dy` and shaded (skirts). */
  copy(k: number, dy: number, shade: number): number {
    this.pos.push(this.pos[k * 3], this.pos[k * 3 + 1] + dy, this.pos[k * 3 + 2]);
    this.nor.push(this.nor[k * 3], this.nor[k * 3 + 1], this.nor[k * 3 + 2]);
    this.col.push(...[0, 1, 2].map((a) => Math.round(this.col[k * 3 + a] * shade)));
    return this.count - 1;
  }
}

/**
 * Skirt along a run of top vertices (in order along the edge), facing
 * `out` (the edge's outward direction on the ground, [dx, dz]).
 */
function skirt(v: Verts, tops: number[], out: [number, number]): Uint32Array {
  const bottoms = tops.map((t) => v.copy(t, -SKIRT_DEPTH, 0.8));
  const tris: number[] = [];
  for (let k = 0; k + 1 < tops.length; k++) {
    const t0 = tops[k];
    const t1 = tops[k + 1];
    const b0 = bottoms[k];
    const b1 = bottoms[k + 1];
    // Triangle (t0, t1, b0) faces (dz, 0, -dx) for an edge running along (dx, dz).
    const dx = v.pos[t1 * 3] - v.pos[t0 * 3];
    const dz = v.pos[t1 * 3 + 2] - v.pos[t0 * 3 + 2];
    if (dz * out[0] - dx * out[1] > 0) tris.push(t0, t1, b0, t1, b1, b0);
    else tris.push(t0, b0, t1, t1, b0, b1);
  }
  return Uint32Array.from(tris);
}

/**
 * @param origin chunk's north-west corner in local metres (for world-anchored noise)
 * @param near   also build the 2 m tiles (else only the coarse chunk)
 */
export function buildTerrainParts(
  samples: TerrainSamples,
  layout: TerrainLayout,
  origin: { x: number; z: number },
  ground: GroundSamples | undefined,
  near: boolean,
): TerrainParts {
  const { cell, cells, apron, seaShelf } = layout;
  const { n, heights } = samples;
  const h = (r: number, c: number) => heights[(r + apron) * n + c + apron];
  const classAt = ground && ((r: number, c: number) => ground.classes[(r + GROUND_APRON) * ground.n + c + GROUND_APRON]);
  // Height to draw: the ground, or a little under it beneath road strips.
  const side1 = cells + 1;
  const drawn = new Float32Array(side1 * side1);
  for (let r = 0; r < side1; r++) {
    for (let c = 0; c < side1; c++) drawn[r * side1 + c] = h(r, c) - (classAt && underPaving(classAt, r, c) ? HIDDEN_AIM : 0);
  }
  const hd = (r: number, c: number) => drawn[r * side1 + c];
  const step = COARSE_STEP;
  if (cells % step) throw new Error(`terrain coarse step ${step} must divide ${cells}`);
  const tileCells = cells % TILE_CELLS === 0 && TILE_CELLS % step === 0 ? TILE_CELLS : cells;
  const tilesPerSide = cells / tileCells;

  const v = new Verts();
  const normal = new THREE.Vector3();
  const colour = new THREE.Color();
  const lattice = (r: number, c: number, y: number, lodStep: number) => {
    // Central differences at 2 m, reaching into the apron at the edges, so
    // both chunks on a seam compute identical normals and colours there.
    normal.set(-(h(r, c + 1) - h(r, c - 1)) / (2 * cell), 1, -(h(r + 1, c) - h(r - 1, c)) / (2 * cell)).normalize();
    vertexColour(origin.x + c * cell, origin.z + r * cell, h(r, c), normal.y, seaShelf, ground, r, c, lodStep, colour);
    return v.add(c * cell, y, r * cell, normal, colour);
  };

  // Coarse grid, sunk under the drawn ground.
  const sideC = cells / step + 1;
  const sink = coarseSink(hd, cells, step);
  const coarse = new Int32Array(sideC * sideC);
  for (let gz = 0; gz < sideC; gz++) for (let gx = 0; gx < sideC; gx++) coarse[gz * sideC + gx] = lattice(gz * step, gx * step, hd(gz * step, gx * step) - sink[gz * sideC + gx], step);
  const at = (grid: Int32Array, w: number, gx: number, gz: number) => grid[gz * w + gx];
  /** Quads of a grid (side w, spacing `per` cells) over cells [r0, r1) x [c0, c1). */
  const quads = (grid: Int32Array, w: number, per: number, r0: number, r1: number, c0: number, c1: number) => {
    const tris: number[] = [];
    for (let gz = r0 / per; gz < r1 / per; gz++) {
      for (let gx = c0 / per; gx < c1 / per; gx++) {
        const p00 = at(grid, w, gx, gz);
        const p10 = at(grid, w, gx + 1, gz);
        const p01 = at(grid, w, gx, gz + 1);
        const p11 = at(grid, w, gx + 1, gz + 1);
        tris.push(p00, p01, p10, p10, p01, p11);
      }
    }
    return tris;
  };
  /** Top vertices along an edge of a grid: north/south rows or west/east columns of [r0, r1] x [c0, c1]. */
  const edge = (grid: Int32Array, w: number, per: number, e: number, r0: number, r1: number, c0: number, c1: number) => {
    const out: number[] = [];
    if (e < 2) for (let c = c0; c <= c1; c += per) out.push(at(grid, w, c / per, (e === 0 ? r0 : r1) / per));
    else for (let r = r0; r <= r1; r += per) out.push(at(grid, w, (e === 2 ? c0 : c1) / per, r / per));
    return out;
  };
  const OUT: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];

  const far: number[] = quads(coarse, sideC, step, 0, cells, 0, cells);
  for (let e = 0; e < 4; e++) far.push(...skirt(v, edge(coarse, sideC, step, e, 0, cells, 0, cells), OUT[e]));

  let tiles: TerrainParts['tiles'];
  if (near) {
    const fine = new Int32Array(side1 * side1);
    for (let r = 0; r < side1; r++) for (let c = 0; c < side1; c++) fine[r * side1 + c] = lattice(r, c, hd(r, c), 1);
    tiles = [];
    for (let tr = 0; tr < tilesPerSide; tr++) {
      for (let tc = 0; tc < tilesPerSide; tc++) {
        const r0 = tr * tileCells;
        const c0 = tc * tileCells;
        const r1 = r0 + tileCells;
        const c1 = c0 + tileCells;
        const lods = [[fine, side1, 1], [coarse, sideC, step]] as const;
        const ground = lods.map(([g, w, per]) => Uint32Array.from(quads(g, w, per, r0, r1, c0, c1))) as [Uint32Array, Uint32Array];
        const skirts = lods.map(([g, w, per]) => OUT.map((o, e) => skirt(v, edge(g, w, per, e, r0, r1, c0, c1), o))) as [Uint32Array[], Uint32Array[]];
        tiles.push({ ground, skirts });
      }
    }
  }
  return {
    pos: Float32Array.from(v.pos),
    nor: Int8Array.from(v.nor),
    col: Uint8Array.from(v.col),
    count: v.count,
    far: Uint32Array.from(far),
    tiles,
    tilesPerSide,
  };
}

/**
 * How far to lower each vertex of a coarse grid (every `step`th sample) so
 * it doesn't bulge above the full-detail ground in hollows: a 10 m grid
 * bridges a motorway trench or a gully floor, hiding the roads draped on
 * the real ground. Interior vertices drop by the worst overshoot in their
 * cells, which puts every sample in an all-interior cell back at or below
 * the ground. Edge vertices only look along their edge (data both chunks
 * share, so seams still match); corners stay put.
 */
function coarseSink(h: (r: number, c: number) => number, cells: number, step: number): Float32Array {
  const side = cells / step + 1;
  const cellErr = new Float32Array((side - 1) * (side - 1));
  for (let gz = 0; gz < side - 1; gz++) {
    for (let gx = 0; gx < side - 1; gx++) {
      const r0 = gz * step;
      const c0 = gx * step;
      const h00 = h(r0, c0);
      const h10 = h(r0, c0 + step);
      const h01 = h(r0 + step, c0);
      const h11 = h(r0 + step, c0 + step);
      let worst = 0;
      for (let dr = 0; dr <= step; dr++) {
        for (let dc = 0; dc <= step; dc++) {
          const fx = dc / step;
          const fz = dr / step;
          // Same diagonal as the triangles: (x1, z0) to (x0, z1).
          const coarse = fx + fz <= 1 ? h00 + (h10 - h00) * fx + (h01 - h00) * fz : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
          worst = Math.max(worst, coarse - h(r0 + dr, c0 + dc));
        }
      }
      cellErr[gz * (side - 1) + gx] = worst;
    }
  }
  // Overshoot of the straight line between neighbouring coarse vertices along an edge line.
  const edgeErr = (alongRows: boolean, fixed: number, g: number) => {
    let worst = 0;
    const at = (k: number) => (alongRows ? h(k, fixed) : h(fixed, k));
    const a = at(g * step);
    const b = at((g + 1) * step);
    for (let k = 0; k <= step; k++) worst = Math.max(worst, a + ((b - a) * k) / step - at(g * step + k));
    return worst;
  };
  const sink = new Float32Array(side * side);
  const last = side - 1;
  for (let gz = 0; gz < side; gz++) {
    for (let gx = 0; gx < side; gx++) {
      const onX = gx === 0 || gx === last;
      const onZ = gz === 0 || gz === last;
      let s = 0;
      if (onX && onZ) s = 0;
      else if (onX) s = Math.max(edgeErr(true, gx * step, gz - 1), edgeErr(true, gx * step, gz));
      else if (onZ) s = Math.max(edgeErr(false, gz * step, gx - 1), edgeErr(false, gz * step, gx));
      else for (const [cz, cx] of [[gz - 1, gx - 1], [gz - 1, gx], [gz, gx - 1], [gz, gx]]) s = Math.max(s, cellErr[cz * last + cx]);
      sink[gz * side + gx] = s;
    }
  }
  return sink;
}

const _earth = new THREE.Color();
const _sum = new THREE.Color();
const _one = new THREE.Color();

/**
 * Colour of the vertex at sample (r, c). Coarse LODs average the land use
 * over the block of samples each vertex stands for, so a street doesn't
 * vanish (or turn into dots) when only every fifth sample is drawn.
 */
function vertexColour(
  x: number, z: number, y: number, ny: number, seaShelf: number,
  ground: GroundSamples | undefined, r: number, c: number, step: number, out: THREE.Color,
): THREE.Color {
  if (!ground) return groundColour(x, z, y, ny, seaShelf, SURFACE_ID.grass, out);
  const at = (rr: number, cc: number) => ground.classes[(rr + GROUND_APRON) * ground.n + cc + GROUND_APRON];
  if (step === 1) {
    // Full detail sits under the road meshes. Vertex colours blend over a
    // whole 2 m cell, so a street's tint would bleed past the mesh's crisp
    // edge; eroding paved surfaces by one sample keeps the tint underneath.
    let k = at(r, c);
    if (k >= SURFACE_ID.paving) {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) k = Math.min(k, at(r + dr, c + dc));
    }
    return groundColour(x, z, y, ny, seaShelf, k, out);
  }
  const half = Math.min(Math.floor(step / 2), GROUND_APRON);
  const counts = new Map<number, number>();
  for (let dr = -half; dr <= half; dr++) {
    for (let dc = -half; dc <= half; dc++) {
      const k = at(r + dr, c + dc);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  if (counts.size === 1) return groundColour(x, z, y, ny, seaShelf, counts.keys().next().value!, out);
  const total = (2 * half + 1) ** 2;
  _sum.setRGB(0, 0, 0);
  for (const [k, n] of counts) {
    groundColour(x, z, y, ny, seaShelf, k, _one);
    _sum.r += (_one.r * n) / total;
    _sum.g += (_one.g * n) / total;
    _sum.b += (_one.b * n) / total;
  }
  return out.copy(_sum);
}

/**
 * Stylised ground colour by land use: paved grey in the city (going green
 * on steep banks, which are planted or overgrown), green in parks and
 * gardens (browner as it steepens, sandy at the waterline), dark green bush,
 * and the road surfaces. Stone for sea walls, dark for the harbour floor. Low-frequency noise
 * anchored to world position breaks up large areas and matches across seams.
 */
function groundColour(x: number, z: number, y: number, ny: number, seaShelf: number, surface: number, out: THREE.Color): THREE.Color {
  if (y <= seaShelf + 0.01) return out.copy(SEABED).multiplyScalar(0.94 + 0.12 * valueNoise(x / 60, z / 60));
  // The drop from a wharf or sea wall to the harbour floor: stone, not a grassy bank.
  if (y < 5 && ny < 0.85) return out.copy(SEAWALL).multiplyScalar(0.85 + 0.25 * valueNoise(x / 7, z / 7));
  const steep = THREE.MathUtils.smoothstep(1 - ny, 0.04, 0.3); // ~16 deg starts browning, ~45 deg is bare
  const patch = valueNoise(x / 45, z / 45) * 0.6 + valueNoise(x / 11, z / 11) * 0.4;
  // Nothing is paved up a wall: a street's edge that spills over a cutting
  // or retaining wall takes the bank colour instead of spiky asphalt.
  if (surface >= SURFACE_ID.paving && ny < 0.9) surface = SURFACE_ID.urban;
  switch (surface) {
    case SURFACE_ID.road:
      return out.copy(ASPHALT);
    case SURFACE_ID.footpath:
      return out.copy(FOOTPATH);
    case SURFACE_ID.paving:
      return out.copy(PAVING);
    case SURFACE_ID.trees:
      out.copy(TREES).lerp(_earth.copy(EARTH), steep * 0.4);
      return out.multiplyScalar(0.8 + 0.35 * patch);
    case SURFACE_ID.sand:
      return out.copy(SAND).multiplyScalar(0.92 + 0.12 * patch);
    case SURFACE_ID.urban: {
      // Banks too steep to build on are planted, so they stay green.
      const bank = THREE.MathUtils.smoothstep(1 - ny, 0.1, 0.25);
      out.copy(PAVED).multiplyScalar(0.9 + 0.16 * patch);
      if (bank <= 0) return out;
      _earth.copy(GRASS_LOW).lerp(EARTH, steep * 0.5).multiplyScalar(0.86 + 0.26 * patch);
      return out.lerp(_earth, bank);
    }
  }
  out.copy(GRASS_LOW).lerp(GRASS_HIGH, THREE.MathUtils.clamp(y / 80, 0, 1));
  out.lerp(_earth.copy(EARTH), steep);
  if (y < 1.5) out.lerp(SAND, THREE.MathUtils.clamp((1.5 - y) / 1.5, 0, 1) * 0.7);
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
