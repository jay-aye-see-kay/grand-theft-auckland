// Park edges: the walls, fences, hedges and retaining walls OSM maps along
// parks and gardens, and a low hedge where a park meets a street's
// footpath with nothing mapped there (hedges are barely mapped), so parks
// read as bounded spaces rather than lawn spilling onto the footpath.
//
// Only the stretches that border green ground are drawn: the city has
// kilometres of fencing round car parks, building sites and motorways, and
// the street views can't afford it (guard rails and the like belong with
// the street furniture). Retaining walls are drawn wherever the ground
// steps more than a metre across them, as a face over the LiDAR's slope.
//
// Everything goes in the building chunks' tree tiles (drawn within 200 m).
// Walls, retaining walls and mapped hedges are solid; fences and the
// default hedges are only drawn (the car goes through them, GTA-style).
import { SURFACE_ID } from '../../src/city/format.ts';
import { assembleRings, MeshBuilder, nodesLocal, parseLength, rgb } from './buildings.ts';
import { hash } from './eras.ts';
import type { GroundRaster } from './ground.ts';
import type { OsmData, OsmWay, Tags } from './osm.ts';
import { lonLatToLocal, type Local } from './project.ts';
import type { Grid, TerrainSampler } from './terrain.ts';
import { inTreeTile } from './trees.ts';

type Kind = 'wall' | 'fence' | 'hedge' | 'retaining_wall' | 'edging';

/** Sampling step along a line, m. */
const STEP = 1;
/** Green this close (m) to either side of a barrier makes it a park edge. */
const GREEN_REACH = 4;
/** Runs shorter than this aren't drawn, m: the default edging's are longer, as a scrap of hedge looks dropped there. */
const MIN_RUN = 2;
const MIN_EDGING = 6;
/** Pieces follow the ground in steps of at most this, m. */
const PIECE = 6;
/** Fence posts this far apart, m. */
const POST_SPACING = 2.5;
/** How far the foot of a barrier goes into the ground, so it never floats on a slope. */
const FOOT = 0.3;
/** A retaining wall is drawn where the ground across it (RETAIN_PROBE m each side) steps more than RETAIN_DROP m. */
const RETAIN_PROBE = 1.5;
const RETAIN_DROP = 1;
/** Default park edging: a low hedge this far in from the park's edge, m. */
const EDGING_INSET = 0.6;
/** Gates, paths and mapped barriers this close leave a gap in the default edging, m. */
const EDGING_GAP = 3;

const GREEN = new Set([SURFACE_ID.grass, SURFACE_ID.flowerbed, SURFACE_ID.trees]);
const PAVED = new Set([SURFACE_ID.footpath, SURFACE_ID.paving, SURFACE_ID.road]);

/** `leafy`: a hedge, whose top catches the sun while its sides are in its own shade. */
type Style = { height: number; width: number; colour: [number, number, number]; solid: boolean; leafy?: boolean };
const STYLE: Record<Kind, Style> = {
  wall: { height: 1.2, width: 0.3, colour: rgb(0x8f887c), solid: true },
  retaining_wall: { height: 0.3, width: 0.4, colour: rgb(0x7d776c), solid: true }, // height: above the upper ground
  fence: { height: 1.4, width: 0.05, colour: rgb(0x45494b), solid: false },
  hedge: { height: 1.2, width: 0.8, colour: rgb(0x3d6a2e), solid: true, leafy: true },
  edging: { height: 0.8, width: 0.7, colour: rgb(0x40702f), solid: false, leafy: true },
};
const WOOD = rgb(0x84664a);

type Ctx = {
  grid: Grid;
  terrain: TerrainSampler;
  ground: GroundRaster;
  covers: (x: number, z: number) => boolean;
  chunkAt: (x: number, z: number) => MeshBuilder | null;
};

/** A run to draw: points STEP m apart along the line, and how to draw it. */
type Run = { pts: Local[]; kind: Kind; style: Style; key: string };

