// Shared between the offline generator (tools/citygen) and the game: the
// city manifest schema and the terrain chunk codec. No DOM or Node APIs here,
// so both sides can import it.

/** Bump when the manifest or a layer's encoding changes incompatibly. */
export const CITY_FORMAT = 1;

/**
 * public/city/<area>/manifest.json. Chunks are square, axis-aligned in local
 * metres (x east, z south, origin at Britomart). Each chunk lists its data
 * files by layer name, so later tasks add layers (buildings, roads, extra
 * colliders) without touching the terrain ones.
 */
export interface CityManifest {
  format: number;
  area: string;
  /** WGS84 of the local origin, for reference. */
  origin: { lon: number; lat: number };
  /** Source bbox [minLon, minLat, maxLon, maxLat]. */
  bbox: [number, number, number, number];
  /** Chunk side, metres. */
  chunkSize: number;
  /** Chunk grid: chunk (i, j) covers x0 + i * chunkSize .. + chunkSize, likewise z. */
  grid: { x0: number; z0: number; nx: number; nz: number };
  /** Local bounds of the whole grid; y is the terrain height range. */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number; minY: number; maxY: number };
  terrain: {
    /** Metres between height samples. */
    cellSize: number;
    /** Extra samples stored beyond each chunk edge (for smooth normals across seams). */
    apron: number;
    /** Samples per side including both edges and the apron. */
    samples: number;
    /** Height the harbour floor is flattened to, well under the water. */
    seaShelf: number;
    encoding: 'gtat1+deflate';
  };
  /** Land-use classes on the terrain lattice (see encodeGround). */
  ground?: {
    /** Extra lattice points stored beyond each chunk edge. */
    apron: number;
    /** Samples per side including the apron. */
    samples: number;
    encoding: 'gtag1+deflate';
  };
  /** The harbour: a water plane at this height (metres above sea level) wherever the ground is lower. */
  water?: { level: number };
  /** Tall buildings as one always-loaded far LOD (see encodeSkyline). */
  skyline?: string;
  /** Buildings marked as landmarks in overrides/<area>.json, for hand-made models. */
  landmarks?: LandmarkInfo[];
  chunks: ChunkInfo[];
}

export interface LandmarkInfo {
  /** e.g. 'sky-tower'; several entries can share one (the Wynyard silos). */
  id: string;
  /** 'way/123' or 'relation/456'. */
  osm: string;
  name?: string;
  /** Footprint centroid, local metres. */
  x: number;
  z: number;
  /** Lowest ground under it and the top of its tallest part, metres above sea level. */
  base: number;
  top: number;
  /** Outer ring of the footprint, local metres. */
  footprint: [number, number][];
  /** The OSM geometry is left out of the buildings mesh (its collider stays). */
  hidden: boolean;
}

export interface ChunkInfo {
  i: number;
  j: number;
  /** Terrain height range inside the chunk (excluding the apron). */
  minY: number;
  maxY: number;
  /** Layer name -> file path relative to the manifest. */
  files: Record<string, string>;
}

/** Name of chunk (i, j)'s file for a layer, e.g. terrain/3_4.bin. */
export const chunkFile = (layer: string, i: number, j: number, ext = 'bin') => `${layer}/${i}_${j}.${ext}`;

// Terrain chunk file, before deflate (all little-endian):
//   0  'GTAT'  magic
//   4  u16     version (1)
//   6  u16     n, samples per side (incl. apron)
//   8  i32     base height, cm
//  12  u16[n*n] residuals, row-major (row = z, column = x, north-west first)
// Heights are integer cm above `base`. Each value is stored as the zigzagged
// difference (mod 2^16) from the planar prediction left + up - upleft, which
// makes slopes nearly free for deflate.
const MAGIC = 0x54415447; // 'GTAT' read as little-endian u32
const HEADER = 12;
const VERSION = 1;

