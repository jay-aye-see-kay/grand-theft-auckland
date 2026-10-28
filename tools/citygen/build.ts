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
import { chunkFile, CITY_FORMAT, encodeBuildings, encodeGround, encodeSkyline, encodeTerrain, GROUND_APRON, type ChunkInfo, type CityManifest } from '../../src/city/format.ts';
import { buildBuildings, MeshBuilder } from './buildings.ts';
import { Frontages } from './frontage.ts';
import { buildParking, writeParking } from './parking.ts';
import { loadCityData } from './fetch.ts';
import { GroundRaster, GROUND_SAMPLES, paintLandUse, paintPaths } from './ground.ts';
import { CBD_BBOX, ORIGIN } from './project.ts';
import { Overrides } from './overrides.ts';
import { loadWikidata } from './wikidata.ts';
import { layPiers } from './piers.ts';
import { buildSeawalls } from './seawalls.ts';
import { buildRoads, collectRoads, corridorRadius, roadNetwork, roadTris as roadTrisByKind } from './roads.ts';
import { APRON, buildTerrainChunk, CELL_SIZE, CHUNK_SIZE, chunkGrid, markCapsule, markLattice, SAMPLES, SEA_SHELF, smoothCorridors, TerrainSampler, WATER_LEVEL } from './terrain.ts';

const AREA = 'cbd';
const OUT = fileURLToPath(new URL(`../../public/city/${AREA}/`, import.meta.url));

const data = await loadCityData(CBD_BBOX);
// Hand fixes first, so everything downstream reads the corrected tags.
const overrides = Overrides.load(AREA);
const stale = overrides.apply(data.osm);
for (const w of stale) console.warn(`overrides/${AREA}.json: ${w}`);
console.log(`Overrides: ${overrides.size} entries, ${stale.length} stale`);
// Piers the LiDAR sees through go back into the DEM before anything samples it.
const piers = layPiers(data.osm, data.dem, overrides);
console.log(`Piers: ${piers.piers} decks laid over the water (${piers.pixels} DEM pixels)`);
const grid = chunkGrid(CBD_BBOX);
console.log(`Grid ${grid.nx}x${grid.nz} chunks of ${CHUNK_SIZE} m from x0=${grid.x0} z0=${grid.z0}`);

// Layers this script owns are rebuilt from scratch so stale chunks can't linger.
for (const layer of ['terrain', 'buildings', 'roads', 'ground']) {
  rmSync(join(OUT, layer), { recursive: true, force: true });
  mkdirSync(join(OUT, layer), { recursive: true });
}

