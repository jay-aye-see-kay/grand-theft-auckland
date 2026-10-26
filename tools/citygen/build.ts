// Generates the game's city data from the cached sources:
//   public/city/<area>/manifest.json
//   public/city/<area>/terrain/<i>_<j>.bin   (see src/city/format.ts)
//   public/city/<area>/buildings/<i>_<j>.bin (chunks with buildings only)
//   public/city/<area>/roads/<i>_<j>.bin     (chunks with roads only)
//   public/city/<area>/ground/<i>_<j>.bin    (land use under the terrain)
//
//   node --experimental-strip-types tools/citygen/build.ts
//
// Output is deterministic (byte-identical on re-run with the same cache and
// Node/zlib), and committed so CI never needs the network.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chunkFile, CITY_FORMAT, encodeBuildings, encodeGround, encodeTerrain, GROUND_APRON, type ChunkInfo, type CityManifest } from '../../src/city/format.ts';
import { buildBuildings } from './buildings.ts';
import { buildParking, writeParking } from './parking.ts';
import { loadCityData } from './fetch.ts';
import { GroundRaster, GROUND_SAMPLES, paintLandUse } from './ground.ts';
import { CBD_BBOX, ORIGIN } from './project.ts';
import { buildRoads } from './roads.ts';
import { APRON, buildTerrainChunk, CELL_SIZE, CHUNK_SIZE, chunkGrid, SAMPLES, SEA_SHELF, TerrainSampler } from './terrain.ts';

const AREA = 'cbd';
const OUT = fileURLToPath(new URL(`../../public/city/${AREA}/`, import.meta.url));

const data = await loadCityData(CBD_BBOX);
const grid = chunkGrid(CBD_BBOX);
console.log(`Grid ${grid.nx}x${grid.nz} chunks of ${CHUNK_SIZE} m from x0=${grid.x0} z0=${grid.z0}`);

// Layers this script owns are rebuilt from scratch so stale chunks can't linger.
for (const layer of ['terrain', 'buildings', 'roads', 'ground']) {
  rmSync(join(OUT, layer), { recursive: true, force: true });
  mkdirSync(join(OUT, layer), { recursive: true });
}

const blds = buildBuildings(data, grid);
const c = blds.counts;
console.log(
  `Buildings: ${c.outlines} outlines + ${c.parts} parts drawn (${c.hiddenOutlines} outlines replaced by their parts, ${c.outside} outside the grid). ` +
    `Heights from tag ${c.height}, levels ${c.levels}, LiDAR ${c.dsm}, default ${c.default}.`,
);
const tallest = blds.buildings.slice().sort((a, b) => b.top - b.base - (a.top - a.base)).slice(0, 8);
console.log(`Tallest: ${tallest.map((b) => `${b.key} ${(b.top - b.base).toFixed(0)} m`).join(', ')}`);
const ground = new GroundRaster(grid);
const landUse = paintLandUse(data.osm, ground);
console.log(`Land use: ${Object.entries(landUse).map(([k, n]) => `${n} ${k}`).join(', ')} polygons`);
const terrainSampler = new TerrainSampler(data.dem);
const roads = buildRoads(data, grid, terrainSampler, ground);
console.log(
  `Roads: ${roads.counts.ways} ways (${roads.counts.bridges} bridges), ` +
    Object.entries(roads.counts.km).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)} km`).join(', '),
);
let roadBytes = 0;
let maxRoadBytes = 0;
let roadTris = 0;
let roadVerts = 0;
let groundBytes = 0;
let buildingBytes = 0;
let maxBuildingBytes = 0;
let buildingTris = 0;

const chunks: ChunkInfo[] = [];
let minY = Infinity;
let maxY = -Infinity;
for (let j = 0; j < grid.nz; j++) {
  for (let i = 0; i < grid.nx; i++) {
    const t = buildTerrainChunk(data.dem, grid, i, j);
    const file = chunkFile('terrain', i, j);
    writeFileSync(join(OUT, file), deflateSync(encodeTerrain(t.cm, SAMPLES), { level: 9 }));
    const files: Record<string, string> = { terrain: file };
    const mb = blds.chunks.get(`${i},${j}`);
    if (mb) {
      const bfile = chunkFile('buildings', i, j);
      const bytes = deflateSync(encodeBuildings(mb.encode(grid.x0 + (i + 0.5) * CHUNK_SIZE, grid.z0 + (j + 0.5) * CHUNK_SIZE)), { level: 9 });
      writeFileSync(join(OUT, bfile), bytes);
      files.buildings = bfile;
      buildingBytes += bytes.length;
      maxBuildingBytes = Math.max(maxBuildingBytes, bytes.length);
      buildingTris += mb.idx.length / 3;
    }
    const rb = roads.chunks.get(`${i},${j}`);
    if (rb && rb.idx.length) {
      const rfile = chunkFile('roads', i, j);
      const bytes = deflateSync(encodeBuildings(rb.encode(grid.x0 + (i + 0.5) * CHUNK_SIZE, grid.z0 + (j + 0.5) * CHUNK_SIZE)), { level: 9 });
      writeFileSync(join(OUT, rfile), bytes);
      files.roads = rfile;
      roadBytes += bytes.length;
      maxRoadBytes = Math.max(maxRoadBytes, bytes.length);
      roadTris += rb.idx.length / 3;
      roadVerts += rb.vertexCount;
    }
    const gfile = chunkFile('ground', i, j);
    const gbytes = deflateSync(encodeGround(ground.chunk(i, j)), { level: 9 });
    writeFileSync(join(OUT, gfile), gbytes);
    files.ground = gfile;
    groundBytes += gbytes.length;
    chunks.push({ i, j, minY: t.minY, maxY: t.maxY, files });
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
  ground: { apron: GROUND_APRON, samples: GROUND_SAMPLES, encoding: 'gtag1+deflate' },
  chunks,
};
// One line per chunk keeps the manifest readable and diffs small.
const { chunks: list, ...head } = manifest;
const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, '');
writeFileSync(join(OUT, 'manifest.json'), `${headJson},\n  "chunks": [\n${list.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]\n}\n`);

const parking = buildParking(data, terrainSampler);
writeParking(parking, join(OUT, 'parking.json'));
console.log(`Parking: ${parking.cars.length} cars, spawn (${parking.spawn.x}, ${parking.spawn.z})`);

const size = (dir: string): number =>
  readdirSync(dir).reduce((s, f) => {
    const p = join(dir, f);
    return s + (statSync(p).isDirectory() ? size(p) : statSync(p).size);
  }, 0);
console.log(`Wrote ${chunks.length} terrain chunks, heights ${minY.toFixed(1)}..${maxY.toFixed(1)} m`);
console.log(
  `Wrote ${blds.chunks.size} building chunks: ${(buildingBytes / 1024).toFixed(0)} KB deflated, ` +
    `largest ${(maxBuildingBytes / 1024).toFixed(0)} KB, ${buildingTris} triangles`,
);
console.log(
  `Wrote ${roads.chunks.size} road chunks: ${(roadBytes / 1024).toFixed(0)} KB deflated, ` +
    `largest ${(maxRoadBytes / 1024).toFixed(0)} KB, ${roadVerts} vertices, ${roadTris} triangles; ground ${(groundBytes / 1024).toFixed(0)} KB`,
);
console.log(`Total ${(size(OUT) / 1024).toFixed(0)} KB in ${OUT}`);
