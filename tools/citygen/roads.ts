// OSM centrelines -> road, footpath and kerb strips draped on the terrain,
// merged into one vertex-coloured mesh per chunk (the `roads` layer).
//
// Tier-1 junctions are overlapping strips plus round caps ("discs") at
// junction and end nodes. Overlaps don't z-fight: each surface sits at its
// own small lift above the ground (paving < footpath < road < kerb) and
// carries a draw layer that the game turns into a depth bias for distances
// where a few cm is below depth-buffer precision. Where the same surface
// overlaps itself it has one flat colour and an up normal, so the two copies
// are indistinguishable. Kerbs are drawn on top, so they're cut back where
// another carriageway joins (the junction's mouth).
//
// Draping: cross-sections are considered every 2 m (the heightfield spacing)
// and then simplified, keeping one only where needed to stay within a band
// around the game's terrain triangles (see simplify); likewise across the
// width, piece by piece along the way (see pieces). The band is thin (a few
// mm below, 3 cm above) round junctions and way ends, where surfaces
// overlap and their lifts must keep them in order; elsewhere strips only
// meet edge to edge, so it widens to a few cm each way, as far as each
// surface's lift allows without the ground showing through. Deep inside a
// paved area the game sinks the terrain mesh (PAVED_SINK), giving more room.
// Kerbs follow their footpath's simplified surface, so they always sit
// above it. The car drives on the terrain heightfield, so draped roads need
// no colliders and kerbs are visual only (flush stripes, not 15 cm steps:
// a raised footpath would have to be cut out of every junction).
//
// Bridges: the LiDAR DEM has bridges removed, so draping would drop them
// into the gully. Bridge ways follow a deck profile instead (bridgeHeights)
// and get a thin deck collider. The DEM's cut-out is a little bigger than
// the bridge OSM maps, so decks are carried on over its edge (extendDecks).
// Tunnels are skipped.
//
// Footpaths are not clamped against buildings: where OSM puts a footprint
// right against a centreline the footpath just runs inside the building,
// where it can't be seen.
import { PAVED_SINK, SURFACE_ID, underPaving } from '../../src/city/format.ts';
import { MeshBuilder, parseLength, rgb } from './buildings.ts';
import { roadMarking, tileOf } from '../../src/city/facades.ts';
import type { GroundRaster, PathLine } from './ground.ts';
import { DRIVEABLE_HIGHWAYS, type OsmData, type Tags } from './osm.ts';
import type { Overrides } from './overrides.ts';
import { lonLatToLocal, type Local } from './project.ts';
import { sampleLocal, type Raster } from './raster.ts';
import { CELL_SIZE, CHUNK_SIZE, type Grid, type TerrainSampler } from './terrain.ts';

export const FOOTPATH_WIDTH = 3;
export const KERB_WIDTH = 0.3;
/** Spacing of candidate cross-sections along a way, m (the heightfield's cell). */
const SAMPLE = 2;
/** A bend sharper than this (radians) always keeps its cross-section; gentler ones only if the plan needs it (PLAN_TOL). */
const HARD_TURN = 0.3;
/** How far a strip's edges may cut across a gentle bend, m. */
const PLAN_TOL = 0.2;
/** Longest stretch between kept cross-sections, m. */
const MAX_SPAN = 60;
/**
 * How far a simplified surface may float above the terrain (it must never
 * dip more than TOL_DOWN below, or the ground would poke through). The
 * surfaces' lifts are more than TOL_UP + TOL_DOWN apart, so their order holds.
 */
const TOL_UP = 0.025;
const TOL_DOWN = 0.01;
/** True if a surface interpolated to `y` over ground at `ground` stays within tolerance. */
const within = (y: number, ground: number) => y - ground <= TOL_UP && ground - y <= TOL_DOWN;
/** Across the width, columns are dropped only where the ground between them is this straight. */
const LATERAL_TOL = 0.01;
/** Where a kept cross-section aims to sit above the ground, leaving room both ways for the next span. */
const AIM = 0.01;
/**
 * Away from junctions and way ends: how far a surface may float above the
 * ground, and its lateral tolerance. How far it may dip is set per surface
 * (looseDown), never more than LOOSE_DOWN_MAX.
 */
const LOOSE_UP = 0.05;
const LOOSE_LAT = 0.02;
const LOOSE_DOWN_MAX = 0.05;
/** Clearance kept between a surface and the terrain mesh under it, m. */
const CLEAR = 0.01;
/** Strips keep the tight band this far either side of a junction cap (beyond its radius), m. */
const JUNCTION_MARGIN = 0.5;
/** Columns across a strip are chosen per piece: the most any station within this distance needs, m. */
const PIECE_REACH = 25;
/** Steepest a bridge deck may climb away from where it meets the ground. */
const BRIDGE_GRADE = 0.1;
/** Visible thickness of a bridge deck's edge, m. */
const DECK_DEPTH = 1.2;
/** Headroom a bridge deck keeps over a road on a lower layer that it crosses, m. */
const CLEARANCE = 6;
/** Steepest a deck climbs to clear a crossing (flyover ramps run at 5-7 %). */
const RAMP_GRADE = 0.07;

type RGB = [number, number, number];
type Level = { lift: number; layer: number; colour: RGB; tile: number };
/** Lift above the terrain (m), draw layer, colour and texture (see facades.ts) of each surface. */
const LEVELS = {
  paving: { lift: 0.014, layer: 1, colour: rgb(0x9f9b93), tile: tileOf('paving') },
  footpath: { lift: 0.05, layer: 2, colour: rgb(0x9d9b95), tile: tileOf('paving') },
  road: { lift: 0.086, layer: 3, colour: rgb(0x35383d), tile: tileOf('asphalt') },
  kerb: { lift: 0.122, layer: 4, colour: rgb(0xdedbd2), tile: tileOf('concrete') },
} satisfies Record<string, Level>;
/** Crossing paint: a few cm over the carriageway (inside its draping band), on its own draw layer. */
const MARK_LIFT = 0.086 + 0.055;
const MARK_LAYER = 5;
const MARK_COLOUR = rgb(0xd8d8d2);
/** Lane lines' dash period along the road, m (3 m lines, 6 m gaps). */
const DASH_PERIOD = 9;
/** Streets that get lane lines (not lanes, service roads or shared spaces). */
const MARKED = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential']);
const DECK_SIDE = rgb(0x85827c);
const UP = [0, 1, 0] as const;

/** Carriageway width by class when a way has neither `width` nor `lanes`. */
const DEFAULT_WIDTH: Record<string, number> = {
  motorway: 10.5, motorway_link: 5.5, trunk: 14, trunk_link: 6, primary: 14, primary_link: 6,
  secondary: 11, secondary_link: 6, tertiary: 9, tertiary_link: 6, unclassified: 7, residential: 7.5,
  living_street: 6, service: 4.5, busway: 7, pedestrian: 6,
};
/** Urban street classes that get footpaths and kerbs. */
const STREETS = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential']);
const PAVED_STREETS = new Set(['pedestrian', 'living_street']);
const CARRIAGEWAYS = new Set<string>([...DRIVEABLE_HIGHWAYS, 'busway'].filter((h) => !PAVED_STREETS.has(h)));
const SKIP_SERVICE = new Set(['parking_aisle', 'driveway', 'drive-through', 'emergency_access']);

type Road = {
  id: number;
  highway: string;
  /** Node ids and their local points, consecutive duplicates removed. */
  nodes: number[];
  pts: Local[];
  /** Arc length at each point. */
  s: number[];
  surface: 'road' | 'paving';
  width: number;
  left: boolean;
  right: boolean;
  bridge: boolean;
  /** OSM layer (0 when untagged; 1 for an untagged bridge). */
  layer: number;
  /** Lane lines painted by the chunk shader (see roadMarking in facades.ts), 0 for none. */
  marking: number;
  lanes: number;
};

function skipped(t: Tags): boolean {
  if (t.area === 'yes' || (t.tunnel !== undefined && t.tunnel !== 'no')) return true;
  if (t.indoor === 'yes' || t.location === 'underground' || t.covered === 'yes') return true;
  return t.service !== undefined && SKIP_SERVICE.has(t.service);
}

function roadWidth(t: Tags): number {
  const w = parseLength(t.width);
  if (w >= 2 && w <= 40) return w;
  const lanes = Number(t.lanes);
  const motorway = t.highway === 'motorway' || t.highway === 'motorway_link';
  if (Number.isFinite(lanes) && lanes >= 1 && lanes <= 10) return Math.max(3, lanes * (motorway ? 3.5 : 3.3));
  return DEFAULT_WIDTH[t.highway] ?? 6;
}

