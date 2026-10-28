// The road graph: the drivable network, generated offline by
// tools/citygen/roadgraph.ts into public/city/<area>/roadgraph.json.
//
// Routing for mission arrows and the minimap, lanes for traffic and police:
//   nearest(x, z)        the closest road: which edge, how far along, which side
//   route(from, to)      shortest legal drive between two points (one-ways respected)
//   lane(edge, dir, k, s) a pose in lane k (0 = kerbside), driving on the left
//   randomLane(rng)      somewhere to put a car that can always drive on
//
// Edges run from node a to node b. `fw` lanes go a -> b and `bw` lanes
// b -> a; one-way edges are stored the right way round, so bw is 0. Plain
// TypeScript with no DOM, so it runs in Node too.

export const ROADGRAPH_FORMAT = 1;

/** Highway classes, biggest first; edges store an index into this. Pedestrian malls and busways aren't in the graph. */
export const ROAD_CLASSES = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service',
] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];

/** Node flag: traffic signals. */
export const SIGNALS = 1;
/** Edge flags. */
export const BRIDGE = 1;
export const ROUNDABOUT = 2;
/** Closed to ordinary cars (access=no, buses only): routes avoid it and traffic doesn't spawn on it. */
export const RESTRICTED = 4;

/** [x, z, y, flags]: map metres (origin Britomart, x east, z south, y above sea level). */
export type RoadGraphNodeRow = [number, number, number, number];
/**
 * [a, b, class, name, fw lanes, bw lanes, carriageway width m, flags, length m, OSM way id, [x, z, y, ...]]:
 * name indexes `names` (-1 for none); the points run from a to b, both included.
 */
export type RoadGraphEdgeRow = [number, number, number, number, number, number, number, number, number, number, number[]];
export interface RoadGraphFile {
  format: number;
  classes: readonly string[];
  names: string[];
  nodes: RoadGraphNodeRow[];
  edges: RoadGraphEdgeRow[];
}

/** 1 drives a -> b, -1 drives b -> a. */
export type Dir = 1 | -1;

export interface RoadNode {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly signals: boolean;
  /** Edges you can drive away from here on, and where they lead. */
  readonly out: readonly { edge: RoadEdge; dir: Dir; to: number }[];
  /** In the largest strongly connected part: from here you can reach everywhere else in it, and back. */
  readonly main: boolean;
}

export interface RoadEdge {
  readonly index: number;
  readonly a: number;
  readonly b: number;
  readonly highway: RoadClass;
  /** Street name ('' if none). */
  readonly name: string;
  /** Lanes a -> b and b -> a. */
  readonly fw: number;
  readonly bw: number;
  /** Carriageway width, m. */
  readonly width: number;
  readonly bridge: boolean;
  readonly roundabout: boolean;
  readonly restricted: boolean;
  readonly length: number;
  readonly osm: number;
  /** Centreline points x, z, y from a to b, and the distance along at each. */
  readonly pts: Float32Array;
  readonly s: Float32Array;
  /** Both ends in the main part (see RoadNode.main). */
  readonly main: boolean;
}

/** Where a point is relative to the nearest road. */
export interface RoadSnap {
  edge: RoadEdge;
  /** Distance along the edge from a, m. */
  s: number;
  /** The closest point on the centreline. */
  x: number;
  z: number;
  /** From the query point, m. */
  dist: number;
  /** The point is on the left of a -> b, i.e. beside the a -> b lanes (we drive on the left). */
  left: boolean;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  /** Game heading: forward is (cos h, 0, -sin h). */
  heading: number;
}

export interface Route {
  /** Metres driven. */
  length: number;
  /** The centreline from the start's nearest road point to the goal's. */
  points: { x: number; z: number }[];
  /** Edges in order, with the direction each is driven. */
  legs: { edge: RoadEdge; dir: Dir }[];
  from: RoadSnap;
  to: RoadSnap;
}

