// Trees: OSM's mapped trees (mostly street trees) and treetops found in the
// LiDAR (DSM minus DEM) over parks, gardens and bush, baked into each
// chunk's building mesh as low-poly models with a trunk collider.
//
// LiDAR tops are only trusted on green ground: elsewhere a local maximum
// of the canopy height is as likely a verandah, a bus shelter, a crane or a
// ship. Street trees come from OSM instead, taking their height and crown
// from a LiDAR top beside them where there is one (they're often young or
// mapped after the 2024 survey otherwise).
//
// Budget: each chunk's trees are grouped by 50 m tile (MeshBuilder.group),
// and the game draws a tile's only when it's near the player; the ground's
// 'trees' tint already shows bush from afar.
import { SURFACE_ID } from '../../src/city/format.ts';
import { MeshBuilder, parseLength, rgb } from './buildings.ts';
import { hash } from './eras.ts';
import type { GroundRaster } from './ground.ts';
import type { OsmData, Tags } from './osm.ts';
import { lonLatToLocal, ORIGIN_NZTM, type Local } from './project.ts';
import type { Raster } from './raster.ts';
import { CHUNK_SIZE, type Grid, type TerrainSampler } from './terrain.ts';

/** Tiles per chunk side that trees are grouped by (50 m, like the terrain's). */
const TREE_TILES = 5;

export type TreeKind = 'broadleaf' | 'palm' | 'conifer';
export type Tree = { x: number; z: number; height: number; crown: number; kind: TreeKind };

/** Canopy above the ground (m) that can be a tree top: below is shrubs and parked cars, above is buildings and cranes. */
const MIN_TOP = 4;
const MAX_TOP = 32;
/** A top is the highest canopy pixel within this many pixels (1 m) around it. */
const TOP_WINDOW = 3;
/** The crown's edge: where the canopy falls below this fraction of the top's height. */
const CROWN_EDGE = 0.6;
const MIN_CROWN = 1.5;
const MAX_CROWN = 9;
/** How far from an OSM tree a LiDAR top may be and still be that tree, m. */
const MATCH = 4;
/** OSM trees with no LiDAR top beside them: young street trees. */
const DEFAULT_HEIGHT = 6;
const DEFAULT_CROWN = 2.2;
/** Spacing of trees along a mapped tree row, m. */
const ROW_SPACING = 9;
/** Ground classes a LiDAR top must stand on. */
const GREEN = new Set([SURFACE_ID.grass, SURFACE_ID.flowerbed, SURFACE_ID.trees, SURFACE_ID.sand, SURFACE_ID.path]);

type Sources = { osm: OsmData; dem: Raster; dsm: Raster };
type Context = {
  grid: Grid;
  ground: GroundRaster;
  /** Inside a building footprint. */
  covers: (x: number, z: number) => boolean;
  /** Height of a bridge deck over a point, if any. */
  deckAt: (x: number, z: number) => number | null;
};

/** LiDAR tree tops in the grid: local maxima of the canopy height, with a crown radius from where it falls away. */
function lidarTops(dem: Raster, dsm: Raster, grid: Grid): Tree[] {
  const { width: w, height: h } = dem;
  const chm = new Float32Array(w * h);
  for (let i = 0; i < chm.length; i++) {
    const v = dsm.data[i] - dem.data[i];
    chm[i] = Number.isFinite(v) ? v : 0;
  }
  // Pixel centres in local metres (the projection is a plain offset; see project.ts).
  const x0 = dem.west + dem.res / 2 - ORIGIN_NZTM.e;
  const z0 = ORIGIN_NZTM.n - (dem.north - dem.res / 2);
  const tops: Tree[] = [];
  const W = TOP_WINDOW;
  const dirs = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);
  for (let r = W; r < h - W; r++) {
    const z = z0 + r * dem.res;
    if (z < grid.z0 || z >= grid.z0 + grid.nz * 250) continue;
    for (let c = W; c < w - W; c++) {
      const top = chm[r * w + c];
      if (top < MIN_TOP || top > MAX_TOP) continue;
      const x = x0 + c * dem.res;
      if (x < grid.x0 || x >= grid.x0 + grid.nx * 250) continue;
      // Strictly higher than earlier pixels, at least as high as later ones: one top per plateau.
      let peak = true;
      for (let dr = -W; dr <= W && peak; dr++) {
        for (let dc = -W; dc <= W; dc++) {
          const k = (r + dr) * w + c + dc;
          const v = chm[k];
          if (v > top || (v === top && (dr < 0 || (dr === 0 && dc < 0)))) {
            peak = false;
            break;
          }
        }
      }
      if (!peak) continue;
      // Crown radius: mean distance out to the edge, in eight directions.
      let sum = 0;
      for (const [dx, dz] of dirs) {
        let d = 1;
        for (; d <= MAX_CROWN; d++) {
          const rr = Math.round(r + dz * d);
          const cc = Math.round(c + dx * d);
          if (rr < 0 || cc < 0 || rr >= h || cc >= w || chm[rr * w + cc] < top * CROWN_EDGE) break;
        }
        sum += d;
      }
      const crown = Math.min(MAX_CROWN, Math.max(MIN_CROWN, sum / 8));
      tops.push({ x, z, height: top, crown, kind: crown < top * 0.2 && top > 12 ? 'conifer' : 'broadleaf' });
    }
  }
  return tops;
}