function footpathSides(t: Tags): { left: boolean; right: boolean } {
  if (!STREETS.has(t.highway)) return { left: false, right: false };
  const sw = t.sidewalk ?? t['sidewalk:both'];
  let left = sw !== 'no' && sw !== 'none' && sw !== 'right';
  let right = sw !== 'no' && sw !== 'none' && sw !== 'left';
  if (t['sidewalk:left'] === 'no') left = false;
  if (t['sidewalk:right'] === 'no') right = false;
  return { left, right };
}

/** Half-width of a road's surfaces: carriageway plus any footpath. */
export const corridorRadius = (r: Road) => r.width / 2 + (r.left || r.right ? FOOTPATH_WIDTH : 0);

export function collectRoads(osm: OsmData): Road[] {
  const roads: Road[] = [];
  for (const way of osm.ways.values()) {
    const t = way.tags;
    const highway = t.highway;
    if (!highway || skipped(t)) continue;
    const surface = CARRIAGEWAYS.has(highway) ? 'road' : PAVED_STREETS.has(highway) ? 'paving' : null;
    if (!surface) continue;
    const nodes: number[] = [];
    const pts: Local[] = [];
    for (const ref of way.nodes) {
      const n = osm.nodes.get(ref);
      if (!n) continue;
      const p = lonLatToLocal(n.lon, n.lat);
      const last = pts[pts.length - 1];
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.05) continue;
      nodes.push(ref);
      pts.push(p);
    }
    if (pts.length < 2) continue;
    const s = [0];
    for (let k = 1; k < pts.length; k++) s.push(s[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
    const bridge = t.bridge !== undefined && t.bridge !== 'no';
    const layer = Number.isFinite(Number(t.layer)) && t.layer !== undefined ? Number(t.layer) : bridge ? 1 : 0;
    const width = roadWidth(t);
    // Lanes as tagged, else two on any street wide enough; one-way streets get lines only between lanes.
    const tagged = Number(t.lanes);
    const lanes = Number.isFinite(tagged) && tagged >= 1 ? Math.round(tagged) : width >= 6 ? 2 : 1;
    const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || highway === 'motorway' || t.junction === 'roundabout';
    const marking = MARKED.has(highway) && surface === 'road' ? roadMarking(lanes, !oneway) : 0;
    roads.push({ id: way.id, highway, nodes, pts, s, surface, width, ...footpathSides(t), bridge, layer, marking, lanes });
  }
  return roads;
}

// ---------------------------------------------------------------- park paths

/** Point b moved d further along the line from a. */
function extend(a: Local, b: Local, d: number): Local {
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: b.x + ((b.x - a.x) * d) / len, z: b.z + ((b.z - a.z) * d) / len };
}

/** How far a park path's strip carries on past the green it crosses (under a footpath, or to the edge of a plaza), m. */
const PATH_OVERRUN = 1.5;

/**
 * Splits a path into runs over ground painted 'path' (where it crosses
 * green; see paintPaths), each carried on PATH_OVERRUN beyond its ends. The
 * runs keep the way's own vertices, plus their cut points.
 */
function pathRuns(pts: Local[], ground: GroundRaster): Local[][] {
  // Any of the four lattice points round it: the painted line is only ~2 m wide.
  const onPath = (x: number, z: number) => {
    const c = Math.floor(x / CELL_SIZE);
    const r = Math.floor(z / CELL_SIZE);
    return [[c, r], [c + 1, r], [c, r + 1], [c + 1, r + 1]].some(([cc, rr]) => ground.lattice(cc, rr) === SURFACE_ID.path);
  };
  // Samples every metre or less, flagged if on the path and if they're one of the way's vertices.
  const samples: { p: Local; on: boolean; vertex: boolean }[] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)));
    for (let q = 0; q < n; q++) {
      const p = { x: a.x + ((b.x - a.x) * q) / n, z: a.z + ((b.z - a.z) * q) / n };
      samples.push({ p, on: onPath(p.x, p.z), vertex: q === 0 });
    }
  }
  const last = pts[pts.length - 1];
  samples.push({ p: last, on: onPath(last.x, last.z), vertex: true });
  const over = Math.ceil(PATH_OVERRUN);
  const keep = samples.map((_, i) => samples.slice(Math.max(0, i - over), i + over + 1).some((t) => t.on));
  const runs: Local[][] = [];
  for (let i = 0; i < samples.length;) {
    if (!keep[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < samples.length && keep[j + 1]) j++;
    const run = samples.slice(i, j + 1).filter((s, k, all) => s.vertex || k === 0 || k === all.length - 1).map((s) => s.p);
    if (run.length >= 2) runs.push(run);
    i = j + 1;
  }
  return runs;
}

/**
 * Park paths: thin strips draped over the grass, like the streets'
 * footpaths but without kerbs or junction caps (paths meet end to
 * centreline, so the joins are covered). They're footpath, so where they
 * overlap each other or a street's footpath they're indistinguishable, and
 * its lift leaves room to follow the ground loosely (paving's would hold
 * them within 2 mm, for several times the triangles). Returns the km drawn.
 */
