// Land use on the terrain lattice: which surface each 2 m ground sample is
// (paved city, grass, flowerbeds, trees, sand, paths, paving, footpath, road). The game tints
// the terrain's vertex colours by it, so the CBD reads as paved city with
// green only where OSM maps parks, gardens and bush, and the debug probe
// reports it as "the surface under a point".
//
// Classes are painted in SURFACES order (later wins): land-use polygons
// first, then pedestrian areas, then paths through parks and bush, then
// footpaths and carriageways from roads.ts. Anything unmapped stays 'urban'.
import { GROUND_APRON, SURFACE_ID, type GroundSamples, type Surface } from '../../src/city/format.ts';
import { assembleRings, nodesLocal, parseLength } from './buildings.ts';
import type { OsmData, OsmWay, Tags } from './osm.ts';
import { lonLatToLocal, type Local } from './project.ts';
import { CELL_SIZE, CHUNK_SIZE, type Grid } from './terrain.ts';

const CELLS = CHUNK_SIZE / CELL_SIZE;
/** Ground samples per chunk side: the chunk's lattice points plus the apron. */
export const GROUND_SAMPLES = CELLS + 1 + 2 * GROUND_APRON;

/** Which surface a land-use polygon paints, or null to leave it alone. */
export function landSurface(t: Tags): Surface | null {
  const lu = t.landuse;
  const le = t.leisure;
  const na = t.natural;
  if (na === 'wood' || na === 'scrub' || lu === 'forest' || na === 'wetland') return 'trees';
  if (na === 'beach' || na === 'sand') return 'sand';
  if (lu === 'flowerbed') return 'flowerbed';
  if (
    le === 'park' || le === 'garden' || le === 'pitch' || le === 'golf_course' || le === 'common' || le === 'dog_park' ||
    lu === 'grass' || lu === 'recreation_ground' || lu === 'village_green' || lu === 'meadow' || lu === 'cemetery' ||
    lu === 'allotments' || lu === 'plant_nursery' || na === 'grassland' || na === 'grass' || na === 'heath'
  ) {
    // Artificial turf and hard courts are still green from above; paved plazas tagged as parks are rare enough.
    return 'grass';
  }
  return null;
}

/** Pedestrian squares and paved areas mapped as highway areas, and pier decks. */
export function isPavedArea(t: Tags): boolean {
  if (t.man_made === 'pier') return true; // decks: see piers.ts
  if (t.area !== 'yes') return t['area:highway'] === 'pedestrian' || t['area:highway'] === 'footway';
  return t.highway === 'pedestrian' || t.highway === 'footway';
}

/** Global ground-class raster over the chunk grid (plus apron), in lattice units. */
export class GroundRaster {
  readonly c0: number;
  readonly r0: number;
  readonly cols: number;
  readonly rows: number;
  readonly classes: Uint8Array;

  constructor(grid: Grid) {
    this.c0 = grid.x0 / CELL_SIZE - GROUND_APRON;
    this.r0 = grid.z0 / CELL_SIZE - GROUND_APRON;
    this.cols = grid.nx * CELLS + 1 + 2 * GROUND_APRON;
    this.rows = grid.nz * CELLS + 1 + 2 * GROUND_APRON;
    this.classes = new Uint8Array(this.cols * this.rows); // 0 = urban
  }

  private set(c: number, r: number, id: number) {
    const cc = c - this.c0;
    const rr = r - this.r0;
    if (cc < 0 || rr < 0 || cc >= this.cols || rr >= this.rows) return;
    const k = rr * this.cols + cc;
    if (this.classes[k] < id) this.classes[k] = id;
  }

  /** Class at global lattice point (c, r) (local (c, r) * CELL_SIZE), 0 outside the raster. */
  lattice(c: number, r: number): number {
    const cc = c - this.c0;
    const rr = r - this.r0;
    if (cc < 0 || rr < 0 || cc >= this.cols || rr >= this.rows) return 0;
    return this.classes[rr * this.cols + cc];
  }

  /** Calls `fn` with the global lattice point (c, r) of every sample of `surface`. */
  each(surface: Surface, fn: (c: number, r: number) => void) {
    const id = SURFACE_ID[surface];
    for (let rr = 0; rr < this.rows; rr++) {
      for (let cc = 0; cc < this.cols; cc++) if (this.classes[rr * this.cols + cc] === id) fn(cc + this.c0, rr + this.r0);
    }
  }

  at(x: number, z: number): number {
    const cc = Math.round(x / CELL_SIZE) - this.c0;
    const rr = Math.round(z / CELL_SIZE) - this.r0;
    if (cc < 0 || rr < 0 || cc >= this.cols || rr >= this.rows) return 0;
    return this.classes[rr * this.cols + cc];
  }

  /** Paints lattice points inside the rings (even-odd, so inner rings are holes). */
  fillPolygon(rings: Local[][], surface: Surface) {
    const id = SURFACE_ID[surface];
    const pts = rings.flat();
    if (!pts.length) return;
    const rMin = Math.ceil(Math.min(...pts.map((p) => p.z)) / CELL_SIZE);
    const rMax = Math.floor(Math.max(...pts.map((p) => p.z)) / CELL_SIZE);
    for (let r = Math.max(rMin, this.r0); r <= Math.min(rMax, this.r0 + this.rows - 1); r++) {
      const z = r * CELL_SIZE;
      const xs: number[] = [];
      for (const ring of rings) {
        for (let k = 0, l = ring.length - 1; k < ring.length; l = k++) {
          const a = ring[k];
          const b = ring[l];
          if (a.z > z !== b.z > z) xs.push(a.x + ((z - a.z) * (b.x - a.x)) / (b.z - a.z));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let c = Math.ceil(xs[k] / CELL_SIZE); c <= Math.floor(xs[k + 1] / CELL_SIZE); c++) this.set(c, r, id);
      }
    }
  }

