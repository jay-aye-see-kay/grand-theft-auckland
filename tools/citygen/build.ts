// Generates the game's city data from the cached sources:
//   public/city/<area>/manifest.json
//   public/city/<area>/terrain/<i>_<j>.bin   (see src/city/format.ts)
//
//   node --experimental-strip-types tools/citygen/build.ts
//
// Output is deterministic (byte-identical on re-run with the same cache and
// Node/zlib), and committed so CI never needs the network.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chunkFile, CITY_FORMAT, encodeTerrain, type ChunkInfo, type CityManifest } from '../../src/city/format.ts';
import { loadCityData } from './fetch.ts';
import { CBD_BBOX, ORIGIN } from './project.ts';
import { APRON, buildTerrainChunk, CELL_SIZE, CHUNK_SIZE, chunkGrid, SAMPLES, SEA_SHELF } from './terrain.ts';

const AREA = 'cbd';
const OUT = fileURLToPath(new URL(`../../public/city/${AREA}/`, import.meta.url));

const data = await loadCityData(CBD_BBOX);
const grid = chunkGrid(CBD_BBOX);
console.log(`Grid ${grid.nx}x${grid.nz} chunks of ${CHUNK_SIZE} m from x0=${grid.x0} z0=${grid.z0}`);

// Layers this script owns are rebuilt from scratch so stale chunks can't linger.
rmSync(join(OUT, 'terrain'), { recursive: true, force: true });
mkdirSync(join(OUT, 'terrain'), { recursive: true });

const chunks: ChunkInfo[] = [];
let minY = Infinity;
let maxY = -Infinity;
for (let j = 0; j < grid.nz; j++) {
  for (let i = 0; i < grid.nx; i++) {
    const t = buildTerrainChunk(data.dem, grid, i, j);
    const file = chunkFile('terrain', i, j);
    writeFileSync(join(OUT, file), deflateSync(encodeTerrain(t.cm, SAMPLES), { level: 9 }));
    chunks.push({ i, j, minY: t.minY, maxY: t.maxY, files: { terrain: file } });
    minY = Math.min(minY, t.minY);
    maxY = Math.max(maxY, t.maxY);
  }
}

const manifest: CityManifest = {
  format: CITY_FORMAT,
  area: AREA,
  origin: ORIGIN,
  bbox: CBD_BBOX,
  chunkSize: CHUNK_SIZE,
  grid,
  bounds: {
    minX: grid.x0,
    minZ: grid.z0,
    maxX: grid.x0 + grid.nx * CHUNK_SIZE,
    maxZ: grid.z0 + grid.nz * CHUNK_SIZE,
    minY,
    maxY,
  },
  terrain: { cellSize: CELL_SIZE, apron: APRON, samples: SAMPLES, seaShelf: SEA_SHELF, encoding: 'gtat1+deflate' },
  chunks,
};
// One line per chunk keeps the manifest readable and diffs small.
const { chunks: list, ...head } = manifest;
const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, '');
writeFileSync(join(OUT, 'manifest.json'), `${headJson},\n  "chunks": [\n${list.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]\n}\n`);

const size = (dir: string): number =>
  readdirSync(dir).reduce((s, f) => {
    const p = join(dir, f);
    return s + (statSync(p).isDirectory() ? size(p) : statSync(p).size);
  }, 0);
console.log(`Wrote ${chunks.length} terrain chunks, heights ${minY.toFixed(1)}..${maxY.toFixed(1)} m`);
console.log(`Total ${(size(OUT) / 1024).toFixed(0)} KB in ${OUT}`);
