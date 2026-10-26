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
// and then simplified, keeping one only where needed to stay within a thin
// band above the game's terrain triangles (see simplify); likewise across
// the width. The car drives on the terrain heightfield, so draped roads need
// no colliders and kerbs are visual only (flush stripes, not 15 cm steps:
// a raised footpath would have to be cut out of every junction).
//
// Bridges: the LiDAR DEM has bridges removed, so draping would drop them
// into the gully. Bridge ways follow a deck profile instead (bridgeHeights)
// and get a thin deck collider. Tunnels are skipped.
//
// Footpaths are not clamped against buildings: where OSM puts a footprint
// right against a centreline the footpath just runs inside the building,
// where it can't be seen.
import { MeshBuilder, parseLength, rgb } from './buildings.ts';
import type { GroundRaster } from './ground.ts';
import { DRIVEABLE_HIGHWAYS, type OsmData, type Tags } from './osm.ts';
import { lonLatToLocal, type Local } from './project.ts';
import { sampleLocal, type Raster } from './raster.ts';
import { CHUNK_SIZE, type Grid, type TerrainSampler } from './terrain.ts';

export const FOOTPATH_WIDTH = 3;
export const KERB_WIDTH = 0.3;
/** Spacing of candidate cross-sections along a way, m (the heightfield's cell). */
const SAMPLE = 2;
/** Longest stretch between kept cross-sections, m. */
const MAX_SPAN = 40;
/**
 * How far a simplified surface may float above the terrain (it must never
 * dip more than TOL_DOWN below, or the ground would poke through). The
 * surfaces' lifts are more than TOL_UP + TOL_DOWN apart, so their order holds.
 */
const TOL_UP = 0.03;
const TOL_DOWN = 0.004;
/** True if a surface interpolated to `y` over ground at `ground` stays within tolerance. */
const within = (y: number, ground: number) => y - ground <= TOL_UP && ground - y <= TOL_DOWN;
/** Across the width, columns are dropped only where the ground between them is this straight. */
const LATERAL_TOL = 0.01;
/** Where a kept cross-section aims to sit above the ground, leaving room both ways for the next span. */
const AIM = 0.01;
/** Steepest a bridge deck may climb away from where it meets the ground. */
const BRIDGE_GRADE = 0.1;
/** Visible thickness of a bridge deck's edge, m. */
const DECK_DEPTH = 1.2;

type RGB = [number, number, number];
type Level = { lift: number; layer: number; colour: RGB };
/** Lift above the terrain (m), draw layer and colour of each surface. */
const LEVELS = {
  paving: { lift: 0.014, layer: 1, colour: rgb(0xa69a88) },
  footpath: { lift: 0.05, layer: 2, colour: rgb(0xa3a19b) },
  road: { lift: 0.086, layer: 3, colour: rgb(0x35383d) },
  kerb: { lift: 0.122, layer: 4, colour: rgb(0xd2cfc6) },
} satisfies Record<string, Level>;
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
    roads.push({ id: way.id, highway, nodes, pts, s, surface, width: roadWidth(t), ...footpathSides(t), bridge });
  }
  return roads;
}

// ---------------------------------------------------------------- stations

/** A candidate cross-section: a point on the centreline with its (mitred) left normal. */
type Station = { s: number; x: number; z: number; nx: number; nz: number; m: number; hard: boolean };