/** A tree's kind from its OSM tags (genus, species, taxon, leaf type). */
function kindOf(t: Tags): TreeKind {
  const name = [t.genus, t.species, t.taxon, t['species:en'], t['genus:en']].filter(Boolean).join(' ').toLowerCase();
  if (/palm|phoenix|washingtonia|rhopalostylis|nikau|nīkau|archontophoenix|syagrus|cocos|livistona|trachycarpus|howea/.test(name)) return 'palm';
  if (t.leaf_type === 'needleleaved' || /araucaria|pinus|pine|cupressus|podocarpus|agathis|kauri|dacrydium|rimu|totara|tōtara/.test(name)) return 'conifer';
  return 'broadleaf';
}

/** Finds trees: OSM ones (sized from LiDAR where it sees them), then LiDAR tops over green ground. */
export function findTrees(data: Sources, ctx: Context): { trees: Tree[]; counts: Record<string, number> } {
  const { grid, ground, covers, deckAt } = ctx;
  const inGrid = (p: Local) => p.x >= grid.x0 && p.z >= grid.z0 && p.x < grid.x0 + grid.nx * 250 && p.z < grid.z0 + grid.nz * 250;
  // Tops not on a building or a bridge (both stand well above the DEM).
  const tops = lidarTops(data.dem, data.dsm, grid).filter((t) => !covers(t.x, t.z) && deckAt(t.x, t.z) === null);
  // Bucketed by 10 m cell for the nearest-top lookups.
  const cells = new Map<string, Tree[]>();
  const cellOf = (x: number, z: number) => `${Math.floor(x / 10)},${Math.floor(z / 10)}`;
  for (const t of tops) {
    const k = cellOf(t.x, t.z);
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(t);
  }
  const near = (p: Local, d: number): Tree[] => {
    const out: Tree[] = [];
    for (let i = Math.floor((p.x - d) / 10); i <= Math.floor((p.x + d) / 10); i++) {
      for (let j = Math.floor((p.z - d) / 10); j <= Math.floor((p.z + d) / 10); j++) {
        for (const t of cells.get(`${i},${j}`) ?? []) if (Math.hypot(t.x - p.x, t.z - p.z) <= d) out.push(t);
      }
    }
    return out;
  };
  const used = new Set<Tree>();
  const trees: Tree[] = [];
  const counts = { osm: 0, 'osm sized by LiDAR': 0, row: 0, lidar: 0 };
  const plant = (p: Local, t: Tags) => {
    if (!inGrid(p) || covers(p.x, p.z) || ground.at(p.x, p.z) === SURFACE_ID.road) return false;
    // The highest top beside it is its crown.
    const top = near(p, MATCH).filter((c) => !used.has(c)).sort((a, b) => b.height - a.height)[0];
    const tagged = parseLength(t.height);
    const crownTag = parseLength(t.diameter_crown) / 2;
    if (top) {
      used.add(top);
      // Its crown's other tops are the same tree.
      for (const o of near(top, top.crown * 0.8)) used.add(o);
      counts['osm sized by LiDAR']++;
    }
    const height = tagged > 1 && tagged < 40 ? tagged : top ? top.height : DEFAULT_HEIGHT;
    const crown = crownTag > 0.5 && crownTag < 15 ? crownTag : top ? top.crown : DEFAULT_CROWN;
    trees.push({ x: p.x, z: p.z, height, crown: Math.min(crown, height * 0.6), kind: kindOf(t) });
    return true;
  };
  // In id order, so the output doesn't depend on how the cache was read.
  for (const id of [...data.osm.nodes.keys()].sort((a, b) => a - b)) {
    const n = data.osm.nodes.get(id)!;
    if (n.tags?.natural === 'tree' && plant(lonLatToLocal(n.lon, n.lat), n.tags)) counts.osm++;
  }
  // Tree rows: evenly spaced along the way, skipping where a mapped tree already stands.
  for (const id of [...data.osm.ways.keys()].sort((a, b) => a - b)) {
    const w = data.osm.ways.get(id)!;
    if (w.tags.natural !== 'tree_row') continue;
    const pts = w.nodes.flatMap((ref) => {
      const n = data.osm.nodes.get(ref);
      return n ? [lonLatToLocal(n.lon, n.lat)] : [];
    });
    let from = ROW_SPACING / 2; // distance along the next segment to the next tree
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      let s = from;
      for (; s < len; s += ROW_SPACING) {
        const p = { x: a.x + ((b.x - a.x) * s) / len, z: a.z + ((b.z - a.z) * s) / len };
        if (trees.some((t) => Math.hypot(t.x - p.x, t.z - p.z) < ROW_SPACING / 2)) continue;
        if (plant(p, w.tags)) counts.row++;
      }
      from = s - len;
    }
  }
  // LiDAR-only trees on green ground, tallest first, one per crown.
  const placed = new Map<string, Tree[]>();
  for (const t of trees) {
    const k = cellOf(t.x, t.z);
    (placed.get(k) ?? placed.set(k, []).get(k)!).push(t);
  }
  const clash = (t: Tree) => {
    for (let i = Math.floor(t.x / 10) - 1; i <= Math.floor(t.x / 10) + 1; i++) {
      for (let j = Math.floor(t.z / 10) - 1; j <= Math.floor(t.z / 10) + 1; j++) {
        for (const o of placed.get(`${i},${j}`) ?? []) if (Math.hypot(o.x - t.x, o.z - t.z) < Math.max(2, 0.7 * Math.max(o.crown, t.crown))) return true;
      }
    }
    return false;
  };
  for (const t of [...tops].sort((a, b) => b.height - a.height || a.x - b.x || a.z - b.z)) {
    if (used.has(t) || !GREEN.has(ground.at(t.x, t.z)) || clash(t)) continue;
    trees.push(t);
    const k = cellOf(t.x, t.z);
    (placed.get(k) ?? placed.set(k, []).get(k)!).push(t);
    counts.lidar++;
  }
  return { trees, counts };
}

