// OSM buildings -> extruded, vertex-coloured meshes merged per chunk.
//
// Footprints come from closed building ways and multipolygon relations
// (outer/inner rings, so courtyards are holes). Where a building is mapped
// with `building:part`s (towers on podiums, the Sky Tower's shaft and pod),
// the parts are drawn instead of the outline, each with its own height and
// min_height. Every building is seated at the lowest ground point under its
// footprint, so nothing floats on Auckland's slopes; walls simply run into
// the hill on the uphill side.
//
// Heights, in order: `height`, `building:levels` (+ `roof:levels`) x 3.2 m,
// the median of DSM - DEM inside the footprint, else 9 m. Some general
// corrections follow (see solidHeight): canopies are thin slabs at verandah
// height, LiDAR heights of tiny footprints are capped (the DSM there is
// usually a tree or the tower next door), and buildings on a bridge deck
// stand on the deck. Hand fixes go in overrides/<area>.json.
import earcut from 'earcut';
import type { BuildingMesh } from '../../src/city/format.ts';
import type { OsmData, OsmWay, Tags } from './osm.ts';
import { lonLatToLocal, type Local } from './project.ts';
import { sampleLocal, type Raster } from './raster.ts';
import { longKey, Overrides } from './overrides.ts';
import { CHUNK_SIZE, groundCm, type Grid } from './terrain.ts';
import { SUN_DIRECTION } from '../../src/sun.ts';
import { FACADE, ROOF_METRES, SHADE_ONE, tileOf, UV_SCALE, type Layer } from '../../src/city/facades.ts';
import type { Frontages } from './frontage.ts';
import { fitRoof, outsetRing, planeAt, planeRegions, roofAt, roofBreaks, roofFrame, roofPlanes, type Plane, type RoofFit, type RoofShape } from './roofs.ts';

export const LEVEL_HEIGHT = 3.2;
export const DEFAULT_HEIGHT = 9;
/** DSM-derived heights outside this range are treated as noise (trees, cranes, bad LiDAR). */
const DSM_MIN = 2.5;
const DSM_MAX = 250;
/** Walls start this far below the lowest ground point, hiding small terrain interpolation gaps. */
const BASE_SINK = 0.3;
/** Canopies (building=roof) without a min_height become slabs this thick. */
const CANOPY_THICKNESS = 0.8;
/**
 * Canopy height when nothing better is known: verandahs and forecourt roofs
 * sit a storey or so up. The DSM is no use under glass or beside towers.
 */
const CANOPY_DEFAULT = 5;
const CANOPY_DSM_MAX = 12;
/** LiDAR heights for footprints smaller than this (m²) are capped at SLENDER x sqrt(area). */
const SMALL_FOOTPRINT = 200;
const SLENDER = 1.2;
/** Things that really are tall and thin, so their LiDAR heights stand. */
const TALL_THIN = new Set(['silo', 'tower', 'chimney', 'transformer_tower', 'water_tower', 'bell_tower', 'church', 'cathedral']);
/** A tagged height below this on a footprint bigger than 50 m² is a typo or a level count; ignore it. */
const MIN_TAGGED = 2;
/** Bus shelters, when nothing is tagged. */
const SHELTER_HEIGHT = 3;
/** Street verandahs: height of the soffit above the footpath, slab and fascia, m. */
const VERANDAH_HEIGHT = 3.7;
const VERANDAH_THICK = 0.12;
const VERANDAH_FASCIA = 0.45;
/** Deepest a verandah reaches, and how far it stops short of the kerb, m. */
const VERANDAH_DEPTH = 3;
const VERANDAH_KERB = 0.4;
/** Segment length (it steps with the street) and the spacing of kerb posts, m. */
const VERANDAH_STEP = 10;
const VERANDAH_POSTS = 6;
/** Buildings (by their tallest part) at least this tall also go in the far skyline, m. */
const SKYLINE_MIN = 40;
/** Parapet faces only along roof edges at least this long, m. */
const PARAPET_MIN_EDGE = 4;
const FASCIAS = [0xe8e2d4, 0xf0eee8, 0x2f3a34, 0x1e1f22, 0x6b2a2a, 0xd8cdb0, 0x3a4a5e];
/** Height of the darker band at the foot of ground-level walls. */
const BASE_BAND = 4;

export type HeightSource = 'height' | 'levels' | 'dsm' | 'default';

type Ring = Local[];
type Polygon = { outer: Ring; holes: Ring[] };

/** A building outline or part, ready to extrude. */
export type Solid = {
  /** 'w123' or 'r123'. */
  key: string;
  osmId: number;
  tags: Tags;
  isPart: boolean;
  polygons: Polygon[];
  area: number;
  centroid: Local;
  /** Key of the outline this part belongs to (parts only). */
  parent?: string;
};

export type ExtrudedBuilding = {
  key: string;
  base: number;
  bottom: number;
  top: number;
  source: HeightSource;
};

// ---------------------------------------------------------------- geometry

