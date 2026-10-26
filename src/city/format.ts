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
    /** Height the harbour floor is flattened to (until water exists). */
    seaShelf: number;
    encoding: 'gtat1+deflate';
  };
  chunks: ChunkInfo[];
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