export function buildBarriers(osm: OsmData, ctx: Ctx) {
  const runs: Run[] = [];
  const mapped: Local[] = [];
  const counts: Record<string, number> = {};
  for (const id of [...osm.ways.keys()].sort((a, b) => a - b)) {
    const w = osm.ways.get(id)!;
    const kind = barrierKind(w.tags);
    if (!kind) continue;
    const line = nodesLocal(osm, w.nodes);
    if (!line) continue;
    const pts = resample(line);
    mapped.push(...pts);
    const style = styleOf(kind, w.tags);
    for (const run of splitRuns(pts, (p, n) => keep(kind, p, n, ctx))) runs.push({ pts: run, kind, style, key: `w${id}` });
  }
  const gates: Local[] = [];
  for (const n of osm.nodes.values()) if (n.tags?.barrier === 'gate' || n.tags?.barrier === 'entrance') gates.push(lonLatToLocal(n.lon, n.lat));
  runs.push(...edging(osm, ctx, [...mapped, ...gates]));

  for (const run of runs) counts[run.kind] = (counts[run.kind] ?? 0) + emitRun(run, ctx);
  return { metres: counts, tris: barrierTris };
}

function barrierKind(t: Tags): Kind | null {
  if (t.indoor === 'yes' || t.location === 'underground' || Number(t.layer) < 0) return null;
  const b = t.barrier;
  if (b === 'wall' || b === 'city_wall') return 'wall';
  if (b === 'fence' || b === 'railing' || b === 'handrail') return t.fence_type === 'hoarding' ? null : 'fence';
  if (b === 'hedge') return 'hedge';
  if (b === 'retaining_wall') return 'retaining_wall';
  return null;
}

function styleOf(kind: Kind, t: Tags): Style {
  const base = STYLE[kind];
  const tagged = parseLength(t.height);
  const height = kind !== 'retaining_wall' && tagged >= 0.3 && tagged <= 3 ? tagged : base.height;
  const wood = t.fence_type === 'wood' || t.material === 'wood';
  return { ...base, height, colour: kind === 'fence' && wood ? WOOD : base.colour };
}

/** Points every STEP m along a polyline, ends included. */
function resample(line: Local[]): Local[] {
  const out: Local[] = [line[0]];
  for (let k = 0; k + 1 < line.length; k++) {
    const a = line[k];
    const b = line[k + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(len / STEP));
    for (let s = 1; s <= n; s++) out.push({ x: a.x + ((b.x - a.x) * s) / n, z: a.z + ((b.z - a.z) * s) / n });
  }
  return out;
}

/** The unit normal (left of travel) at point k of a sampled line. */
function normalAt(pts: Local[], k: number): Local {
  const a = pts[Math.max(0, k - 1)];
  const b = pts[Math.min(pts.length - 1, k + 1)];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: -(b.z - a.z) / len, z: (b.x - a.x) / len };
}

/** Consecutive points that pass `ok`, as runs at least MIN_RUN long. */
function splitRuns(pts: Local[], ok: (p: Local, n: Local) => boolean): Local[][] {
  const runs: Local[][] = [];
  let cur: Local[] = [];
  const flush = () => {
    if (cur.length * STEP > MIN_RUN) runs.push(cur);
    cur = [];
  };
  for (let k = 0; k < pts.length; k++) {
    if (ok(pts[k], normalAt(pts, k))) cur.push(pts[k]);
    else flush();
  }
  flush();
  return runs;
}

/** Whether a mapped barrier's point is drawn: on open ground, and a park edge (or, for retaining walls, a real step). */
function keep(kind: Kind, p: Local, n: Local, ctx: Ctx): boolean {
  const { ground, covers, terrain } = ctx;
  if (ground.at(p.x, p.z) === SURFACE_ID.road || covers(p.x, p.z)) return false;
  if (kind === 'retaining_wall') {
    const a = terrain.heightAt(p.x + n.x * RETAIN_PROBE, p.z + n.z * RETAIN_PROBE);
    const b = terrain.heightAt(p.x - n.x * RETAIN_PROBE, p.z - n.z * RETAIN_PROBE);
    return Math.abs(a - b) > RETAIN_DROP;
  }
  for (let d = 0; d <= GREEN_REACH; d += 2) {
    if (GREEN.has(ground.at(p.x + n.x * d, p.z + n.z * d)) || GREEN.has(ground.at(p.x - n.x * d, p.z - n.z * d))) return true;
  }
  return false;
}

