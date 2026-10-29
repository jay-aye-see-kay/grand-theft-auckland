// Street furniture: lamps, traffic signals, bus shelters and stops, benches
// and bins, baked into the building chunks as near-only detail (no draw
// calls of their own). Where OSM maps them (the CBD has ~500 lamps, ~400
// signals, ~150 stops, ~450 benches) they go where it says; streets it
// doesn't cover get lamps every LAMP_SPACING along both kerbs, and retail
// streets get bins and benches, so every street reads as lived in.
//
// Signals stand on the left kerb of each signalled junction arm (NZ drives
// on the left), at the stop line. They're static: one axis of each junction
// shows green and the other red, so a junction reads as working.
import type { OsmData, Tags } from './osm.ts';
import { lonLatToLocal, type Local } from './project.ts';
import { hash } from './eras.ts';
import { MeshBuilder, rgb } from './buildings.ts';
import type { GroundRaster } from './ground.ts';
import type { Road, RoadNetwork } from './roads.ts';
import { RETAIL_STREETS } from './frontage.ts';
import { SURFACE_ID } from '../../src/city/format.ts';
import { CHUNK_SIZE, type Grid, type TerrainSampler } from './terrain.ts';

/** Generated lamps along a kerb, m apart (staggered between the two sides). */
const LAMP_SPACING = 40;
/** A generated lamp gives way to a mapped one this close, m. */
const LAMP_CLEAR = 14;
/** Bins and benches along retail streets, m apart. */
const SEAT_SPACING = 40;
/** Furniture stands this far in from the kerb, m. */
const KERB_SET = 0.55;
/** Nothing generated within this of a junction's centre beyond the widest way's half-width, m. */
const JUNCTION_CLEAR = 5;
/** Lamp, signal and shelter heights, m. */
const LAMP_HEIGHT = 7.5;
const SIGNAL_HEIGHT = 3.4;
/** Footpath strips' lift over the ground (roads.ts LEVELS.footpath), so things stand on them. */
const FOOTPATH_LIFT = 0.05;

const STREETS = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street']);

const POLE = rgb(0x34373a);
const SIGNAL_POLE = rgb(0x8c9092);
const SIGNAL_HEAD = rgb(0x1a1b1d);
const RED_ON = rgb(0xff4030);
const GREEN_ON = rgb(0x50ff90);
const LAMP_OFF = rgb(0x2a2c2c);
const LAMP_GLOW = rgb(0xfff2cc);
const SHELTER_FRAME = rgb(0xb4b8ba);
const SHELTER_GLASS = rgb(0xc4d6dc);
const TIMBER = rgb(0x8a6a48);
const BIN = rgb(0x2d3a33);
const STOP_SIGN = rgb(0xe8c440);
/** Lightbox posters on the shelters' ends. */
const POSTERS = [0xd94a3a, 0x2f7fc1, 0xf2c23a, 0x5aa05a, 0x8a4ab8, 0xf08a2a, 0xe8e4dc].map(rgb);

type Kind = 'lamp' | 'signal' | 'shelter' | 'stop' | 'bench' | 'bin';
/** A piece of furniture at (x, z) facing (fx, fz) (towards the road, or along the traffic it serves). */
type Prop = { kind: Kind; x: number; z: number; fx: number; fz: number; green?: boolean; seed: number };

export type FurnitureCounts = Record<Kind, number> & { mapped: number; tris: number };