/** Cross-sections at every vertex and at most SAMPLE apart in between. */
function stations(r: Road): Station[] {
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
      out.push({ s: s[k], x: pts[k].x, z: pts[k].z, nx: bx, nz: bz, m, hard: turn > 0.035 });
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
const offsetPoint = (st: Station, o: number) => ({ x: st.x + st.nx * st.m * o, z: st.z + st.nz * st.m * o });

/**
 * The fewest columns across [o0, o1] that keep every lateral sample (1 m
 * apart) within LATERAL_TOL of the ground at every station.
 */
function chooseColumns(st: Station[], o0: number, o1: number, h: HeightFn): number[] {
  const fine = Math.max(1, Math.ceil((o1 - o0) / SAMPLE));
  const probes = Array.from({ length: fine * 2 + 1 }, (_, k) => o0 + ((o1 - o0) * k) / (fine * 2));
  const heights = st.map((s) => probes.map((o) => h(s, o)));
  for (let cols = 1; cols < fine; cols++) {
    let ok = true;
    for (const hs of heights) {
      for (let k = 0; k < probes.length && ok; k++) {
        const f = (k / (probes.length - 1)) * cols;
        const c = Math.min(Math.floor(f), cols - 1);
        const ka = Math.round((c / cols) * (probes.length - 1));
        const kb = Math.round(((c + 1) / cols) * (probes.length - 1));
        // Column boundaries fall on probes only when they divide evenly; otherwise interpolate the ends.
        const ya = interp(probes, hs, o0 + ((o1 - o0) * c) / cols, ka);
        const yb = interp(probes, hs, o0 + ((o1 - o0) * (c + 1)) / cols, kb);
        const t = f - c;
        if (Math.abs(ya + (yb - ya) * t - hs[k]) > LATERAL_TOL) ok = false;
      }
      if (!ok) break;
    }
    if (ok) return Array.from({ length: cols + 1 }, (_, k) => o0 + ((o1 - o0) * k) / cols);
  }
  return Array.from({ length: fine + 1 }, (_, k) => o0 + ((o1 - o0) * k) / fine);
}

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
function simplify(st: Station[], cols: number[], h: HeightFn): Section[] {
  const hs = st.map((s) => cols.map((o) => h(s, o)));
  let a = 0;
  let ya = hs[0].map((y) => y + AIM);
  const out: Section[] = [{ st: st[0], ys: ya }];
  const end = (b: number, lo: number[], hi: number[]): number[] | null => {
    const len = st[b].s - st[a].s;
    const ys: number[] = [];
    for (let c = 0; c < cols.length; c++) {
      const sl = Math.max(lo[c], (hs[b][c] - TOL_DOWN - ya[c]) / len);
      const sh = Math.min(hi[c], (hs[b][c] + TOL_UP - ya[c]) / len);
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
    while (b + 1 < st.length && !st[b].hard && st[b + 1].s - st[a].s <= MAX_SPAN) {
      // Station b becomes an interior point of the span a..b+1.
      const d = st[b].s - st[a].s;
      const nlo = lo.map((v, c) => Math.max(v, (hs[b][c] - TOL_DOWN - ya[c]) / d));
      const nhi = hi.map((v, c) => Math.min(v, (hs[b][c] + TOL_UP - ya[c]) / d));
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
type StripOpts = { level: Level; collider: boolean; left?: boolean; right?: boolean };

/**
 * Emits the strip between lateral offsets cols[0]..cols[last] (left of the
 * centreline is positive) over the kept stations. With `collider`, the same
 * surface without its lift goes into the chunk's collider; with `left` or
 * `right`, a vertical deck edge hangs off that long edge.
 */
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
    const row = (sec: Section, lift: number, layer: number) =>
      cols.map((o, c) => {
        const p = offsetPoint(sec.st, o);
        return mb.vertex(p.x, sec.ys[c] + lift, p.z, UP, level.colour, layer);
      });
    const ra = mb === prev ? prevRow : row(a, level.lift, level.layer);
    const rb = row(b, level.lift, level.layer);
    for (let c = 0; c + 1 < cols.length; c++) {
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
  const seg = Math.min(32, Math.max(10, Math.ceil((2 * Math.PI * r) / 4)));
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
    if (r0 === 0) centre = mb.vertex(cx, h(cx, cz) + lift, cz, UP, level.colour, layer);
    for (let q = r0 === 0 ? 1 : 0; q <= rings; q++) {
      const rr = r0 + ((r - r0) * q) / rings;
      ringIdx.push(dir.map(([dx, dz]) => mb.vertex(cx + dx * rr, h(cx + dx * rr, cz + dz * rr) + lift, cz + dz * rr, UP, level.colour, layer)));
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
function bridgeHeights(roads: Road[], terrain: TerrainSampler, dsm: Raster, at: Map<number, Local>): Map<number, number> {
  const atGrade = new Set<number>();
  for (const r of roads) if (!r.bridge) for (const n of r.nodes) atGrade.add(n);
  const h = new Map<number, number>();
  const edges = new Map<number, { to: number; d: number }[]>();
  for (const r of roads) {
    if (!r.bridge) continue;
    for (let k = 0; k < r.nodes.length; k++) {
      const n = r.nodes[k];
      if (!h.has(n)) {
        const p = at.get(n)!;
        const ground = terrain.heightAt(p.x, p.z);
        if (atGrade.has(n)) h.set(n, ground);
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

export function buildRoads(data: { osm: OsmData; dsm: Raster }, grid: Grid, terrain: TerrainSampler, ground: GroundRaster): RoadsResult {
  const roads = collectRoads(data.osm);
  const out = new ChunkMeshes(grid);
  const at = new Map<number, Local>();
  const byNode = new Map<number, { road: Road; k: number }[]>();
  for (const r of roads) {
    r.nodes.forEach((n, k) => {
      at.set(n, r.pts[k]);
      if (!byNode.has(n)) byNode.set(n, []);
      byNode.get(n)!.push({ road: r, k });
    });
  }
  const deck = bridgeHeights(roads, terrain, data.dsm, at);
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

  for (const r of roads) {
    km[r.highway] = (km[r.highway] ?? 0) + r.s[r.s.length - 1] / 1000;
    const st = stations(r);
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

    const cols = chooseColumns(st, -half, half, h);
    emitStrip(out, simplify(st, cols, h), cols, { level, collider: r.bridge, left: r.bridge && !r.left, right: r.bridge && !r.right });
    for (const [o0, o1, on, isLeft] of [[half, fpL, r.left, true], [-fpR, -half, r.right, false]] as const) {
      if (!on) continue;
      const fcols = chooseColumns(st, o0, o1, h);
      emitStrip(out, simplify(st, fcols, h), fcols, { level: LEVELS.footpath, collider: r.bridge, left: r.bridge && isLeft, right: r.bridge && !isLeft });
    }

    // Kerbs on the footpath's inner edge, cut where carriageways join.
    if (r.left || r.right) {
      const cuts: Cuts = { left: [], right: [] };
      r.nodes.forEach((n, k) => {
        const others = byNode.get(n)!.filter((o) => o.road !== r);
        const c = kerbCuts(r, k, others);
        cuts.left.push(...c.left);
        cuts.right.push(...c.right);
      });
      for (const [o0, o1, on, side] of [[half, half + KERB_WIDTH, r.left, cuts.left], [-half - KERB_WIDTH, -half, r.right, cuts.right]] as const) {
        if (!on) continue;
        const kcols = [o0, o1];
        for (const run of uncutRuns(simplify(st, kcols, h), side)) {
          emitStrip(out, run, kcols, { level: LEVELS.kerb, collider: false });
        }
      }
    }

  }

  // Junction caps: one set of discs per node where ways meet at an angle (a
  // side road, or a bend where one way continues another), sized for the
  // widest way there. The footpath disc fills the corners between footpaths.
  for (const [n, entries] of byNode) {
    if (entries.length < 2) continue;
    const angled = entries.some((e, q) => entries.some((f, w) => w !== q && f.road !== e.road && joinsAtAngle(e.road, e.k, f.road, f.k)));
    if (!angled) continue;
    const p = at.get(n)!;
    const flat = entries.every((e) => e.road.bridge);
    const dh = flat ? () => deck.get(n)! : drape;
    const roadsHere = entries.filter((e) => e.road.surface === 'road');
    const main = roadsHere.length ? roadsHere : entries;
    const half = Math.max(...main.map((e) => e.road.width / 2));
    emitDisc(out, p.x, p.z, 0, half, dh, roadsHere.length ? LEVELS.road : LEVELS.paving, flat);
    const fr = Math.max(0, ...entries.filter((e) => e.road.left || e.road.right).map((e) => e.road.width / 2 + FOOTPATH_WIDTH));
    if (fr > half) emitDisc(out, p.x, p.z, Math.max(0, half - 0.5), fr, dh, LEVELS.footpath, flat);
  }
  const bridges = roads.filter((r) => r.bridge).length;
  return { chunks: out.chunks, counts: { ways: roads.length, bridges, km } };
}