function emitPaths(out: ChunkMeshes, paths: PathLine[], ground: GroundRaster, terrain: TerrainSampler, covered?: (x: number, z: number) => boolean): number {
  const level = LEVELS.footpath;
  // Loose all along: there are no junctions to keep in order.
  const band: StripBand = {
    down: () => Math.min(LOOSE_DOWN_MAX, Math.max(0.002, level.lift - CLEAR - LOOSE_LAT)),
    up: () => LOOSE_UP,
    lat: () => LOOSE_LAT,
  };
  const h: HeightFn = (st, o) => {
    const p = offsetPoint(st, o);
    return terrain.heightAt(p.x, p.z);
  };
  let m = 0;
  for (const path of paths) {
    // Carried on half a width past each end, which closes the wedge where two ways meet at an angle.
    const pts0 = path.pts.slice();
    const n = pts0.length;
    pts0[0] = extend(pts0[1], pts0[0], path.half);
    pts0[n - 1] = extend(pts0[n - 2], pts0[n - 1], path.half);
    for (const pts of pathRuns(pts0, ground)) {
      const s = [0];
      for (let k = 1; k < pts.length; k++) s.push(s[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
      m += s[s.length - 1];
      for (const piece of drapeStrip(stations({ pts, s }), -path.half, path.half, h, band)) {
        tally('park path', out, () => emitStrip(out, piece.sections, piece.cols, { level, collider: false, covered }));
      }
    }
  }
  return m / 1000;
}

// ---------------------------------------------------------------- stations

/** A candidate cross-section: a point on the centreline with its (mitred) left normal. */
type Station = { s: number; x: number; z: number; nx: number; nz: number; m: number; hard: boolean };

/** Cross-sections at every vertex and at most SAMPLE apart in between. */
function stations(r: Pick<Road, 'pts' | 's'>): Station[] {
  const { pts, s } = r;
  const normal = (k: number) => {
    const dx = pts[k + 1].x - pts[k].x;
    const dz = pts[k + 1].z - pts[k].z;
    const len = Math.hypot(dx, dz);
    // Left of travel: facing east (+x), north (-z) is on your left.
    return { x: dz / len, z: -dx / len };
  };
  const out: Station[] = [];
  const last = pts.length - 1;
  for (let k = 0; k < last; k++) {
    const n = normal(k);
    if (k === 0) out.push({ s: 0, x: pts[0].x, z: pts[0].z, nx: n.x, nz: n.z, m: 1, hard: true });
    else {
      const p = normal(k - 1);
      let bx = p.x + n.x;
      let bz = p.z + n.z;
      const bl = Math.hypot(bx, bz);
      let m = 1;
      if (bl > 1e-3) {
        bx /= bl;
        bz /= bl;
        m = 1 / Math.max(bx * n.x + bz * n.z, 0.4);
      } else {
        bx = n.x;
        bz = n.z;
      }
      const turn = Math.acos(Math.min(1, p.x * n.x + p.z * n.z));
      out.push({ s: s[k], x: pts[k].x, z: pts[k].z, nx: bx, nz: bz, m, hard: turn > HARD_TURN });
    }
    const len = s[k + 1] - s[k];
    const steps = Math.ceil(len / SAMPLE);
    for (let q = 1; q < steps; q++) {
      const f = q / steps;
      out.push({
        s: s[k] + len * f,
        x: pts[k].x + (pts[k + 1].x - pts[k].x) * f,
        z: pts[k].z + (pts[k + 1].z - pts[k].z) * f,
        nx: n.x,
        nz: n.z,
        m: 1,
        hard: false,
      });
    }
  }
  const n = normal(last - 1);
  out.push({ s: s[last], x: pts[last].x, z: pts[last].z, nx: n.x, nz: n.z, m: 1, hard: true });
  return out;
}

type HeightFn = (st: Station, o: number) => number;

/** Whether the strip's outer edges, drawn straight from station a to b, pass within PLAN_TOL of every station between. */
function planOk(st: Station[], cols: number[], a: number, b: number): boolean {
  if (PLAN_TOL <= 0) return true;
  for (const o of [cols[0], cols[cols.length - 1]]) {
    const pa = offsetPoint(st[a], o);
    const pb = offsetPoint(st[b], o);
    const dx = pb.x - pa.x;
    const dz = pb.z - pa.z;
    const len2 = dx * dx + dz * dz || 1;
    for (let k = a + 1; k < b; k++) {
      const p = offsetPoint(st[k], o);
      const f = Math.min(1, Math.max(0, ((p.x - pa.x) * dx + (p.z - pa.z) * dz) / len2));
      if (Math.hypot(p.x - pa.x - f * dx, p.z - pa.z - f * dz) > PLAN_TOL) return false;
    }
  }
  return true;
}
const offsetPoint = (st: Station, o: number) => ({ x: st.x + st.nx * st.m * o, z: st.z + st.nz * st.m * o });

function interp(probes: number[], hs: number[], o: number, near: number): number {
  if (Math.abs(probes[near] - o) < 1e-6) return hs[near];
  let k = 0;
  while (k < probes.length - 2 && probes[k + 1] < o) k++;
  const t = (o - probes[k]) / (probes[k + 1] - probes[k]);
  return hs[k] + (hs[k + 1] - hs[k]) * t;
}

/** A kept cross-section: its station and the surface height (before lift) at each column. */
type Section = { st: Station; ys: number[] };

/**
 * Keeps as few stations as possible while every skipped one stays inside
 * the band [ground - TOL_DOWN, ground + TOL_UP], column by column. Kept
 * heights are free to sit anywhere in the band, so each span is a
 * "visibility cone": the range of slopes from the last kept height that pass
 * through every band so far, narrowed one station at a time.
 */
/** Band (m) a surface may dip below / rise above the ground at station i, column c. */
type Band = { down: (i: number, c: number) => number; up: (i: number) => number };
const TIGHT: Band = { down: () => TOL_DOWN, up: () => TOL_UP };

function simplify(st: Station[], cols: number[], h: HeightFn, band: Band = TIGHT): Section[] {
  const hs = st.map((s) => cols.map((o) => h(s, o)));
  const DOWN = (b: number, c: number) => band.down(b, c);
  const UP = (b: number) => band.up(b);
  let a = 0;
  let ya = hs[0].map((y) => y + AIM);
  const out: Section[] = [{ st: st[0], ys: ya }];
  const end = (b: number, lo: number[], hi: number[]): number[] | null => {
    const len = st[b].s - st[a].s;
    const ys: number[] = [];
    for (let c = 0; c < cols.length; c++) {
      const sl = Math.max(lo[c], (hs[b][c] - DOWN(b, c) - ya[c]) / len);
      const sh = Math.min(hi[c], (hs[b][c] + UP(b) - ya[c]) / len);
      if (sl > sh) return null;
      const want = (hs[b][c] + AIM - ya[c]) / len;
      ys.push(ya[c] + Math.min(sh, Math.max(sl, want)) * len);
    }
    return ys;
  };
  while (a < st.length - 1) {
    const lo = cols.map(() => -Infinity);
    const hi = cols.map(() => Infinity);
    let b = a + 1;
    let ys = end(b, lo, hi)!;
    while (b + 1 < st.length && !st[b].hard && st[b + 1].s - st[a].s <= MAX_SPAN && planOk(st, cols, a, b + 1)) {
      // Station b becomes an interior point of the span a..b+1.
      const d = st[b].s - st[a].s;
      const nlo = lo.map((v, c) => Math.max(v, (hs[b][c] - DOWN(b, c) - ya[c]) / d));
      const nhi = hi.map((v, c) => Math.min(v, (hs[b][c] + UP(b) - ya[c]) / d));
      if (nlo.some((v, c) => v > nhi[c])) break;
      const next = end(b + 1, nlo, nhi);
      if (!next) break;
      lo.splice(0, lo.length, ...nlo);
      hi.splice(0, hi.length, ...nhi);
      ys = next;
      b++;
    }
    out.push({ st: st[b], ys });
    a = b;
    ya = ys;
  }
  return out;
}

/** Fewest columns across [o0, o1] that keep one station's lateral samples (1 m apart) within `lat` of the ground. */
function columnsNeeded(st: Station, o0: number, o1: number, h: HeightFn, lat: number): number {
  const fine = Math.max(1, Math.ceil((o1 - o0) / SAMPLE));
  const probes = Array.from({ length: fine * 2 + 1 }, (_, k) => o0 + ((o1 - o0) * k) / (fine * 2));
  const hs = probes.map((o) => h(st, o));
  for (let cols = 1; cols < fine; cols++) {
    let ok = true;
    for (let k = 0; k < probes.length && ok; k++) {
      const f = (k / (probes.length - 1)) * cols;
      const c = Math.min(Math.floor(f), cols - 1);
      const ka = Math.round((c / cols) * (probes.length - 1));
      const kb = Math.round(((c + 1) / cols) * (probes.length - 1));
      const ya = interp(probes, hs, o0 + ((o1 - o0) * c) / cols, ka);
      const yb = interp(probes, hs, o0 + ((o1 - o0) * (c + 1)) / cols, kb);
      if (Math.abs(ya + (yb - ya) * (f - c) - hs[k]) > lat) ok = false;
    }
    if (ok) return cols;
  }
  return fine;
}

/** Height of a row (heights `ys` at offsets `cols`) at offset o, by linear interpolation. */
function rowAt(cols: number[], ys: number[], o: number): number {
  let c = 0;
  while (c < cols.length - 2 && cols[c + 1] < o) c++;
  const t = Math.min(1, Math.max(0, (o - cols[c]) / (cols[c + 1] - cols[c] || 1)));
  return ys[c] + (ys[c + 1] - ys[c]) * t;
}

/** Per-station tolerances for a strip: dip below and rise above the ground (by offset), and lateral. */
type StripBand = { down: (i: number, o: number) => number; up: (i: number) => number; lat: (i: number) => number };
type Piece = { cols: number[]; sections: Section[] };

/**
 * Drapes a strip between offsets o0..o1: one column count for a whole way
 * is set by its bumpiest cross-section, so the way is cut into pieces, each
 * with the columns its own stretch needs (the most any station within
 * PIECE_REACH needs, so pieces don't flicker). Each piece is simplified on
 * its own; where two meet, the finer one's row is put on the coarser one's
 * lines, so there's no crack.
 */
function drapeStrip(st: Station[], o0: number, o1: number, h: HeightFn, band: StripBand): Piece[] {
  const need = st.map((s, i) => columnsNeeded(s, o0, o1, h, band.lat(i)));
  const most = st.map((s, i) => {
    let v = need[i];
    for (let j = i - 1; j >= 0 && s.s - st[j].s <= PIECE_REACH; j--) v = Math.max(v, need[j]);
    for (let j = i + 1; j < st.length && st[j].s - s.s <= PIECE_REACH; j++) v = Math.max(v, need[j]);
    return v;
  });
  const pieces: Piece[] = [];
  for (let i0 = 0; i0 < st.length - 1;) {
    let i1 = i0 + 1;
    while (i1 < st.length - 1 && most[i1] === most[i0]) i1++;
    const n = Math.max(most[i0], most[i1]);
    const cols = Array.from({ length: n + 1 }, (_, k) => o0 + ((o1 - o0) * k) / n);
    const sub = st.slice(i0, i1 + 1);
    const from = i0;
    const sections = simplify(sub, cols, h, { down: (b, c) => band.down(from + b, cols[c]), up: (b) => band.up(from + b) });
    pieces.push({ cols, sections });
    i0 = i1;
  }
  // One piece with the most columns anywhere can come out cheaper than several.
  if (pieces.length > 1) {
    const cost = (ps: Piece[]) => ps.reduce((t, p) => t + (p.sections.length - 1) * (p.cols.length - 1), 0);
    const n = Math.max(...most);
    const cols = Array.from({ length: n + 1 }, (_, k) => o0 + ((o1 - o0) * k) / n);
    const whole = [{ cols, sections: simplify(st, cols, h, { down: (b, c) => band.down(b, cols[c]), up: (b) => band.up(b) }) }];
    if (cost(whole) <= cost(pieces)) return whole;
  }
  for (let q = 1; q < pieces.length; q++) {
    const a = pieces[q - 1];
    const b = pieces[q];
    const ra = a.sections[a.sections.length - 1];
    const rb = b.sections[0];
    if (a.cols.length <= b.cols.length) rb.ys = b.cols.map((o) => rowAt(a.cols, ra.ys, o));
    else ra.ys = a.cols.map((o) => rowAt(b.cols, rb.ys, o));
  }
  return pieces;
}

/** Kerb rows may sag this far (m) below the footpath-following line: still well above the footpath. */
const KERB_SAG = 0.015;

/** Drops kerb rows the line between their neighbours already follows (kerbs sit 7 cm proud, so a cm or two is fine). */
function thinKerb(rows: Section[], cols: number[]): Section[] {
  const stations = rows.map((r) => r.st);
  const fits = (a: number, b: number) => {
    if (rows[b].st.s - rows[a].st.s > MAX_SPAN || !planOk(stations, cols, a, b)) return false;
    for (let k = a + 1; k < b; k++) {
      const f = (rows[k].st.s - rows[a].st.s) / (rows[b].st.s - rows[a].st.s || 1);
      if (!rows[k].ys.every((y, c) => Math.abs(rows[a].ys[c] + (rows[b].ys[c] - rows[a].ys[c]) * f - y) <= KERB_SAG)) return false;
    }
    return true;
  };
  const out = rows.slice(0, 1);
  let a = 0;
  for (let b = 2; b < rows.length; b++) {
    if (fits(a, b)) continue;
    out.push(rows[b - 1]);
    a = b - 1;
  }
  if (rows.length > 1) out.push(rows[rows.length - 1]);
  return out;
}

// ---------------------------------------------------------------- meshing

/** One MeshBuilder per chunk; geometry goes to the chunk containing its middle. */
class ChunkMeshes {
  readonly chunks = new Map<string, MeshBuilder>();
  private readonly grid: Grid;
  constructor(grid: Grid) {
    this.grid = grid;
  }

  at(x: number, z: number): MeshBuilder | null {
    const i = Math.floor((x - this.grid.x0) / CHUNK_SIZE);
    const j = Math.floor((z - this.grid.z0) / CHUNK_SIZE);
    if (i < 0 || j < 0 || i >= this.grid.nx || j >= this.grid.nz) return null;
    const key = `${i},${j}`;
    let mb = this.chunks.get(key);
    if (!mb) this.chunks.set(key, (mb = new MeshBuilder()));
    return mb;
  }
}

/** Appends triangle (a, b, c) wound to face up (or `down`) to a list. */
function tri(mb: MeshBuilder, list: number[], a: number, b: number, c: number, down = false) {
  const p = mb.pos;
  const cy = (p[b * 3 + 2] - p[a * 3 + 2]) * (p[c * 3] - p[a * 3]) - (p[b * 3] - p[a * 3]) * (p[c * 3 + 2] - p[a * 3 + 2]);
  if (cy > 0 !== down) list.push(a, b, c);
  else list.push(a, c, b);
}

/** `left` / `right`: hang a deck edge off that long edge (left is the cols[last] side). */
type StripOpts = {
  level: Level;
  collider: boolean;
  left?: boolean;
  right?: boolean;
  covered?: (x: number, z: number) => boolean;
  /** Lane lines: the marking code and lane count over the strip's full width (cols[0]..cols[last] = right..left edge). */
  marking?: { code: number; lanes: number; half: number };
};

/**
 * Emits the strip between lateral offsets cols[0]..cols[last] (left of the
 * centreline is positive) over the kept stations. With `collider`, the same
 * surface without its lift goes into the chunk's collider; with `left` or
 * `right`, a vertical deck edge hangs off that long edge.
 */
/** Road triangles by kind, for the build log. */
export const roadTris: Record<string, number> = {};
let counted = 0;
/** Runs `emit` and books the triangles it adds (across all chunks) to `kind`. */
function tally(kind: string, out: ChunkMeshes, emit: () => void) {
  emit();
  let total = 0;
  for (const mb of out.chunks.values()) total += mb.idx.length / 3;
  roadTris[kind] = (roadTris[kind] ?? 0) + total - counted;
  counted = total;
}

function emitStrip(out: ChunkMeshes, sections: Section[], cols: number[], opts: StripOpts) {
  const { level } = opts;
  let prev: MeshBuilder | null = null;
  let prevRow: number[] = [];
  let prevColl: number[] = [];
  for (let q = 0; q + 1 < sections.length; q++) {
    const a = sections[q];
    const b = sections[q + 1];
    const mb = out.at((a.st.x + b.st.x) / 2, (a.st.z + b.st.z) / 2);
    if (!mb) {
      prev = null;
      continue;
    }
    const mk = opts.marking;
    const tile = mk ? tileOf('asphalt', mk.code) : level.tile;
    const row = (sec: Section, lift: number, layer: number) =>
      cols.map((o, c) => {
        const p = offsetPoint(sec.st, o);
        // Lane units across from the right-hand edge, dash periods along.
        const u = mk ? ((o + mk.half) / (2 * mk.half)) * mk.lanes : 0;
        return mb.vertex(p.x, sec.ys[c] + lift, p.z, UP, level.colour, layer, tile, u, mk ? sec.st.s / DASH_PERIOD : 0);
      });
    const ra = mb === prev ? prevRow : row(a, level.lift, level.layer);
    const rb = row(b, level.lift, level.layer);
    for (let c = 0; c + 1 < cols.length; c++) {
      // Inside a building (a footpath mapped through a shopfront): never seen.
      if (opts.covered && [ra[c], ra[c + 1], rb[c], rb[c + 1]].every((v) => opts.covered!(mb.pos[v * 3], mb.pos[v * 3 + 2]))) {
        const m = [ra[c], ra[c + 1], rb[c], rb[c + 1]].reduce((t, v) => [t[0] + mb.pos[v * 3] / 4, t[1] + mb.pos[v * 3 + 2] / 4], [0, 0]);
        if (opts.covered(m[0], m[1])) continue;
      }
      tri(mb, mb.idx, ra[c], ra[c + 1], rb[c]);
      tri(mb, mb.idx, ra[c + 1], rb[c + 1], rb[c]);
    }
    if (opts.collider) {
      const ca = mb === prev ? prevColl : row(a, 0, 0);
      const cb = row(b, 0, 0);
      for (let c = 0; c + 1 < cols.length; c++) {
        tri(mb, mb.colliderIdx, ca[c], ca[c + 1], cb[c]);
        tri(mb, mb.colliderIdx, ca[c + 1], cb[c + 1], cb[c]);
      }
      prevColl = cb;
    }
    for (const [c, sign, on] of [[0, -1, opts.right], [cols.length - 1, 1, opts.left]] as const) {
      if (on) {
        const pa = mb.pos.slice(ra[c] * 3, ra[c] * 3 + 3);
        const pb = mb.pos.slice(rb[c] * 3, rb[c] * 3 + 3);
        const dx = pb[0] - pa[0];
        const dz = pb[2] - pa[2];
        const len = Math.hypot(dx, dz) || 1;
        // Outward: the left normal on the left edge, the right normal on the right edge.
        const n = [(sign * dz) / len, 0, (-sign * dx) / len];
        const v = [pa, pb].flatMap((p) => [mb.vertex(p[0], p[1], p[2], n, DECK_SIDE), mb.vertex(p[0], p[1] - DECK_DEPTH, p[2], n, DECK_SIDE)]);
        // (top a, bottom a, top b) faces right of travel; flip it for the left edge.
        if (sign < 0) mb.idx.push(v[0], v[1], v[2], v[2], v[1], v[3]);
        else mb.idx.push(v[0], v[2], v[1], v[2], v[3], v[1]);
      }
    }
    prev = mb;
    prevRow = rb;
  }
}

/** A round cap (or ring, with r0 > 0), draped by `h` and densified only where the ground isn't planar. */
function emitDisc(out: ChunkMeshes, cx: number, cz: number, r0: number, r: number, h: (x: number, z: number) => number, level: Level, collider: boolean) {
  const mb = out.at(cx, cz);
  if (!mb || r <= r0 + 0.05) return;
  const seg = Math.min(32, Math.max(6, Math.ceil((2 * Math.PI * r) / 8)));
  const dir = Array.from({ length: seg }, (_, k) => [Math.cos((2 * Math.PI * k) / seg), Math.sin((2 * Math.PI * k) / seg)]);
  // The fewest rings (at most SAMPLE apart) that keep radial samples within TOL.
  const fineRings = Math.max(1, Math.ceil((r - r0) / SAMPLE));
  const probes = fineRings * 2;
  const radial = dir.map(([dx, dz]) =>
    Array.from({ length: probes + 1 }, (_, k) => {
      const rr = r0 + ((r - r0) * k) / probes;
      return rr === 0 ? h(cx, cz) : h(cx + dx * rr, cz + dz * rr);
    }),
  );
  let rings = fineRings;
  for (let n = 1; n < fineRings; n++) {
    const ok = radial.every((hs) =>
      hs.every((y, k) => {
        const f = (k / probes) * n;
        const q = Math.min(Math.floor(f), n - 1);
        const ya = hs[Math.round((q / n) * probes)];
        const yb = hs[Math.round(((q + 1) / n) * probes)];
        return within(ya + (yb - ya) * (f - q), y);
      }),
    );
    if (ok) {
      rings = n;
      break;
    }
  }
  for (const [lift, layer, list] of collider ? [[level.lift, level.layer, mb.idx], [0, 0, mb.colliderIdx]] as const : [[level.lift, level.layer, mb.idx]] as const) {
    const ringIdx: number[][] = [];
    let centre = -1;
    if (r0 === 0) centre = mb.vertex(cx, h(cx, cz) + lift, cz, UP, level.colour, layer, level.tile);
    for (let q = r0 === 0 ? 1 : 0; q <= rings; q++) {
      const rr = r0 + ((r - r0) * q) / rings;
      ringIdx.push(dir.map(([dx, dz]) => mb.vertex(cx + dx * rr, h(cx + dx * rr, cz + dz * rr) + lift, cz + dz * rr, UP, level.colour, layer, level.tile)));
    }
    if (centre >= 0) for (let k = 0; k < seg; k++) tri(mb, list as number[], centre, ringIdx[0][k], ringIdx[0][(k + 1) % seg]);
    for (let q = 0; q + 1 < ringIdx.length; q++) {
      const A = ringIdx[q];
      const B = ringIdx[q + 1];
      for (let k = 0; k < seg; k++) {
        const k1 = (k + 1) % seg;
        tri(mb, list as number[], A[k], A[k1], B[k]);
        tri(mb, list as number[], A[k1], B[k1], B[k]);
      }
    }
  }
}

// ---------------------------------------------------------------- bridges

/** Furthest a deck is carried past its OSM end over the DEM's bridge cut-out, m. */
const EXTEND_MAX = 30;
/** Ground rising more than this over 2 m (25 %) is the cut-out's edge, not a street. */
const HOLE_RISE = 0.5;
/** How far past the last such rise the deck reaches, clear of the 2 m lattice's slope. */
const EXTEND_MARGIN = 3;

/**
 * Carries bridge decks past their OSM ends over the edge of the DEM's bridge
 * cut-out. LINZ removes bridges from the DEM over an area a few metres
 * larger than the deck OSM maps, so the at-grade roads meeting a bridge dip
 * into the hole, and the deck, anchored to the ground at its end node,
 * starts metres low and climbs a wall to clear the road below (Upper Queen
 * St over the motorway: 2.6 m low, then +5 m in 7 m). From each bridge
 * node, every at-grade way leaving it is walked outward; the last steep rise
 * in its ground within EXTEND_MAX (plus a margin) becomes deck, splitting
 * the way at a new node there, so the deck is anchored on solid ground.
 * A way that is all hole carries the walk on to the ways at its far end.
 */
export function extendDecks(roads: Road[], terrain: TerrainSampler): Road[] {
  const byNode = new Map<number, { road: Road; k: number }[]>();
  for (const r of roads) r.nodes.forEach((n, k) => {
    if (!byNode.has(n)) byNode.set(n, []);
    byNode.get(n)!.push({ road: r, k });
  });
  const pointAt = (r: Road, s: number): Local => {
    let k = 0;
    while (k < r.s.length - 2 && r.s[k + 1] < s) k++;
    const f = Math.min(1, Math.max(0, (s - r.s[k]) / (r.s[k + 1] - r.s[k] || 1)));
    return { x: r.pts[k].x + (r.pts[k + 1].x - r.pts[k].x) * f, z: r.pts[k].z + (r.pts[k + 1].z - r.pts[k].z) * f };
  };
  // Arc-length intervals of at-grade ways that become deck, with the layer of the bridge they extend.
  const spans = new Map<Road, { a: number; b: number; layer: number }[]>();
  type Front = { n: number; budget: number; minCut: number; layer: number };
  const queue: Front[] = [];
  for (const r of roads) if (r.bridge) for (const n of r.nodes) queue.push({ n, budget: EXTEND_MAX, minCut: 0, layer: r.layer });
  const walked = new Set<string>();
  while (queue.length) {
    const { n, budget, minCut, layer } = queue.shift()!;
    for (const { road: r, k } of byNode.get(n)!) {
      if (r.bridge) continue;
      for (const dir of [1, -1]) {
        if ((dir > 0 && k === r.nodes.length - 1) || (dir < 0 && k === 0)) continue;
        const key = `${r.id}:${k}:${dir}`;
        if (walked.has(key)) continue;
        walked.add(key);
        const s0 = r.s[k];
        const toEnd = dir > 0 ? r.s[r.s.length - 1] - s0 : s0;
        const reach = Math.min(budget, toEnd);
        const g: number[] = [];
        for (let t = 0; t <= Math.ceil(reach); t++) {
          const p = pointAt(r, s0 + dir * Math.min(t, reach));
          g.push(terrain.heightAt(p.x, p.z));
        }
        let rise = -1;
        for (let t = 2; t < g.length; t++) if (g[t] - g[t - 2] > HOLE_RISE) rise = t;
        const cut = Math.max(minCut, rise >= 0 ? rise + EXTEND_MARGIN : 0);
        if (cut <= 0) continue;
        const all = cut >= toEnd - 1;
        const len = all ? toEnd : cut;
        const a = dir > 0 ? s0 : s0 - len;
        if (!spans.has(r)) spans.set(r, []);
        spans.get(r)!.push({ a, b: a + len, layer });
        if (all && budget > toEnd) queue.push({ n: r.nodes[dir > 0 ? r.nodes.length - 1 : 0], budget: budget - toEnd, minCut: cut - toEnd, layer });
      }
    }
  }

  // Split each extended way at its spans' ends (new nodes, ids below zero) into deck and at-grade pieces.
  let nextId = -1;
  const out: Road[] = [];
  for (const r of roads) {
    const sp = spans.get(r);
    if (!sp) {
      out.push(r);
      continue;
    }
    const length = r.s[r.s.length - 1];
    const cuts = [...new Set(sp.flatMap((x) => [x.a, x.b]))].filter((s) => s > 0.5 && s < length - 0.5).sort((p, q) => p - q);
    // Each cut lands on an existing node within half a metre, else a new one.
    const stops: { s: number; k: number }[] = [{ s: 0, k: 0 }];
    for (const s of cuts) {
      const k = r.s.findIndex((v) => Math.abs(v - s) <= 0.5);
      if (k >= 0) {
        if (k !== stops[stops.length - 1].k) stops.push({ s: r.s[k], k });
      } else if (s - stops[stops.length - 1].s > 0.5) stops.push({ s, k: -1 });
    }
    stops.push({ s: length, k: r.s.length - 1 });
    const extra = new Map<number, { n: number; p: Local }>();
    for (const st of stops) if (st.k < 0) extra.set(st.s, { n: nextId--, p: pointAt(r, st.s) });
    for (let q = 0; q + 1 < stops.length; q++) {
      const [lo, hi] = [stops[q], stops[q + 1]];
      if (hi.s - lo.s < 0.05) continue;
      const nodes: number[] = [];
      const pts: Local[] = [];
      if (lo.k < 0) {
        nodes.push(extra.get(lo.s)!.n);
        pts.push(extra.get(lo.s)!.p);
      }
      for (let k = 0; k < r.nodes.length; k++) {
        if (r.s[k] < lo.s - 1e-6 || r.s[k] > hi.s + 1e-6) continue;
        if ((lo.k < 0 && r.s[k] - lo.s < 0.05) || (hi.k < 0 && hi.s - r.s[k] < 0.05)) continue;
        nodes.push(r.nodes[k]);
        pts.push(r.pts[k]);
      }
      if (hi.k < 0) {
        nodes.push(extra.get(hi.s)!.n);
        pts.push(extra.get(hi.s)!.p);
      }
      if (pts.length < 2) continue;
      const s = [0];
      for (let k = 1; k < pts.length; k++) s.push(s[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
      const mid = (lo.s + hi.s) / 2;
      const over = sp.find((x) => mid > x.a && mid < x.b);
      out.push({ ...r, nodes, pts, s, bridge: !!over, layer: over ? Math.max(r.layer, over.layer) : r.layer });
    }
  }
  return out;
}

const median = (v: number[]) => {
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Deck height at every node of a bridge way. Nodes shared with an at-grade
 * road are anchored to the terrain there. A run of bridge ways with two or
 * more anchors is graded smoothly between them (linear along a chain: the
 * DSM is no use there, as trees beside a deck read 10-15 m above it, e.g.
 * Grafton Bridge). This flattens flyovers that rise and fall between two
 * at-grade ends (the Central Motorway Junction ramps); T10 can do better.
 * Runs with fewer anchors start from the DSM median around each node and
 * are pulled down so no stretch climbs faster than BRIDGE_GRADE. Never
 * below ground.
 */
export function bridgeHeights(
  roads: Road[], terrain: TerrainSampler, dsm: Raster, at: Map<number, Local>, fixed: Map<number, number> = new Map(),
): Map<number, number> {
  const atGrade = new Set<number>();
  for (const r of roads) if (!r.bridge) for (const n of r.nodes) atGrade.add(n);
  // Heights pinned by overrides act like at-grade anchors.
  for (const n of fixed.keys()) atGrade.add(n);
  const h = new Map<number, number>();
  const edges = new Map<number, { to: number; d: number }[]>();
  for (const r of roads) {
    if (!r.bridge) continue;
    for (let k = 0; k < r.nodes.length; k++) {
      const n = r.nodes[k];
      if (!h.has(n)) {
        const p = at.get(n)!;
        const ground = terrain.heightAt(p.x, p.z);
        if (fixed.has(n)) h.set(n, fixed.get(n)!);
        else if (atGrade.has(n)) h.set(n, ground);
        else {
          const samples: number[] = [];
          for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dz * dz <= 9) samples.push(sampleLocal(dsm, p.x + dx, p.z + dz));
          const deck = median(samples.filter((v) => !Number.isNaN(v)));
          h.set(n, Math.max(ground, Number.isFinite(deck) ? deck : ground));
        }
      }
      if (k > 0) {
        const d = r.s[k] - r.s[k - 1];
        const a = r.nodes[k - 1];
        if (!edges.has(a)) edges.set(a, []);
        if (!edges.has(n)) edges.set(n, []);
        edges.get(a)!.push({ to: n, d });
        edges.get(n)!.push({ to: a, d });
      }
    }
  }
  // Connected runs of bridge nodes and their anchors.
  const graded = new Set<number>();
  const seen = new Set<number>();
  for (const start of [...h.keys()].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const n = stack.pop()!;
      comp.push(n);
      for (const e of edges.get(n) ?? []) if (!seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
    comp.sort((a, b) => a - b);
    const anchors = comp.filter((n) => atGrade.has(n));
    if (anchors.length < 2) continue;
    // Harmonic interpolation (Gauss-Seidel, weights 1/length): linear along each chain.
    const mean = anchors.reduce((t, n) => t + h.get(n)!, 0) / anchors.length;
    const free = comp.filter((n) => !atGrade.has(n));
    for (const n of free) h.set(n, mean);
    for (let it = 0; it < 5000; it++) {
      let change = 0;
      for (const n of free) {
        let sw = 0;
        let sh = 0;
        for (const e of edges.get(n)!) {
          const w = 1 / Math.max(e.d, 0.1);
          sw += w;
          sh += w * h.get(e.to)!;
        }
        const v = sh / sw;
        change = Math.max(change, Math.abs(v - h.get(n)!));
        h.set(n, v);
      }
      if (change < 1e-4) break;
    }
    for (const n of comp) graded.add(n);
  }

  // Flyovers: a deck that crosses a road on a lower layer keeps CLEARANCE
  // over it, and the ramps either side climb to that at RAMP_GRADE (a
  // max-plus relaxation from the highest requirement down). Anchored nodes
  // stay put, so a crossing right next to one makes a steeper ramp.
  const need = crossingNeeds(roads, terrain, h);
  const queue2 = [...need.keys()].sort((a, b) => need.get(b)! - need.get(a)! || a - b);
  const settled = new Set<number>();
  while (queue2.length) {
    queue2.sort((a, b) => need.get(b)! - need.get(a)! || a - b);
    const n = queue2.shift()!;
    if (settled.has(n)) continue;
    settled.add(n);
    for (const e of edges.get(n) ?? []) {
      const want = need.get(n)! - RAMP_GRADE * e.d;
      if (!settled.has(e.to) && !atGrade.has(e.to) && want > (need.get(e.to) ?? -Infinity)) {
        need.set(e.to, want);
        queue2.push(e.to);
      }
    }
  }
  for (const [n, v] of need) {
    if (atGrade.has(n) || !h.has(n)) continue;
    if (v > h.get(n)!) h.set(n, v);
    graded.add(n);
  }

  // Min-plus relaxation (a Dijkstra from the lowest nodes up): h(n) <= h(m) + grade * d(n, m).
  const order = [...h.keys()].sort((a, b) => h.get(a)! - h.get(b)! || a - b);
  const done = new Set<number>();
  const queue = order.slice();
  while (queue.length) {
    queue.sort((a, b) => h.get(a)! - h.get(b)! || a - b);
    const n = queue.shift()!;
    if (done.has(n)) continue;
    done.add(n);
    for (const e of edges.get(n) ?? []) {
      const lim = h.get(n)! + BRIDGE_GRADE * e.d;
      if (!done.has(e.to) && !graded.has(e.to) && h.get(e.to)! > lim) h.set(e.to, lim);
    }
  }
  for (const [n, v] of h) {
    const p = at.get(n)!;
    h.set(n, Math.max(v, terrain.heightAt(p.x, p.z)));
  }
  return h;
}

/**
 * For each bridge node next to a crossing over a road on a lower layer: the
 * deck height that clears it, less a RAMP_GRADE climb from the node to the
 * crossing (a 70 m span shouldn't lift its far end the full clearance). The
 * lower road's height is the terrain there, or its own deck (as first
 * estimated) if it's a bridge too.
 */
function crossingNeeds(roads: Road[], terrain: TerrainSampler, h: Map<number, number>): Map<number, number> {
  const need = new Map<number, number>();
  type Seg = { r: Road; k: number; minX: number; maxX: number; minZ: number; maxZ: number };
  const segs: Seg[] = [];
  for (const r of roads) {
    for (let k = 0; k + 1 < r.pts.length; k++) {
      const a = r.pts[k];
      const b = r.pts[k + 1];
      segs.push({ r, k, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) });
    }
  }
  const heightOn = (r: Road, k: number, f: number, x: number, z: number) => {
    if (!r.bridge) return terrain.heightAt(x, z);
    const ha = h.get(r.nodes[k]) ?? terrain.heightAt(x, z);
    const hb = h.get(r.nodes[k + 1]) ?? terrain.heightAt(x, z);
    return ha + (hb - ha) * f;
  };
  for (const top of segs) {
    if (!top.r.bridge) continue;
    const a = top.r.pts[top.k];
    const b = top.r.pts[top.k + 1];
    for (const low of segs) {
      if (low.r === top.r || low.r.layer >= top.r.layer) continue;
      if (low.maxX < top.minX || low.minX > top.maxX || low.maxZ < top.minZ || low.minZ > top.maxZ) continue;
      const c = low.r.pts[low.k];
      const d = low.r.pts[low.k + 1];
      if (low.r.nodes[low.k] === top.r.nodes[top.k] || low.r.nodes[low.k + 1] === top.r.nodes[top.k + 1] ||
        low.r.nodes[low.k] === top.r.nodes[top.k + 1] || low.r.nodes[low.k + 1] === top.r.nodes[top.k]) continue;
      // Proper intersection of a-b with c-d.
      const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
      if (Math.abs(den) < 1e-9) continue;
      const t = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den;
      const u = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den;
      if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const req = heightOn(low.r, low.k, u, x, z) + CLEARANCE;
      // Each end of a long span needs only what a ramp from there reaches at the crossing.
      const len = top.r.s[top.k + 1] - top.r.s[top.k];
      for (const [n, d] of [[top.r.nodes[top.k], t * len], [top.r.nodes[top.k + 1], (1 - t) * len]]) {
        need.set(n, Math.max(need.get(n) ?? -Infinity, req - RAMP_GRADE * d));
      }
    }
  }
  return need;
}

// ---------------------------------------------------------------- junctions

/** Unit direction from point k of a road towards point kk. */
function towards(r: Road, k: number, kk: number) {
  const dx = r.pts[kk].x - r.pts[k].x;
  const dz = r.pts[kk].z - r.pts[k].z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}

/**
 * Whether another way meeting road r at its point k needs a cap there: it
 * leaves at an angle (a side road, or a bend of more than ~10 degrees where
 * one way continues another). A straight continuation needs none.
 */
function joinsAtAngle(r: Road, k: number, o: Road, ok: number): boolean {
  const mine = [k - 1, k + 1].filter((q) => q >= 0 && q < r.pts.length).map((q) => towards(r, k, q));
  const theirs = [ok - 1, ok + 1].filter((q) => q >= 0 && q < o.pts.length).map((q) => towards(o, ok, q));
  // Within ~10 degrees of straight on (or straight back) from one of my directions is a continuation.
  return theirs.some((d) => !mine.some((m) => Math.abs(m.x * d.x + m.z * d.z) > 0.985));
}

/** Arc-length intervals [from, to] on one side of a road where its kerb is cut for a joining carriageway. */
type Cuts = { left: [number, number][]; right: [number, number][] };

function kerbCuts(r: Road, k: number, others: { road: Road; k: number }[]): Cuts {
  const cuts: Cuts = { left: [], right: [] };
  const { pts } = r;
  const a = pts[Math.max(0, k - 1)];
  const b = pts[Math.min(pts.length - 1, k + 1)];
  const tl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const t = { x: (b.x - a.x) / tl, z: (b.z - a.z) / tl };
  const nl = { x: t.z, z: -t.x };
  for (const o of others) {
    if (o.road.surface !== 'road') continue;
    const op = o.road.pts;
    for (const kk of [o.k - 1, o.k + 1]) {
      if (kk < 0 || kk >= op.length) continue;
      const dx = op[kk].x - op[o.k].x;
      const dz = op[kk].z - op[o.k].z;
      const dl = Math.hypot(dx, dz) || 1;
      const d = { x: dx / dl, z: dz / dl };
      const cos = d.x * t.x + d.z * t.z;
      const sin = Math.abs(d.x * nl.z - d.z * nl.x);
      if (sin < 0.2) continue; // a continuation, not a side road
      const s = Math.max(sin, 0.25);
      const centre = r.s[k] + ((r.width / 2) * cos) / s;
      const half = o.road.width / 2 / s + 1;
      (d.x * nl.x + d.z * nl.z > 0 ? cuts.left : cuts.right).push([centre - half, centre + half]);
    }
  }
  return cuts;
}

/** Splits kept sections into runs that avoid the cut intervals (cut ends become new sections). */
function uncutRuns(sections: Section[], cuts: [number, number][]): Section[][] {
  const runs: Section[][] = [];
  let cur: Section[] = [];
  const cutAt = (s: number) => cuts.some(([a, b]) => s > a && s < b);
  const lerp = (p: Section, q: Section, s: number): Section => {
    const f = (s - p.st.s) / (q.st.s - p.st.s);
    const st = { s, x: p.st.x + (q.st.x - p.st.x) * f, z: p.st.z + (q.st.z - p.st.z) * f, nx: q.st.nx, nz: q.st.nz, m: 1, hard: false };
    return { st, ys: p.ys.map((y, c) => y + (q.ys[c] - y) * f) };
  };
  for (let q = 0; q < sections.length; q++) {
    const p = sections[q];
    if (q > 0) {
      const prev = sections[q - 1];
      // Interval ends inside this span split it.
      const ends = cuts.flat().filter((s) => s > prev.st.s && s < p.st.s).sort((a, b) => a - b);
      for (const s of ends) {
        const mid = lerp(prev, p, s);
        if (!cutAt(s - 1e-3)) cur.push(mid);
        if (cur.length > 1) runs.push(cur);
        cur = [];
        if (!cutAt(s + 1e-3)) cur.push(mid);
      }
    }
    if (!cutAt(p.st.s)) cur.push(p);
    else {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

// ---------------------------------------------------------------- build

export type RoadsResult = {
  chunks: Map<string, MeshBuilder>;
  counts: { ways: number; bridges: number; km: Record<string, number> };
};

/** Roads collected and bridge decks solved, before meshing: buildings need the decks too. */
export type RoadNetwork = {
  roads: Road[];
  at: Map<number, Local>;
  byNode: Map<number, { road: Road; k: number }[]>;
  deck: Map<number, number>;
  /** Deck height under a point on a bridge (its carriageway, footpaths and a margin), else null. */
  deckAt: (x: number, z: number) => number | null;
  /** Pedestrian crossings on carriageways: node id -> 'zebra' or 'signals'. */
  crossings: Map<number, 'zebra' | 'signals'>;
};

export function roadNetwork(data: { osm: OsmData; dsm: Raster }, terrain: TerrainSampler, overrides?: Overrides): RoadNetwork {
  const roads = extendDecks(collectRoads(data.osm), terrain);
  const at = new Map<number, Local>();
  const byNode = new Map<number, { road: Road; k: number }[]>();
  for (const r of roads) {
    r.nodes.forEach((n, k) => {
      at.set(n, r.pts[k]);
      if (!byNode.has(n)) byNode.set(n, []);
      byNode.get(n)!.push({ road: r, k });
    });
  }
  // Deck heights pinned per node by overrides ({ "deck": [h0, h1, ...] } on a bridge way).
  const fixed = new Map<number, number>();
  for (const r of roads) {
    const d = overrides?.get(`w${r.id}`)?.deck;
    if (!Array.isArray(d)) continue;
    const way = data.osm.ways.get(r.id)!;
    if (d.length !== way.nodes.length) {
      console.warn(`overrides: way/${r.id} deck has ${d.length} heights for ${way.nodes.length} nodes; ignored`);
      continue;
    }
    way.nodes.forEach((n, k) => {
      if (typeof d[k] === 'number') fixed.set(n, d[k]);
    });
  }
  const deck = bridgeHeights(roads, terrain, data.dsm, at, fixed);
  const crossings = new Map<number, 'zebra' | 'signals'>();
  for (const [n] of byNode) {
    const t = data.osm.nodes.get(n)?.tags;
    if (t?.highway !== 'crossing' && t?.railway !== 'crossing') continue;
    const kind = t.crossing ?? t['crossing:markings'] ?? '';
    if (['zebra', 'marked', 'uncontrolled'].includes(kind) || t['crossing_ref'] === 'zebra') crossings.set(n, 'zebra');
    else if (kind === 'traffic_signals') crossings.set(n, 'signals');
  }
  const bridges = roads.filter((r) => r.bridge);
  const deckAt = (x: number, z: number): number | null => {
    // The highest deck in reach: where decks cross, things on them sit on the top one.
    let best: number | null = null;
    for (const r of bridges) {
      // Footpaths mapped as separate ways run alongside: allow for them too.
      const reach = r.width / 2 + FOOTPATH_WIDTH + 2;
      for (let k = 0; k + 1 < r.pts.length; k++) {
        const a = r.pts[k];
        const b = r.pts[k + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len2 = dx * dx + dz * dz || 1;
        const f = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2));
        const d = Math.hypot(x - a.x - f * dx, z - a.z - f * dz);
        if (d > reach) continue;
        const y = deck.get(r.nodes[k])! + (deck.get(r.nodes[k + 1])! - deck.get(r.nodes[k])!) * f;
        if (best === null || y > best) best = y;
      }
    }
    return best;
  };
  return { roads, at, byNode, deck, deckAt, crossings };
}

export function buildRoads(
  grid: Grid, terrain: TerrainSampler, ground: GroundRaster, net: RoadNetwork, covered?: (x: number, z: number) => boolean, paths: PathLine[] = [],
): RoadsResult {
  const { roads, at, byNode, deck } = net;
  const out = new ChunkMeshes(grid);
  const drape = (x: number, z: number) => terrain.heightAt(x, z);
  const km: Record<string, number> = {};

  // Ground classes first (bridges leave the ground under them alone).
  for (const r of roads) {
    if (r.bridge) continue;
    const fp = r.left || r.right;
    for (let k = 0; k + 1 < r.pts.length; k++) {
      if (fp) ground.fillCapsule(r.pts[k], r.pts[k + 1], r.width / 2 + FOOTPATH_WIDTH, 'footpath');
      ground.fillCapsule(r.pts[k], r.pts[k + 1], r.width / 2, r.surface === 'road' ? 'road' : 'paving');
    }
  }

  // Junction caps: one set of discs per node where ways meet at an angle (a
  // side road, or a bend where one way continues another), sized for the
  // widest way there. The footpath disc fills the corners between footpaths.
  const caps = new Map<number, { half: number; fr: number }>();
  for (const [n, entries] of byNode) {
    if (entries.length < 2) continue;
    const angled = entries.some((e, q) => entries.some((f, w) => w !== q && f.road !== e.road && joinsAtAngle(e.road, e.k, f.road, f.k)));
    if (!angled) continue;
    const roadsHere = entries.filter((e) => e.road.surface === 'road');
    const main = roadsHere.length ? roadsHere : entries;
    const half = Math.max(...main.map((e) => e.road.width / 2));
    const fr = Math.max(0, ...entries.filter((e) => e.road.left || e.road.right).map((e) => e.road.width / 2 + FOOTPATH_WIDTH));
    caps.set(n, { half, fr });
  }

  // Deep inside paved ground, where the game sinks the terrain mesh (PAVED_SINK).
  const paved = (r: number, c: number) => ground.lattice(c, r);
  const sunkCache = new Map<number, boolean>();
  const sunkAt = (c: number, r: number) => {
    const key = (c + 0x8000) * 0x10000 + (r + 0x8000);
    let v = sunkCache.get(key);
    if (v === undefined) sunkCache.set(key, (v = underPaving(paved, r, c)));
    return v;
  };
  const sunk = (x: number, z: number) => {
    const c = Math.floor(x / CELL_SIZE);
    const r = Math.floor(z / CELL_SIZE);
    return sunkAt(c, r) && sunkAt(c + 1, r) && sunkAt(c, r + 1) && sunkAt(c + 1, r + 1);
  };

  for (const r of roads) {
    km[r.highway] = (km[r.highway] ?? 0) + r.s[r.s.length - 1] / 1000;
    const st = stations(r);
    // Tight round junction caps and at the ends (where another way carries
    // on), loose elsewhere; bridges are straight lines anyway.
    const length = r.s[r.s.length - 1];
    // A footpath only needs to stay under the junction's carriageway disc;
    // a carriageway must also stay over its footpath ring.
    const tightFor = (footpath: boolean) => st.map((x) => r.bridge || x.s < 0.01 || x.s > length - 0.01 || r.nodes.some((n, k) => {
      const cap = caps.get(n);
      return !!cap && Math.abs(x.s - r.s[k]) <= (footpath ? cap.half : Math.max(cap.half, cap.fr)) + JUNCTION_MARGIN;
    }));
    const tightRoad = tightFor(false);
    const tightFoot = tightFor(true);
    const band = (lv: Level): StripBand => {
      const tight = lv === LEVELS.footpath ? tightFoot : tightRoad;
      return {
      down: (i, o) => {
        // Thin surfaces (paving) can't dip as far without the ground showing through.
        if (tight[i]) return Math.min(TOL_DOWN, Math.max(0.002, lv.lift - LATERAL_TOL - 0.002));
        const p = offsetPoint(st[i], o);
        const room = lv.lift - CLEAR - LOOSE_LAT + (sunk(p.x, p.z) ? PAVED_SINK : 0);
        return Math.min(LOOSE_DOWN_MAX, Math.max(0.002, room));
      },
      up: (i) => (tight[i] ? TOL_UP : LOOSE_UP),
      lat: (i) => (tight[i] ? LATERAL_TOL : LOOSE_LAT),
      };
    };
    // Bridge decks: linear between node heights along the way, never below the ground at the centreline.
    const deckAt = (s: Station) => {
      let k = 0;
      while (k < r.s.length - 2 && r.s[k + 1] < s.s) k++;
      const f = Math.min(1, Math.max(0, (s.s - r.s[k]) / (r.s[k + 1] - r.s[k] || 1)));
      const y = deck.get(r.nodes[k])! + (deck.get(r.nodes[k + 1])! - deck.get(r.nodes[k])!) * f;
      return Math.max(y, terrain.heightAt(s.x, s.z));
    };
    const h: HeightFn = r.bridge ? (s) => deckAt(s) : (s, o) => {
      const p = offsetPoint(s, o);
      return terrain.heightAt(p.x, p.z);
    };
    const half = r.width / 2;
    const level = r.surface === 'road' ? LEVELS.road : LEVELS.paving;
    const fpL = r.left ? half + FOOTPATH_WIDTH : half;
    const fpR = r.right ? half + FOOTPATH_WIDTH : half;

    for (const piece of drapeStrip(st, -half, half, h, band(level))) {
      const marking = r.marking ? { code: r.marking, lanes: Math.min(r.lanes, 7), half } : undefined;
      tally('carriageway', out, () => emitStrip(out, piece.sections, piece.cols, { level, collider: r.bridge, left: r.bridge && !r.left, right: r.bridge && !r.right, covered: r.bridge ? undefined : covered, marking }));
    }
    // Kerbs on the footpath's inner edge, cut where carriageways join. They
    // follow the footpath's own simplified surface, so they're always on top of it.
    const cuts: Cuts = { left: [], right: [] };
    if (r.left || r.right) {
      r.nodes.forEach((n, k) => {
        const others = byNode.get(n)!.filter((o) => o.road !== r);
        const c = kerbCuts(r, k, others);
        cuts.left.push(...c.left);
        cuts.right.push(...c.right);
      });
    }
    for (const [o0, o1, on, isLeft, k0, k1, side] of [
      [half, fpL, r.left, true, half, half + KERB_WIDTH, cuts.left],
      [-fpR, -half, r.right, false, -half - KERB_WIDTH, -half, cuts.right],
    ] as const) {
      if (!on) continue;
      const kerb: Section[] = [];
      for (const [q, piece] of drapeStrip(st, o0, o1, h, band(LEVELS.footpath)).entries()) {
        tally('footpath', out, () => emitStrip(out, piece.sections, piece.cols, { level: LEVELS.footpath, collider: r.bridge, left: r.bridge && isLeft, right: r.bridge && !isLeft, covered: r.bridge ? undefined : covered }));
        // Lifted from the footpath's level to the kerb's by emitStrip.
        for (const sec of piece.sections.slice(q ? 1 : 0)) kerb.push({ st: sec.st, ys: [rowAt(piece.cols, sec.ys, k0), rowAt(piece.cols, sec.ys, k1)] });
      }
      const kcols = [k0, k1];
      for (const run of uncutRuns(thinKerb(kerb, kcols), side)) tally('kerb', out, () => emitStrip(out, run, kcols, { level: LEVELS.kerb, collider: false, covered: r.bridge ? undefined : covered }));
    }

  }

  for (const [n, { half, fr }] of caps) {
    const entries = byNode.get(n)!;
    const p = at.get(n)!;
    const flat = entries.every((e) => e.road.bridge);
    const dh = flat ? () => deck.get(n)! : drape;
    const roadsHere = entries.some((e) => e.road.surface === 'road');
    tally('junction', out, () => emitDisc(out, p.x, p.z, 0, half, dh, roadsHere ? LEVELS.road : LEVELS.paving, flat));
    if (fr > half) tally('junction', out, () => emitDisc(out, p.x, p.z, Math.max(0, half - 0.5), fr, dh, LEVELS.footpath, flat));
  }
  // Pedestrian crossings painted on the carriageway: zebra stripes, or the
  // two lines of a signalised crossing.
  let painted = 0;
  for (const [n, kind] of net.crossings) {
    const entry = byNode.get(n)?.find((e) => e.road.surface === 'road' && !e.road.bridge);
    if (!entry) continue;
    const { road: r, k } = entry;
    const a = r.pts[Math.max(0, k - 1)];
    const b = r.pts[Math.min(r.pts.length - 1, k + 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.5) continue;
    const p = at.get(n)!;
    const mb = out.at(p.x, p.z);
    if (!mb) continue;
    const [ux, uz] = [(b.x - a.x) / len, (b.z - a.z) / len];
    const half = r.width / 2;
    /** A flat white quad on the road: `along` is its extent along the way, `across` across it. */
    const quad = (a0: number, a1: number, c0: number, c1: number) => {
      const pt = (al: number, ac: number) => {
        const x = p.x + ux * al - uz * ac;
        const z = p.z + uz * al + ux * ac;
        return mb.vertex(x, drape(x, z) + MARK_LIFT, z, UP, MARK_COLOUR, MARK_LAYER, tileOf('concrete'));
      };
      tri(mb, mb.idx, pt(a0, c0), pt(a1, c0), pt(a1, c1));
      tri(mb, mb.idx, pt(a0, c0), pt(a1, c1), pt(a0, c1));
    };
    if (kind === 'zebra') {
      for (let c = -half + 0.3; c + 0.55 <= half - 0.2; c += 1.1) quad(-1.5, 1.5, c, c + 0.55);
    } else {
      quad(-1.6, -1.45, -half + 0.2, half - 0.2);
      quad(1.45, 1.6, -half + 0.2, half - 0.2);
    }
    painted++;
  }
  roadTris['crossings painted'] = painted;
  km['park path'] = emitPaths(out, paths, ground, terrain, covered);
  const bridges = roads.filter((r) => r.bridge).length;
  return { chunks: out.chunks, counts: { ways: roads.length, bridges, km } };
}
