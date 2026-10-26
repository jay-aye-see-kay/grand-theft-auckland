// Downloads OSM tiles and LINZ DEM/DSM windows for an area into
// .cache/citygen/<area>/ and loads them back. Anything already cached is
// reused as-is, so re-runs are offline and deterministic; pass --refresh on
// the command line to re-download.
//
//   node --experimental-strip-types tools/citygen/fetch.ts [--refresh]
//
// In the Claude sandbox, Node's fetch needs NODE_USE_ENV_PROXY=1 to use the
// HTTPS proxy (the npm scripts set it).
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fromUrl } from 'geotiff';
import { bboxToNztmExtent, CBD_BBOX, type BBox } from './project.ts';
import { loadOsmFiles, type OsmData } from './osm.ts';
import { loadRaster, saveRaster, type Raster, type RasterKind } from './raster.ts';

export const CACHE_ROOT = fileURLToPath(new URL('../../.cache/citygen/', import.meta.url));

const OSM_API = 'https://api.openstreetmap.org/api/0.6/map';
const USER_AGENT = 'grand-theft-auckland-citygen/0.1 (offline map generator)';
/** OSM tile size in micro-degrees (integer maths keeps tile edges exact). */
const TILE_UDEG = 10_000;

/** LINZ 2024 1 m LiDAR tile covering the CBD (lon 174.749–174.804, lat −36.878 to −36.813). */
export const LINZ_TILES: Record<RasterKind, string> = {
  dem: 'https://nz-elevation.s3.ap-southeast-2.amazonaws.com/auckland/auckland-part-1_2024/dem_1m/2193/BA32_10000_0401.tiff',
  dsm: 'https://nz-elevation.s3.ap-southeast-2.amazonaws.com/auckland/auckland-part-1_2024/dsm_1m/2193/BA32_10000_0401.tiff',
};
/** Raster margin beyond the bbox, so terrain can be sampled a little past the edge. */
const RASTER_PAD_M = 50;

export type CityData = { bbox: BBox; osm: OsmData; dem: Raster; dsm: Raster };
type Options = { refresh?: boolean; log?: (msg: string) => void };

export function areaDir(bbox: BBox): string {
  return join(CACHE_ROOT, bbox.map((v) => v.toFixed(4)).join('_'));
}

const udeg = (v: number) => Math.round(v * 1e6);

/** Splits a bbox into tiles of at most TILE_UDEG on each side, row-major from the south-west. */
export function osmTiles(bbox: BBox): BBox[] {
  const [w, s, e, n] = bbox.map(udeg);
  const nx = Math.ceil((e - w) / TILE_UDEG);
  const ny = Math.ceil((n - s) / TILE_UDEG);
  const tiles: BBox[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x0 = w + Math.round(((e - w) * i) / nx);
      const x1 = w + Math.round(((e - w) * (i + 1)) / nx);
      const y0 = s + Math.round(((n - s) * j) / ny);
      const y1 = s + Math.round(((n - s) * (j + 1)) / ny);
      tiles.push([x0 / 1e6, y0 / 1e6, x1 / 1e6, y1 / 1e6]);
    }
  }
  return tiles;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(what: string, fn: () => Promise<T>, log: (m: string) => void, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      const wait = 2000 * 2 ** (i - 1);
      log(`  ${what} failed (${(err as Error).message}); retry ${i}/${attempts - 1} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

/** Fetches any missing OSM tiles sequentially (OSM API usage policy) and returns their paths. */
export async function fetchOsmTiles(bbox: BBox, opts: Options = {}): Promise<string[]> {
  const log = opts.log ?? console.log;
  const dir = join(areaDir(bbox), 'osm');
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  let fetched = 0;
  for (const tile of osmTiles(bbox)) {
    const key = tile.map((v) => v.toFixed(6)).join(',');
    const path = join(dir, `${key.replace(/,/g, '_')}.osm`);
    paths.push(path);
    if (existsSync(path) && !opts.refresh) continue;
    if (fetched++ > 0) await sleep(1000);
    log(`  OSM ${key}`);
    const xml = await withRetry(`OSM ${key}`, async () => {
      const res = await fetch(`${OSM_API}?bbox=${key}`, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // A cut-off transfer would otherwise be cached as a truncated tile.
      if (!text.trimEnd().endsWith('</osm>')) throw new Error('truncated response');
      return text;
    }, log);
    writeFileSync(`${path}.tmp`, xml);
    renameSync(`${path}.tmp`, path);
  }
  return paths;
}

/**
 * Reads the window of a LINZ COG that covers the bbox via HTTP range requests
 * (only the needed internal tiles are downloaded), and caches it.
 */
export async function fetchRaster(kind: RasterKind, bbox: BBox, opts: Options = {}): Promise<Raster> {
  const log = opts.log ?? console.log;
  const path = join(areaDir(bbox), kind);
  if (existsSync(`${path}.f32`) && existsSync(`${path}.json`) && !opts.refresh) return loadRaster(path);
  mkdirSync(areaDir(bbox), { recursive: true });
  const url = LINZ_TILES[kind];
  log(`  ${kind.toUpperCase()} window from ${url.split('/').slice(-3).join('/')}`);
  const raster = await withRetry(kind, async () => {
    const tiff = await fromUrl(url);
    const image = await tiff.getImage(0);
    const [originE, originN] = image.getOrigin();
    const [resX, resY] = image.getResolution();
    if (Math.abs(resX + resY) > 1e-9 || resX <= 0) throw new Error(`unexpected resolution ${resX},${resY}`);
    const ext = bboxToNztmExtent(bbox, RASTER_PAD_M);
    const x0 = Math.max(0, Math.floor((ext.minE - originE) / resX));
    const x1 = Math.min(image.getWidth(), Math.ceil((ext.maxE - originE) / resX));
    const y0 = Math.max(0, Math.floor((originN - ext.maxN) / resX));
    const y1 = Math.min(image.getHeight(), Math.ceil((originN - ext.minN) / resX));
    if (x1 <= x0 || y1 <= y0) throw new Error(`bbox is outside ${url}`);
    const rasters = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true });
    const nodata = image.getGDALNoData();
    const data = new Float32Array(rasters.length);
    for (let i = 0; i < data.length; i++) {
      const v = Number(rasters[i]);
      data[i] = nodata !== null && v === nodata ? NaN : v;
    }
    const r: Raster = {
      kind, west: originE + x0 * resX, north: originN - y0 * resX, res: resX,
      width: x1 - x0, height: y1 - y0, data, source: url,
    };
    return r;
  }, log);
  saveRaster(path, raster);
  return raster;
}

/** Everything the generator needs for an area: fetched on first use, then read from the cache. */
export async function loadCityData(bbox: BBox = CBD_BBOX, opts: Options = {}): Promise<CityData> {
  const tiles = await fetchOsmTiles(bbox, opts);
  const dem = await fetchRaster('dem', bbox, opts);
  const dsm = await fetchRaster('dsm', bbox, opts);
  return { bbox, osm: loadOsmFiles(tiles), dem, dsm };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const refresh = process.argv.includes('--refresh');
  console.log(`Fetching CBD ${CBD_BBOX.join(',')} into ${areaDir(CBD_BBOX)}${refresh ? ' (refresh)' : ''}`);
  const d = await loadCityData(CBD_BBOX, { refresh });
  console.log(
    `OSM: ${d.osm.nodes.size} nodes, ${d.osm.ways.size} ways, ${d.osm.relations.size} relations. ` +
      `DEM ${d.dem.width}x${d.dem.height}, DSM ${d.dsm.width}x${d.dsm.height} @ ${d.dem.res} m.`,
  );
}
