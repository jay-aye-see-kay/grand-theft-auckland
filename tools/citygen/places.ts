// The gazetteer: named places for missions (shops, bars, cafés, dairies,
// landmarks, wharves, parks), from OSM points of interest. Written to
// public/city/<area>/places.json; src/missions/runtime/places.ts reads it.
//
//   node --experimental-strip-types tools/citygen/places.ts
//
// (build.ts also writes it, so a full rebuild keeps it in step.)
//
// Businesses get parody names (names.ts) and public places keep their real
// ones. Every place also gets a marker point: on the nearest street, a
// metre or so in from the kerb on the place's side, clear of buildings, so
// a start ring or goal beam is somewhere you can drive to. Hand picks (ids
// missions use, names, spots along a street) are `place` entries in
// overrides/<area>.json.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectSolids, inRing, parseLength, type Solid } from './buildings.ts';
import { loadCityData } from './fetch.ts';
import { ALL_PARODIES, Namer, PUBLIC_KINDS, REAL_BRANDS } from './names.ts';
import { wayLocal, type OsmData, type Tags } from './osm.ts';
import { Overrides, type PlaceOverride } from './overrides.ts';
import { CBD_BBOX, lonLatToLocal, type Local } from './project.ts';
import { collectRoads } from './roads.ts';

export const PLACES_FORMAT = 1;

type Road = ReturnType<typeof collectRoads>[number];

export type Place = {
  name: string;
  kind: string;
  /** The street it's on (OSM addr:street, else the street its marker is on). */
  street: string;
  /** Marker point, local metres (origin Britomart, x east, z south). */
  x: number;
  z: number;
  /** The place itself (its centre, or the OSM node). */
  at: [number, number];
  /** 'node/123', 'way/123' or 'relation/123'. */
  osm: string;
};

export type Places = { format: number; kinds: Record<string, number>; places: Record<string, Place> };

/** OSM tags -> kind; null leaves it out (benches, parking, ATMs, offices). */
function kindOf(t: Tags): string | null {
  const a = t.amenity;
  const s = t.shop;
  if (s === 'convenience' || s === 'general' || s === 'grocery') return 'dairy';
  if (a === 'bar' || a === 'pub' || a === 'nightclub' || a === 'biergarten') return 'bar';
  if (a === 'cafe' || s === 'coffee' || s === 'tea') return 'cafe';
  if (a === 'restaurant') return 'restaurant';
  if (a === 'fast_food' || a === 'food_court' || a === 'ice_cream') return 'takeaway';
  if (s === 'bakery' || s === 'pastry' || s === 'confectionery' || s === 'chocolate') return 'bakery';
  if (s === 'supermarket') return 'supermarket';
  if (s === 'alcohol' || s === 'wine' || s === 'beverages') return 'liquor';
  if (a === 'bank' || a === 'bureau_de_change') return 'bank';
  if (t.tourism === 'hotel' || t.tourism === 'hostel' || t.tourism === 'motel' || t.tourism === 'guest_house') return 'hotel';
  if (a === 'pharmacy' || s === 'chemist') return 'pharmacy';
  if (a === 'fuel') return 'fuel';
  if (a === 'casino') return 'casino';
  if (a === 'cinema') return 'cinema';
  if (t.leisure === 'fitness_centre' || t.leisure === 'sports_centre') return 'gym';
  if (s === 'hairdresser' || s === 'beauty' || s === 'massage' || s === 'tattoo' || s === 'cosmetics') return 'salon';
  if (t.tourism === 'gallery' || s === 'art') return 'gallery';
  if (t.tourism === 'museum') return 'museum';
  if (a === 'library') return 'library';
  if (a === 'theatre' || a === 'arts_centre' || a === 'concert_hall') return 'theatre';
  if (a === 'university' || a === 'college') return 'university';
  if (a === 'place_of_worship') return 'church';
  if (a === 'townhall' || a === 'police' || a === 'fire_station' || a === 'courthouse' || a === 'post_office') return 'civic';
  if (a === 'ferry_terminal' || t.man_made === 'pier' || t.leisure === 'marina') return 'wharf';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'park';
  if (t.tourism === 'artwork') return 'artwork';
  if (t.tourism === 'attraction' || t.tourism === 'viewpoint') return 'attraction';
  if (s && s !== 'vacant' && s !== 'yes' && s !== 'erotic') return 'shop';
  return null;
}

/** Search this far for a street to put the marker on, m. */
const STREET_SEARCH = 90;
/** A lane behind the building is a worse front door than the street this much further away, m. */
const SERVICE_PENALTY = 12;
/** Marker this far in from the edge of the carriageway, m. */
const KERB_IN = 1.5;

const r1 = (v: number) => Math.round(v * 10) / 10;
const slug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