/** Places and draws the furniture into the chunks' detail meshes. */
export function placeFurniture(
  osm: OsmData, net: RoadNetwork, grid: Grid, terrain: TerrainSampler, ground: GroundRaster,
  covers: (x: number, z: number) => boolean, chunkAt: (x: number, z: number) => MeshBuilder | null,
): FurnitureCounts {
  const props: Prop[] = [];
  const counts: FurnitureCounts = { lamp: 0, signal: 0, shelter: 0, stop: 0, bench: 0, bin: 0, mapped: 0, tris: 0 };
  const streets = net.roads.filter((r) => !r.bridge && r.layer === 0 && STREETS.has(r.highway));
  const nearest = nearestRoad(streets);
  // Junctions: nodes where three or more ways meet, with the room they take.
  const junctions: { p: Local; r: number }[] = [];
  for (const [n, entries] of net.byNode) {
    const ways = new Set(entries.map((e) => e.road));
    if (ways.size < 2 && entries.length < 3) continue;
    junctions.push({ p: net.at.get(n)!, r: Math.max(...entries.map((e) => e.road.width / 2)) + JUNCTION_CLEAR });
  }
  const inJunction = (x: number, z: number) => junctions.some((j) => Math.abs(j.p.x - x) < 40 && Math.hypot(j.p.x - x, j.p.z - z) < j.r);
  const free = (x: number, z: number) => !covers(x, z) && ground.at(x, z) !== SURFACE_ID.road && !inJunction(x, z);

  // Mapped furniture, in id order so the output doesn't depend on load order.
  const mappedLamps: Local[] = [];
  for (const id of [...osm.nodes.keys()].sort((a, b) => a - b)) {
    const n = osm.nodes.get(id)!;
    const t = n.tags;
    if (!t) continue;
    const kind = mappedKind(t);
    if (!kind) continue;
    let p = lonLatToLocal(n.lon, n.lat);
    const near = nearest(p);
    if (!near || near.d > 25) continue;
    // Mapped on the carriageway (or the centreline): out to the kerb on its side.
    const kerb = near.road.width / 2 + KERB_SET + (kind === 'shelter' ? 1.2 : 0);
    if (near.d < kerb) p = { x: near.px - near.nx * kerb, z: near.pz - near.nz * kerb };
    if (covers(p.x, p.z)) continue;
    // Facing the road; shelters and stops face it too (their backs to the buildings).
    props.push({ kind, x: p.x, z: p.z, fx: near.nx, fz: near.nz, seed: id });
    if (kind === 'lamp') mappedLamps.push(p);
    counts.mapped++;
  }
  const lampNear = (x: number, z: number) => mappedLamps.some((q) => Math.abs(q.x - x) < LAMP_CLEAR && Math.hypot(q.x - x, q.z - z) < LAMP_CLEAR);

  // Generated: lamps along both kerbs, bins and benches on retail streets.
  for (const r of streets) {
    const name = osm.ways.get(r.id)?.tags.name ?? '';
    const retail = RETAIL_STREETS.has(name);
    for (const side of [1, -1] as const) {
      if (!(side === 1 ? r.left : r.right)) continue;
      const kerb = r.width / 2 + KERB_SET;
      alongRoad(r, LAMP_SPACING, side === 1 ? 0 : LAMP_SPACING / 2, (p, n) => {
        const x = p.x + n.x * kerb * side;
        const z = p.z + n.z * kerb * side;
        if (free(x, z) && !lampNear(x, z)) props.push({ kind: 'lamp', x, z, fx: -n.x * side, fz: -n.z * side, seed: Math.round(x * 31 + z * 17) });
      });
      if (!retail) continue;
      alongRoad(r, SEAT_SPACING, side === 1 ? SEAT_SPACING / 4 : (SEAT_SPACING * 3) / 4, (p, n, k) => {
        const x = p.x + n.x * (kerb + 0.3) * side;
        const z = p.z + n.z * (kerb + 0.3) * side;
        if (free(x, z)) props.push({ kind: k % 2 ? 'bench' : 'bin', x, z, fx: -n.x * side, fz: -n.z * side, seed: Math.round(x * 13 + z * 7) });
      });
    }
  }

  // Signals at signalled junctions' stop lines, on the arriving traffic's left kerb.
  for (const stop of net.stops) {
    if (!stop.signalled) continue;
    const { p, n, t } = stationAt(stop.r, stop.s);
    // Travel direction and its left: n is left of the way's own direction.
    const dir = stop.dir;
    const kerb = stop.r.width / 2 + KERB_SET;
    const x = p.x + n.x * kerb * dir;
    const z = p.z + n.z * kerb * dir;
    if (covers(x, z)) continue;
    // Green for the way that runs nearer north-south, red across it.
    const green = Math.abs(t.z) > Math.abs(t.x);
    props.push({ kind: 'signal', x, z, fx: -t.x * dir, fz: -t.z * dir, green, seed: Math.round(x * 7 + z * 3) });
  }

  for (const prop of props) {
    const mb = chunkAt(prop.x, prop.z);
    if (!mb || prop.x < grid.x0 || prop.z < grid.z0 || prop.x >= grid.x0 + grid.nx * CHUNK_SIZE || prop.z >= grid.z0 + grid.nz * CHUNK_SIZE) continue;
    const y = terrain.heightAt(prop.x, prop.z) + FOOTPATH_LIFT;
    const before = mb.extras.length + mb.fineIdx.length;
    // Lamps, signals and shelters are seen down a street; benches and bins only close up.
    const fine = prop.kind === 'bench' || prop.kind === 'bin';
    mb.detail(() => MODELS[prop.kind](new Kit(mb), prop, y), fine);
    counts.tris += (mb.extras.length + mb.fineIdx.length - before) / 3;
    counts[prop.kind]++;
  }
  return counts;
}