function signedArea(r: Ring): number {
  let a = 0;
  for (let k = 0; k < r.length; k++) {
    const p = r[k];
    const q = r[(k + 1) % r.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

function ringCentroid(r: Ring): Local {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let k = 0; k < r.length; k++) {
    const p = r[k];
    const q = r[(k + 1) % r.length];
    const c = p.x * q.z - q.x * p.z;
    a += c;
    cx += (p.x + q.x) * c;
    cz += (p.z + q.z) * c;
  }
  if (Math.abs(a) < 1e-9) return { x: r.reduce((s, p) => s + p.x, 0) / r.length, z: r.reduce((s, p) => s + p.z, 0) / r.length };
  return { x: cx / (3 * a), z: cz / (3 * a) };
}

export function inRing(r: Ring, x: number, z: number): boolean {
  let inside = false;
  for (let k = 0, l = r.length - 1; k < r.length; l = k++) {
    const a = r[k];
    const b = r[l];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function inPolygon(p: Polygon, x: number, z: number): boolean {
  return inRing(p.outer, x, z) && !p.holes.some((h) => inRing(h, x, z));
}

function inSolid(s: Solid, x: number, z: number): boolean {
  return s.polygons.some((p) => inPolygon(p, x, z));
}

/** Footprints bucketed on a coarse grid, for point-in-building tests, each with a payload. */
class Footprints<T = Solid> {
  private readonly buckets = new Map<number, { s: Solid; v: T }[]>();
  private static readonly SIZE = 32;
  private key = (i: number, j: number) => (i + 0x8000) * 0x10000 + (j + 0x8000);

  add(s: Solid, v: T = s as unknown as T) {
    const pts = s.polygons.flatMap((p) => p.outer);
    const S = Footprints.SIZE;
    const i0 = Math.floor(Math.min(...pts.map((p) => p.x)) / S);
    const i1 = Math.floor(Math.max(...pts.map((p) => p.x)) / S);
    const j0 = Math.floor(Math.min(...pts.map((p) => p.z)) / S);
    const j1 = Math.floor(Math.max(...pts.map((p) => p.z)) / S);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        if (!this.buckets.has(k)) this.buckets.set(k, []);
        this.buckets.get(k)!.push({ s, v });
      }
    }
  }

  /** Payloads of footprints whose bucket holds (x, z) (not necessarily containing it). */
  at(x: number, z: number): T[] {
    return (this.buckets.get(this.key(Math.floor(x / Footprints.SIZE), Math.floor(z / Footprints.SIZE))) ?? []).map((e) => e.v);
  }

  covers(x: number, z: number): boolean {
    const list = this.buckets.get(this.key(Math.floor(x / Footprints.SIZE), Math.floor(z / Footprints.SIZE)));
    return !!list && list.some((e) => inSolid(e.s, x, z));
  }
}

/**
 * Drops the closing duplicate, repeated points and (nearly) collinear
 * vertices, which would otherwise each cost a wall quad. Returns the ring
 * wound so its signed area has the requested sign (outer > 0, holes < 0):
 * with that convention (dz, -dx) points away from the solid for every edge.
 */
function cleanRing(points: Ring, positive: boolean): Ring | null {
  let r = points.slice();
  if (r.length > 1 && r[0].x === r[r.length - 1].x && r[0].z === r[r.length - 1].z) r.pop();
  for (let changed = true; changed && r.length >= 3; ) {
    changed = false;
    for (let k = 0; k < r.length && r.length >= 3; k++) {
      const a = r[(k + r.length - 1) % r.length];
      const b = r[k];
      const c = r[(k + 1) % r.length];
      const ab = Math.hypot(b.x - a.x, b.z - a.z);
      const ac = Math.hypot(c.x - a.x, c.z - a.z);
      // Distance of b from the line a-c, or a near-duplicate point.
      const off = ac > 1e-6 ? Math.abs((c.x - a.x) * (a.z - b.z) - (a.x - b.x) * (c.z - a.z)) / ac : ab;
      if (ab < 0.05 || off < 0.04) {
        r.splice(k, 1);
        changed = true;
        k--;
      }
    }
  }
  if (r.length < 3) return null;
  const area = signedArea(r);
  if (Math.abs(area) < 1) return null;
  if (area > 0 !== positive) r = r.reverse();
  return r;
}

/** Joins member ways end to end into closed rings (node id lists). Unclosable pieces are dropped. */
export function assembleRings(ways: OsmWay[]): number[][] {
  const pieces = ways.map((w) => w.nodes.slice()).filter((n) => n.length >= 2);
  const rings: number[][] = [];
  while (pieces.length) {
    const ring = pieces.shift()!;
    while (ring[0] !== ring[ring.length - 1]) {
      const end = ring[ring.length - 1];
      const k = pieces.findIndex((p) => p[0] === end || p[p.length - 1] === end);
      if (k < 0) break;
      const next = pieces.splice(k, 1)[0];
      if (next[0] !== end) next.reverse();
      ring.push(...next.slice(1));
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

export function nodesLocal(data: OsmData, nodes: number[]): Ring | null {
  const out: Ring = [];
  for (const ref of nodes) {
    const n = data.nodes.get(ref);
    if (!n) return null; // partially fetched: skip rather than draw a wrong shape
    out.push(lonLatToLocal(n.lon, n.lat));
  }
  return out;
}

// ---------------------------------------------------------------- footprints

const isOutline = (t: Tags) => t.building !== undefined && t.building !== 'no';
const isPart = (t: Tags) => t['building:part'] !== undefined && t['building:part'] !== 'no';

function skipped(t: Tags): boolean {
  if (t.location === 'underground' || t.building === 'underground' || t['building:part'] === 'underground') return true;
  const layer = Number(t.layer);
  return Number.isFinite(layer) && layer < 0;
}

function makeSolid(key: string, osmId: number, tags: Tags, polygons: Polygon[]): Solid | null {
  if (!polygons.length) return null;
  let area = 0;
  let cx = 0;
  let cz = 0;
  for (const p of polygons) {
    const a = signedArea(p.outer) + p.holes.reduce((s, h) => s + signedArea(h), 0);
    const c = ringCentroid(p.outer);
    area += a;
    cx += c.x * a;
    cz += c.z * a;
  }
  if (area < 2) return null;
  return { key, osmId, tags, isPart: isPart(tags) && !isOutline(tags), polygons, area, centroid: { x: cx / area, z: cz / area } };
}

/**
 * Building outlines and parts from closed ways and multipolygon relations.
 * A way that is a member of a building multipolygon is used only through
 * that relation (old-style multipolygons put the tags on the outer way).
 */
export function collectSolids(data: OsmData): Solid[] {
  const solids: Solid[] = [];
  const viaRelation = new Set<number>();
  for (const rel of data.relations.values()) {
    const t = rel.tags;
    if (t.type !== 'multipolygon' || !(isOutline(t) || isPart(t)) || skipped(t)) continue;
    const outers: OsmWay[] = [];
    const inners: OsmWay[] = [];
    let missing = false;
    for (const m of rel.members) {
      if (m.type !== 'way') continue;
      const w = data.ways.get(m.ref);
      if (!w) {
        missing = true;
        continue;
      }
      viaRelation.add(w.id);
      (m.role === 'inner' ? inners : outers).push(w);
    }
    if (missing) continue;
    const outerRings = assembleRings(outers).map((n) => nodesLocal(data, n)).map((r) => r && cleanRing(r, true)).filter((r): r is Ring => !!r);
    const innerRings = assembleRings(inners).map((n) => nodesLocal(data, n)).map((r) => r && cleanRing(r, false)).filter((r): r is Ring => !!r);
    const polygons: Polygon[] = outerRings.map((outer) => ({ outer, holes: [] }));
    for (const hole of innerRings) {
      const p = polygons.find((poly) => inRing(poly.outer, hole[0].x, hole[0].z));
      if (p) p.holes.push(hole);
    }
    const s = makeSolid(`r${rel.id}`, rel.id, t, polygons);
    if (s) solids.push(s);
  }
  for (const way of data.ways.values()) {
    const t = way.tags;
    if (!(isOutline(t) || isPart(t)) || skipped(t) || viaRelation.has(way.id)) continue;
    if (way.nodes.length < 4 || way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;
    const ring = nodesLocal(data, way.nodes);
    const outer = ring && cleanRing(ring, true);
    if (!outer) continue;
    const s = makeSolid(`w${way.id}`, way.id, t, [{ outer, holes: [] }]);
    if (s) solids.push(s);
  }
  // type=building relations name their parts explicitly.
  const relParent = new Map<string, string>();
  for (const rel of data.relations.values()) {
    if (rel.tags.type !== 'building') continue;
    const outline = rel.members.find((m) => m.role === 'outline');
    if (!outline) continue;
    const okey = `${outline.type[0]}${outline.ref}`;
    for (const m of rel.members) if (m.role === 'part') relParent.set(`${m.type[0]}${m.ref}`, okey);
  }
  linkParts(solids, relParent);
  return solids;
}

/**
 * Attaches each part to the outline containing it and hides outlines whose
 * parts cover most of them (the OSM convention: an outline with parts is not
 * drawn). An outline with only a token part (a spire, a canopy) stays.
 */
function linkParts(solids: Solid[], relParent: Map<string, string>) {
  const outlines = solids.filter((s) => !s.isPart);
  const byKey = new Map(solids.map((s) => [s.key, s]));
  const bounds = new Map(outlines.map((s) => {
    const pts = s.polygons.flatMap((p) => p.outer);
    return [s.key, { minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minZ: Math.min(...pts.map((p) => p.z)), maxZ: Math.max(...pts.map((p) => p.z)) }];
  }));
  for (const part of solids) {
    if (!part.isPart) continue;
    const fromRel = relParent.get(part.key);
    if (fromRel && byKey.get(fromRel) && !byKey.get(fromRel)!.isPart) {
      part.parent = fromRel;
      continue;
    }
    const { x, z } = part.centroid;
    let best: Solid | undefined;
    for (const o of outlines) {
      const b = bounds.get(o.key)!;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      // The smallest containing outline wins (a part of a tower, not of the block around it).
      if (inSolid(o, x, z) && (!best || o.area < best.area)) best = o;
    }
    if (best) part.parent = best.key;
  }
}

/**
 * Outlines to draw plus parts to draw. Hidden outlines still provide the
 * base and colour for their parts. Parts that sit on top of their outline's
 * tagged height (a crown with min_height at the roof) don't count towards
 * covering it: a tower mapped as an outline plus just its crown would
 * otherwise lose its shaft and leave the crown floating.
 */
export function visibleSolids(solids: Solid[]): { visible: Solid[]; hidden: Set<string> } {
  const byKey = new Map(solids.map((s) => [s.key, s]));
  const tagTop = (t: Tags) => parseLength(t.height) || Number(t['building:levels']) * LEVEL_HEIGHT || Infinity;
  const partBottom = (t: Tags) => Math.max(parseLength(t.min_height) || 0, (Number(t['building:min_level']) || 0) * LEVEL_HEIGHT);
  const covered = new Map<string, number>();
  for (const s of solids) {
    if (!s.isPart || !s.parent) continue;
    if (partBottom(s.tags) >= tagTop(byKey.get(s.parent)!.tags) - 1) continue;
    covered.set(s.parent, (covered.get(s.parent) ?? 0) + s.area);
  }
  const hidden = new Set<string>();
  for (const s of solids) if (!s.isPart && (covered.get(s.key) ?? 0) >= 0.5 * s.area) hidden.add(s.key);
  return { visible: solids.filter((s) => !hidden.has(s.key)), hidden };
}

// ---------------------------------------------------------------- heights

/** Parses an OSM length ("42", "42 m", "42.5m", "120'"). NaN if missing or nonsense. */
export function parseLength(v: string | undefined): number {
  if (!v) return NaN;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(m|ft|')?\s*$/.exec(v.replace(',', '.'));
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2] === 'ft' || m[2] === "'" ? n * 0.3048 : n;
}

/** Points on a grid inside the solid, at most about `max` of them, and always at least the centroid. */
function interiorSamples(s: Solid, max = 200): Local[] {
  const pts = s.polygons.flatMap((p) => p.outer);
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minZ = Math.min(...pts.map((p) => p.z));
  const maxZ = Math.max(...pts.map((p) => p.z));
  const step = Math.max(1.5, Math.sqrt(((maxX - minX) * (maxZ - minZ)) / max));
  const out: Local[] = [];
  for (let z = minZ + step / 2; z < maxZ; z += step) {
    for (let x = minX + step / 2; x < maxX; x += step) if (inSolid(s, x, z)) out.push({ x, z });
  }
  if (!out.length && inSolid(s, s.centroid.x, s.centroid.z)) out.push(s.centroid);
  return out;
}

const median = (v: number[]) => {
  const s = v.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export type SolidHeight = { height: number; minHeight: number; source: HeightSource };

const isCanopy = (t: Tags) => t.building === 'roof' || t['building:part'] === 'roof';

/**
 * Height above its base of the roof and of the underside (min_height), with
 * where the height came from. `deck` is the bridge deck height under a
 * building with layer > 0 that stands on one (the DSM is measured from the
 * DEM, which has the bridge removed, so it would read from the gully floor).
 */
export function solidHeight(s: Solid, dem: Raster, dsm: Raster, deck: number | null = null): SolidHeight {
  const t = s.tags;
  const h = rawHeight(s, dem, dsm, deck);
  const canopy = isCanopy(t);
  if (canopy && (h.source === 'default' || (h.source === 'dsm' && h.height > CANOPY_DSM_MAX))) {
    h.height = Math.max(CANOPY_DEFAULT, h.minHeight + CANOPY_THICKNESS);
    h.source = 'default';
  }
  // building=roof is a canopy (station platforms, forecourts) with open space
  // under it: a slab you can drive beneath, not a solid block.
  if (canopy && h.minHeight === 0 && h.height > CANOPY_THICKNESS + 2) h.minHeight = h.height - CANOPY_THICKNESS;
  // A kiosk under a tower's overhang or a tree reads as a 40-80 m spike.
  if (h.source === 'dsm' && s.area < SMALL_FOOTPRINT && !TALL_THIN.has(t.building ?? '') && !t.man_made) {
    h.height = Math.max(h.minHeight + 1, Math.min(h.height, Math.max(4, SLENDER * Math.sqrt(s.area))));
  }
  return h;
}

function rawHeight(s: Solid, dem: Raster, dsm: Raster, deck: number | null): SolidHeight {
  const t = s.tags;
  let minHeight = parseLength(t.min_height);
  if (!(minHeight >= 0)) minHeight = Number(t['building:min_level']) * LEVEL_HEIGHT;
  if (!(minHeight >= 0)) minHeight = 0;
  const tagged = parseLength(t.height);
  if (tagged > 0 && (tagged >= MIN_TAGGED || s.area <= 50 || s.isPart)) return { height: tagged, minHeight, source: 'height' };
  const levels = Number(t['building:levels']);
  if (levels > 0) {
    const roof = Number(t['roof:levels']);
    return { height: (levels + (roof > 0 ? roof : 0)) * LEVEL_HEIGHT, minHeight, source: 'levels' };
  }
  // Bus shelters: the DSM there is usually the tree or awning over them.
  if (t.amenity === 'shelter') return { height: SHELTER_HEIGHT, minHeight, source: 'default' };
  const diffs: number[] = [];
  for (const p of interiorSamples(s)) {
    const d = sampleLocal(dsm, p.x, p.z) - (deck ?? sampleLocal(dem, p.x, p.z));
    if (Number.isFinite(d)) diffs.push(d);
  }
  if (diffs.length >= 3) {
    const h = median(diffs);
    if (h >= DSM_MIN && h <= DSM_MAX && h > minHeight + 1) return { height: h, minHeight, source: 'dsm' };
  }
  return { height: Math.max(DEFAULT_HEIGHT, minHeight + 3), minHeight, source: 'default' };
}

/** Lowest terrain point under a solid (vertices, points along its edges and inside), metres. */
function lowestGround(s: Solid, dem: Raster): number {
  let lo = Infinity;
  const at = (x: number, z: number) => (lo = Math.min(lo, groundCm(dem, x, z) / 100));
  for (const p of s.polygons) {
    for (const r of [p.outer, ...p.holes]) {
      for (let k = 0; k < r.length; k++) {
        const a = r[k];
        const b = r[(k + 1) % r.length];
        const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 2);
        for (let q = 0; q < steps; q++) at(a.x + ((b.x - a.x) * q) / steps, a.z + ((b.z - a.z) * q) / steps);
      }
    }
  }
  for (const p of interiorSamples(s, 400)) at(p.x, p.z);
  return lo;
}

// ---------------------------------------------------------------- colour

/** FNV-1a: stable per-building randomness from the OSM key. */
function hash(key: string, salt = 0): number {
  let h = 0x811c9dc5 ^ salt;
  for (let k = 0; k < key.length; k++) h = Math.imul(h ^ key.charCodeAt(k), 0x01000193);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

// sRGB hex, stylised CBD tones.
const GLASS = [0x6f8796, 0x7d93a3, 0x5d7484, 0x8aa0ad, 0x667a88, 0x7a8f8f];
const CONCRETE = [0xb9b6ad, 0xa8a69f, 0xc9c4b8, 0x9c9a94, 0xd2cdc0, 0xb0aca2];
const SANDSTONE = [0xcdb991, 0xd8c8a4, 0xc2a979, 0xe0d4b8, 0xbfa888];
const BRICK = [0x9a5a44, 0x8a4d3b, 0xa86a50, 0x7d4a3a, 0x94604a];
const PAINTED = [0xe6e0d4, 0xd9d3c7, 0xe8dcc4, 0xcfd3cf];

const NAMED: Record<string, number> = {
  white: 0xf0f0ea, grey: 0x9a9a96, gray: 0x9a9a96, lightgrey: 0xc4c4c0, lightgray: 0xc4c4c0, darkgrey: 0x5e5e5c, darkgray: 0x5e5e5c,
  black: 0x3a3a3a, red: 0xa04a3c, brown: 0x7a5a44, beige: 0xd8cbad, cream: 0xe6dcc0, tan: 0xc8ae86, yellow: 0xd9c47a,
  blue: 0x6f88a8, lightblue: 0x9fb6c8, green: 0x6f8a6a, silver: 0xbfc3c4, orange: 0xc98a4e, pink: 0xd9a8a0,
};

function tagColour(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return parseInt(s.slice(1), 16);
  if (/^#[0-9a-f]{3}$/.test(s)) return parseInt(s.slice(1).split('').map((c) => c + c).join(''), 16);
  return NAMED[s.replace(/[\s_-]/g, '')] ?? null;
}

export const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export const rgb = (hex: number): [number, number, number] => [toLinear((hex >> 16) & 255), toLinear((hex >> 8) & 255), toLinear(hex & 255)];
const mix = (a: number[], b: number[], t: number) => a.map((v, k) => v + (b[k] - v) * t) as [number, number, number];

const PASTEL = [0xe8dcc0, 0xd9d6c4, 0xe6d6b8, 0xcfd6cc, 0xe3d2c6, 0xd6d0bc];

/** A building's dress: facade layer above the street, what's at street level, and its colour family. */
export type FacadeStyle = { upper: Layer; ground: 'shop' | 'lobby' | null; heritage: boolean; palette: number[]; floor: number };

const HOUSES = new Set(['house', 'detached', 'terrace', 'semidetached_house', 'bungalow', 'hut', 'cabin']);
const FLATS = new Set(['apartments', 'residential', 'dormitory', 'hotel']);
const SHEDS = new Set(['warehouse', 'industrial', 'service', 'shed', 'garage', 'garages', 'storage_tank', 'transformer_tower', 'construction', 'carport', 'roof']);
const RETAIL = new Set(['retail', 'commercial', 'shop', 'kiosk', 'supermarket']);

/** Year in a start_date ('1886', '~1910', 'C19', '1920s'), NaN if none. */
function startYear(t: Tags): number {
  const m = /(1[6-9]\d\d|20\d\d)/.exec(t.start_date ?? t['building:start_date'] ?? '');
  return m ? Number(m[1]) : NaN;
}

/**
 * Facade style for a building, deterministic per OSM id, from its tags,
 * height (of its tallest part) and street: towers are glass, ribbon
 * windows or precast grids; flats get balconies; heritage (tagged, built
 * before 1940, or low-rise on a retail street such as Queen St or K Road)
 * is brick or sandstone with shopfronts below; sheds and car parks plain.
 * `building:material` and `building:colour` win where mapped.
 */
export function facadeStyle(key: string, tags: Tags, height: number, retailStreet: boolean, shops: number): FacadeStyle {
  const r = hash(key, 5);
  const b = tags.building ?? tags['building:part'] ?? 'yes';
  const material = (tags['building:material'] ?? tags['building:facade:material'] ?? '').toLowerCase();
  const year = startYear(tags);
  const levels = Number(tags['building:levels']);
  const tagged = tags.heritage !== undefined || tags['ref:nz:heritage'] !== undefined || tags.historic !== undefined || tags['heritage:operator'] !== undefined;
  const heritage = material !== 'glass' && (tagged || year < 1940 || b === 'church' || b === 'cathedral' ||
    (retailStreet && height <= 24 && !(year >= 1960) && r < 0.8));
  const retail = shops > 0 || RETAIL.has(b) || (retailStreet && !HOUSES.has(b));
  let upper: Layer;
  let palette: number[];
  if (material.includes('glass')) [upper, palette] = ['glass', GLASS];
  else if (heritage) {
    const brick = material === 'brick' || (material !== 'stone' && material !== 'sandstone' && material !== 'plaster' && hash(key, 6) < 0.45);
    [upper, palette] = brick ? ['brick', BRICK] : ['stone', hash(key, 7) < 0.6 ? SANDSTONE : PAINTED];
  } else if (b === 'parking') [upper, palette] = ['ribbon', CONCRETE];
  else if (SHEDS.has(b) && height < 20) [upper, palette] = ['plain', CONCRETE];
  else if (HOUSES.has(b)) [upper, palette] = ['stucco', PASTEL];
  else if (FLATS.has(b)) [upper, palette] = height > 20 ? (r < 0.6 ? ['balcony', PAINTED] : ['grid', CONCRETE]) : r < 0.5 ? ['balcony', PASTEL] : ['stucco', PASTEL];
  else if (height >= 60) [upper, palette] = r < 0.55 ? ['glass', GLASS] : r < 0.8 ? ['ribbon', CONCRETE] : ['grid', CONCRETE];
  else if (height >= 25) [upper, palette] = r < 0.3 ? ['grid', CONCRETE] : r < 0.55 ? ['ribbon', CONCRETE] : r < 0.75 ? ['glass', GLASS] : ['stucco', SANDSTONE];
  else [upper, palette] = r < 0.35 ? ['stucco', PASTEL] : r < 0.6 ? ['grid', CONCRETE] : r < 0.8 ? ['brick', BRICK] : ['stone', SANDSTONE];
  if (material === 'brick' && upper !== 'brick' && upper !== 'glass') palette = BRICK;
  const ground = height >= 40 ? (retail && height < 80 ? 'shop' : 'lobby') : retail && !SHEDS.has(b) ? 'shop' : null;
  const natural = upper === 'brick' || upper === 'stone' ? 4.2 : upper === 'balcony' || upper === 'stucco' ? 3.1 : 3.7;
  const floor = levels >= 2 ? Math.min(4.8, Math.max(2.7, height / levels)) : natural;
  return { upper, ground, heritage, palette, floor };
}

/**
 * Wall colour (linear RGB) for a building, from its style's palette,
 * deterministic per OSM id. A `building:colour` tag pulls it most of the
 * way towards the mapped colour.
 */
function wallColour(key: string, tags: Tags, style: FacadeStyle): [number, number, number] {
  const palette = style.palette;
  let c = rgb(palette[Math.floor(hash(key, 1) * palette.length)]);
  const tagged = tagColour(tags['building:colour']);
  if (tagged !== null) c = mix(c, rgb(tagged), 0.6);
  const jitter = 0.92 + 0.14 * hash(key, 2);
  return c.map((v) => v * jitter) as [number, number, number];
}

function roofColour(key: string, tags: Tags, wall: [number, number, number]): [number, number, number] {
  const tagged = tagColour(tags['roof:colour']);
  // Roofs greyer than the walls and a touch lighter (membranes, gravel and
  // plant decks catch the full sky): they read as tops from the street and from the air.
  const base = mix(wall, rgb(0xa8a7a2), 0.5).map((v) => v * 1.05) as [number, number, number];
  return tagged !== null ? mix(base, rgb(tagged), 0.5) : base.map((v) => v * (0.95 + 0.1 * hash(key, 3))) as [number, number, number];
}

/** `roof:shape` values drawn as one of ours (domes and onions stay flat: too round for planes). */
const TAGGED_ROOFS: Record<string, RoofShape> = {
  flat: 'flat', gabled: 'gabled', hipped: 'hipped', pyramidal: 'pyramidal', skillion: 'skillion', mansard: 'mansard',
  'half-hipped': 'hipped', side_hipped: 'hipped', crosspitched: 'hipped', gambrel: 'gabled', saltbox: 'gabled', double_saltbox: 'gabled',
};
/** Buildings taller than this keep flat roofs unless one is mapped, m. */
const PITCHED_MAX = 30;
/** Footprints must fill this much of their bounding rectangle for a fitted gable or hip (skillions SKILLION_FILL). */
const PITCHED_FILL = 0.75;
const SKILLION_FILL = 0.8;
/** The highest ridge drawn, m above the eave. */
const RISE_MAX = 9;
/** Walls under a pitched roof are at least this tall, m. */
const EAVE_MIN = 2.4;

// Pitched roof cladding (sRGB): painted corrugated iron is the Auckland roof; tiles on some houses.
const TIN = [0x8a3b32, 0x4f6150, 0x3c3f42, 0x8c8f8f, 0xa6aaa8, 0x6b2f2a, 0x5a6b73];
const TIN_INDUSTRIAL = [0x8c8f8f, 0xa6aaa8, 0x7d8285, 0x3c3f42];
const TILE = [0xa45a3f, 0x8e4c36, 0x6e4b3a, 0x4a4a4c, 0x7a3e30];

export type RoofChoice = { pitched: PitchedRoof; eave: number; ridge: number; shape: RoofShape; colour: [number, number, number] };

/**
 * A pitched roof for a building, or null for a flat one: the mapped
 * `roof:shape` if any, else what the DSM shows (see roofs.ts) on footprints
 * that are near enough rectangular. Heights: a tagged `height` is the
 * ridge; levels give the eave; a LiDAR height is replaced by the fitted eave.
 */
export function chooseRoof(s: Solid, h: SolidHeight, dsm: Raster, bottom: number, top: number, familyTop: number): RoofChoice | null {
  const t = s.tags;
  if (s.polygons.length !== 1 || s.polygons[0].holes.length || isCanopy(t)) return null;
  const tagged = TAGGED_ROOFS[(t['roof:shape'] ?? '').toLowerCase()];
  if (tagged === 'flat' || (t['roof:shape'] && !tagged)) return null;
  if (!tagged && (familyTop > PITCHED_MAX + 10 || h.height > PITCHED_MAX)) return null;
  const ring = s.polygons[0].outer;
  const frame = roofFrame(ring, s.area);
  const fit: RoofFit | null = fitRoof(dsm, { ring, area: s.area, frame });
  let shape: RoofShape;
  let alongU = true;
  let rise: number;
  const fitted = !!fit && fit.shape !== 'flat' && (!tagged || fit.shape === tagged);
  if (tagged) {
    shape = tagged;
    alongU = fit?.shape === 'gabled' ? fit.alongU : t['roof:orientation'] !== 'across';
    const half = shape === 'gabled' && !alongU ? frame.L : frame.W;
    const defaults: Record<RoofShape, number> = { flat: 0, gabled: half * 0.55, hipped: frame.W * 0.5, pyramidal: frame.W * 0.75, skillion: frame.W * 0.4, mansard: 3 };
    rise = parseLength(t['roof:height']) || (fitted ? fit!.rise : Math.min(defaults[shape], 5));
  } else {
    if (!fitted) return null;
    if (frame.fill < (fit!.shape === 'skillion' ? SKILLION_FILL : PITCHED_FILL)) return null;
    shape = fit!.shape;
    alongU = fit!.alongU;
    rise = fit!.rise;
  }
  rise = Math.min(rise, RISE_MAX);
  let eave = top;
  if (h.source === 'height') eave = top - rise;
  else if ((h.source === 'dsm' || h.source === 'default') && fitted) eave = Math.min(fit!.eave, bottom + 60);
  eave = Math.max(eave, bottom + EAVE_MIN);
  if (h.source === 'height') rise = Math.max(0.5, top - eave);
  const planes = roofPlanes(frame, { shape, alongU, rise, plane: fitted ? fit!.plane : undefined }, eave);
  // Cladding: mapped material, else tiles on some houses, iron everywhere else.
  const material = (t['roof:material'] ?? '').toLowerCase();
  const house = HOUSES.has(t.building ?? '');
  const tiles = /tile|slate|clay/.test(material) || (!/metal|tin|iron/.test(material) && house && hash(s.key, 11) < 0.3);
  const palette = tiles ? TILE : SHEDS.has(t.building ?? '') ? TIN_INDUSTRIAL : TIN;
  let colour = rgb(palette[Math.floor(hash(s.key, 12) * palette.length)]);
  const tc = tagColour(t['roof:colour']);
  if (tc !== null) colour = mix(colour, rgb(tc), 0.7);
  // Houses' eaves overhang more than commercial buildings' (often behind a parapet in reality).
  const overhang = house || FLATS.has(t.building ?? '') ? 0.5 : 0.3;
  return { pitched: { planes, layer: tiles ? 'roof-tile' : 'roof-tin', overhang }, eave, ridge: eave + rise, shape, colour };
}

// ---------------------------------------------------------------- meshing

/** Baked light for one wall: colour multipliers at its foot, at the band row (BASE_BAND up) and at its top. */
export type WallShade = (a: Local, b: Local, n: readonly number[], bottom: number, top: number, grounded: boolean) => { foot: number; band: number; top: number };

/** What a wall is clad in: atlas layers above and at street level (null: plain vertex colour, or the same as above). */
export type WallFace = { upper: Layer | null; ground: Layer | null };

/** How a building is dressed (see prism). */
export type Look = {
  shade: WallShade;
  /** Cladding for a wall from a to b (outward normal n). */
  wall: (a: Local, b: Local, n: readonly number[], len: number) => WallFace;
  /** Storey height above the ground floor, and the ground floor's (the shopfront band), m. */
  floor: number;
  groundFloor: number;
  /** Ground height (m above sea level) at a point, for the shopfront band on slopes. */
  groundAt: (x: number, z: number) => number;
  /** Height of the parapet round a flat roof, m (0 for none). */
  parapet: number;
};

/** A pitched roof's planes (absolute heights; the roof is their minimum) and its cladding. */
export type PitchedRoof = { planes: Plane[]; layer: Layer; overhang: number };

/** How far out from a wall to look for the building across the street, m. */
const CANYON_REACH = 40;
const CANYON_STEP = 1.5;
const SUN_H = Math.hypot(SUN_DIRECTION[0], SUN_DIRECTION[2]);

/**
 * Cheap baked lighting for walls (no shadow maps at run time):
 * - a sun-facing term: walls in shade differ by how far they turn from the
 *   sun, so the faces of a block read distinctly instead of one flat tone;
 * - street-canyon occlusion: the taller and closer the building across the
 *   way, the darker the lower floors (sky hidden), fading up the wall;
 * - ground contact: the foot of a wall that stands on the ground is darkest.
 * `across(x, z, y)` is the top (m above sea level) of the nearest other
 * building's footprint covering (x, z), or -Infinity.
 */
export function canyonShade(across: (x: number, z: number, self: unknown) => number, self: unknown): WallShade {
  return (a, b, n, bottom, top, grounded) => {
    // Sun term: 1 facing the sun, down to 0.8 facing directly away (on top of the real-time light).
    const facing = (n[0] * SUN_DIRECTION[0] + n[2] * SUN_DIRECTION[2]) / SUN_H;
    const sun = facing > 0 ? 1 : 1 - 0.2 * -facing;
    // The opposite building's elevation angle from three points along the wall.
    let elevFoot = 0;
    let elevBand = 0;
    let elevTop = 0;
    for (const t of [0.2, 0.5, 0.8]) {
      const mx = a.x + (b.x - a.x) * t + n[0] * 0.3;
      const mz = a.z + (b.z - a.z) * t + n[2] * 0.3;
      for (let d = CANYON_STEP; d <= CANYON_REACH; d += CANYON_STEP) {
        const h = across(mx + n[0] * d, mz + n[2] * d, self);
        if (h === -Infinity) continue;
        elevFoot += Math.atan2(Math.max(0, h - bottom), d) / 3;
        elevBand += Math.atan2(Math.max(0, h - bottom - BASE_BAND), d) / 3;
        elevTop += Math.atan2(Math.max(0, h - top), d) / 3;
        break;
      }
    }
    const occ = (e: number) => e / (Math.PI / 2);
    const foot = (grounded ? 0.62 : 0.85) * (1 - 0.45 * occ(elevFoot));
    const band = 0.95 * (1 - 0.4 * occ(elevBand));
    // Tops in the open sky get a little lift; a low building in a canyon stays dim.
    const crown = 1.06 * (1 - 0.35 * occ(elevTop));
    return { foot: foot * sun, band: band * sun, top: crown * sun };
  };
}

/** Accumulates one chunk's merged mesh in absolute local metres. */
export class MeshBuilder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  /** Render triangles (swapped for `extras` while detail is emitted, see detail()). */
  idx: number[] = [];
  /** Small detail drawn only near the player (verandahs, parapets, plant rooms): after idx in the file. */
  readonly extras: number[] = [];
  readonly colliderIdx: number[] = [];
  /** Per-vertex draw layer (roads only; buildings leave it all 0 and the file omits it). */
  readonly lay: number[] = [];
  /** Per-vertex surface detail (see facades.ts): atlas tile, UVs in repeats, baked light. */
  readonly tile: number[] = [];
  readonly uv: number[] = [];
  readonly shade: number[] = [];

  get vertexCount() {
    return this.pos.length / 3;
  }

  /** Runs `emit` with its triangles going to the near-only detail list. */
  detail(emit: () => void) {
    const core = this.idx;
    this.idx = this.extras;
    try {
      emit();
    } finally {
      this.idx = core;
    }
  }

  vertex(x: number, y: number, z: number, n: readonly number[], c: readonly number[], layer = 0, tile = 0, u = 0, v = 0, shade = 1): number {
    this.pos.push(x, y, z);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    this.lay.push(layer);
    this.tile.push(tile);
    this.uv.push(u, v);
    this.shade.push(shade);
    return this.pos.length / 3 - 1;
  }

  /**
   * One footprint as a prism from `bottom` to `top`, textured per `look`
   * (see Look): each wall gets a whole number of its facade's bays across
   * and the building's floor height up, a shopfront or lobby band at street
   * level where it faces a street, and a parapet above a flat roof. Baked
   * light goes in the shade channel; the vertex colour is the wall's tint.
   */
  prism(s: Pick<Solid, 'polygons'>, bottom: number, top: number, wall: [number, number, number], roof: [number, number, number], grounded: boolean, visible = true, look?: Look, pitched?: PitchedRoof) {
    const planes = pitched?.planes;
    if (!visible) {
      this.colliderPrism(s.polygons, bottom, top, planes);
      return;
    }
    const gf = look?.groundFloor ?? BASE_BAND;
    // A shopfront or lobby band needs its own row of vertices; otherwise only
    // walls tall enough for the foot darkening to matter get one.
    const shops = !!look && look.groundFloor !== BASE_BAND;
    const banded = grounded && top - bottom > (shops ? gf + 1.5 : BASE_BAND * 2);
    // Pitched roofs have no parapet; their walls run up to the roof (gable ends).
    const parapet = planes ? 0 : look?.parapet ?? 0;
    const lid = top + parapet;
    const roofY = (p: Local) => (planes ? Math.max(top, roofAt(planes, p.x, p.z)) : lid);
    for (const poly of s.polygons) {
      for (const ring0 of [poly.outer, ...poly.holes]) {
        const ring = planes ? roofBreaks(ring0, planes) : ring0;
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k];
          const b = ring[(k + 1) % ring.length];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          const n: [number, number, number] = [(b.z - a.z) / len, 0, -(b.x - a.x) / len];
          const l = look ? look.shade(a, b, n, bottom, top, grounded) : { foot: grounded ? 0.55 : 0.85, band: 0.93, top: 1.04 };
          const face = look?.wall(a, b, n, len) ?? { upper: null, ground: null };
          // Facade UVs: whole bays across, floors up from the top of the ground floor.
          const fit = (layer: Layer | null) => {
            const f = layer && FACADE[layer];
            return f ? Math.max(1, Math.round(len / f.bay)) / f.bays : 0;
          };
          const floorV = (layer: Layer | null, y: number) => {
            const f = layer && FACADE[layer];
            return f ? (y - (bottom + (banded ? gf : 0))) / ((look?.floor ?? 3.5) * f.floors) : 0;
          };
          const upTile = face.upper ? tileOf(face.upper) : 0;
          const uUp = fit(face.upper);
          const put = (p: Local, y: number, light: number, tile: number, u: number, v: number) =>
            this.vertex(p.x, y, p.z, n, wall, 0, tile, u, v, light);
          const a1 = put(a, lid, l.top, upTile, 0, floorV(face.upper, lid));
          const b1 = put(b, lid, l.top, upTile, uUp, floorV(face.upper, lid));
          // The collider stops at the roof; the parapet above it is only drawn.
          let ac = parapet ? this.vertex(a.x, top, a.z, n, wall) : a1;
          let bc = parapet ? this.vertex(b.x, top, b.z, n, wall) : b1;
          if (planes) {
            // Under a pitched roof: plain wall from the eave up to the roof line (a gable end).
            const ya = roofY(a);
            const yb = roofY(b);
            if (ya > top + 0.02 || yb > top + 0.02) {
              const pt = tileOf('plain');
              const pu = len / 8;
              const ga = put(a, top, l.top, pt, 0, 0);
              const gb = put(b, top, l.top, pt, pu, 0);
              const gc = put(b, yb, l.top, pt, pu, (yb - top) / 8);
              const gd = put(a, ya, l.top, pt, 0, (ya - top) / 8);
              this.idx.push(ga, gc, gb, ga, gd, gc);
              ac = gd;
              bc = gc;
            }
          }
          // Outward-facing (counter-clockwise seen from outside) for rings wound as cleanRing() leaves them.
          if (banded) {
            // The ground floor follows the street: a storey above the ground at each corner.
            const ga = look ? look.groundAt(a.x, a.z) : bottom;
            const gb = look ? look.groundAt(b.x, b.z) : bottom;
            const ya = Math.min(Math.max(ga, bottom) + gf, top - 1);
            const yb = Math.min(Math.max(gb, bottom) + gf, top - 1);
            const low = face.ground ?? face.upper;
            const lowTile = low ? tileOf(low) : 0;
            const uLow = fit(low);
            const shopV = (y: number, g: number) => (face.ground ? (y - Math.max(g, bottom)) / gf : floorV(low, y));
            const a0 = put(a, bottom, l.foot, lowTile, 0, shopV(bottom, ga));
            const b0 = put(b, bottom, l.foot, lowTile, uLow, shopV(bottom, gb));
            const am = put(a, ya, l.band, lowTile, 0, shopV(ya, ga));
            const bm = put(b, yb, l.band, lowTile, uLow, shopV(yb, gb));
            let au = am;
            let bu = bm;
            if (low !== face.upper || face.ground) {
              au = put(a, ya, l.band, upTile, 0, floorV(face.upper, ya));
              bu = put(b, yb, l.band, upTile, uUp, floorV(face.upper, yb));
            }
            this.idx.push(a0, bm, b0, a0, am, bm, au, b1, bu, au, a1, b1);
            this.colliderIdx.push(a0, bc, b0, a0, ac, bc);
          } else {
            const a0 = put(a, bottom, l.foot, upTile, 0, floorV(face.upper, bottom));
            const b0 = put(b, bottom, l.foot, upTile, uUp, floorV(face.upper, bottom));
            this.idx.push(a0, b1, b0, a0, a1, b1);
            this.colliderIdx.push(a0, bc, b0, a0, ac, bc);
          }
          if (parapet && len >= PARAPET_MIN_EDGE) {
            // The parapet's inside face, looking onto the roof (short edges, round towers' facets, go without).
            const m: [number, number, number] = [-n[0], 0, -n[2]];
            const pa = this.vertex(a.x, top, a.z, m, wall, 0, tileOf('plain'), 0, 0, 0.7);
            const pb = this.vertex(b.x, top, b.z, m, wall, 0, tileOf('plain'), len / 8, 0, 0.7);
            const qa = this.vertex(a.x, lid, a.z, m, wall, 0, tileOf('plain'), 0, parapet / 8, 0.85);
            const qb = this.vertex(b.x, lid, b.z, m, wall, 0, tileOf('plain'), len / 8, parapet / 8, 0.85);
            this.extras.push(pa, pb, qb, pa, qb, qa);
          }
        }
      }
      if (planes && pitched) {
        this.pitchedRoof(poly.outer, pitched, roof, !!look);
        continue;
      }
      // Flat roof (and an underside for parts that float, like a tower's pod).
      const rings = [poly.outer, ...poly.holes];
      const flat: number[] = [];
      const holes: number[] = [];
      for (const r of rings) {
        if (r !== poly.outer) holes.push(flat.length / 2);
        for (const p of r) flat.push(p.x, p.z);
      }
      const tris = earcut(flat, holes);
      const faces: [number, number[], [number, number, number], boolean, number][] = [[top, roof, [0, 1, 0], true, look ? tileOf('roof') : 0]];
      if (!grounded) faces.push([bottom, roof, [0, -1, 0], false, look ? tileOf('concrete') : 0]);
      for (const [y, c, n, up, tile] of faces) {
        const first = this.vertexCount;
        for (let k = 0; k < flat.length; k += 2) this.vertex(flat[k], y, flat[k + 1], n, c, 0, tile, 0, 0, up ? 1 : 0.6);
        for (let k = 0; k < tris.length; k += 3) {
          let [p, q, r] = [tris[k], tris[k + 1], tris[k + 2]];
          // Wind so the face points along n: cross((q-p),(r-p)).y > 0 faces up.
          const cy = (flat[q * 2 + 1] - flat[p * 2 + 1]) * (flat[r * 2] - flat[p * 2]) - (flat[q * 2] - flat[p * 2]) * (flat[r * 2 + 1] - flat[p * 2 + 1]);
          if (cy > 0 !== up) [q, r] = [r, q];
          this.idx.push(first + p, first + q, first + r);
          this.colliderIdx.push(first + p, first + q, first + r);
        }
      }
    }
  }

  /**
   * A pitched roof over a ring (no holes): each plane over its share of the
   * footprint, drawn and in the collider. Sloping planes are textured along
   * their fall (corrugations and tile courses run downhill); a flat plane
   * (a mansard's top) gets the flat-roof layer.
   */
  pitchedRoof(ring: Ring, pitched: PitchedRoof, colour: readonly number[], textured: boolean) {
    // Eaves overhang the walls (and read as a roof from the street); the underside is near-only detail.
    const eaves = (pitched.overhang && outsetRing(ring, pitched.overhang)) || ring;
    for (const { plane, ring: region } of planeRegions(eaves, pitched.planes)) {
      const flat: number[] = [];
      for (const p of region) flat.push(p.x, p.z);
      const tris = earcut(flat);
      if (!tris.length) continue;
      const g = Math.hypot(plane.bx, plane.bz);
      const n = [-plane.bx, 1, -plane.bz].map((v) => v / Math.hypot(plane.bx, 1, plane.bz));
      // Downhill unit vector, and across it.
      const dx = g > 1e-6 ? -plane.bx / g : 0;
      const dz = g > 1e-6 ? -plane.bz / g : 1;
      const stretch = Math.sqrt(1 + g * g);
      const sloped = g > 0.05;
      const tile = !textured ? 0 : sloped ? tileOf(pitched.layer) : tileOf('roof');
      const metres = sloped ? ROOF_METRES[pitched.layer] ?? 4 : 1;
      // Light falls off a little on slopes facing away from the sun.
      const facing = sloped ? (dx * SUN_DIRECTION[0] + dz * SUN_DIRECTION[2]) / SUN_H : 0;
      const light = sloped ? 1.02 + 0.1 * facing : 1;
      const first = this.vertexCount;
      // UVs from the ring's first corner (int16 UVs can't hold world-sized ones).
      const [ox, oz] = [ring[0].x, ring[0].z];
      for (let k = 0; k < flat.length; k += 2) {
        const x = flat[k];
        const z = flat[k + 1];
        const u = ((x - ox) * -dz + (z - oz) * dx) / metres;
        const v = (((x - ox) * dx + (z - oz) * dz) * stretch) / metres;
        this.vertex(x, planeAt(plane, x, z), z, n, colour, 0, tile, sloped ? u : 0, sloped ? -v : 0, light);
      }
      for (let k = 0; k < tris.length; k += 3) {
        let [p, q, r] = [tris[k], tris[k + 1], tris[k + 2]];
        const cy = (flat[q * 2 + 1] - flat[p * 2 + 1]) * (flat[r * 2] - flat[p * 2]) - (flat[q * 2] - flat[p * 2]) * (flat[r * 2 + 1] - flat[p * 2 + 1]);
        if (cy <= 0) [q, r] = [r, q];
        this.idx.push(first + p, first + q, first + r);
        this.colliderIdx.push(first + p, first + q, first + r);
      }
      if (eaves !== ring && textured) {
        const under = this.vertexCount;
        for (let k = 0; k < flat.length; k += 2) this.vertex(flat[k], planeAt(plane, flat[k], flat[k + 1]) - 0.05, flat[k + 1], [0, -1, 0], colour, 0, 0, 0, 0, 0.45);
        for (let k = 0; k < tris.length; k += 3) {
          let [p, q, r] = [tris[k], tris[k + 1], tris[k + 2]];
          const cy = (flat[q * 2 + 1] - flat[p * 2 + 1]) * (flat[r * 2] - flat[p * 2]) - (flat[q * 2] - flat[p * 2]) * (flat[r * 2 + 1] - flat[p * 2 + 1]);
          if (cy > 0) [q, r] = [r, q];
          this.extras.push(under + p, under + q, under + r);
        }
      }
    }
  }

  /**
   * A box (plant room, lift overrun) of half-size hx by hz turned by `angle`,
   * standing on y0 and h tall: four walls and a lid, drawn only.
   */
  box(cx: number, cz: number, hx: number, hz: number, angle: number, y0: number, h: number, colour: readonly number[], layer: Layer) {
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    const corner = (i: number, j: number) => ({ x: cx + i * hx * c - j * hz * sn, z: cz + i * hx * sn + j * hz * c });
    // Counter-clockwise in x/z as the rings are (positive signed area).
    const ring = [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)];
    if (signedArea(ring) < 0) ring.reverse();
    const tile = tileOf(layer);
    const f = FACADE[layer]!;
    for (let k = 0; k < 4; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = [(b.z - a.z) / len, 0, -(b.x - a.x) / len];
      const u = len / (f.bay * f.bays);
      const v = h / (3.5 * f.floors);
      const a0 = this.vertex(a.x, y0, a.z, n, colour, 0, tile, 0, 0, 0.8);
      const b0 = this.vertex(b.x, y0, b.z, n, colour, 0, tile, u, 0, 0.8);
      const a1 = this.vertex(a.x, y0 + h, a.z, n, colour, 0, tile, 0, v, 1);
      const b1 = this.vertex(b.x, y0 + h, b.z, n, colour, 0, tile, u, v, 1);
      this.idx.push(a0, b1, b0, a0, a1, b1);
    }
    const lid = ring.map((p) => this.vertex(p.x, y0 + h, p.z, [0, 1, 0], colour, 0, tileOf('roof'), 0, 0, 1));
    this.idx.push(lid[0], lid[2], lid[1], lid[0], lid[3], lid[2]);
  }

  /**
   * A street verandah along a wall from a to b (outward normal n): a thin
   * slab `depth` out over the footpath, `height` above the ground at each
   * point (it steps with the street every few metres), with a fascia along
   * its front, and posts at the kerb when `posts`. Drawn only: it's above
   * head height, and posts are thin enough to walk through.
   */
  verandah(a: Local, b: Local, n: readonly number[], depth: number, height: number, groundAt: (x: number, z: number) => number, fascia: readonly number[], posts: boolean) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / VERANDAH_STEP));
    const back: Local[] = [];
    const ys: number[] = [];
    // A hair off the wall so it never z-fights the facade.
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const p = { x: a.x + (b.x - a.x) * t + n[0] * 0.02, z: a.z + (b.z - a.z) * t + n[2] * 0.02 };
      back.push(p);
      ys.push(groundAt(p.x + n[0] * depth * 0.5, p.z + n[2] * depth * 0.5) + height);
    }
    const front = back.map((p) => ({ x: p.x + n[0] * depth, z: p.z + n[2] * depth }));
    const top = rgb(0x6e706f);
    const under = rgb(0xe4ddcc);
    const u = (k: number) => (len * k) / steps;
    const UP = [0, 1, 0];
    const DOWN = [0, -1, 0];
    const roofTile = tileOf('roof');
    const plainTile = tileOf('plain');
    for (let k = 0; k < steps; k++) {
      const [p0, p1, q0, q1, y0, y1] = [back[k], back[k + 1], front[k], front[k + 1], ys[k], ys[k + 1]];
      // Top: corrugated iron, falling slightly to the street.
      const t = [
        this.vertex(p0.x, y0 + VERANDAH_THICK + 0.12, p0.z, UP, top, 0, roofTile),
        this.vertex(p1.x, y1 + VERANDAH_THICK + 0.12, p1.z, UP, top, 0, roofTile),
        this.vertex(q1.x, y1 + VERANDAH_THICK, q1.z, UP, top, 0, roofTile),
        this.vertex(q0.x, y0 + VERANDAH_THICK, q0.z, UP, top, 0, roofTile),
      ];
      this.quadUp(t, true);
      // Soffit: pale paint, in its own shadow.
      const d = [
        this.vertex(p0.x, y0, p0.z, DOWN, under, 0, plainTile, u(k) / 8, 0, 0.62),
        this.vertex(p1.x, y1, p1.z, DOWN, under, 0, plainTile, u(k + 1) / 8, 0, 0.62),
        this.vertex(q1.x, y1, q1.z, DOWN, under, 0, plainTile, u(k + 1) / 8, depth / 8, 0.7),
        this.vertex(q0.x, y0, q0.z, DOWN, under, 0, plainTile, u(k) / 8, depth / 8, 0.7),
      ];
      this.quadUp(d, false);
      // Fascia along the front.
      const f = [
        this.vertex(q0.x, y0 - VERANDAH_FASCIA, q0.z, n, fascia, 0, plainTile, u(k) / 8, 0, 0.9),
        this.vertex(q1.x, y1 - VERANDAH_FASCIA, q1.z, n, fascia, 0, plainTile, u(k + 1) / 8, 0, 0.9),
        this.vertex(q1.x, y1 + VERANDAH_THICK, q1.z, n, fascia, 0, plainTile, u(k + 1) / 8, 0.1, 1),
        this.vertex(q0.x, y0 + VERANDAH_THICK, q0.z, n, fascia, 0, plainTile, u(k) / 8, 0.1, 1),
      ];
      this.wallQuad(f, q0, q1, n);
    }
    // End caps, facing along the wall.
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    for (const [p, q, y, s] of [[back[0], front[0], ys[0], -1], [back[steps], front[steps], ys[steps], 1]] as const) {
      const m = [ux * s, 0, uz * s];
      const c = [
        this.vertex(p.x, y, p.z, m, fascia, 0, 0, 0, 0, 0.8),
        this.vertex(q.x, y - VERANDAH_FASCIA, q.z, m, fascia, 0, 0, 0, 0, 0.8),
        this.vertex(q.x, y + VERANDAH_THICK, q.z, m, fascia, 0, 0, 0, 0, 0.8),
        this.vertex(p.x, y + VERANDAH_THICK + 0.12, p.z, m, fascia, 0, 0, 0, 0, 0.8),
      ];
      this.wallQuad(c, p, q, m);
    }
    if (posts) {
      const count = Math.max(1, Math.round(len / VERANDAH_POSTS));
      for (let k = 0; k <= count; k++) {
        const t = (k + 0.5) / (count + 1);
        const x = a.x + (b.x - a.x) * t + n[0] * (depth - 0.2);
        const z = a.z + (b.z - a.z) * t + n[2] * (depth - 0.2);
        const g = groundAt(x, z);
        this.post(x, z, 0.08, Math.atan2(n[2], n[0]), g, ys[Math.round(t * steps)] - g, fascia);
      }
    }
  }

  /** A thin square post facing direction `angle` (its back and top left out: never seen), drawn only. */
  private post(cx: number, cz: number, half: number, angle: number, y0: number, h: number, colour: readonly number[]) {
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    // Front, then the two sides, each as (corner a, corner b, outward normal).
    const pt = (i: number, j: number) => ({ x: cx + (i * c - j * sn) * half, z: cz + (i * sn + j * c) * half });
    const faces: [ReturnType<typeof pt>, ReturnType<typeof pt>, number[]][] = [
      [pt(1, -1), pt(1, 1), [c, 0, sn]],
      [pt(-1, -1), pt(1, -1), [sn, 0, -c]],
      [pt(1, 1), pt(-1, 1), [-sn, 0, c]],
    ];
    for (const [a, b, n] of faces) {
      const v = [this.vertex(a.x, y0, a.z, n, colour, 0, 0, 0, 0, 0.8), this.vertex(b.x, y0, b.z, n, colour, 0, 0, 0, 0, 0.8), this.vertex(b.x, y0 + h, b.z, n, colour), this.vertex(a.x, y0 + h, a.z, n, colour)];
      this.wallQuad(v, a, b, n);
    }
  }

  /**
   * Two triangles for an upright quad: v = [bottom a, bottom b, top b, top a],
   * wound to face along n (as prism's walls: (dz, -dx) of a to b faces out).
   */
  private wallQuad(v: number[], a: Local, b: Local, n: readonly number[]) {
    const cross = (b.x - a.x) * n[2] - (b.z - a.z) * n[0];
    if (cross < 0) this.idx.push(v[0], v[2], v[1], v[0], v[3], v[2]);
    else this.idx.push(v[0], v[1], v[2], v[0], v[2], v[3]);
  }

  /** Two triangles over four vertices in order round a quad, facing up (or down). */
  private quadUp(v: number[], up: boolean) {
    const p = (k: number) => [this.pos[v[k] * 3], this.pos[v[k] * 3 + 2]];
    const [a, b, c] = [p(0), p(1), p(2)];
    const cy = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
    if (cy > 0 === up) this.idx.push(v[0], v[1], v[2], v[0], v[2], v[3]);
    else this.idx.push(v[0], v[2], v[1], v[0], v[3], v[2]);
  }

  /**
   * An invisible solid: walls and a lid in the collider only (its vertices
   * ride along in the render buffers but no drawn triangle uses them).
   */
  colliderPrism(polygons: Polygon[], bottom: number, top: number, planes?: Plane[]) {
    const none = [0, 0, 0] as const;
    for (const poly of polygons) {
      for (const ring0 of [poly.outer, ...poly.holes]) {
        const ring = planes ? roofBreaks(ring0, planes) : ring0;
        const yAt = (p: Local) => (planes ? Math.max(top, roofAt(planes, p.x, p.z)) : top);
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k];
          const b = ring[(k + 1) % ring.length];
          const a0 = this.vertex(a.x, bottom, a.z, none, none);
          const b0 = this.vertex(b.x, bottom, b.z, none, none);
          const a1 = this.vertex(a.x, yAt(a), a.z, none, none);
          const b1 = this.vertex(b.x, yAt(b), b.z, none, none);
          this.colliderIdx.push(a0, b1, b0, a0, a1, b1);
        }
      }
      if (planes) {
        for (const { plane, ring: region } of planeRegions(poly.outer, planes)) {
          const flat = region.flatMap((p) => [p.x, p.z]);
          const first = this.vertexCount;
          for (let k = 0; k < flat.length; k += 2) this.vertex(flat[k], planeAt(plane, flat[k], flat[k + 1]), flat[k + 1], none, none);
          const tris = earcut(flat);
          for (let k = 0; k < tris.length; k += 3) {
            let [p, q, r] = [tris[k], tris[k + 1], tris[k + 2]];
            const cy = (flat[q * 2 + 1] - flat[p * 2 + 1]) * (flat[r * 2] - flat[p * 2]) - (flat[q * 2] - flat[p * 2]) * (flat[r * 2 + 1] - flat[p * 2 + 1]);
            if (cy <= 0) [q, r] = [r, q];
            this.colliderIdx.push(first + p, first + q, first + r);
          }
        }
        continue;
      }
      const flat: number[] = [];
      const holes: number[] = [];
      for (const r of [poly.outer, ...poly.holes]) {
        if (r !== poly.outer) holes.push(flat.length / 2);
        for (const p of r) flat.push(p.x, p.z);
      }
      const first = this.vertexCount;
      for (let k = 0; k < flat.length; k += 2) this.vertex(flat[k], top, flat[k + 1], none, none);
      const tris = earcut(flat, holes);
      for (let k = 0; k < tris.length; k += 3) this.colliderIdx.push(first + tris[k], first + tris[k + 2], first + tris[k + 1]);
    }
  }

  /** Quantises to the file format, relative to the chunk centre (cx, cz). */
  encode(cx: number, cz: number): BuildingMesh {
    const n = this.vertexCount;
    const xCm = new Int32Array(n);
    const zCm = new Int32Array(n);
    const yCm = new Int32Array(n);
    let base = Infinity;
    for (let k = 0; k < n; k++) base = Math.min(base, Math.floor(this.pos[k * 3 + 1] * 100));
    for (let k = 0; k < n; k++) {
      xCm[k] = Math.round((this.pos[k * 3] - cx) * 100);
      yCm[k] = Math.round(this.pos[k * 3 + 1] * 100) - base;
      zCm[k] = Math.round((this.pos[k * 3 + 2] - cz) * 100);
    }
    const normals = new Int8Array(this.nor.map((v) => Math.round(v * 127)));
    const colours = new Uint8Array(this.col.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)));
    const layers = this.lay.some((v) => v) ? Uint8Array.from(this.lay) : undefined;
    const detail = this.tile.some((v) => v) || this.shade.some((v) => v !== 1)
      ? {
          shade: Uint8Array.from(this.shade, (v) => Math.round(Math.min(255, Math.max(0, v * SHADE_ONE)))),
          u: Int32Array.from({ length: n }, (_, k) => Math.round(this.uv[k * 2] * UV_SCALE)),
          v: Int32Array.from({ length: n }, (_, k) => Math.round(this.uv[k * 2 + 1] * UV_SCALE)),
          tile: Uint8Array.from(this.tile),
        }
      : undefined;
    const indices = Uint32Array.from([...this.idx, ...this.extras]);
    const nearOnly = this.extras.length ? { nearOnly: this.idx.length } : {};
    return { xCm, zCm, yCm, baseCm: base, normals, colours, indices, colliderIndices: Uint32Array.from(this.colliderIdx), layers, detail, ...nearOnly };
  }
}