// ---------------------------------------------------------------- models

const BARK = rgb(0x5a4636);
const PALM_TRUNK = rgb(0x7d6b55);
/** Foliage greens per kind; each tree picks one and varies its brightness. */
const LEAVES: Record<TreeKind, [number, number, number][]> = {
  broadleaf: [rgb(0x3f6b2e), rgb(0x4d7a34), rgb(0x365e2a), rgb(0x5a7f3a), rgb(0x2f5426)],
  palm: [rgb(0x557a35), rgb(0x4a6e2e)],
  conifer: [rgb(0x2c4a2a), rgb(0x34532e)],
};

/** Triangles a model adds, for the build log. */
export const treeTris = { crowns: 0, trunks: 0 };

/**
 * A tapered trunk: an open three-sided prism from just under the ground to
 * `top`. Its faces are also the tree's collider, so a car stops against it
 * and the character controller walks round it.
 */
function trunk(mb: MeshBuilder, x: number, y: number, z: number, top: number, r: number, colour: readonly number[], rot: number) {
  const sides = 3;
  const base = y - 0.3;
  const ring: number[][] = [];
  for (let k = 0; k < sides; k++) {
    const a = rot + (k * 2 * Math.PI) / sides;
    const n = [Math.cos(a), 0, Math.sin(a)];
    ring.push([
      mb.vertex(x + n[0] * r, base, z + n[2] * r, n, colour, 0, 0, 0, 0, 0.75),
      mb.vertex(x + n[0] * r * 0.6, top, z + n[2] * r * 0.6, n, colour),
    ]);
  }
  const faces: number[] = [];
  for (let k = 0; k < sides; k++) {
    const [a0, a1] = ring[k];
    const [b0, b1] = ring[(k + 1) % sides];
    faces.push(a0, a1, b0, b0, a1, b1);
  }
  mb.idx.push(...faces);
  mb.colliderIdx.push(...faces);
  treeTris.trunks += sides * 2;
}

/**
 * A closed blob between `bottom` and `top`: an apex, rings and a base
 * point, with normals pointing out from its middle so it shades round.
 * `rings` gives each ring's [height fraction, radius fraction]; alternate
 * rings are turned half a step so the facets interlock.
 */