/** Encodes n*n integer heights in cm (row-major, rows along z). */
export function encodeTerrain(cm: Int32Array, n: number): Uint8Array {
  if (cm.length !== n * n) throw new Error('encodeTerrain: size mismatch');
  let base = Infinity;
  let top = -Infinity;
  for (const v of cm) {
    base = Math.min(base, v);
    top = Math.max(top, v);
  }
  if (top - base > 0xffff) throw new Error(`encodeTerrain: height range ${top - base} cm exceeds u16`);
  const out = new Uint8Array(HEADER + n * n * 2);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, n, true);
  view.setInt32(8, base, true);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const q = cm[r * n + c] - base;
      const d = (q - predict(cm, n, r, c, base)) & 0xffff;
      const s = (d << 16) >> 16; // as int16
      view.setUint16(HEADER + (r * n + c) * 2, ((s << 1) ^ (s >> 31)) & 0xffff, true);
    }
  }
  return out;
}

function predict(q: ArrayLike<number>, n: number, r: number, c: number, base: number): number {
  const at = (rr: number, cc: number) => q[rr * n + cc] - base;
  if (r === 0 && c === 0) return 0;
  if (r === 0) return at(r, c - 1);
  if (c === 0) return at(r - 1, c);
  return at(r, c - 1) + at(r - 1, c) - at(r - 1, c - 1);
}

export interface TerrainSamples {
  n: number;
  /** Heights in metres, row-major (rows along z), n*n. */
  heights: Float32Array;
}

export function decodeTerrain(bytes: Uint8Array): TerrainSamples {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('terrain chunk: bad magic');
  if (view.getUint16(4, true) !== VERSION) throw new Error('terrain chunk: unsupported version');
  const n = view.getUint16(6, true);
  const base = view.getInt32(8, true);
  if (bytes.byteLength < HEADER + n * n * 2) throw new Error('terrain chunk: truncated');
  const q = new Int32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const z = view.getUint16(HEADER + (r * n + c) * 2, true);
      const s = (z >>> 1) ^ -(z & 1);
      q[r * n + c] = (predict(q, n, r, c, 0) + s) & 0xffff;
    }
  }
  const heights = new Float32Array(n * n);
  for (let k = 0; k < q.length; k++) heights[k] = (base + q[k]) / 100;
  return { n, heights };
}

// Buildings chunk file, before deflate (all little-endian). One merged,
// vertex-coloured mesh per chunk plus the triangles its collider uses:
//   0  'GTAB'  magic
//   4  u16     version (1)
//   6  u16     flags: bit 0 = 32-bit indices, bit 1 = per-vertex layers
//              (roads: which surface sits on top where strips overlap),
//              bit 2 = surface detail (shade, UVs and atlas tile per vertex)
//   8  i32     base height, cm (y of the lowest vertex)
//  12  u32     vertex count n
//  16  u32     render index count
//  20  u32     collider index count
//  24  u16[n]  x, cm from the chunk centre (i16)  \  each plane stored as the
//      u16[n]  z, cm from the chunk centre (i16)   } zigzagged difference from
//      u16[n]  y, cm above base (u16)             /  the previous value
//      i8[3n]  normals (snorm, xyz interleaved)
//      u8[3n]  colours (linear RGB, interleaved)
//      u8[n]   layers (only with flag bit 1)
//      u8[n]   shade: baked light x SHADE_ONE (flag bit 2, as are the next two)
//      u16[2n] u, v in 1/UV_SCALE repeats (i16, zigzagged deltas, u plane then v)
//      u8[n]   atlas tile (see facades.ts)
//      u32     (flag bit 3) render indices before the near-only detail
//      u32     (flag bit 4) render indices before the fine detail (nearer still)
//      u16|u32 render indices, then collider indices (zigzagged deltas)
// Delta coding keeps neighbouring vertices of a building tiny for deflate.
const BUILDINGS_MAGIC = 0x42415447; // 'GTAB'
const BUILDINGS_VERSION = 1;
const BUILDINGS_HEADER = 24;