export type BuildingsResult = {
  /** Per chunk "i,j" -> merged mesh builder. */
  chunks: Map<string, MeshBuilder>;
  /** The far skyline (see SKYLINE_MIN): tall buildings again, plainer, per chunk "i,j". */
  skyline: Map<string, MeshBuilder>;
  buildings: ExtrudedBuilding[];
  landmarks: Landmark[];
  /** Whether a ground point is inside a drawn building that stands on the ground (not a canopy or a hidden landmark). */
  covers: (x: number, z: number) => boolean;
  counts: Record<HeightSource, number> & { outlines: number; parts: number; hiddenOutlines: number; outside: number; hidden: number; blocks: number; verandahs: number; verandahMetres: number; roofs: Partial<Record<RoofShape, number>> };
};

/** A building tagged as a landmark in the overrides, for hand-made models (T9). */
export type Landmark = {
  id: string;
  /** 'way/123' or 'relation/456'. */
  osm: string;
  name?: string;
  /** Footprint centroid, local metres. */
  x: number;
  z: number;
  /** Ground under it (the lowest point) and the top of its tallest part, metres above sea level. */
  base: number;
  top: number;
  /** Outer ring of the biggest polygon, local metres (0.1 m). */
  footprint: [number, number][];
  /** True when the OSM geometry is left out of the mesh (only its collider remains). */
  hidden: boolean;
};