function blob(mb: MeshBuilder, x: number, z: number, bottom: number, top: number, r: number, rings: [number, number][], sides: number, colour: readonly number[], rot: number, lumps: number[]) {
  const cy = (bottom + top) / 2;
  const hy = (top - bottom) / 2;
  const v = (px: number, py: number, pz: number, shade: number) => {
    const n = [(px - x) / r, (py - cy) / hy, (pz - z) / r];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return mb.vertex(px, py, pz, [n[0] / l, n[1] / l, n[2] / l], colour, 0, 0, 0, 0, shade);
  };
  const apex = v(x, top, z, 1.05);
  const ringIdx = rings.map(([fy, fr], q) => {
    const y = bottom + (top - bottom) * fy;
    return Array.from({ length: sides }, (_, k) => {
      const a = rot + ((k + (q % 2) * 0.5) * 2 * Math.PI) / sides;
      const rr = r * fr * lumps[(k + q * 3) % lumps.length];
      // Darker underneath, where the crown shades itself.
      return v(x + Math.cos(a) * rr, y, z + Math.sin(a) * rr, 0.8 + 0.25 * fy);
    });
  });
  const foot = v(x, bottom, z, 0.7);
  const before = mb.idx.length;
  const first = ringIdx[0];
  const last = ringIdx[ringIdx.length - 1];
  // Rings run bottom to top; faces wind counter-clockwise seen from outside.
  for (let k = 0; k < sides; k++) mb.idx.push(foot, first[k], first[(k + 1) % sides]);
  for (let q = 0; q + 1 < ringIdx.length; q++) {
    const lo = ringIdx[q];
    const hi = ringIdx[q + 1];
    const shift = q % 2 === 0; // the upper ring is turned half a step ahead
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      if (shift) mb.idx.push(lo[k], hi[k], lo[k1], lo[k1], hi[k], hi[k1]);
      else mb.idx.push(lo[k], hi[(k + sides - 1) % sides], hi[k], lo[k], hi[k], lo[k1]);
    }
  }
  for (let k = 0; k < sides; k++) mb.idx.push(last[k], apex, last[(k + 1) % sides]);
  treeTris.crowns += (mb.idx.length - before) / 3;
}

/** Bakes one tree into its chunk's mesh, standing on the ground at y. */
export function emitTree(mb: MeshBuilder, t: Tree, y: number) {
  const key = `${t.x.toFixed(1)},${t.z.toFixed(1)}`;
  const h0 = hash(key, 1);
  const h1 = hash(key, 2);
  const rot = h0 * Math.PI * 2;
  const palette = LEAVES[t.kind];
  const base = palette[Math.floor(h1 * palette.length)];
  const leaf = base.map((c) => c * (0.85 + 0.3 * h0));
  const lumps = [1, 0.86 + 0.2 * h1, 1.08, 0.9 + 0.15 * h0, 0.95];
  const h = t.height;
  if (t.kind === 'palm') {
    trunk(mb, t.x, y, t.z, y + h - 0.4, 0.22, PALM_TRUNK, rot);
    // A flat, drooping head of fronds.
    const r = Math.max(2, Math.min(t.crown, 3.5));
    blob(mb, t.x, t.z, y + h - 1.6, y + h + 0.4, r, [[0.25, 0.9], [0.55, 1]], 5, leaf, rot, lumps);
    return;
  }
  if (t.kind === 'conifer') {
    const r = Math.min(t.crown, h * 0.3);
    trunk(mb, t.x, y, t.z, y + h * 0.5, 0.18 + 0.012 * h, BARK, rot);
    blob(mb, t.x, t.z, y + Math.min(2, h * 0.15), y + h, r, [[0.05, 1], [0.45, 0.7]], 5, leaf, rot, lumps);
    return;
  }
  // Broadleaf: a round crown on a trunk, its foot clear of head height.
  const r = t.crown;
  const depth = Math.min(h - 2, Math.max(r * 1.4, h * 0.55));
  const bottom = y + h - depth;
  trunk(mb, t.x, y, t.z, bottom + depth * 0.3, 0.18 + 0.012 * h + 0.02 * r, BARK, rot);
  blob(mb, t.x, t.z, bottom, y + h, r, [[0.2, 0.85], [0.6, 1]], 5, leaf, rot, lumps);
}

/** Bakes every tree into its chunk's mesh (`chunkAt` gives a point's chunk builder), grouped by tile. */
export function emitTrees(trees: Tree[], grid: Grid, terrain: TerrainSampler, chunkAt: (x: number, z: number) => MeshBuilder | null) {
  const size = CHUNK_SIZE / TREE_TILES;
  for (const t of trees) {
    const mb = chunkAt(t.x, t.z);
    if (!mb) continue;
    const c = Math.floor(((((t.x - grid.x0) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE) / size);
    const r = Math.floor(((((t.z - grid.z0) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE) / size);
    mb.group(r * TREE_TILES + c, TREE_TILES, () => emitTree(mb, t, terrain.heightAt(t.x, t.z)));
  }
}
