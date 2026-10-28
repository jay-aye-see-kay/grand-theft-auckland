// Generates the game's city data from the cached sources:
//   public/city/<area>/manifest.json
//   public/city/<area>/terrain/<i>_<j>.bin   (see src/city/format.ts)
//   public/city/<area>/buildings/<i>_<j>.bin (chunks with buildings only)
//   public/city/<area>/roads/<i>_<j>.bin     (chunks with roads only)
//   public/city/<area>/ground/<i>_<j>.bin    (land use under the terrain)
//   public/city/<area>/parking.json, places.json (spawn and parked cars; the gazetteer)
//   public/city/<area>/roadgraph.json        (the drivable network, for routing and traffic)
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
import { buildPlaces, writePlaces } from './places.ts';
import { buildRoadGraph, describeRoadGraph, writeRoadGraph } from './roadgraph.ts';
import { loadCityData } from './fetch.ts';
import { GROUND_SAMPLES } from './ground.ts';
import { prepareGround } from './prepare.ts';
import { CBD_BBOX, ORIGIN } from './project.ts';
import { Overrides } from './overrides.ts';
import { loadWikidata } from './wikidata.ts';
import { layPiers } from './piers.ts';
import { buildBarriers } from './barriers.ts';
import { emitTrees, findTrees, treeTris } from './trees.ts';
import { placeFurniture } from './furniture.ts';
import { buildSeawalls } from './seawalls.ts';
import { buildRoads, roadNetwork, roadTris as roadTrisByKind } from './roads.ts';
import { APRON, buildTerrainChunk, CELL_SIZE, CHUNK_SIZE, chunkGrid, SAMPLES, SEA_SHELF, TerrainSampler, WATER_LEVEL } from './terrain.ts';

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

// Smooth street surfaces in the ground itself before anything samples it.
const { ground, landUse, paths, smoothed } = prepareGround(data, grid);
console.log(`Land use: ${Object.entries(landUse).map(([k, n]) => `${n} ${k}`).join(', ')} polygons`);
console.log(`Smoothed ${smoothed} lattice points under streets and park paths`);
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
    `${c.verandahs} verandahs (${c.verandahsMapped} mapped in OSM, ${(c.verandahMetres / 1000).toFixed(1)} km), ${c.murals} painted walls. ` +
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
// The ground under buildings is never seen: the game leaves it out of the terrain mesh.
const families = new Map<string, number>();
for (const f of blds.footprints) {
  if (!families.has(f.family)) families.set(f.family, families.size + 1);
  ground.coverBuilding(families.get(f.family)!, f.bbox, f.inside);
}
const roads = buildRoads(grid, terrainSampler, ground, network, blds.covers, paths);
// Trees after the roads have painted the ground, so mapped trees in a carriageway are left out.
const forest = findTrees(data, { grid, ground, covers: blds.covers, deckAt: network.deckAt });
emitTrees(forest.trees, grid, terrainSampler, (x, z) => {
  const i = Math.floor((x - grid.x0) / CHUNK_SIZE);
  const j = Math.floor((z - grid.z0) / CHUNK_SIZE);
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.nz) return null;
  let mb = blds.chunks.get(`${i},${j}`);
  if (!mb) blds.chunks.set(`${i},${j}`, (mb = new MeshBuilder()));
  return mb;
});
ground.paintCanopy(forest.trees);
const furniture = placeFurniture(data.osm, network, grid, terrainSampler, ground, blds.covers, (x, z) => {
  const i = Math.floor((x - grid.x0) / CHUNK_SIZE);
  const j = Math.floor((z - grid.z0) / CHUNK_SIZE);
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.nz) return null;
  let mb = blds.chunks.get(`${i},${j}`);
  if (!mb) blds.chunks.set(`${i},${j}`, (mb = new MeshBuilder()));
  return mb;
});
console.log(
  `Furniture: ${furniture.lamp} lamps, ${furniture.signal} signals, ${furniture.shelter} shelters, ${furniture.stop} stops, ${furniture.bench} benches, ` +
    `${furniture.bin} bins (${furniture.mapped} from OSM), ${furniture.tris} near-only triangles`,
);
const barriers = buildBarriers(data.osm, {
  grid,
  terrain: terrainSampler,
  ground,
  covers: blds.covers,
  chunkAt: (x, z) => {
    const i = Math.floor((x - grid.x0) / CHUNK_SIZE);
    const j = Math.floor((z - grid.z0) / CHUNK_SIZE);
    if (i < 0 || j < 0 || i >= grid.nx || j >= grid.nz) return null;
    let mb = blds.chunks.get(`${i},${j}`);
    if (!mb) blds.chunks.set(`${i},${j}`, (mb = new MeshBuilder()));
    return mb;
  },
});
console.log(
  `Park edges: ${Object.entries(barriers.metres).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)} km`).join(', ')}, ` +
    `${barriers.tris.drawn} triangles (${barriers.tris.solid} solid)`,
);
console.log(
  `Trees: ${forest.trees.length} (${Object.entries(forest.counts).map(([k, v]) => `${v} ${k}`).join(', ')}), ` +
    `${treeTris.crowns} crown + ${treeTris.trunks} trunk triangles`,
);
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
const places = buildPlaces(data.osm, overrides);
writePlaces(places, join(OUT, 'places.json'));
console.log(`Places: ${Object.keys(places.places).length} (${Object.entries(places.kinds).map(([k, v]) => `${v} ${k}`).join(', ')})`);

const roadGraph = buildRoadGraph(data.osm, network, terrainSampler);
writeRoadGraph(roadGraph.graph, join(OUT, 'roadgraph.json'));
console.log(describeRoadGraph(roadGraph.stats));

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