export type BuildOptions = {
  overrides?: Overrides;
  /** Bridge deck height at a point, or null off any bridge (see roads.ts). */
  deckAt?: (x: number, z: number) => number | null;
  /** The street a wall faces, for shopfronts (see frontage.ts). */
  frontages?: Frontages;
};

/** Extrudes every visible building and part and merges them into the chunk containing each centroid. */
export function buildBuildings(data: { osm: OsmData; dem: Raster; dsm: Raster }, grid: Grid, opts: BuildOptions = {}): BuildingsResult {
  const overrides = opts.overrides ?? new Overrides('none');
  const solids = collectSolids(data.osm);
  const { visible, hidden } = visibleSolids(solids);
  const byKey = new Map(solids.map((s) => [s.key, s]));
  const counts = { height: 0, levels: 0, dsm: 0, default: 0, outlines: 0, parts: 0, hiddenOutlines: hidden.size, outside: 0, hidden: 0, blocks: 0, verandahs: 0, verandahMetres: 0, roofs: {} as Partial<Record<RoofShape, number>> };
  const chunks = new Map<string, MeshBuilder>();
  const skyline = new Map<string, MeshBuilder>();
  const chunkKey = (x: number, z: number) => `${Math.floor((x - grid.x0) / CHUNK_SIZE)},${Math.floor((z - grid.z0) / CHUNK_SIZE)}`;
  const chunkAt = (x: number, z: number) => {
    const i = Math.floor((x - grid.x0) / CHUNK_SIZE);
    const j = Math.floor((z - grid.z0) / CHUNK_SIZE);
    if (i < 0 || j < 0 || i >= grid.nx || j >= grid.nz) return null;
    const key = `${i},${j}`;
    let mb = chunks.get(key);
    if (!mb) chunks.set(key, (mb = new MeshBuilder()));
    return mb;
  };
  const buildings: ExtrudedBuilding[] = [];
  const baseCache = new Map<string, number>();
  const lowest = (s: Solid) => {
    let b = baseCache.get(s.key);
    if (b === undefined) baseCache.set(s.key, (b = lowestGround(s, data.dem)));
    return b;
  };
  // Raised buildings (layer > 0) standing on a bridge deck: the bus shelters on the K Road bridge.
  const deckUnder = new Map<string, number>();
  for (const s of solids) {
    const layer = Number(s.tags.layer);
    if (!(layer > 0) || !opts.deckAt) continue;
    const d = opts.deckAt(s.centroid.x, s.centroid.z);
    if (d !== null && d > lowest(s) + 2) deckUnder.set(s.key, d);
  }
  const baseOf = (s: Solid) => deckUnder.get(s.key) ?? lowest(s) - BASE_SINK;
  // Overrides that hide an outline hide its parts too.
  const hideKey = (s: Solid) => !!(overrides.get(s.key)?.hide || (s.parent && overrides.get(s.parent)?.hide));
  // Tallest point of each outline's family, so a podium's colour family follows its tower.
  const familyTop = new Map<string, number>();
  const heights = new Map<string, SolidHeight>();
  for (const s of visible) {
    const h = solidHeight(s, data.dem, data.dsm, deckUnder.get(s.key) ?? null);
    heights.set(s.key, h);
    const fam = s.parent ?? s.key;
    familyTop.set(fam, Math.max(familyTop.get(fam) ?? 0, h.height));
  }
  const famTopAbs = new Map<string, number>();
  const cover = new Footprints();
  // First where everything stands, then the meshes: walls are shaded by the buildings around them.
  type Placed = { s: Solid; h: SolidHeight; mb: MeshBuilder; base: number; bottom: number; top: number; grounded: boolean; famTags: Tags; fam: string; hide: boolean; roof: RoofChoice | null };
  const placed: Placed[] = [];
  for (const s of visible) {
    const h = heights.get(s.key)!;
    if (h.minHeight >= h.height - 0.1) continue;
    const mb = chunkAt(s.centroid.x, s.centroid.z);
    if (!mb) {
      counts.outside++;
      continue;
    }
    const parent = s.parent ? byKey.get(s.parent) : undefined;
    // Parts share their outline's base so podium, shaft and pod line up.
    const base = parent ? Math.min(baseOf(parent), baseOf(s)) : baseOf(s);
    const grounded = h.minHeight < 0.5;
    const bottom = grounded ? base : base + h.minHeight;
    const fam = s.parent ?? s.key;
    const roof = grounded && !hideKey(s) ? chooseRoof(s, h, data.dsm, bottom, base + h.height, familyTop.get(fam)!) : null;
    if (roof) counts.roofs[roof.shape] = (counts.roofs[roof.shape] ?? 0) + 1;
    const top = roof ? roof.eave : base + h.height;
    famTopAbs.set(fam, Math.max(famTopAbs.get(fam) ?? -Infinity, roof ? roof.ridge : top));
    const famTags = parent && !s.tags['building:colour'] ? { ...parent.tags, ...s.tags } : s.tags;
    const hide = hideKey(s);
    const o = overrides.get(s.key);
    const po = s.parent ? overrides.get(s.parent) : undefined;
    // A hidden building keeps its collider unless told otherwise.
    if (hide && (o?.block === false || po?.block === false)) {
      counts.hidden++;
      continue;
    }
    placed.push({ s, h, mb, base, bottom, top, grounded, famTags, fam, hide, roof });
  }
  // Occluders for the canyon shading: drawn, standing on the ground, more than a kiosk.
  const occluders = new Footprints<Placed>();
  for (const p of placed) if (!p.hide && p.grounded && p.top - p.bottom > 2.5) occluders.add(p.s, p);
  const across = (x: number, z: number, self: unknown) => {
    let best = -Infinity;
    const me = self as Placed;
    for (const p of occluders.at(x, z)) if (p.fam !== me.fam && p.top > best && inSolid(p.s, x, z)) best = p.top;
    return best;
  };
  // Shops, cafes and bars mapped as points: a building with any gets shopfronts.
  const shopPts: Local[] = [];
  for (const n of data.osm.nodes.values()) {
    const t = n.tags;
    if (t.shop || ['cafe', 'restaurant', 'fast_food', 'bar', 'pub', 'bank', 'pharmacy'].includes(t.amenity ?? '')) shopPts.push(lonLatToLocal(n.lon, n.lat));
  }
  const shopGrid = new Map<string, Local[]>();
  for (const q of shopPts) {
    const k = `${Math.floor(q.x / 32)},${Math.floor(q.z / 32)}`;
    if (!shopGrid.has(k)) shopGrid.set(k, []);
    shopGrid.get(k)!.push(q);
  }
  const shopsIn = (s: Solid) => {
    const pts = s.polygons.flatMap((p) => p.outer);
    let count = 0;
    for (let i = Math.floor(Math.min(...pts.map((p) => p.x)) / 32); i <= Math.floor(Math.max(...pts.map((p) => p.x)) / 32); i++) {
      for (let j = Math.floor(Math.min(...pts.map((p) => p.z)) / 32); j <= Math.floor(Math.max(...pts.map((p) => p.z)) / 32); j++) {
        for (const q of shopGrid.get(`${i},${j}`) ?? []) if (inSolid(s, q.x, q.z)) count++;
      }
    }
    return count;
  };
  const familyShops = new Map<string, number>();
  const familyRetail = new Map<string, boolean>();
  for (const p of placed) {
    familyShops.set(p.fam, (familyShops.get(p.fam) ?? 0) + shopsIn(byKey.get(p.fam) ?? p.s));
    if (!opts.frontages || familyRetail.get(p.fam)) continue;
    let retail = false;
    for (const poly of p.s.polygons) {
      for (let k = 0; k < poly.outer.length && !retail; k++) {
        const a = poly.outer[k];
        const b = poly.outer[(k + 1) % poly.outer.length];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len > 2) retail = !!opts.frontages.facing(a, b, [(b.z - a.z) / len, 0, -(b.x - a.x) / len])?.retail;
      }
    }
    familyRetail.set(p.fam, retail);
  }
  const ground = (x: number, z: number) => groundCm(data.dem, x, z) / 100;
  for (const p of placed) {
    const { s, h, mb, bottom, top, grounded, famTags, fam, hide } = p;
    const canopy = isCanopy(s.tags);
    const style = facadeStyle(fam, famTags, familyTop.get(fam)!, familyRetail.get(fam) ?? false, familyShops.get(fam) ?? 0);
    const wall = wallColour(fam, famTags, style);
    const roof = p.roof?.colour ?? roofColour(s.key, famTags, wall);
    const pitched = p.roof?.pitched;
    const shopLayer: Layer | null = style.ground === 'lobby' ? 'lobby' : style.ground === 'shop' ? (style.heritage ? 'shop-heritage' : 'shop') : null;
    const look: Look = {
      shade: canyonShade(across, p),
      floor: style.floor,
      groundFloor: style.ground === 'lobby' ? 5 : style.ground === 'shop' ? 4.2 : BASE_BAND,
      groundAt: ground,
      parapet: grounded && !canopy && top - bottom > 5 ? (style.heritage ? 1.2 : 0.8) : 0,
      wall: (a, b, n, len) => {
        if (canopy || len < 1.5) return { upper: 'plain', ground: null };
        // A party wall: another building right against it.
        const mx = (a.x + b.x) / 2 + n[0] * 0.8;
        const mz = (a.z + b.z) / 2 + n[2] * 0.8;
        // (Only where it's nearly as tall: above a lower neighbour the facade carries on.)
        if (across(mx, mz, p) > top - 4) return { upper: 'plain', ground: null };
        const front = shopLayer && opts.frontages?.facing(a, b, n);
        return { upper: style.upper, ground: front ? shopLayer : null };
      },
    };
    mb.prism(s, bottom, top, wall, roof, grounded, !hide, look, pitched);
    // Tall buildings again for the always-loaded far skyline: no shopfronts or parapets.
    if (!hide && familyTop.get(fam)! >= SKYLINE_MIN) {
      const key = chunkKey(s.centroid.x, s.centroid.z);
      if (!skyline.has(key)) skyline.set(key, new MeshBuilder());
      skyline.get(key)!.prism(s, bottom, top, wall, roof, grounded, true, { ...look, parapet: 0, groundFloor: BASE_BAND, wall: (_a, _b, _n, len) => ({ upper: canopy || len < 1.5 ? 'plain' : style.upper, ground: null }) }, pitched);
    }
    // Verandahs over the footpath along shopfronts on retail streets.
    if (!hide && !canopy && grounded && style.ground === 'shop' && top - bottom > 5 && opts.frontages) {
      const fascia = rgb(FASCIAS[Math.floor(hash(fam, 9) * FASCIAS.length)]);
      for (const poly of s.polygons) {
        const ring = poly.outer;
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k];
          const b = ring[(k + 1) % ring.length];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          if (len < 2.5) continue;
          const n = [(b.z - a.z) / len, 0, -(b.x - a.x) / len];
          const front = opts.frontages.facing(a, b, n);
          if (!front || !(front.retail || (familyShops.get(fam) ?? 0) > 0) || front.highway === 'pedestrian') continue;
          const depth = Math.min(VERANDAH_DEPTH, front.kerb - VERANDAH_KERB);
          if (depth < 1.2) continue;
          mb.detail(() => mb.verandah(a, b, n, depth, VERANDAH_HEIGHT, ground, fascia, style.heritage && hash(fam, 10) < 0.5));
          counts.verandahs++;
          counts.verandahMetres += len;
        }
      }
    }
    // Plant rooms on tower roofs.
    if (!hide && !canopy && !pitched && top - p.base > 40 && s.area > 400 && inSolid(s, s.centroid.x, s.centroid.z)) {
      const ring = s.polygons[0].outer;
      let angle = 0;
      let longest = 0;
      for (let k = 0; k < ring.length; k++) {
        const q = ring[(k + 1) % ring.length];
        const d = Math.hypot(q.x - ring[k].x, q.z - ring[k].z);
        if (d > longest) [longest, angle] = [d, Math.atan2(q.z - ring[k].z, q.x - ring[k].x)];
      }
      const half = Math.min(7, Math.sqrt(s.area) * 0.18);
      mb.detail(() => mb.box(s.centroid.x, s.centroid.z, half, half * 0.7, angle, top, 3.5, rgb(0xb4b2ac), 'plain'));
    }
    if (grounded && !hide && top - bottom > 2.5) cover.add(s);
    if (hide) counts.hidden++;
    counts[h.source]++;
    if (s.isPart) counts.parts++;
    else counts.outlines++;
    buildings.push({ key: s.key, base: p.base, bottom, top: p.roof ? p.roof.ridge : top, source: h.source });
  }

  // Landmarks: where they stand, for the hand-made models.
  const landmarks: Landmark[] = [];
  for (const s of solids) {
    const o = overrides.get(s.key);
    if (!o?.landmark) continue;
    const big = s.polygons.reduce((a, b) => (Math.abs(signedArea(b.outer)) > Math.abs(signedArea(a.outer)) ? b : a));
    const r1 = (v: number) => Math.round(v * 10) / 10;
    landmarks.push({
      id: o.landmark,
      osm: longKey(s.key),
      ...(s.tags.name ? { name: s.tags.name } : {}),
      x: r1(s.centroid.x),
      z: r1(s.centroid.z),
      base: r1(lowest(s)),
      top: r1(famTopAbs.get(s.key) ?? lowest(s) + (heights.get(s.key)?.height ?? solidHeight(s, data.dem, data.dsm).height)),
      footprint: big.outer.map((p) => [r1(p.x), r1(p.z)]),
      hidden: !!o.hide,
    });
  }
  landmarks.sort((a, b) => a.id.localeCompare(b.id) || a.osm.localeCompare(b.osm));

  counts.blocks = addBlocks(data, overrides, new Set(solids.map((s) => s.key)), chunkAt);
  return { chunks, skyline, buildings, landmarks, counts, covers: (x, z) => cover.covers(x, z) };
}