function mappedKind(t: Tags): Kind | null {
  if (t.highway === 'street_lamp') return 'lamp';
  if (t.highway === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes')) return t.shelter === 'yes' ? 'shelter' : 'stop';
  if (t.amenity === 'bench') return 'bench';
  if (t.amenity === 'waste_basket') return 'bin';
  return null;
}

/** Nearest point on any of the roads: where, how far, and the unit normal from it towards the query point's side, flipped to point at the road. */
function nearestRoad(roads: Road[]) {
  const BUCKET = 50;
  const buckets = new Map<string, { road: Road; k: number }[]>();
  for (const road of roads) {
    for (let k = 0; k + 1 < road.pts.length; k++) {
      const a = road.pts[k];
      const b = road.pts[k + 1];
      for (let i = Math.floor(Math.min(a.x, b.x) / BUCKET); i <= Math.floor(Math.max(a.x, b.x) / BUCKET); i++) {
        for (let j = Math.floor(Math.min(a.z, b.z) / BUCKET); j <= Math.floor(Math.max(a.z, b.z) / BUCKET); j++) {
          const key = `${i},${j}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key)!.push({ road, k });
        }
      }
    }
  }
  return (p: Local) => {
    let best: { road: Road; d: number; px: number; pz: number; nx: number; nz: number } | null = null;
    for (let i = Math.floor(p.x / BUCKET) - 1; i <= Math.floor(p.x / BUCKET) + 1; i++) {
      for (let j = Math.floor(p.z / BUCKET) - 1; j <= Math.floor(p.z / BUCKET) + 1; j++) {
        for (const { road, k } of buckets.get(`${i},${j}`) ?? []) {
          const a = road.pts[k];
          const b = road.pts[k + 1];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const len2 = dx * dx + dz * dz || 1;
          const f = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
          const px = a.x + dx * f;
          const pz = a.z + dz * f;
          const d = Math.hypot(p.x - px, p.z - pz);
          if (best && d >= best.d) continue;
          // Towards the road from the point's side (perpendicular to the way, so it holds on the centreline too).
          const len = Math.sqrt(len2);
          let nx = -dz / len;
          let nz = dx / len;
          if ((p.x - px) * nx + (p.z - pz) * nz > 0) [nx, nz] = [-nx, -nz];
          best = { road, d, px, pz, nx, nz };
        }
      }
    }
    return best;
  };
}

/** Point, left normal and unit tangent at arc length s along a way. */
function stationAt(r: Road, s: number): { p: Local; n: Local; t: Local } {
  let k = 0;
  while (k < r.s.length - 2 && r.s[k + 1] < s) k++;
  const a = r.pts[k];
  const b = r.pts[k + 1];
  const len = r.s[k + 1] - r.s[k] || 1;
  const f = Math.min(1, Math.max(0, (s - r.s[k]) / len));
  const t = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
  // Left of travel along the way (as roads.ts's stations): facing +x, -z is on the left.
  return { p: { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f }, n: { x: t.z, z: -t.x }, t };
}

/** Calls `f` every `spacing` m along a way from `offset` (with the station and a running count), skipping its ends. */
function alongRoad(r: Road, spacing: number, offset: number, f: (p: Local, n: Local, k: number) => void) {
  const total = r.s[r.s.length - 1];
  let k = 0;
  for (let s = offset + spacing / 2; s < total - 4; s += spacing) {
    if (s < 4) continue;
    const { p, n } = stationAt(r, s);
    f(p, n, k++);
  }
}

// ---------------------------------------------------------------- models

/** Small solids for the models: boxes turned to face a direction, drawn as their sides and top (and, asked, bottom). */
class Kit {
  private readonly mb: MeshBuilder;
  constructor(mb: MeshBuilder) {
    this.mb = mb;
  }

  /**
   * A box centred over (x, z) from y0 to y1, `w` across (along the right of
   * the facing direction f) and `d` deep (along f), each face lit as `shade`.
   */
  box(x: number, z: number, f: Local, w: number, d: number, y0: number, y1: number, colour: readonly number[], opts: { bottom?: readonly number[]; front?: readonly number[]; shade?: number; sides?: boolean } = {}) {
    const r = { x: -f.z, z: f.x };
    const at = (i: number, j: number) => ({ x: x + r.x * (w / 2) * i + f.x * (d / 2) * j, z: z + r.z * (w / 2) * i + f.z * (d / 2) * j });
    // Corners counter-clockwise seen from above, with each side's outward normal.
    const ring = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
    const normals = [{ x: -f.x, z: -f.z }, r, f, { x: -r.x, z: -r.z }];
    const shade = opts.shade ?? 1;
    for (let k = 0; k < 4; k++) {
      // Without `sides`, just the long faces (a thin arm's ends are never seen).
      if (opts.sides === false && (k === 0 || k === 2)) continue;
      const a = ring[k];
      const b = ring[(k + 1) % 4];
      const n = [normals[k].x, 0, normals[k].z];
      const c = k === 2 && opts.front ? opts.front : colour;
      this.quad([a.x, y0, a.z], [b.x, y0, b.z], [b.x, y1, b.z], [a.x, y1, a.z], n, c, shade * 0.85, shade);
    }
    const top = ring.map((p) => [p.x, y1, p.z] as const);
    this.quad(top[0], top[1], top[2], top[3], [0, 1, 0], colour, shade, shade);
    if (opts.bottom) {
      const bot = ring.map((p) => [p.x, y0, p.z] as const);
      this.quad(bot[3], bot[2], bot[1], bot[0], [0, -1, 0], opts.bottom, 1.2, 1.2);
    }
  }

  /** A three-sided upright pole (no cap: never seen), its faces turned by `rot`. */
  pole(x: number, z: number, half: number, y0: number, y1: number, colour: readonly number[], rot = 0) {
    const ring = [0, 1, 2].map((q) => {
      const a = rot + (q * 2 * Math.PI) / 3;
      return { x: x + Math.cos(a) * half * 1.4, z: z + Math.sin(a) * half * 1.4 };
    });
    for (let q = 0; q < 3; q++) {
      const a = ring[q];
      const b = ring[(q + 1) % 3];
      const mx = (a.x + b.x) / 2 - x;
      const mz = (a.z + b.z) / 2 - z;
      const l = Math.hypot(mx, mz) || 1;
      this.quad([a.x, y0, a.z], [b.x, y0, b.z], [b.x, y1, b.z], [a.x, y1, a.z], [mx / l, 0, mz / l], colour, 0.8, 1);
    }
  }

  /** Runs `emit` with its triangles going to the finest detail (drawn nearer still). */
  fine(emit: () => void) {
    this.mb.detail(emit, true);
  }

  /** A quad a-b-c-d, wound to face along n, lit `lo` at a and b and `hi` at c and d. */
  quad(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[], n: readonly number[], colour: readonly number[], lo: number, hi: number) {
    const mb = this.mb;
    const v = [mb.vertex(a[0], a[1], a[2], n, colour, 0, 0, 0, 0, lo), mb.vertex(b[0], b[1], b[2], n, colour, 0, 0, 0, 0, lo), mb.vertex(c[0], c[1], c[2], n, colour, 0, 0, 0, 0, hi), mb.vertex(d[0], d[1], d[2], n, colour, 0, 0, 0, 0, hi)];
    // Wind so the face's geometric normal agrees with n.
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (g[0] * n[0] + g[1] * n[1] + g[2] * n[2] >= 0) mb.idx.push(v[0], v[1], v[2], v[0], v[2], v[3]);
    else mb.idx.push(v[0], v[2], v[1], v[0], v[3], v[2]);
  }
}

const MODELS: Record<Kind, (k: Kit, p: Prop, y: number) => void> = {
  lamp(k, p, y) {
    // A tall pole, an arm out over the road, a lantern lit underneath.
    // The pole is seen down the street; arm and lantern only close up.
    const f = { x: p.fx, z: p.fz };
    k.pole(p.x, p.z, 0.08, y, y + LAMP_HEIGHT, POLE, Math.atan2(f.z, f.x));
    const reach = 1.6;
    k.fine(() => {
      k.box(p.x + f.x * (reach / 2), p.z + f.z * (reach / 2), f, 0.08, reach, y + LAMP_HEIGHT - 0.1, y + LAMP_HEIGHT, POLE, { sides: false });
      // The lantern: a flat housing, lit underneath (it's seen from below).
      const cx = p.x + f.x * reach;
      const cz = p.z + f.z * reach;
      const r = { x: -f.z, z: f.x };
      const at = (i: number, j: number, dy: number) => [cx + r.x * 0.15 * i + f.x * 0.35 * j, y + LAMP_HEIGHT + dy, cz + r.z * 0.15 * i + f.z * 0.35 * j] as const;
      k.quad(at(-1, -1, 0.02), at(1, -1, 0.02), at(1, 1, 0.02), at(-1, 1, 0.02), [0, 1, 0], LAMP_OFF, 1, 1);
      k.quad(at(-1, 1, -0.12), at(1, 1, -0.12), at(1, -1, -0.12), at(-1, -1, -0.12), [0, -1, 0], LAMP_GLOW, 1.2, 1.2);
    });
  },
  signal(k, p, y) {
    // A grey pole and a black three-aspect head facing the arriving traffic, lit red or green.
    const f = { x: p.fx, z: p.fz };
    k.pole(p.x, p.z, 0.07, y, y + SIGNAL_HEIGHT, SIGNAL_POLE);
    const top = y + SIGNAL_HEIGHT;
    k.box(p.x, p.z, f, 0.36, 0.28, top - 1.05, top, SIGNAL_HEAD);
    const r = { x: -f.z, z: f.x };
    const face = 0.15;
    for (const [q, on] of [[0, !p.green], [1, false], [2, !!p.green]] as const) {
      const cy = top - 0.2 - q * 0.32;
      const colour = on ? (q === 0 ? RED_ON : GREEN_ON) : LAMP_OFF;
      const cx = p.x + f.x * face;
      const cz = p.z + f.z * face;
      const s = 0.11;
      k.quad([cx - r.x * s, cy - s, cz - r.z * s], [cx + r.x * s, cy - s, cz + r.z * s], [cx + r.x * s, cy + s, cz + r.z * s], [cx - r.x * s, cy + s, cz - r.z * s], [f.x, 0, f.z], colour, on ? 1.6 : 1, on ? 1.6 : 1);
    }
    // The push button for pedestrians, on the footpath side.
    k.fine(() => k.box(p.x - f.x * 0.12, p.z - f.z * 0.12, f, 0.12, 0.08, y + 1, y + 1.25, rgb(0xe0b020)));
  },
  shelter(k, p, y) {
    // Facing the road: a glass back panel and roof on posts, a bench, a lit poster at one end.
    const f = { x: p.fx, z: p.fz };
    const r = { x: -f.z, z: f.x };
    const len = 3.6;
    const depth = 1.5;
    const h = 2.5;
    k.box(p.x, p.z, f, len + 0.2, depth + 0.2, y + h, y + h + 0.12, SHELTER_FRAME, { bottom: SHELTER_FRAME });
    const bx = p.x - f.x * (depth / 2);
    const bz = p.z - f.z * (depth / 2);
    k.box(bx, bz, f, len, 0.05, y + 0.1, y + h, SHELTER_GLASS, { shade: 0.9 });
    const end = hash(String(p.seed), 3) < 0.5 ? -1 : 1;
    const poster = POSTERS[Math.floor(hash(String(p.seed), 4) * POSTERS.length)];
    k.box(p.x + r.x * (len / 2) * end, p.z + r.z * (len / 2) * end, r, depth - 0.2, 0.12, y + 0.15, y + 2.2, poster, { shade: 1.25 });
    k.fine(() => {
      for (const s of [-1, 1]) k.pole(p.x + r.x * (len / 2 - 0.1) * s + f.x * (depth / 2 - 0.1), p.z + r.z * (len / 2 - 0.1) * s + f.z * (depth / 2 - 0.1), 0.04, y, y + h, SHELTER_FRAME);
      k.box(bx + f.x * 0.3, bz + f.z * 0.3, f, len * 0.6, 0.35, y + 0.42, y + 0.48, TIMBER);
    });
  },
  stop(k, p, y) {
    // A pole with the stop's flag at the top.
    const f = { x: p.fx, z: p.fz };
    k.pole(p.x, p.z, 0.04, y, y + 2.8, POLE);
    k.box(p.x + f.x * 0.05, p.z + f.z * 0.05, { x: -f.z, z: f.x }, 0.04, 0.45, y + 2.2, y + 2.8, STOP_SIGN);
  },
  bench(k, p, y) {
    // Timber slats on steel ends, its back to the road.
    const f = { x: p.fx, z: p.fz };
    const r = { x: -f.z, z: f.x };
    k.box(p.x, p.z, r, 0.45, 1.8, y + 0.42, y + 0.48, TIMBER);
    k.box(p.x - f.x * 0.2, p.z - f.z * 0.2, r, 0.06, 1.8, y + 0.5, y + 0.85, TIMBER);
    for (const s of [-1, 1]) k.box(p.x + r.x * 0.8 * s, p.z + r.z * 0.8 * s, r, 0.45, 0.05, y, y + 0.42, POLE);
  },
  bin(k, p, y) {
    const f = { x: p.fx, z: p.fz };
    k.box(p.x, p.z, f, 0.5, 0.5, y, y + 1, BIN);
  },
};