/**
 * Default edging: along each park or garden's boundary, wherever lawn
 * meets a footpath or street just outside it, a low hedge set in on the
 * lawn side. Gaps where paths come in, at gates, and where OSM maps a
 * barrier already.
 */
function edging(osm: OsmData, ctx: Ctx, avoid: Local[]): Run[] {
  const { ground, covers } = ctx;
  // Bucketed by 10 m for the gap lookups.
  const cells = new Map<string, Local[]>();
  for (const p of avoid) {
    const k = `${Math.floor(p.x / 10)},${Math.floor(p.z / 10)}`;
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(p);
  }
  const nearAvoid = (p: Local) => {
    for (let i = Math.floor((p.x - EDGING_GAP) / 10); i <= Math.floor((p.x + EDGING_GAP) / 10); i++) {
      for (let j = Math.floor((p.z - EDGING_GAP) / 10); j <= Math.floor((p.z + EDGING_GAP) / 10); j++) {
        for (const q of cells.get(`${i},${j}`) ?? []) if (Math.hypot(q.x - p.x, q.z - p.z) < EDGING_GAP) return true;
      }
    }
    return false;
  };
  const nearPath = (p: Local) => {
    for (let dx = -EDGING_GAP; dx <= EDGING_GAP; dx += 1) {
      for (let dz = -EDGING_GAP; dz <= EDGING_GAP; dz += 1) if (ground.at(p.x + dx, p.z + dz) === SURFACE_ID.path) return true;
    }
    return false;
  };
  const rings: { ring: Local[]; key: string }[] = [];
  const isPark = (t: Tags) => t.leisure === 'park' || t.leisure === 'garden';
  const viaRelation = new Set<number>();
  for (const [id, rel] of [...osm.relations].sort((a, b) => a[0] - b[0])) {
    if (rel.tags.type !== 'multipolygon' || !isPark(rel.tags)) continue;
    const ways: OsmWay[] = [];
    for (const m of rel.members) {
      const w = m.type === 'way' ? osm.ways.get(m.ref) : undefined;
      if (w) ways.push(w);
      if (w) viaRelation.add(w.id);
    }
    for (const nodes of assembleRings(ways)) {
      const ring = nodesLocal(osm, nodes);
      if (ring) rings.push({ ring, key: `r${id}` });
    }
  }
  for (const id of [...osm.ways.keys()].sort((a, b) => a - b)) {
    const w = osm.ways.get(id)!;
    if (!isPark(w.tags) || viaRelation.has(id) || w.nodes.length < 4 || w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue;
    const ring = nodesLocal(osm, w.nodes);
    if (ring) rings.push({ ring, key: `w${id}` });
  }
  const runs: Run[] = [];
  for (const { ring, key } of rings) {
    const pts = resample(ring);
    // Which side is the park: the one with green just in, and paving just out.
    const side = (p: Local, n: Local) => {
      for (const s of [1, -1]) {
        const inside = ground.at(p.x + n.x * s * 1.5, p.z + n.z * s * 1.5);
        const outside = [1, 2, 3].map((d) => ground.at(p.x - n.x * s * d, p.z - n.z * s * d));
        if (GREEN.has(inside) && outside.some((c) => PAVED.has(c))) return s;
      }
      return 0;
    };
    const inset: Local[] = [];
    const ok: boolean[] = [];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const n = normalAt(pts, k);
      const s = side(p, n);
      const q = { x: p.x + n.x * s * EDGING_INSET, z: p.z + n.z * s * EDGING_INSET };
      inset.push(q);
      ok.push(s !== 0 && !covers(q.x, q.z) && !nearPath(p) && !nearAvoid(p));
    }
    let cur: Local[] = [];
    const flush = () => {
      if (cur.length * STEP > MIN_EDGING) runs.push({ pts: cur, kind: 'edging', style: STYLE.edging, key });
      cur = [];
    };
    for (let k = 0; k < pts.length; k++) {
      if (ok[k]) cur.push(inset[k]);
      else flush();
    }
    flush();
  }
  return runs;
}

