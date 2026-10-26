// Prints what the cached CBD data contains and sanity-checks the projection
// and DEM window against two known ground heights. Exits non-zero if the
// check fails.
//
//   node --experimental-strip-types tools/citygen/stats.ts
import { CBD_BBOX, lonLatToLocal, ORIGIN, type LonLat } from './project.ts';
import { DRIVEABLE_HIGHWAYS, isBuilding, wayInBBox, waysNamed, type OsmData } from './osm.ts';
import { sampleLocal } from './raster.ts';
import { loadCityData } from './fetch.ts';

const d = await loadCityData(CBD_BBOX);
const { osm, dem, dsm } = d;
const inBox = [...osm.ways.values()].filter((w) => wayInBBox(osm, w, CBD_BBOX));

const buildings = inBox.filter((w) => isBuilding(w.tags));
const buildingRels = [...osm.relations.values()].filter((r) => isBuilding(r.tags));
const withHeight = buildings.filter((w) => w.tags.height !== undefined || w.tags['building:levels'] !== undefined);
const parts = inBox.filter((w) => w.tags['building:part'] !== undefined && w.tags['building:part'] !== 'no');

const byClass = new Map<string, number>();
for (const w of inBox) if (w.tags.highway) byClass.set(w.tags.highway, (byClass.get(w.tags.highway) ?? 0) + 1);
const driveable = new Set<string>(DRIVEABLE_HIGHWAYS);
const roadCount = [...byClass].filter(([k]) => driveable.has(k)).reduce((a, [, n]) => a + n, 0);

console.log(`\nCBD bbox ${CBD_BBOX.join(', ')}`);
console.log(`OSM merged: ${osm.nodes.size} nodes, ${osm.ways.size} ways, ${osm.relations.size} relations (${inBox.length} ways touch the bbox)`);
console.log(`Buildings: ${buildings.length} ways + ${buildingRels.length} multipolygon relations`);
console.log(`  with height or building:levels: ${withHeight.length} (${pct(withHeight.length, buildings.length)})`);
console.log(`  building:part ways: ${parts.length}`);
console.log(`Roads (driveable classes): ${roadCount}`);
for (const [k, n] of [...byClass].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`  ${driveable.has(k) ? '*' : ' '} ${k.padEnd(16)} ${n}`);
}
console.log(`DEM ${dem.width}x${dem.height} @ ${dem.res} m, west ${dem.west} north ${dem.north}; DSM ${dsm.width}x${dsm.height}`);

/** Shared nodes of two named streets: the intersection, as OSM sees it. */
function corner(data: OsmData, a: string, b: string): LonLat | null {
  const aNodes = new Set(waysNamed(data, a).flatMap((w) => w.nodes));
  const shared = [...new Set(waysNamed(data, b).flatMap((w) => w.nodes))].filter((id) => aNodes.has(id));
  if (shared.length === 0) return null;
  const pts = shared.map((id) => data.nodes.get(id)!);
  return {
    lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length,
    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
  };
}

const kRoadGuess: LonLat = { lon: 174.763, lat: -36.859 };
const kRoad = corner(osm, 'Queen Street', 'Karangahape Road');

function report(label: string, p: LonLat) {
  const l = lonLatToLocal(p.lon, p.lat);
  const g = sampleLocal(dem, l.x, l.z);
  const s = sampleLocal(dsm, l.x, l.z);
  console.log(
    `${label.padEnd(26)} ${p.lon.toFixed(5)}, ${p.lat.toFixed(5)}  local x=${l.x.toFixed(1)} z=${l.z.toFixed(1)}  ` +
      `ground ${g.toFixed(2)} m  surface ${s.toFixed(2)} m`,
  );
  return g;
}

console.log('');
const britomart = report('Britomart (origin)', ORIGIN);
if (kRoad) console.log(`Queen St / K Rd corner from OSM shared nodes (guess was ${kRoadGuess.lon}, ${kRoadGuess.lat})`);
else console.log('Queen St / K Rd: no shared OSM node found, using the guess');
const kRd = report('Queen St / K Road corner', kRoad ?? kRoadGuess);

const ok = britomart > -1 && britomart < 8 && kRd > 55 && kRd < 85;
console.log(`\nSanity check (Britomart -1..8 m, K Road 55..85 m): ${ok ? 'PASS' : 'FAIL'}`);
if (!ok) process.exit(1);

function pct(a: number, b: number) {
  return b ? `${((100 * a) / b).toFixed(0)}%` : '-';
}