export interface SnapOptions {
  /** Only roads this close, m (default 60). */
  within?: number;
  /** Leave out roads closed to cars (default true). */
  open?: boolean;
  /** Only roads in the main part, where a car can always drive on (default false). */
  main?: boolean;
}

/** Routes prefer proper streets: a metre of these counts as more. */
const COST: Partial<Record<RoadClass, number>> = { service: 1.6, living_street: 1.3 };
const RESTRICTED_COST = 6;
/** Spatial index cell, m. */
const CELL = 25;

export class RoadGraph {
  readonly nodes: readonly RoadNode[];
  readonly edges: readonly RoadEdge[];
  private readonly cells = new Map<number, number[]>();
  /** Total length of open edges in the main part (for picking spawn points by length). */
  private readonly spawnable: RoadEdge[];

  constructor(file: RoadGraphFile) {
    if (file.format !== ROADGRAPH_FORMAT) throw new Error(`road graph format ${file.format}, expected ${ROADGRAPH_FORMAT}`);
    const out: { edge: RoadEdge; dir: Dir; to: number }[][] = file.nodes.map(() => []);
    const edges: RoadEdge[] = file.edges.map(([a, b, cls, name, fw, bw, width, flags, length, osm, p], index) => {
      const pts = new Float32Array(p);
      const s = new Float32Array(p.length / 3);
      for (let k = 1; k < s.length; k++) s[k] = s[k - 1] + Math.hypot(p[3 * k] - p[3 * k - 3], p[3 * k + 1] - p[3 * k - 2]);
      return {
        index, a, b, highway: (file.classes[cls] ?? 'service') as RoadClass, name: file.names[name] ?? '', fw, bw, width,
        bridge: !!(flags & BRIDGE), roundabout: !!(flags & ROUNDABOUT), restricted: !!(flags & RESTRICTED),
        // The simplified centreline is a few cm shorter than the OSM one; use its own length so s stays on it.
        length: s[s.length - 1] || length, osm, pts, s, main: false,
      };
    });
    for (const e of edges) {
      if (e.fw > 0) out[e.a].push({ edge: e, dir: 1, to: e.b });
      if (e.bw > 0) out[e.b].push({ edge: e, dir: -1, to: e.a });
    }
    const main = mainComponent(out);
    this.nodes = file.nodes.map(([x, z, y, flags], index) => ({ index, x, y, z, signals: !!(flags & SIGNALS), out: out[index], main: main[index] }));
    for (const e of edges) (e as { main: boolean }).main = main[e.a] && main[e.b];
    this.edges = edges;
    this.spawnable = edges.filter((e) => e.main && !e.restricted);

    for (const e of edges) {
      for (let k = 0; k + 1 < e.s.length; k++) {
        const [x0, z0, x1, z1] = [e.pts[3 * k], e.pts[3 * k + 1], e.pts[3 * k + 3], e.pts[3 * k + 4]];
        for (let i = Math.floor(Math.min(x0, x1) / CELL); i <= Math.floor(Math.max(x0, x1) / CELL); i++) {
          for (let j = Math.floor(Math.min(z0, z1) / CELL); j <= Math.floor(Math.max(z0, z1) / CELL); j++) {
            const key = cellKey(i, j);
            let list = this.cells.get(key);
            if (!list) this.cells.set(key, (list = []));
            if (list[list.length - 1] !== e.index) list.push(e.index);
          }
        }
      }
    }
  }

