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

/**
 * Wall colour (linear RGB) for a building: picked from a palette by height
 * and type, deterministic per OSM id. A `building:colour` tag pulls it most
 * of the way towards the mapped colour.
 */
function wallColour(key: string, tags: Tags, height: number): [number, number, number] {
  const r = hash(key);
  const heritage = tags.heritage !== undefined || tags['ref:nz:heritage'] !== undefined || tags.historic !== undefined;
  const glassy = tags['building:material'] === 'glass' || tags['building:facade:material'] === 'glass';
  let palette: number[];
  if (glassy) palette = GLASS;
  else if (heritage) palette = r < 0.55 ? SANDSTONE : BRICK;
  else if (height >= 45) palette = r < 0.6 ? GLASS : CONCRETE;
  else if (height > 15) palette = r < 0.45 ? CONCRETE : r < 0.75 ? SANDSTONE : r < 0.9 ? GLASS : BRICK;
  else palette = r < 0.35 ? BRICK : r < 0.6 ? SANDSTONE : r < 0.8 ? PAINTED : CONCRETE;
  let c = rgb(palette[Math.floor(hash(key, 1) * palette.length)]);
  const tagged = tagColour(tags['building:colour']);
  if (tagged !== null) c = mix(c, rgb(tagged), 0.6);
  const jitter = 0.92 + 0.14 * hash(key, 2);
  return c.map((v) => v * jitter) as [number, number, number];
}

function roofColour(key: string, tags: Tags, wall: [number, number, number]): [number, number, number] {
  const tagged = tagColour(tags['roof:colour']);
  // Roofs a little darker and greyer than the walls: they read as tops from the street and from the air.
  const base = mix(wall, rgb(0x8a8984), 0.35).map((v) => v * 0.8) as [number, number, number];
  return tagged !== null ? mix(base, rgb(tagged), 0.5) : base.map((v) => v * (0.95 + 0.1 * hash(key, 3))) as [number, number, number];
}

// ---------------------------------------------------------------- meshing

