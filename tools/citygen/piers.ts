// Piers over open water as walkable, drivable decks.
//
// The LiDAR DEM drops piled wharves and piers along with the water under
// them (Queens Wharf, the Viaduct's boardwalks): ground classification
// sees through the deck to the sea. Each OSM `man_made=pier` area is
// burnt back into the DEM at its deck height before anything else samples
// it, so the terrain, its collider, the buildings standing on it and the
// land-use tint all agree. Fixed piers take the height of any dry part of
// them in the DEM (where they join the land), else PIER_DECK; floating
// pontoons sit just above the water. An override `deck` sets the height,
// or `false` leaves the pier out.
import { assembleRings, inRing, nodesLocal } from './buildings.ts';
import type { OsmData, OsmWay, Tags } from './osm.ts';
import type { Overrides } from './overrides.ts';
import { localToNztm, nztmToLocal, type Local } from './project.ts';
import type { Raster } from './raster.ts';
import { SEA_CUTOFF, WATER_LEVEL } from './terrain.ts';

/** Deck of a fixed pier with no dry part to copy, m above sea level (the wharves are ~3 m). */
const PIER_DECK = 2.8;
/** Freeboard of a floating pontoon, m. */
const PONTOON = 0.5;
/** Burn the deck this far past the mapped edge, so the 2 m terrain lattice catches narrow piers. */
const GROW = 0.75;

const isPier = (t: Tags) => t.man_made === 'pier' && t.area !== 'no';

/** Raises the DEM under pier areas in place. Returns how many piers were laid and DEM pixels raised. */
export function layPiers(osm: OsmData, dem: Raster, overrides?: Overrides): { piers: number; pixels: number } {
  const jobs: { key: string; tags: Tags; rings: Local[][] }[] = [];
  const viaRelation = new Set<number>();
  for (const rel of osm.relations.values()) {
    if (!isPier(rel.tags) || rel.tags.type !== 'multipolygon') continue;
    const outers: OsmWay[] = [];
    for (const m of rel.members) {
      const w = m.type === 'way' ? osm.ways.get(m.ref) : undefined;
      if (!w) continue;
      viaRelation.add(w.id);
      if (m.role !== 'inner') outers.push(w);
    }
    const rings = assembleRings(outers).map((n) => nodesLocal(osm, n)).filter((r): r is Local[] => !!r);
    if (rings.length) jobs.push({ key: `r${rel.id}`, tags: rel.tags, rings });
  }
  for (const way of osm.ways.values()) {
    if (!isPier(way.tags) || viaRelation.has(way.id)) continue;
    if (way.nodes.length < 4 || way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;
    const ring = nodesLocal(osm, way.nodes);
    if (ring) jobs.push({ key: `w${way.id}`, tags: way.tags, rings: [ring] });
  }

  let piers = 0;
  let pixels = 0;
  for (const job of jobs) {
    const o = overrides?.get(job.key)?.deck;
    if (o === false) continue;
    const cells = pixelsUnder(dem, job.rings);
    if (!cells.length) continue;
    let deck: number;
    if (typeof o === 'number') deck = o;
    else if (job.tags.floating === 'yes') deck = WATER_LEVEL + PONTOON;
    else {
      const dry = cells.map((k) => dem.data[k]).filter((v) => v > WATER_LEVEL + 0.5).sort((a, b) => a - b);
      deck = dry.length >= Math.max(4, cells.length * 0.15) ? dry[Math.floor(dry.length / 2)] : PIER_DECK;
    }
    let raised = 0;
    for (const k of cells) {
      const v = dem.data[k];
      // Only fill the sea (and low spots on the deck): never cut into land.
      if (Number.isNaN(v) || v < SEA_CUTOFF || v < deck - 0.5) {
        dem.data[k] = deck;
        raised++;
      }
    }
    if (raised) {
      piers++;
      pixels += raised;
    }
  }
  return { piers, pixels };
}

/** Indices of DEM pixels whose centres are inside the rings or within GROW of their edges. */
function pixelsUnder(dem: Raster, rings: Local[][]): number[] {
  const pts = rings.flat();
  const minX = Math.min(...pts.map((p) => p.x)) - GROW;
  const maxX = Math.max(...pts.map((p) => p.x)) + GROW;
  const minZ = Math.min(...pts.map((p) => p.z)) - GROW;
  const maxZ = Math.max(...pts.map((p) => p.z)) + GROW;
  // Local axes are aligned with NZTM (x = east, z = south), so the bbox maps straight across.
  const nw = localToNztm(minX, minZ);
  const se = localToNztm(maxX, maxZ);
  const c0 = Math.max(0, Math.floor((nw.e - dem.west) / dem.res));
  const c1 = Math.min(dem.width - 1, Math.ceil((se.e - dem.west) / dem.res));
  const r0 = Math.max(0, Math.floor((dem.north - nw.n) / dem.res));
  const r1 = Math.min(dem.height - 1, Math.ceil((dem.north - se.n) / dem.res));
  const out: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const p = nztmToLocal(dem.west + (c + 0.5) * dem.res, dem.north - (r + 0.5) * dem.res);
      // Even-odd over all rings, so a ring inside another is a hole.
      let inside = false;
      for (const ring of rings) if (inRing(ring, p.x, p.z)) inside = !inside;
      if (inside || rings.some((ring) => nearRing(ring, p.x, p.z, GROW))) out.push(r * dem.width + c);
    }
  }
  return out;
}

function nearRing(ring: Local[], x: number, z: number, d: number): boolean {
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2));
    if (Math.hypot(x - a.x - t * dx, z - a.z - t * dz) <= d) return true;
  }
  return false;
}
