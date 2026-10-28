// The road graph: the drivable network as data, for routing (mission
// arrows, the minimap), traffic and police. Written to
// public/city/<area>/roadgraph.json; src/city/road-graph.ts reads it.
//
//   node --experimental-strip-types tools/citygen/roadgraph.ts
//
// (build.ts also writes it, so a full rebuild keeps it in step.)
//
// Built from the same ways roads.ts draws (after bridge decks are extended),
// so an edge's centreline is the middle of the asphalt you see. Nodes are
// junctions, way ends and traffic signals; edges run between them. Each edge
// stores its lanes each way (0 one way for one-way streets, whose geometry
// always runs in the allowed direction), so the game can put cars in a lane
// on the left without knowing about OSM's oneway=-1.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCityData } from './fetch.ts';
import type { OsmData, Tags } from './osm.ts';
import { Overrides } from './overrides.ts';
import { prepareGround } from './prepare.ts';
import { CBD_BBOX, type Local } from './project.ts';
import { roadNetwork, type RoadNetwork } from './roads.ts';
import { chunkGrid, TerrainSampler } from './terrain.ts';
import {
  BRIDGE, RESTRICTED, ROAD_CLASSES, ROADGRAPH_FORMAT, ROUNDABOUT, SIGNALS,
  type RoadGraphEdgeRow, type RoadGraphFile, type RoadGraphNodeRow,
} from '../../src/city/road-graph.ts';

type Road = RoadNetwork['roads'][number];

/** Centrelines are simplified to within this in plan, and this in height, m. */
const SIMPLIFY = 0.25;
const SIMPLIFY_Y = 0.1;
/** Heights are sampled this often along the way, m. */
const DENSIFY = 5;

const r1 = (v: number) => Math.round(v * 10) / 10;

const ONEWAY_YES = new Set(['yes', '1', 'true']);
const CLOSED = new Set(['no', 'private', 'destination_no']);

/** Lanes in the way's own direction and against it; [n, 0] for one-way, [0, n] for oneway=-1. */
function lanesEachWay(t: Tags, lanes: number): [number, number] {
  const roundabout = t.junction === 'roundabout' || t.junction === 'circular';
  if (t.oneway === '-1') return [0, lanes];
  if (ONEWAY_YES.has(t.oneway ?? '') || roundabout || ((t.highway === 'motorway' || t.highway === 'motorway_link') && t.oneway !== 'no')) return [lanes, 0];
  const fw = Number(t['lanes:forward']);
  const bw = Number(t['lanes:backward']);
  if (fw >= 1 && bw >= 1) return [Math.round(fw), Math.round(bw)];
  // A narrow two-way street (one lane tagged, or none and under 6 m) is one shared lane each way.
  const back = Math.max(1, Math.floor(lanes / 2));
  return [Math.max(1, lanes - back), back];
}

function restricted(t: Tags): boolean {
  const car = t.motor_vehicle ?? t.motorcar ?? t.vehicle ?? t.access;
  return car !== undefined && CLOSED.has(car);
}

/**
 * Douglas-Peucker: indices of the points to keep, so the plan stays within
 * `tol` and the height (linear in distance along) within `tolY`.
 */
function simplify(pts: Local[], ys: number[], tol: number, tolY: number): number[] {
  const s = [0];
  for (let k = 1; k < pts.length; k++) s.push(s[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = pts[i];
    const b = pts[j];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    let worst = 1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k].x - a.x) * dz - (pts[k].z - a.z) * dx) / len / tol;
      const y = ys[i] + ((ys[j] - ys[i]) * (s[k] - s[i])) / (s[j] - s[i] || 1);
      const e = Math.max(d, Math.abs(ys[k] - y) / tolY);
      if (e > worst) [worst, at] = [e, k];
    }
    if (at >= 0) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return [...keep.keys()].filter((k) => keep[k]);
}

export type RoadGraphStats = { nodes: number; edges: number; km: number; oneWay: number; signals: number };