/** Default height of an invisible block (a road block, a fence line), m. */
const BLOCK_HEIGHT = 2;
const BLOCK_THICKNESS = 0.5;

/**
 * Invisible colliders from `block` overrides on anything that isn't a
 * building (buildings are solid already; a hidden one keeps its collider):
 * an area becomes a prism, a line a thin wall following it.
 */
function addBlocks(
  data: { osm: OsmData; dem: Raster },
  overrides: Overrides,
  buildingKeys: Set<string>,
  chunkAt: (x: number, z: number) => MeshBuilder | null,
): number {
  let n = 0;
  const ground = (x: number, z: number) => groundCm(data.dem, x, z) / 100;
  for (const key of overrides.keys()) {
    const o = overrides.get(key)!;
    if (!o.block || o.delete) continue;
    const [type, idStr] = key.split('/');
    const short = `${type[0]}${idStr}`;
    if (buildingKeys.has(short)) continue;
    const height = typeof o.block === 'number' ? o.block : BLOCK_HEIGHT;
    let rings: Ring[] = [];
    let line: Ring | null = null;
    if (type === 'way') {
      const way = data.osm.ways.get(Number(idStr));
      const pts = way && nodesLocal(data.osm, way.nodes);
      if (!way || !pts) continue;
      if (way.nodes.length >= 4 && way.nodes[0] === way.nodes[way.nodes.length - 1]) {
        const r = cleanRing(pts, true);
        if (r) rings = [r];
      } else line = pts;
    } else {
      const rel = data.osm.relations.get(Number(idStr));
      if (!rel) continue;
      const ways = rel.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => data.osm.ways.get(m.ref)).filter((w): w is OsmWay => !!w);
      rings = assembleRings(ways).map((r) => nodesLocal(data.osm, r)).map((r) => r && cleanRing(r, true)).filter((r): r is Ring => !!r);
    }
    for (const outer of rings) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of outer) {
        lo = Math.min(lo, ground(p.x, p.z));
        hi = Math.max(hi, ground(p.x, p.z));
      }
      const c = ringCentroid(outer);
      chunkAt(c.x, c.z)?.colliderPrism([{ outer, holes: [] }], lo - BASE_SINK, hi + height);
    }
    if (line) {
      for (let k = 0; k + 1 < line.length; k++) {
        const a = line[k];
        const b = line[k + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 0.05) continue;
        const nx = ((b.z - a.z) / len) * (BLOCK_THICKNESS / 2);
        const nz = (-(b.x - a.x) / len) * (BLOCK_THICKNESS / 2);
        const quad: Ring = [{ x: a.x + nx, z: a.z + nz }, { x: b.x + nx, z: b.z + nz }, { x: b.x - nx, z: b.z - nz }, { x: a.x - nx, z: a.z - nz }];
        if (signedArea(quad) < 0) quad.reverse();
        const lo = Math.min(ground(a.x, a.z), ground(b.x, b.z));
        const hi = Math.max(ground(a.x, a.z), ground(b.x, b.z));
        chunkAt((a.x + b.x) / 2, (a.z + b.z) / 2)?.colliderPrism([{ outer: quad, holes: [] }], lo - BASE_SINK, hi + height);
      }
    }
    n++;
  }
  return n;
}