  static async load(url: URL): Promise<RoadGraph> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`road graph: HTTP ${res.status}`);
    return new RoadGraph((await res.json()) as RoadGraphFile);
  }

  /** Kilometres of road, and how much of it is in the main part. */
  stats() {
    const km = (list: readonly RoadEdge[]) => Math.round(list.reduce((n, e) => n + e.length, 0) / 100) / 10;
    return {
      nodes: this.nodes.length,
      edges: this.edges.length,
      km: km(this.edges),
      mainKm: km(this.edges.filter((e) => e.main)),
      oneWay: this.edges.filter((e) => e.bw === 0).length,
      signals: this.nodes.filter((n) => n.signals).length,
    };
  }

  /** The nearest road to (x, z), or null if there's none within `within`. */
  nearest(x: number, z: number, opts: SnapOptions = {}): RoadSnap | null {
    const within = opts.within ?? 60;
    const open = opts.open ?? true;
    let best: RoadSnap | null = null;
    const seen = new Set<number>();
    for (let i = Math.floor((x - within) / CELL); i <= Math.floor((x + within) / CELL); i++) {
      for (let j = Math.floor((z - within) / CELL); j <= Math.floor((z + within) / CELL); j++) {
        for (const k of this.cells.get(cellKey(i, j)) ?? []) {
          if (seen.has(k)) continue;
          seen.add(k);
          const e = this.edges[k];
          if ((open && e.restricted) || (opts.main && !e.main)) continue;
          const snap = project(e, x, z);
          // Ties (a junction node shared by several edges) go to the lowest index, so results repeat.
          if (snap.dist <= within && (!best || snap.dist < best.dist - 1e-6 || (Math.abs(snap.dist - best.dist) <= 1e-6 && e.index < best.edge.index))) best = snap;
        }
      }
    }
    return best;
  }

  /** The centreline at `s` metres from a, facing a -> b. */
  pointAt(edge: RoadEdge, s: number): Pose {
    const { pts, s: at } = edge;
    s = Math.min(Math.max(s, 0), edge.length);
    let k = 0;
    while (k < at.length - 2 && at[k + 1] < s) k++;
    const f = (s - at[k]) / (at[k + 1] - at[k] || 1);
    const dx = pts[3 * k + 3] - pts[3 * k];
    const dz = pts[3 * k + 4] - pts[3 * k + 1];
    return {
      x: pts[3 * k] + dx * f,
      z: pts[3 * k + 1] + dz * f,
      y: pts[3 * k + 2] + (pts[3 * k + 5] - pts[3 * k + 2]) * f,
      heading: Math.atan2(-dz, dx),
    };
  }

  /**
   * A pose in lane `lane` (0 = kerbside) driving `dir`, `s` metres from where
   * that direction starts. Lanes split the carriageway evenly; each
   * direction keeps to its left of the centreline.
   */
  lane(edge: RoadEdge, dir: Dir, lane: number, s: number): Pose {
    const p = this.pointAt(edge, dir > 0 ? s : edge.length - s);
    const heading = dir > 0 ? p.heading : p.heading + Math.PI;
    const total = edge.fw + edge.bw;
    const w = edge.width / Math.max(1, total);
    // Distance left of the travel direction, from the centreline.
    const left = edge.width / 2 - (Math.min(lane, (dir > 0 ? edge.fw : edge.bw) - 1) + 0.5) * w;
    return { x: p.x - Math.sin(heading) * left, y: p.y, z: p.z - Math.cos(heading) * left, heading: Math.atan2(Math.sin(heading), Math.cos(heading)) };
  }

  /**
   * Somewhere a car can drive on forever: an open edge in the main part
   * (picked by length, so every metre is as likely), a direction it allows,
   * a lane and a distance along. `near`/`within` keep it close to a point.
   */
  randomLane(rng: () => number, q: { near?: { x: number; z: number }; within?: number } = {}): { edge: RoadEdge; dir: Dir; lane: number; s: number } | null {
    const near = q.near;
    const within = q.within ?? Infinity;
    const list = near ? this.spawnable.filter((e) => edgeDistance(e, near.x, near.z) <= within) : this.spawnable;
    const total = list.reduce((n, e) => n + e.length, 0);
    if (!total) return null;
    let pick = rng() * total;
    let edge = list[list.length - 1];
    for (const e of list) {
      if (pick < e.length) {
        edge = e;
        break;
      }
      pick -= e.length;
    }
    const dirs: Dir[] = edge.bw > 0 ? [1, -1] : [1];
    const dir = dirs[Math.floor(rng() * dirs.length) % dirs.length];
    const lanes = dir > 0 ? edge.fw : edge.bw;
    return { edge, dir, lane: Math.floor(rng() * lanes) % lanes, s: rng() * edge.length };
  }

  /**
   * The shortest legal drive from one point to another (A* over directed
   * edges, from and to the nearest open roads), or null if there's no way.
   */
  route(from: { x: number; z: number }, to: { x: number; z: number }, opts: SnapOptions = {}): Route | null {
    const a = this.nearest(from.x, from.z, opts);
    const b = this.nearest(to.x, to.z, opts);
    if (!a || !b) return null;
    const cost = (e: RoadEdge) => (e.restricted ? RESTRICTED_COST : 1) * (COST[e.highway] ?? 1);
    const n = this.nodes.length;
    const g = new Float64Array(n).fill(Infinity);
    const via = new Array<{ edge: RoadEdge; dir: Dir; from: number } | null>(n).fill(null);
    const h = (i: number) => Math.hypot(this.nodes[i].x - b.x, this.nodes[i].z - b.z);
    const heap = new Heap();
    // Off the start edge, either way it allows.
    const ea = a.edge;
    if (ea.fw > 0) relax(ea.b, (ea.length - a.s) * cost(ea));
    if (ea.bw > 0) relax(ea.a, a.s * cost(ea));
    function relax(i: number, c: number) {
      if (c >= g[i]) return false;
      g[i] = c;
      heap.push(i, c + h(i));
      return true;
    }
    // Onto the goal edge from either end it allows; or straight there along the start edge.
    const eb = b.edge;
    let best = Infinity;
    let finish: { node: number; dir: Dir } | null = null;
    if (ea === eb && ((ea.fw > 0 && b.s >= a.s) || (ea.bw > 0 && b.s <= a.s))) best = Math.abs(b.s - a.s) * cost(ea);
    const closed = new Uint8Array(n);
    while (heap.size) {
      const [i, f] = heap.pop();
      if (f >= best) break;
      if (closed[i]) continue;
      closed[i] = 1;
      if (i === eb.a && eb.fw > 0 && g[i] + b.s * cost(eb) < best) {
        best = g[i] + b.s * cost(eb);
        finish = { node: i, dir: 1 };
      }
      if (i === eb.b && eb.bw > 0 && g[i] + (eb.length - b.s) * cost(eb) < best) {
        best = g[i] + (eb.length - b.s) * cost(eb);
        finish = { node: i, dir: -1 };
      }
      for (const l of this.nodes[i].out) {
        if (relax(l.to, g[i] + l.edge.length * cost(l.edge))) via[l.to] = { edge: l.edge, dir: l.dir, from: i };
      }
    }
    if (best === Infinity) return null;

    const legs: { edge: RoadEdge; dir: Dir }[] = [];
    const points: { x: number; z: number }[] = [{ x: a.x, z: a.z }];
    if (!finish) {
      // Straight along the one edge.
      const dir: Dir = b.s >= a.s ? 1 : -1;
      if (dir > 0 ? ea.fw === 0 : ea.bw === 0) return null;
      legs.push({ edge: ea, dir });
      this.trace(ea, a.s, b.s, points);
      return { length: Math.abs(b.s - a.s), points, legs, from: a, to: b };
    }
    const chain: { edge: RoadEdge; dir: Dir }[] = [];
    let at = finish.node;
    while (via[at]) {
      chain.push(via[at]!);
      at = via[at]!.from;
    }
    chain.reverse();
    // The first leg leaves the start edge at the node the chain starts from.
    const firstDir: Dir = at === ea.b && ea.fw > 0 ? 1 : -1;
    legs.push({ edge: ea, dir: firstDir });
    this.trace(ea, a.s, firstDir > 0 ? ea.length : 0, points);
    for (const l of chain) {
      legs.push(l);
      this.trace(l.edge, l.dir > 0 ? 0 : l.edge.length, l.dir > 0 ? l.edge.length : 0, points);
    }
    legs.push({ edge: eb, dir: finish.dir });
    this.trace(eb, finish.dir > 0 ? 0 : eb.length, b.s, points);
    const length = legs.reduce((sum, l, k) => {
      if (k === 0) return sum + (l.dir > 0 ? ea.length - a.s : a.s);
      if (k === legs.length - 1) return sum + (l.dir > 0 ? b.s : eb.length - b.s);
      return sum + l.edge.length;
    }, 0);
    return { length, points, legs, from: a, to: b };
  }

  /** Appends the centreline from s0 to s1 along an edge (either way), skipping repeats. */
  private trace(e: RoadEdge, s0: number, s1: number, out: { x: number; z: number }[]) {
    const push = (x: number, z: number) => {
      const last = out[out.length - 1];
      if (!last || Math.hypot(last.x - x, last.z - z) > 0.05) out.push({ x, z });
    };
    const ks = [...e.s.keys()].filter((k) => e.s[k] > Math.min(s0, s1) && e.s[k] < Math.max(s0, s1));
    if (s1 < s0) ks.reverse();
    for (const k of ks) push(e.pts[3 * k], e.pts[3 * k + 1]);
    const p = this.pointAt(e, s1);
    push(p.x, p.z);
  }
}