  /** Paints lattice points within `radius` of the segment a-b (not over 'urban' ones if `greenOnly`). */
  fillCapsule(a: Local, b: Local, radius: number, surface: Surface, greenOnly = false) {
    const id = SURFACE_ID[surface];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const c0 = Math.ceil((Math.min(a.x, b.x) - radius) / CELL_SIZE);
    const c1 = Math.floor((Math.max(a.x, b.x) + radius) / CELL_SIZE);
    const r0 = Math.ceil((Math.min(a.z, b.z) - radius) / CELL_SIZE);
    const r1 = Math.floor((Math.max(a.z, b.z) + radius) / CELL_SIZE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = c * CELL_SIZE;
        const z = r * CELL_SIZE;
        const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
        if (Math.hypot(x - a.x - t * dx, z - a.z - t * dz) > radius) continue;
        if (!greenOnly || this.lattice(c, r) !== SURFACE_ID.urban) this.set(c, r, id);
      }
    }
  }

  /** Chunk (i, j)'s samples, apron included. */
  chunk(i: number, j: number): GroundSamples {
    const n = GROUND_SAMPLES;
    const classes = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) {
      const src = (j * CELLS + r) * this.cols + i * CELLS;
      classes.set(this.classes.subarray(src, src + n), r * n);
    }
    return { n, classes };
  }
}

/** Paints land-use polygons (ways and multipolygons) and pedestrian areas. */
export function paintLandUse(osm: OsmData, ground: GroundRaster): Record<string, number> {
  const counts: Record<string, number> = {};
  const jobs: { surface: Surface; rings: Local[][] }[] = [];
  const viaRelation = new Set<number>();
  for (const rel of osm.relations.values()) {
    if (rel.tags.type !== 'multipolygon') continue;
    const surface = landSurface(rel.tags) ?? (isPavedArea(rel.tags) ? 'paving' : null);
    if (!surface) continue;
    const ways: OsmWay[] = [];
    for (const m of rel.members) {
      const w = m.type === 'way' ? osm.ways.get(m.ref) : undefined;
      if (w) ways.push(w);
      if (w) viaRelation.add(w.id);
    }
    const rings = assembleRings(ways).map((n) => nodesLocal(osm, n)).filter((r): r is Local[] => !!r);
    if (rings.length) jobs.push({ surface, rings });
  }
  for (const way of osm.ways.values()) {
    if (way.nodes.length < 4 || way.nodes[0] !== way.nodes[way.nodes.length - 1] || viaRelation.has(way.id)) continue;
    const surface = landSurface(way.tags) ?? (isPavedArea(way.tags) ? 'paving' : null);
    if (!surface) continue;
    const ring = nodesLocal(osm, way.nodes);
    if (ring) jobs.push({ surface, rings: [ring] });
  }
  // Paint in class order so a garden inside a wood stays a wood, and so on.
  jobs.sort((a, b) => SURFACE_ID[a.surface] - SURFACE_ID[b.surface]);
  for (const job of jobs) {
    ground.fillPolygon(job.rings, job.surface);
    counts[job.surface] = (counts[job.surface] ?? 0) + 1;
  }
  return counts;
}

/** Default widths of paths by highway class, m. */
const PATH_WIDTH: Record<string, number> = { footway: 2, path: 1.5, steps: 2, cycleway: 2.5, bridleway: 2, track: 3 };
/**
 * Half the lattice spacing and a little: the narrowest strip that always
 * covers a lattice point, so a path on the 2 m grid never breaks up.
 */
const MIN_PATH_RADIUS = 1.05;

/** A path's centreline and half-width, m. */
export type PathLine = { pts: Local[]; half: number };

/**
 * Paints paths and steps where they cross parks, gardens, bush and beaches,
 * so a park reads as one from its paths. Over the paved city they'd add
 * nothing (and paved footpaths along streets come from roads.ts), so
 * they're left out there. The tint shows the paths from afar; near the
 * player roads.ts drapes the returned lines as crisp strips over it.
 */
export function paintPaths(osm: OsmData, ground: GroundRaster): PathLine[] {
  const lines: PathLine[] = [];
  for (const way of osm.ways.values()) {
    const t = way.tags;
    const base = PATH_WIDTH[t.highway];
    if (!base || t.area === 'yes') continue;
    // Not over or under anything: footbridges, underpasses, paths inside buildings.
    if ((t.bridge && t.bridge !== 'no') || (t.tunnel && t.tunnel !== 'no') || t.indoor === 'yes' || t.covered === 'yes') continue;
    if (t.layer && Number(t.layer) !== 0) continue;
    const w = parseLength(t.width);
    const half = Math.max(MIN_PATH_RADIUS, (w > 0.5 && w < 10 ? w : base) / 2);
    const pts: Local[] = [];
    for (const ref of way.nodes) {
      const n = osm.nodes.get(ref);
      if (!n) continue;
      const p = lonLatToLocal(n.lon, n.lat);
      const last = pts[pts.length - 1];
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.05) continue;
      if (last) ground.fillCapsule(last, p, half, 'path', true);
      pts.push(p);
    }
    if (pts.length >= 2) lines.push({ pts, half });
  }
  return lines;
}