// ---------------------------------------------------------------- models

/** Triangles drawn and solid, for the build log. */
export const barrierTris = { drawn: 0, solid: 0 };

/** Draws a run in its chunk's tree tiles, piece by piece; returns its length, m. */
function emitRun(run: Run, ctx: Ctx): number {
  const { pts, style } = run;
  // Pieces of up to PIECE m between kept points, each in the tile of its middle.
  const every = Math.max(1, Math.round(PIECE / STEP));
  const knots: number[] = [];
  for (let k = 0; k < pts.length - 1; k += every) knots.push(k);
  knots.push(pts.length - 1);
  let metres = 0;
  for (let q = 0; q + 1 < knots.length; q++) {
    const a = pts[knots[q]];
    const b = pts[knots[q + 1]];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.05) continue;
    metres += len;
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const mb = ctx.chunkAt(mid.x, mid.z);
    if (!mb) continue;
    const shade = 0.9 + 0.2 * hash(`${run.key}:${q}`, 3);
    const colour = style.colour.map((c) => c * shade);
    inTreeTile(mb, ctx.grid, mid.x, mid.z, () => {
      if (run.kind === 'fence') fence(mb, a, b, style, colour, ctx.terrain, q === 0);
      else if (run.kind === 'retaining_wall') retaining(mb, a, b, style, colour, ctx.terrain, q === 0, q + 2 === knots.length);
      else wall(mb, a, b, style, colour, ctx.terrain, q === 0, q + 2 === knots.length);
    });
  }
  return metres;
}

type V3 = [number, number, number];

/** A quad a-b-c-d (counter-clockwise from its front), drawn and, if `solid`, in the collider. */
function quad(mb: MeshBuilder, p: V3[], n: readonly number[], colour: readonly number[], shades: number[], solid: boolean) {
  const v = p.map((q, k) => mb.vertex(q[0], q[1], q[2], n, colour, 0, 0, 0, 0, shades[k]));
  const tri = [v[0], v[1], v[2], v[0], v[2], v[3]];
  mb.idx.push(...tri);
  barrierTris.drawn += 2;
  if (solid) {
    mb.colliderIdx.push(...tri);
    barrierTris.solid += 2;
  }
}

/** Height of a slab's foot and top at one end of a piece. */
type Span = { foot: number; top: number };

/**
 * A wall or hedge piece from a to b, `width` thick: two sides and a top,
 * plus end caps at a run's ends. Left of travel is (-uz, ux); every face
 * winds counter-clockwise seen from outside.
 */
function slab(mb: MeshBuilder, a: Local, b: Local, width: number, sa: Span, sb: Span, colour: readonly number[], solid: boolean, capA: boolean, capB: boolean, topLight = 1.05) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const ux = (b.x - a.x) / len;
  const uz = (b.z - a.z) / len;
  const hw = width / 2;
  /** Point p offset to the left (s = 1) or right (s = -1), at height y. */
  const at = (p: Local, s: number, y: number): V3 => [p.x - uz * hw * s, y, p.z + ux * hw * s];
  const lit = [0.75, 0.75, 1, 1];
  quad(mb, [at(a, 1, sa.foot), at(b, 1, sb.foot), at(b, 1, sb.top), at(a, 1, sa.top)], [-uz, 0, ux], colour, lit, solid);
  quad(mb, [at(b, -1, sb.foot), at(a, -1, sa.foot), at(a, -1, sa.top), at(b, -1, sb.top)], [uz, 0, -ux], colour, lit, solid);
  quad(mb, [at(a, 1, sa.top), at(b, 1, sb.top), at(b, -1, sb.top), at(a, -1, sa.top)], [0, 1, 0], colour, [topLight, topLight, topLight, topLight], solid);
  if (capA) quad(mb, [at(a, -1, sa.foot), at(a, 1, sa.foot), at(a, 1, sa.top), at(a, -1, sa.top)], [-ux, 0, -uz], colour, lit, solid);
  if (capB) quad(mb, [at(b, 1, sb.foot), at(b, -1, sb.foot), at(b, -1, sb.top), at(b, 1, sb.top)], [ux, 0, uz], colour, lit, solid);
}