const cellKey = (i: number, j: number) => (i + 0x8000) * 0x10000 + (j + 0x8000);

function project(e: RoadEdge, x: number, z: number): RoadSnap {
  let best: RoadSnap = { edge: e, s: 0, x: e.pts[0], z: e.pts[1], dist: Infinity, left: true };
  for (let k = 0; k + 1 < e.s.length; k++) {
    const [x0, z0] = [e.pts[3 * k], e.pts[3 * k + 1]];
    const dx = e.pts[3 * k + 3] - x0;
    const dz = e.pts[3 * k + 4] - z0;
    const len2 = dx * dx + dz * dz || 1;
    const f = Math.min(1, Math.max(0, ((x - x0) * dx + (z - z0) * dz) / len2));
    const px = x0 + dx * f;
    const pz = z0 + dz * f;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.dist) {
      // Left of travel (heading h, forward (dx, dz)) is (dz, -dx) in x, z: north of an eastbound road.
      best = { edge: e, s: e.s[k] + f * (e.s[k + 1] - e.s[k]), x: px, z: pz, dist: d, left: (x - px) * dz - (z - pz) * dx >= 0 };
    }
  }
  return best;
}

const edgeDistance = (e: RoadEdge, x: number, z: number) => project(e, x, z).dist;

/** Nodes in the largest strongly connected component (iterative Tarjan). */
function mainComponent(out: readonly { to: number }[][]): boolean[] {
  const n = out.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const comp = new Int32Array(n).fill(-1);
  let counter = 0;
  let comps = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] >= 0) continue;
    const work: [number, number][] = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, k] = top;
      if (k < out[v].length) {
        top[1]++;
        const w = out[v][k].to;
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) low[work[work.length - 1][0]] = Math.min(low[work[work.length - 1][0]], low[v]);
      if (low[v] === index[v]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp[w] = comps;
        } while (w !== v);
        comps++;
      }
    }
  }
  const size = new Int32Array(comps);
  for (const c of comp) size[c]++;
  let biggest = 0;
  for (let c = 1; c < comps; c++) if (size[c] > size[biggest]) biggest = c;
  return [...comp].map((c) => c === biggest);
}

/** A binary min-heap of (node, priority). */
class Heap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];

  get size() {
    return this.items.length;
  }

  push(item: number, key: number) {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p];
      keys[i] = keys[p];
      i = p;
    }
    items[i] = item;
    keys[i] = key;
  }

  pop(): [number, number] {
    const { items, keys } = this;
    const top: [number, number] = [items[0], keys[0]];
    const item = items.pop()!;
    const key = keys.pop()!;
    if (items.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= items.length) break;
        if (c + 1 < items.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        items[i] = items[c];
        keys[i] = keys[c];
        i = c;
      }
      items[i] = item;
      keys[i] = key;
    }
    return top;
  }
}