export interface BuildingMesh {
  /** Vertex positions in cm: x and z relative to the chunk centre, y above `baseCm`. */
  xCm: Int32Array;
  zCm: Int32Array;
  yCm: Int32Array;
  baseCm: number;
  normals: Int8Array;
  colours: Uint8Array;
  indices: Uint32Array;
  /** Triangles for the static collider (a subset of the render triangles' vertices). */
  colliderIndices: Uint32Array;
  /** Optional per-vertex draw layer (0 = none); the roads layer biases depth by it. */
  layers?: Uint8Array;
  /** Optional surface detail (see facades.ts): baked light, atlas UVs (x UV_SCALE) and tile per vertex. */
  detail?: { shade: Uint8Array; u: Int32Array; v: Int32Array; tile: Uint8Array };
  /**
   * Render indices from here on are small detail (verandahs, parapets,
   * rooftop plant) drawn only near the player; undefined if there is none.
   */
  nearOnly?: number;
  /** Render indices from here on are fine detail (cornices, rooftop plant, eaves) drawn only very near. */
  fineFrom?: number;
}

const zig = (d: number) => ((d << 1) ^ (d >> 31)) >>> 0;
const unzig = (z: number) => (z >>> 1) ^ -(z & 1);

export function encodeBuildings(m: BuildingMesh): Uint8Array {
  const n = m.xCm.length;
  const wide = n > 0xffff;
  const isz = wide ? 4 : 2;
  const layered = !!m.layers;
  const detailed = !!m.detail;
  const split = m.nearOnly !== undefined;
  const fine = m.fineFrom !== undefined;
  const size = BUILDINGS_HEADER + n * 6 + n * 6 + (layered ? n : 0) + (detailed ? n * 6 : 0) + (m.indices.length + m.colliderIndices.length) * isz + (split ? 4 : 0) + (fine ? 4 : 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, BUILDINGS_MAGIC, true);
  view.setUint16(4, BUILDINGS_VERSION, true);
  view.setUint16(6, (wide ? 1 : 0) | (layered ? 2 : 0) | (detailed ? 4 : 0) | (split ? 8 : 0) | (fine ? 16 : 0), true);
  view.setInt32(8, m.baseCm, true);
  view.setUint32(12, n, true);
  view.setUint32(16, m.indices.length, true);
  view.setUint32(20, m.colliderIndices.length, true);
  let o = BUILDINGS_HEADER;
  for (const [plane, lo, hi] of [[m.xCm, -0x8000, 0x7fff], [m.zCm, -0x8000, 0x7fff], [m.yCm, 0, 0xffff]] as const) {
    let prev = 0;
    for (let k = 0; k < n; k++) {
      const v = plane[k];
      if (v < lo || v > hi) throw new Error(`encodeBuildings: coordinate ${v} cm out of range`);
      const d = ((v - prev) << 16) >> 16; // wraps mod 2^16, as int16
      view.setUint16(o, zig(d) & 0xffff, true);
      o += 2;
      prev = v;
    }
  }
  out.set(new Uint8Array(m.normals.buffer, m.normals.byteOffset, n * 3), o);
  o += n * 3;
  out.set(m.colours.subarray(0, n * 3), o);
  o += n * 3;
  if (m.layers) {
    out.set(m.layers.subarray(0, n), o);
    o += n;
  }
  if (m.detail) {
    out.set(m.detail.shade.subarray(0, n), o);
    o += n;
    for (const plane of [m.detail.u, m.detail.v]) {
      let prev = 0;
      for (let k = 0; k < n; k++) {
        const v = plane[k];
        if (v < -0x8000 || v > 0x7fff) throw new Error(`encodeBuildings: UV ${v / 64} out of range`);
        view.setUint16(o, zig((((v - prev) << 16) >> 16)) & 0xffff, true);
        o += 2;
        prev = v;
      }
    }
    out.set(m.detail.tile.subarray(0, n), o);
    o += n;
  }
  for (const list of [m.indices, m.colliderIndices]) {
    let prev = 0;
    for (const v of list) {
      if (v >= n) throw new Error('encodeBuildings: index out of range');
      // Narrow deltas wrap mod 2^16, like the positions.
      if (wide) view.setUint32(o, zig(v - prev), true);
      else view.setUint16(o, zig(((v - prev) << 16) >> 16) & 0xffff, true);
      o += isz;
      prev = v;
    }
  }
  if (split) view.setUint32(o, m.nearOnly!, true);
  if (fine) view.setUint32(o + (split ? 4 : 0), m.fineFrom!, true);
  return out;
}