/** Accumulates one chunk's merged mesh in absolute local metres. */
export class MeshBuilder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  readonly colliderIdx: number[] = [];
  /** Per-vertex draw layer (roads only; buildings leave it all 0 and the file omits it). */
  readonly lay: number[] = [];

  get vertexCount() {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, n: readonly number[], c: readonly number[], layer = 0): number {
    this.pos.push(x, y, z);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    this.lay.push(layer);
    return this.pos.length / 3 - 1;
  }

  /**
   * One footprint as a prism from `bottom` to `top`. Ground-level walls get
   * an extra row of vertices BASE_BAND up so the darkening at their foot
   * stays near the street instead of fading over the whole tower.
   */
  prism(s: Pick<Solid, 'polygons'>, bottom: number, top: number, wall: [number, number, number], roof: [number, number, number], grounded: boolean, visible = true) {
    if (!visible) {
      this.colliderPrism(s.polygons, bottom, top);
      return;
    }
    const band = grounded && top - bottom > BASE_BAND * 2;
    const foot = wall.map((v) => v * (grounded ? 0.55 : 0.85));
    const mid = wall.map((v) => v * 0.93);
    const crown = wall.map((v) => v * 1.04);
    for (const poly of s.polygons) {
      for (const ring of [poly.outer, ...poly.holes]) {
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k];
          const b = ring[(k + 1) % ring.length];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          const n: [number, number, number] = [(b.z - a.z) / len, 0, -(b.x - a.x) / len];
          const a0 = this.vertex(a.x, bottom, a.z, n, foot);
          const b0 = this.vertex(b.x, bottom, b.z, n, foot);
          const a1 = this.vertex(a.x, top, a.z, n, crown);
          const b1 = this.vertex(b.x, top, b.z, n, crown);
          // Outward-facing (counter-clockwise seen from outside) for rings wound as cleanRing() leaves them.
          if (band) {
            const ys = bottom + BASE_BAND;
            const am = this.vertex(a.x, ys, a.z, n, mid);
            const bm = this.vertex(b.x, ys, b.z, n, mid);
            this.idx.push(a0, bm, b0, a0, am, bm, am, b1, bm, am, a1, b1);
          } else {
            this.idx.push(a0, b1, b0, a0, a1, b1);
          }
          this.colliderIdx.push(a0, b1, b0, a0, a1, b1);
        }
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
      const faces: [number, number[], [number, number, number], boolean][] = [[top, roof, [0, 1, 0], true]];
      if (!grounded) faces.push([bottom, roof.map((v) => v * 0.7), [0, -1, 0], false]);
      for (const [y, c, n, up] of faces) {
        const first = this.vertexCount;
        for (let k = 0; k < flat.length; k += 2) this.vertex(flat[k], y, flat[k + 1], n, c);
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
   * An invisible solid: walls and a lid in the collider only (its vertices
   * ride along in the render buffers but no drawn triangle uses them).
   */
  colliderPrism(polygons: Polygon[], bottom: number, top: number) {
    const none = [0, 0, 0] as const;
    for (const poly of polygons) {
      for (const ring of [poly.outer, ...poly.holes]) {
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k];
          const b = ring[(k + 1) % ring.length];
          const a0 = this.vertex(a.x, bottom, a.z, none, none);
          const b0 = this.vertex(b.x, bottom, b.z, none, none);
          const a1 = this.vertex(a.x, top, a.z, none, none);
          const b1 = this.vertex(b.x, top, b.z, none, none);
          this.colliderIdx.push(a0, b1, b0, a0, a1, b1);
        }
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
    return { xCm, zCm, yCm, baseCm: base, normals, colours, indices: Uint32Array.from(this.idx), colliderIndices: Uint32Array.from(this.colliderIdx), layers };
  }
}

export type BuildingsResult = {
  /** Per chunk "i,j" -> merged mesh builder. */
  chunks: Map<string, MeshBuilder>;
  buildings: ExtrudedBuilding[];
  landmarks: Landmark[];
  counts: Record<HeightSource, number> & { outlines: number; parts: number; hiddenOutlines: number; outside: number; hidden: number; blocks: number };
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
};

/** Extrudes every visible building and part and merges them into the chunk containing each centroid. */
export function buildBuildings(data: { osm: OsmData; dem: Raster; dsm: Raster }, grid: Grid, opts: BuildOptions = {}): BuildingsResult {
  const overrides = opts.overrides ?? new Overrides('none');
  const solids = collectSolids(data.osm);
  const { visible, hidden } = visibleSolids(solids);
  const byKey = new Map(solids.map((s) => [s.key, s]));
  const counts = { height: 0, levels: 0, dsm: 0, default: 0, outlines: 0, parts: 0, hiddenOutlines: hidden.size, outside: 0, hidden: 0, blocks: 0 };
  const chunks = new Map<string, MeshBuilder>();
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
    const top = base + h.height;
    const fam = s.parent ?? s.key;
    famTopAbs.set(fam, Math.max(famTopAbs.get(fam) ?? -Infinity, top));
    const famTags = parent && !s.tags['building:colour'] ? { ...parent.tags, ...s.tags } : s.tags;
    const wall = wallColour(fam, famTags, familyTop.get(fam)!);
    const roof = roofColour(s.key, famTags, wall);
    const hide = hideKey(s);
    const o = overrides.get(s.key);
    const po = s.parent ? overrides.get(s.parent) : undefined;
    // A hidden building keeps its collider unless told otherwise.
    if (hide && (o?.block === false || po?.block === false)) {
      counts.hidden++;
      continue;
    }
    mb.prism(s, bottom, top, wall, roof, grounded, !hide);
    if (hide) counts.hidden++;
    counts[h.source]++;
    if (s.isPart) counts.parts++;
    else counts.outlines++;
    buildings.push({ key: s.key, base, bottom, top, source: h.source });
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
  return { chunks, buildings, landmarks, counts };
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