/** A wall or hedge: `style.height` above the ground at each end. */
function wall(mb: MeshBuilder, a: Local, b: Local, style: Style, colour: readonly number[], terrain: TerrainSampler, capA: boolean, capB: boolean) {
  const span = (p: Local): Span => {
    const y = terrain.heightAt(p.x, p.z);
    return { foot: y - FOOT, top: y + style.height };
  };
  slab(mb, a, b, style.width, span(a), span(b), colour, style.solid, capA, capB, style.leafy ? 1.35 : 1.05);
}

/** A retaining wall: from under the lower ground across the step to `style.height` above the upper. */
function retaining(mb: MeshBuilder, a: Local, b: Local, style: Style, colour: readonly number[], terrain: TerrainSampler, capA: boolean, capB: boolean) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const nx = -(b.z - a.z) / len;
  const nz = (b.x - a.x) / len;
  const span = (p: Local): Span => {
    const y1 = terrain.heightAt(p.x + nx * RETAIN_PROBE, p.z + nz * RETAIN_PROBE);
    const y2 = terrain.heightAt(p.x - nx * RETAIN_PROBE, p.z - nz * RETAIN_PROBE);
    return { foot: Math.min(y1, y2) - FOOT, top: Math.max(y1, y2) + style.height };
  };
  slab(mb, a, b, style.width, span(a), span(b), colour, style.solid, capA, capB);
}

/** Both faces of a thin vertical strip a0-b0-b1-a1 running along u. */
function strip(mb: MeshBuilder, p: V3[], ux: number, uz: number, colour: readonly number[]) {
  quad(mb, p, [-uz, 0, ux], colour, [0.85, 0.85, 1, 1], false);
  quad(mb, [p[1], p[0], p[3], p[2]], [uz, 0, -ux], colour, [0.85, 0.85, 1, 1], false);
}

/** A fence piece from a to b: posts every POST_SPACING m, a top rail and a middle rail, all thin strips. */
function fence(mb: MeshBuilder, a: Local, b: Local, style: Style, colour: readonly number[], terrain: TerrainSampler, first: boolean) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const ux = (b.x - a.x) / len;
  const uz = (b.z - a.z) / len;
  const ya = terrain.heightAt(a.x, a.z);
  const yb = terrain.heightAt(b.x, b.z);
  const h = style.height;
  for (const [y0, y1] of [[h - 0.08, h], [h * 0.45 - 0.04, h * 0.45 + 0.04]]) {
    strip(mb, [[a.x, ya + y0, a.z], [b.x, yb + y0, b.z], [b.x, yb + y1, b.z], [a.x, ya + y1, a.z]], ux, uz, colour);
  }
  // Posts along the piece (the first piece of a run also gets one at its start).
  const posts = Math.max(1, Math.round(len / POST_SPACING));
  const w = 0.05;
  for (let k = first ? 0 : 1; k <= posts; k++) {
    const x = a.x + ((b.x - a.x) * k) / posts;
    const z = a.z + ((b.z - a.z) * k) / posts;
    const y = terrain.heightAt(x, z);
    strip(mb, [[x - ux * w, y - FOOT, z - uz * w], [x + ux * w, y - FOOT, z + uz * w], [x + ux * w, y + h + 0.05, z + uz * w], [x - ux * w, y + h + 0.05, z - uz * w]], ux, uz, colour);
  }
}