export function decodeBuildings(bytes: Uint8Array): BuildingMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== BUILDINGS_MAGIC) throw new Error('buildings chunk: bad magic');
  if (view.getUint16(4, true) !== BUILDINGS_VERSION) throw new Error('buildings chunk: unsupported version');
  const flags = view.getUint16(6, true);
  const wide = (flags & 1) === 1;
  const layered = (flags & 2) === 2;
  const detailed = (flags & 4) === 4;
  const split = (flags & 8) === 8;
  const fine = (flags & 16) === 16;
  const baseCm = view.getInt32(8, true);
  const n = view.getUint32(12, true);
  const ni = view.getUint32(16, true);
  const nc = view.getUint32(20, true);
  const isz = wide ? 4 : 2;
  if (bytes.byteLength < BUILDINGS_HEADER + n * 12 + (layered ? n : 0) + (detailed ? n * 6 : 0) + (ni + nc) * isz) throw new Error('buildings chunk: truncated');
  let o = BUILDINGS_HEADER;
  const planes = [new Int32Array(n), new Int32Array(n), new Int32Array(n)];
  for (const [p, plane] of planes.entries()) {
    let prev = 0;
    for (let k = 0; k < n; k++) {
      const v = prev + unzig(view.getUint16(o, true));
      prev = p === 2 ? v & 0xffff : (v << 16) >> 16;
      plane[k] = prev;
      o += 2;
    }
  }
  const normals = new Int8Array(bytes.buffer.slice(bytes.byteOffset + o, bytes.byteOffset + o + n * 3));
  o += n * 3;
  const colours = bytes.slice(o, o + n * 3);
  o += n * 3;
  let layers: Uint8Array | undefined;
  if (layered) {
    layers = bytes.slice(o, o + n);
    o += n;
  }
  let detail: BuildingMesh['detail'];
  if (detailed) {
    const shade = bytes.slice(o, o + n);
    o += n;
    const uv = [new Int32Array(n), new Int32Array(n)];
    for (const plane of uv) {
      let prev = 0;
      for (let k = 0; k < n; k++) {
        prev = ((prev + unzig(view.getUint16(o, true))) << 16) >> 16;
        plane[k] = prev;
        o += 2;
      }
    }
    const tile = bytes.slice(o, o + n);
    o += n;
    detail = { shade, u: uv[0], v: uv[1], tile };
  }
  const lists = [new Uint32Array(ni), new Uint32Array(nc)];
  for (const list of lists) {
    let prev = 0;
    for (let k = 0; k < list.length; k++) {
      const z = wide ? view.getUint32(o, true) : view.getUint16(o, true);
      prev = wide ? prev + unzig(z) : (prev + unzig(z)) & 0xffff;
      list[k] = prev;
      o += isz;
    }
  }
  const nearOnly = split ? view.getUint32(o, true) : undefined;
  const fineFrom = fine ? view.getUint32(o + (split ? 4 : 0), true) : undefined;
  return { xCm: planes[0], zCm: planes[1], yCm: planes[2], baseCm, normals, colours, indices: lists[0], colliderIndices: lists[1], layers, detail, nearOnly, fineFrom };
}