export function buildRoadGraph(osm: OsmData, net: RoadNetwork, terrain: TerrainSampler): { graph: RoadGraphFile; stats: RoadGraphStats } {
  const cls = new Map<string, number>(ROAD_CLASSES.map((c, k) => [c, k]));
  const roads = net.roads.filter((r) => cls.has(r.highway));
  // A node is a vertex where ways meet, where a way ends (or was split at a deck end), or at traffic signals.
  const uses = new Map<number, number>();
  for (const r of roads) for (const n of r.nodes) uses.set(n, (uses.get(n) ?? 0) + 1);
  const vertex = (r: Road, k: number) =>
    k === 0 || k === r.nodes.length - 1 || uses.get(r.nodes[k])! > 1 || osm.nodes.get(r.nodes[k])?.tags.highway === 'traffic_signals';

  const height = (n: number, p: Local) => net.deck.get(n) ?? terrain.heightAt(p.x, p.z);
  const nodeIndex = new Map<number, number>();
  const nodes: RoadGraphNodeRow[] = [];
  const nodeOf = (r: Road, k: number) => {
    const n = r.nodes[k];
    let i = nodeIndex.get(n);
    if (i === undefined) {
      const p = r.pts[k];
      const signals = osm.nodes.get(n)?.tags.highway === 'traffic_signals';
      nodeIndex.set(n, (i = nodes.length));
      nodes.push([r1(p.x), r1(p.z), r1(height(n, p)), signals ? SIGNALS : 0]);
    }
    return i;
  };

  const names: string[] = [];
  const nameIndex = new Map<string, number>();
  const nameOf = (name: string | undefined) => {
    if (!name) return -1;
    let i = nameIndex.get(name);
    if (i === undefined) nameIndex.set(name, (i = names.push(name) - 1));
    return i;
  };

  const edges: RoadGraphEdgeRow[] = [];
  let km = 0;
  // Ways in id order (pieces of a split way in their own order), so node and edge indices are deterministic.
  const ordered = roads.map((r, k) => ({ r, k })).sort((p, q) => p.r.id - q.r.id || p.k - q.k).map((x) => x.r);
  for (const r of ordered) {
    const t = osm.ways.get(r.id)!.tags;
    const [fw, bw] = lanesEachWay(t, r.lanes);
    const flags = (r.bridge ? BRIDGE : 0) | (t.junction === 'roundabout' || t.junction === 'circular' ? ROUNDABOUT : 0) | (restricted(t) ? RESTRICTED : 0);
    let start = 0;
    for (let k = 1; k < r.nodes.length; k++) {
      if (!vertex(r, k)) continue;
      let ks = [...Array(k - start + 1).keys()].map((q) => start + q);
      let a = nodeOf(r, start);
      let b = nodeOf(r, k);
      const len = r.s[k] - r.s[start];
      start = k;
      if (len < 0.05) continue;
      // One-way against the way's direction: store it the right way round.
      let [f, w] = [fw, bw];
      if (f === 0) {
        ks = ks.reverse();
        [a, b, f, w] = [b, a, w, f];
      }
      // Heights every few metres, so a hill's curve between OSM nodes survives (decks are straight between nodes).
      const pts: Local[] = [];
      const ys: number[] = [];
      for (let q = 0; q < ks.length; q++) {
        const p = r.pts[ks[q]];
        const y = height(r.nodes[ks[q]], p);
        if (q > 0) {
          const o = r.pts[ks[q - 1]];
          const y0 = ys[ys.length - 1];
          const steps = Math.ceil(Math.hypot(p.x - o.x, p.z - o.z) / DENSIFY);
          for (let j = 1; j < steps; j++) {
            const m = { x: o.x + ((p.x - o.x) * j) / steps, z: o.z + ((p.z - o.z) * j) / steps };
            pts.push(m);
            ys.push(r.bridge ? y0 + ((y - y0) * j) / steps : terrain.heightAt(m.x, m.z));
          }
        }
        pts.push(p);
        ys.push(y);
      }
      const pos: number[] = [];
      for (const q of simplify(pts, ys, SIMPLIFY, SIMPLIFY_Y)) pos.push(r1(pts[q].x), r1(pts[q].z), r1(ys[q]));
      edges.push([a, b, cls.get(r.highway)!, nameOf(t.name), f, w, r1(r.width), flags, r1(len), r.id, pos]);
      km += len / 1000;
    }
  }
  return {
    graph: { format: ROADGRAPH_FORMAT, classes: ROAD_CLASSES, names, nodes, edges },
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      km,
      oneWay: edges.filter((e) => e[5] === 0).length,
      signals: nodes.filter((n) => n[3] & SIGNALS).length,
    },
  };
}

/** One node or edge per line keeps the file readable and diffs small. */
export function writeRoadGraph(g: RoadGraphFile, path: string) {
  const list = (rows: unknown[]) => rows.map((x) => `    ${JSON.stringify(x)}`).join(',\n');
  writeFileSync(
    path,
    `{\n  "format": ${g.format},\n  "classes": ${JSON.stringify(g.classes)},\n  "names": ${JSON.stringify(g.names)},\n` +
      `  "nodes": [\n${list(g.nodes)}\n  ],\n  "edges": [\n${list(g.edges)}\n  ]\n}\n`,
  );
}

export const describeRoadGraph = (s: RoadGraphStats) =>
  `Road graph: ${s.nodes} nodes (${s.signals} signals), ${s.edges} edges (${s.oneWay} one-way), ${s.km.toFixed(1)} km`;

if (import.meta.url === `file://${process.argv[1]}`) {
  // The same corrected data and smoothed ground as build.ts, so heights match.
  const data = await loadCityData(CBD_BBOX);
  const overrides = Overrides.load('cbd');
  overrides.apply(data.osm);
  prepareGround(data, chunkGrid(CBD_BBOX));
  const terrain = new TerrainSampler(data.dem);
  const { graph, stats } = buildRoadGraph(data.osm, roadNetwork(data, terrain, overrides), terrain);
  const out = fileURLToPath(new URL('../../public/city/cbd/roadgraph.json', import.meta.url));
  writeRoadGraph(graph, out);
  console.log(`${describeRoadGraph(stats)}. Wrote ${out}`);
}