type Candidate = { key: string; tags: Tags; at: Local; kind: string; pin?: PlaceOverride };

export function buildPlaces(osm: OsmData, overrides: Overrides): Places {
  const [w, s, e, n] = CBD_BBOX;
  const bboxMin = lonLatToLocal(w, n);
  const bboxMax = lonLatToLocal(e, s);
  const inside = (p: Local) => p.x >= bboxMin.x && p.x <= bboxMax.x && p.z >= bboxMin.z && p.z <= bboxMax.z;

  const found: Candidate[] = [];
  const add = (key: string, tags: Tags, at: Local | null) => {
    const o = overrides.get(key);
    if (o?.place === false || !at || !inside(at)) return;
    const pin = o?.place;
    const kind = pin?.kind ?? (pin ? 'landmark' : kindOf(tags));
    // Unnamed POIs aren't places anyone would send you to, except chains (they're all over town).
    if (!kind || (!pin && !tags.name && !tags.brand)) return;
    found.push({ key, tags, at: pin?.at ? { x: pin.at[0], z: pin.at[1] } : at, kind, pin });
  };
  for (const nd of osm.nodes.values()) if (Object.keys(nd.tags).length) add(`node/${nd.id}`, nd.tags, lonLatToLocal(nd.lon, nd.lat));
  for (const way of osm.ways.values()) add(`way/${way.id}`, way.tags, centre(wayLocal(osm, way)));
  for (const rel of osm.relations.values()) {
    if (rel.tags.type !== 'multipolygon' && !overrides.get(`relation/${rel.id}`)?.place) continue;
    const pts = rel.members.filter((m) => m.type === 'way' && m.role !== 'inner').flatMap((m) => {
      const way = osm.ways.get(m.ref);
      return way ? wayLocal(osm, way) : [];
    });
    add(`relation/${rel.id}`, rel.tags, centre(pts));
  }
  // Pinned places first: they reserve their names before anything is generated.
  found.sort((a, b) => Number(!a.pin) - Number(!b.pin) || a.key.localeCompare(b.key));

  const streets = new StreetFinder(osm);
  const namer = new Namer();
  for (const c of found) if (c.pin?.name) namer.reserve(c.pin.name);
  const places: Record<string, Place> = {};
  const problems: string[] = [];
  for (const c of found) {
    const name = c.pin?.name ?? (PUBLIC_KINDS.has(c.kind) ? c.tags.name : namer.name(c.key, c.kind, c.tags));
    if (!name) continue;
    // A street way pinned as a place puts its marker on itself.
    const road = c.key.startsWith('way/') && c.pin ? streets.road(Number(c.key.slice(4))) : undefined;
    const kerb = streets.kerb(c.at, road);
    if (!kerb) {
      if (c.pin) problems.push(`${c.key} (${c.pin.id ?? name}): no street within ${STREET_SEARCH} m`);
      continue;
    }
    const street = c.tags['addr:street'] ?? kerb.street;
    let id = c.pin?.id ?? slug(name);
    if (!c.pin?.id && places[id]) id = `${id}-${slug(street)}`;
    for (let k = 2; places[id]; k++) id = `${c.pin?.id ?? slug(name)}-${k}`;
    if (c.pin?.id && id !== c.pin.id) problems.push(`${c.key}: id ${c.pin.id} is taken`);
    places[id] = { name, kind: c.kind, street, x: r1(kerb.x), z: r1(kerb.z), at: [r1(c.at.x), r1(c.at.z)], osm: c.key };
    // No real business name in the game: a parody must never be its real name.
    if (!PUBLIC_KINDS.has(c.kind) && !c.pin?.name && c.tags.name && norm(name) === norm(c.tags.name) && !ALL_PARODIES.has(name)) {
      problems.push(`${c.key}: parody "${name}" is its real name`);
    }
  }
  if (problems.length) throw new Error(`places:\n  ${problems.join('\n  ')}`);
  checkNoBrands(places);

  const sorted = Object.fromEntries(Object.entries(places).sort((a, b) => a[0].localeCompare(b[0])));
  const kinds: Record<string, number> = {};
  for (const p of Object.values(sorted)) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
  return { format: PLACES_FORMAT, kinds: Object.fromEntries(Object.entries(kinds).sort()), places: sorted };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A business name that is a real brand slipped through (e.g. a typo in the overrides). */
function checkNoBrands(places: Record<string, Place>) {
  const leaks: string[] = [];
  for (const [id, p] of Object.entries(places)) {
    if (PUBLIC_KINDS.has(p.kind)) continue;
    const words = ` ${p.name.toLowerCase()} `;
    const brand = REAL_BRANDS.find((b) => b.length > 3 && words.includes(` ${b} `));
    if (brand) leaks.push(`${id}: "${p.name}" contains the brand "${brand}"`);
  }
  if (leaks.length) throw new Error(`places: real brands in names:\n  ${leaks.join('\n  ')}`);
}

function centre(pts: Local[]): Local | null {
  if (!pts.length) return null;
  // A closed ring repeats its first node: leave it out of the average.
  const ring = pts.length > 2 && pts[0].x === pts[pts.length - 1].x && pts[0].z === pts[pts.length - 1].z ? pts.slice(0, -1) : pts;
  return { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, z: ring.reduce((s, p) => s + p.z, 0) / ring.length };
}

/** Nearest kerbside points on streets you can drive, clear of buildings. */
class StreetFinder {
  private readonly roads: Road[];
  private readonly names = new Map<number, string>();
  private readonly solids: (Solid & { box: [number, number, number, number] })[];

  constructor(osm: OsmData) {
    // Streets at ground level only: a marker on a bridge deck or in a tunnel is somewhere else entirely.
    this.roads = collectRoads(osm).filter((r) => !r.bridge && r.layer === 0);
    for (const r of this.roads) this.names.set(r.id, osm.ways.get(r.id)?.tags.name ?? '');
    // As parking.ts: only footprints that reach the ground block (not canopies or roofs over the footpath).
    this.solids = collectSolids(osm)
      .filter((s) => s.tags.building !== 'roof' && !(parseLength(s.tags.min_height) > 2))
      .map((s) => {
        const xs = s.polygons.flatMap((p) => p.outer.map((q) => q.x));
        const zs = s.polygons.flatMap((p) => p.outer.map((q) => q.z));
        return { ...s, box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] as [number, number, number, number] };
      });
  }

  road(id: number): Road | undefined {
    return this.roads.find((r) => r.id === id);
  }

  /** The marker for a place at `p`: on `only` if given, else the best nearby street. */
  kerb(p: Local, only?: Road): { x: number; z: number; street: string } | null {
    const options: { x: number; z: number; score: number; road: Road }[] = [];
    for (const road of only ? [only] : this.roads) {
      let best: { x: number; z: number; d: number; nx: number; nz: number } | null = null;
      for (let k = 0; k + 1 < road.pts.length; k++) {
        const a = road.pts[k];
        const b = road.pts[k + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len2 = dx * dx + dz * dz;
        const f = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
        const x = a.x + dx * f;
        const z = a.z + dz * f;
        const d = Math.hypot(p.x - x, p.z - z);
        if (!best || d < best.d) {
          // Unit normal towards the place (or either side if it's on the centreline).
          const len = Math.sqrt(len2);
          let nx = -dz / len;
          let nz = dx / len;
          if ((p.x - x) * nx + (p.z - z) * nz < 0) [nx, nz] = [-nx, -nz];
          best = { x, z, d, nx, nz };
        }
      }
      if (!best || (!only && best.d > STREET_SEARCH)) continue;
      const lateral = Math.max(0, Math.min(best.d, road.width / 2 - KERB_IN));
      options.push({
        x: best.x + best.nx * lateral,
        z: best.z + best.nz * lateral,
        score: best.d + (road.highway === 'service' ? SERVICE_PENALTY : 0),
        road,
      });
    }
    options.sort((a, b) => a.score - b.score || a.road.id - b.road.id);
    const clear = options.find((o) => !this.inBuilding(o.x, o.z));
    return clear ? { x: clear.x, z: clear.z, street: this.names.get(clear.road.id) ?? '' } : null;
  }

  private inBuilding(x: number, z: number): boolean {
    return this.solids.some(
      (s) => x >= s.box[0] && x <= s.box[2] && z >= s.box[1] && z <= s.box[3] && s.polygons.some((p) => inRing(p.outer, x, z) && !p.holes.some((h) => inRing(h, x, z))),
    );
  }
}

/** One place per line keeps the file readable and diffs small. */
export function writePlaces(places: Places, path: string) {
  const lines = Object.entries(places.places).map(([id, p]) => `    ${JSON.stringify(id)}: ${JSON.stringify(p)}`);
  writeFileSync(path, `{\n  "format": ${places.format},\n  "kinds": ${JSON.stringify(places.kinds)},\n  "places": {\n${lines.join(',\n')}\n  }\n}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await loadCityData(CBD_BBOX);
  const overrides = Overrides.load('cbd');
  overrides.apply(data.osm); // same corrected data as build.ts
  const places = buildPlaces(data.osm, overrides);
  const out = fileURLToPath(new URL('../../public/city/cbd/places.json', import.meta.url));
  writePlaces(places, out);
  console.log(`Places: ${Object.keys(places.places).length} (${Object.entries(places.kinds).map(([k, v]) => `${v} ${k}`).join(', ')}). Wrote ${out}`);
}