// Ground chunk file (land use under the terrain), before deflate:
//   0  'GTAG'  magic
//   4  u16     version (1)
//   6  u16     n, samples per side (the terrain lattice plus GROUND_APRON each side)
//   8  u8[n*n] surface class per lattice point, row-major (rows along z)
// The terrain mesh tints its vertices by class, and the debug probe reports
// the class under a point.
const GROUND_MAGIC = 0x47415447; // 'GTAG'
const GROUND_VERSION = 2;
const GROUND_HEADER = 8;
/** Extra lattice points stored beyond each chunk edge, so coarse LODs can average across seams. */
export const GROUND_APRON = 2;

/**
 * Surface classes, in paint order: later ones win where they overlap. Paths
 * (through parks and bush) stay below paving: only paving and up are covered
 * by draped road strips.
 */
export const SURFACES = ['urban', 'grass', 'flowerbed', 'trees', 'sand', 'path', 'paving', 'footpath', 'road'] as const;
export type Surface = (typeof SURFACES)[number];
export const SURFACE_ID = Object.fromEntries(SURFACES.map((s, k) => [s, k])) as Record<Surface, number>;

/**
 * Lattice points deep inside a paved surface (the point and its eight
 * neighbours are all paving, footpath or road) are always covered by the
 * draped road strips. The full-detail terrain mesh sinks at least this far
 * there (m), which gives the strips room to be simplified.
 */
export const PAVED_SINK = 0.05;

/** Whether lattice point (r, c) is deep inside paving, given the class at any lattice point. */
export function underPaving(classAt: (r: number, c: number) => number, r: number, c: number): boolean {
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (classAt(r + dr, c + dc) < SURFACE_ID.paving) return false;
  return true;
}

export interface GroundSamples {
  n: number;
  classes: Uint8Array;
}

export function encodeGround(g: GroundSamples): Uint8Array {
  const out = new Uint8Array(GROUND_HEADER + g.n * g.n);
  const view = new DataView(out.buffer);
  view.setUint32(0, GROUND_MAGIC, true);
  view.setUint16(4, GROUND_VERSION, true);
  view.setUint16(6, g.n, true);
  out.set(g.classes.subarray(0, g.n * g.n), GROUND_HEADER);
  return out;
}

export function decodeGround(bytes: Uint8Array): GroundSamples {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GROUND_MAGIC) throw new Error('ground chunk: bad magic');
  if (view.getUint16(4, true) !== GROUND_VERSION) throw new Error('ground chunk: unsupported version');
  const n = view.getUint16(6, true);
  if (bytes.byteLength < GROUND_HEADER + n * n) throw new Error('ground chunk: truncated');
  return { n, classes: bytes.slice(GROUND_HEADER, GROUND_HEADER + n * n) };
}

// Skyline file (the far LOD of tall buildings, always loaded), before
// deflate: 'GTAS', u16 version (1), u16 chunk count, then per chunk u8 i,
// u8 j, u32 byte length and a buildings mesh (encodeBuildings, relative to
// that chunk's centre).
const SKYLINE_MAGIC = 0x53415447; // 'GTAS'

export function encodeSkyline(parts: { i: number; j: number; mesh: Uint8Array }[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + 6 + p.mesh.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, SKYLINE_MAGIC, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, parts.length, true);
  let o = 8;
  for (const p of parts) {
    view.setUint8(o, p.i);
    view.setUint8(o + 1, p.j);
    view.setUint32(o + 2, p.mesh.length, true);
    out.set(p.mesh, o + 6);
    o += 6 + p.mesh.length;
  }
  return out;
}

export function decodeSkyline(bytes: Uint8Array): { i: number; j: number; mesh: BuildingMesh }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SKYLINE_MAGIC) throw new Error('skyline: bad magic');
  const n = view.getUint16(6, true);
  const out: { i: number; j: number; mesh: BuildingMesh }[] = [];
  let o = 8;
  for (let k = 0; k < n; k++) {
    const len = view.getUint32(o + 2, true);
    out.push({ i: view.getUint8(o), j: view.getUint8(o + 1), mesh: decodeBuildings(bytes.subarray(o + 6, o + 6 + len)) });
    o += 6 + len;
  }
  return out;
}