// Smooth street surfaces in the ground itself before anything samples it,
// a little past their edges so the triangles under a strip's edge are smooth too.
const CORRIDOR_MARGIN = 2.5;
const corridors = new Set<number>();
for (const r of collectRoads(data.osm)) {
  if (r.bridge) continue;
  for (let k = 0; k + 1 < r.pts.length; k++) markCapsule(corridors, r.pts[k], r.pts[k + 1], corridorRadius(r) + CORRIDOR_MARGIN);
}
// Land use first: paths through parks are smoothed too (real ones are
// graded), a sample past the painted line, so their strips lie flat on lawn.
const ground = new GroundRaster(grid);
const landUse = paintLandUse(data.osm, ground);
console.log(`Land use: ${Object.entries(landUse).map(([k, n]) => `${n} ${k}`).join(', ')} polygons`);
const paths = paintPaths(data.osm, ground);
ground.each('path', (c, r) => {
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) markLattice(corridors, c + dc, r + dr);
});
console.log(`Smoothed ${smoothCorridors(data.dem, corridors)} lattice points under streets and park paths`);
const terrainSampler = new TerrainSampler(data.dem);
const network = roadNetwork(data, terrainSampler, overrides);
const frontages = new Frontages(data.osm);
const wikidata = loadWikidata(AREA);
const blds = buildBuildings(data, grid, { overrides, deckAt: network.deckAt, frontages, wikidata });
const c = blds.counts;
console.log(
  `Buildings: ${c.outlines} outlines + ${c.parts} parts drawn (${c.hiddenOutlines} outlines replaced by their parts, ${c.outside} outside the grid). ` +
    `Heights from tag ${c.height}, levels ${c.levels}, LiDAR ${c.dsm}, default ${c.default}. ` +
    `${c.hidden} hidden by overrides, ${c.blocks} blocks, ${blds.landmarks.length} landmarks. ` +
    `${c.verandahs} verandahs (${(c.verandahMetres / 1000).toFixed(1)} km). ` +
    `Eras: ${Object.entries(c.eras).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ')}. ` +
    `${c.towers} towers split from podiums, ${c.plant} rooftop plant boxes. ` +
    `Pitched roofs: ${Object.entries(c.roofs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}.`,
);
const tallest = blds.buildings.slice().sort((a, b) => b.top - b.base - (a.top - a.base)).slice(0, 8);
console.log(`Tallest: ${tallest.map((b) => `${b.key} ${(b.top - b.base).toFixed(0)} m`).join(', ')}`);
// Sea walls along the traced coastline, in the buildings layer (always drawn, solid).
const walls = buildSeawalls(data.dem, grid, terrainSampler, (x, z) => {
  const i = Math.floor((x - grid.x0) / CHUNK_SIZE);
  const j = Math.floor((z - grid.z0) / CHUNK_SIZE);
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.nz) return null;
  let mb = blds.chunks.get(`${i},${j}`);
  if (!mb) blds.chunks.set(`${i},${j}`, (mb = new MeshBuilder()));
  return mb;
});
console.log(`Sea walls: ${walls.km.toFixed(1)} km along ${walls.lines} coastlines`);
const roads = buildRoads(grid, terrainSampler, ground, network, blds.covers, paths);
console.log(
  `Roads: ${roads.counts.ways} ways (${roads.counts.bridges} bridges), ` +
    Object.entries(roads.counts.km).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)} km`).join(', '),
);
console.log(`Road triangles by kind: ${Object.entries(roadTrisByKind).map(([k, v]) => `${k} ${v}`).join(', ')}`);
let roadBytes = 0;
let maxRoadBytes = 0;
let roadTris = 0;
let roadVerts = 0;
let groundBytes = 0;
let buildingBytes = 0;
let maxBuildingBytes = 0;
let buildingTris = 0;
let nearTris = 0;
let fineTris = 0;

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
      nearTris += mb.extras.length / 3;
      fineTris += mb.fineIdx.length / 3;
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

// The far skyline: tall buildings from every chunk in one small file.
const skyParts = [...blds.skyline].map(([key, mb]) => {
  const [i, j] = key.split(',').map(Number);
  return { i, j, mesh: encodeBuildings(mb.encode(grid.x0 + (i + 0.5) * CHUNK_SIZE, grid.z0 + (j + 0.5) * CHUNK_SIZE)), tris: mb.idx.length / 3 };
}).sort((a, b) => a.j - b.j || a.i - b.i);
const skyBytes = deflateSync(encodeSkyline(skyParts), { level: 9 });
writeFileSync(join(OUT, 'skyline.bin'), skyBytes);
console.log(`Skyline: ${skyParts.length} chunks, ${skyParts.reduce((n, p) => n + p.tris, 0)} triangles, ${(skyBytes.length / 1024).toFixed(0)} KB`);

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
  water: { level: WATER_LEVEL },
  skyline: 'skyline.bin',
  landmarks: blds.landmarks,
  chunks,
};
// One line per chunk keeps the manifest readable and diffs small.
const { chunks: list, landmarks, ...head } = manifest;
const landmarkJson = (landmarks ?? []).map((l) => `    ${JSON.stringify(l)}`).join(',\n');
const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, '') + (landmarkJson ? `,\n  "landmarks": [\n${landmarkJson}\n  ]` : `,\n  "landmarks": []`);
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
    `largest ${(maxBuildingBytes / 1024).toFixed(0)} KB, ${buildingTris} triangles + ${nearTris} near-only + ${fineTris} fine`,
);
console.log(
  `Wrote ${roads.chunks.size} road chunks: ${(roadBytes / 1024).toFixed(0)} KB deflated, ` +
    `largest ${(maxRoadBytes / 1024).toFixed(0)} KB, ${roadVerts} vertices, ${roadTris} triangles; ground ${(groundBytes / 1024).toFixed(0)} KB`,
);
console.log(`Total ${(size(OUT) / 1024).toFixed(0)} KB in ${OUT}`);
