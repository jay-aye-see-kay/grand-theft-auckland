// Elevation rasters (LINZ 1 m DEM / DSM windows) in NZTM, cached as raw
// Float32 plus a JSON header. Values are metres above NZVD2016 (~sea level).
import { readFileSync, writeFileSync } from 'node:fs';
import { localToNztm } from './project.ts';

export type RasterKind = 'dem' | 'dsm';

export type Raster = {
  kind: RasterKind;
  /** NZTM easting of the west edge of column 0. */
  west: number;
  /** NZTM northing of the north edge of row 0. Rows run southwards. */
  north: number;
  /** Pixel size in metres. */
  res: number;
  width: number;
  height: number;
  /** Row-major, row 0 = north. NaN where the source had no data. */
  data: Float32Array;
  source: string;
};

type Header = Omit<Raster, 'data'>;

export function saveRaster(path: string, r: Raster) {
  const { data, ...header } = r;
  writeFileSync(`${path}.json`, JSON.stringify(header, null, 2) + '\n');
  writeFileSync(`${path}.f32`, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

export function loadRaster(path: string): Raster {
  const header = JSON.parse(readFileSync(`${path}.json`, 'utf8')) as Header;
  const buf = readFileSync(`${path}.f32`);
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (data.length !== header.width * header.height) throw new Error(`${path}: size mismatch`);
  return { ...header, data };
}

/** Bilinear sample at an NZTM point (pixel centres are the samples). NaN outside or on no-data. */
export function sampleNztm(r: Raster, e: number, n: number): number {
  const fx = (e - r.west) / r.res - 0.5;
  const fy = (r.north - n) / r.res - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let sum = 0;
  let wsum = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const x = Math.min(Math.max(x0 + dx, 0), r.width - 1);
      const y = Math.min(Math.max(y0 + dy, 0), r.height - 1);
      if (x0 + dx < -1 || x0 + dx > r.width || y0 + dy < -1 || y0 + dy > r.height) return NaN;
      const v = r.data[y * r.width + x];
      const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
      if (!Number.isNaN(v) && w > 0) {
        sum += v * w;
        wsum += w;
      }
    }
  }
  return wsum > 0 ? sum / wsum : NaN;
}

/** Bilinear sample at a local (x, z) point. */
export function sampleLocal(r: Raster, x: number, z: number): number {
  const p = localToNztm(x, z);
  return sampleNztm(r, p.e, p.n);
}

/** The value of the pixel containing a local (x, z) point (no interpolation). NaN outside. */
export function pixelLocal(r: Raster, x: number, z: number): number {
  const p = localToNztm(x, z);
  const c = Math.floor((p.e - r.west) / r.res);
  const row = Math.floor((r.north - p.n) / r.res);
  if (c < 0 || row < 0 || c >= r.width || row >= r.height) return NaN;
  return r.data[row * r.width + c];
}
