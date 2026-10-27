import type { LandmarkInfo } from '../city/format.ts';
import { DECAL, L } from './atlas.ts';
import { Frame, type Builder, type Mat, type V2 } from './builder.ts';
import type { LandmarkModel } from './landmarks.ts';

// The Ferry Building (1912, Alexander Wiseman, Edwardian Baroque) on Quay
// St at the foot of Queen St: a long sandstone and red-brick block, an
// arcade of round arches along the ground floor, three brick storeys with
// stone dressings, a tiled mansard with dormers, and the clock tower in
// the middle of the Quay St front, its pyramid roof topping out ~40 m up
// (LiDAR). Laid out on the OSM footprint (63 x 14 m).

const SANDSTONE = 0xe6cfa6;
const ARCADE: Mat = { layer: L.ferryArcade, colour: SANDSTONE, su: 4.6, sv: 5.5 };
const UPPER: Mat = { layer: L.ferryUpper, colour: SANDSTONE, su: 4.6, sv: 7 };
const STONE: Mat = { layer: L.stone, colour: SANDSTONE, su: 4, sv: 4 };
const CORNICE: Mat = { layer: L.stone, colour: 0xf0dcb8, su: 4, sv: 1 };
const ROOF: Mat = { layer: L.roofTiles, colour: 0xc9785a, su: 3, sv: 3 };
const LEAD: Mat = { layer: L.slate, colour: 0x7f9488, su: 2, sv: 2 };
const FLAT: Mat = { layer: -1, colour: 0x8a8580 };
const DECALS: Mat = { layer: L.decal, colour: 0xffffff };

const GROUND = 5.5; // top of the arcade
const EAVES = 16; // top of the brick
const CORNICE_TOP = 17;
const RIDGE = 22.5; // mansard top

/**
 * The footprint as a rectangle: the long side facing `out` (plan
 * direction) as a frame from its left end (seen from outside), its length,
 * and the depth back from it.
 */
export function longSide(footprint: [number, number][], out: V2): { f: Frame; length: number; depth: number } {
  let best: { a: V2; b: V2; score: number } | null = null;
  const n = footprint.length;
  const cx = footprint.reduce((s, p) => s + p[0], 0) / n;
  const cz = footprint.reduce((s, p) => s + p[1], 0) / n;
  for (let k = 0; k < n; k++) {
    const a = footprint[k];
    const b = footprint[(k + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const mx = (a[0] + b[0]) / 2 - cx;
    const mz = (a[1] + b[1]) / 2 - cz;
    const score = len * (mx * out[0] + mz * out[1]);
    if (!best || score > best.score) best = { a, b, score };
  }
  const { a, b } = best!;
  const probe = new Frame(a, [b[0] - a[0], b[1] - a[1]], out);
  // Start from the left end seen from outside (looking along -n, +u runs to
  // the right), so decals aren't mirrored.
  const right: V2 = [probe.n[1], -probe.n[0]];
  const dot = (b[0] - a[0]) * right[0] + (b[1] - a[1]) * right[1];
  const [p, q] = dot > 0 ? [a, b] : [b, a];
  const f = new Frame(p, [q[0] - p[0], q[1] - p[1]], out);
  let depth = 0;
  for (const pt of footprint) depth = Math.max(depth, -((pt[0] - f.o[0]) * f.n[0] + (pt[1] - f.o[1]) * f.n[1]));
  return { f, length: Math.hypot(q[0] - p[0], q[1] - p[1]), depth };
}

function build(b: Builder, far: boolean, records: LandmarkInfo[]): void {
  const r = records[0];
  // Quay St runs along the south side.
  const { f, length, depth } = longSide(r.footprint, [0, 1]);
  const y0 = r.base;
  b.ground = y0;
  const ring: V2[] = [f.at(0, 0), f.at(length, 0), f.at(length, -depth), f.at(0, -depth)];
  const bays = (len: number) => Math.max(1, Math.round(len / 4.6));
  const side = (mat: Mat) => (_k: number, a: V2, c: V2) => ({ ...mat, su: Math.hypot(c[0] - a[0], c[1] - a[1]) / bays(Math.hypot(c[0] - a[0], c[1] - a[1])) });

  // Arcade, brick storeys, cornice: three rings round the whole block.
  b.prism(ring, y0 - 1.5, y0 + GROUND, side(ARCADE), null, { vBase: y0 });
  b.prism(ring, y0 + GROUND, y0 + EAVES, side(UPPER), null, { vBase: y0 + GROUND });
  const grow = (d: number): V2[] => [f.at(-d, d), f.at(length + d, d), f.at(length + d, -depth - d), f.at(-d, -depth - d)];
  b.prism(grow(0.45), y0 + EAVES, y0 + CORNICE_TOP, CORNICE, CORNICE);
  if (!far) {
    // A plain string course over the arcade.
    b.prism(grow(0.2), y0 + GROUND - 0.35, y0 + GROUND + 0.1, CORNICE, CORNICE);
  }

  // Mansard: steep tiled slopes to a low flat top.
  const inset = (d: number): V2[] => [f.at(d, -d), f.at(length - d, -d), f.at(length - d, -depth + d), f.at(d, -depth + d)];
  b.frustum(inset(0.1), inset(2.6), y0 + CORNICE_TOP, y0 + RIDGE - 0.6, ROOF);
  b.frustum(inset(2.6), inset(3.6), y0 + RIDGE - 0.6, y0 + RIDGE, ROOF);
  b.cap(inset(3.6), y0 + RIDGE, FLAT);

  // Dormers on both long slopes, one per bay, skipping the tower.
  const n = bays(length);
  const bay = length / n;
  const towerU0 = length / 2 - 4.3;
  const towerU1 = length / 2 + 4.3;
  if (!far) {
    for (const [fr, len] of [[f, length], [new Frame(f.at(length, -depth), [-f.d[0], -f.d[1]], [-f.n[0], -f.n[1]]), length]] as [Frame, number][]) {
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) * bay;
        if (fr === f && u > towerU0 - 1 && u < towerU1 + 1) continue;
        if (u < 2 || u > len - 2) continue;
        dormer(b, fr, u);
      }
    }
  }

  // The clock tower, proud of the Quay St front by half a metre.
  const tw = 8.4;
  const td = 8.2;
  const tu = length / 2;
  const tower: V2[] = [f.at(tu - tw / 2, 0.5), f.at(tu + tw / 2, 0.5), f.at(tu + tw / 2, 0.5 - td), f.at(tu - tw / 2, 0.5 - td)];
  const towerSide = (mat: Mat, per: number) => (_k: number, a: V2, c: V2) => ({ ...mat, su: Math.hypot(c[0] - a[0], c[1] - a[1]) / per });
  b.prism(tower, y0 - 1.5, y0 + GROUND + 0.6, towerSide({ ...ARCADE, sv: 6.1 }, 1), null, { vBase: y0 });
  b.prism(tower, y0 + GROUND + 0.6, y0 + 25, towerSide(UPPER, 2), null, { vBase: y0 + GROUND + 0.6 });
  const tgrow = (d: number, base = tower): V2[] => {
    const c = f.at(tu, 0.5 - td / 2);
    return base.map(([x, z]) => {
      const dx = x - c[0];
      const dz = z - c[1];
      const l = Math.hypot(dx, dz);
      return [x + (dx / l) * d * Math.SQRT2, z + (dz / l) * d * Math.SQRT2] as V2;
    });
  };
  b.prism(tgrow(0.3), y0 + 25, y0 + 25.6, CORNICE, CORNICE);
  // Clock stage: plain stone, a clock on every face.
  b.prism(tower, y0 + 25.6, y0 + 30.4, STONE, null, { vBase: y0 + 25.6 });
  b.prism(tgrow(0.45), y0 + 30.4, y0 + 31.2, CORNICE, CORNICE);
  const tc = f.at(tu, 0.5 - td / 2);
  const faces = [
    new Frame(f.at(tu, 0.5), f.d, f.n),
    new Frame(f.at(tu, 0.5 - td), [-f.d[0], -f.d[1]], [-f.n[0], -f.n[1]]),
    new Frame(f.at(tu + tw / 2, 0.5 - td / 2), [-f.n[0], -f.n[1]], f.d),
    new Frame(f.at(tu - tw / 2, 0.5 - td / 2), f.n, [-f.d[0], -f.d[1]]),
  ];
  for (const face of faces) {
    b.decal(face, 0, y0 + 25.9, 4.2, 4.2, DECAL.clock, DECALS, far ? 0.06 : 0.05);
    if (!far) {
      // Arched windows in the brick shaft below the clock.
      b.decal(face, -1.6, y0 + 18.2, 1.5, 3.4, DECAL.archWindow, DECALS);
      b.decal(face, 1.6, y0 + 18.2, 1.5, 3.4, DECAL.archWindow, DECALS);
    }
  }
  // Pyramid roof, a lantern and a finial.
  const roofBase = tgrow(0.2);
  b.frustum(roofBase, tgrow(-2.6), y0 + 31.2, y0 + 35.5, LEAD);
  b.frustum(tgrow(-2.6), tgrow(-4.05), y0 + 35.5, y0 + 38.6, LEAD);
  if (!far) {
    b.lathe(tc[0], tc[1], [[0.35, y0 + 38.5], [0.35, y0 + 39.6], [0.12, y0 + 41]], 8, { layer: -1, colour: 0x5d6b62 }, 1, 0, false);
  }

  // Colliders: the block and the tower (the OSM footprint's collider stays too).
  if (!far) {
    const c = f.at(length / 2, -depth / 2);
    b.collideBox(c[0], c[1], y0 - 2, y0 + RIDGE, length, depth, f.heading);
    b.collideBox(tc[0], tc[1], y0 - 2, y0 + 31, tw, td, f.heading);
  }
}

/** A dormer window on the mansard: a stone front with an arched window, a tiled hood. */
function dormer(b: Builder, f: Frame, u: number): void {
  const w = 1.9;
  const yb = b.ground + CORNICE_TOP + 0.6;
  const yt = yb + 2.4;
  // Front face sits 0.9 m back from the wall line, on the slope.
  const front = -0.7;
  const back = -3.0;
  const ring: V2[] = [f.at(u - w / 2, front), f.at(u + w / 2, front), f.at(u + w / 2, back), f.at(u - w / 2, back)];
  b.prism(ring, yb, yt, { ...STONE, su: 2, sv: 2 }, null);
  // Little pediment roof.
  b.frustum(
    [f.at(u - w / 2 - 0.15, front + 0.15), f.at(u + w / 2 + 0.15, front + 0.15), f.at(u + w / 2 + 0.15, back), f.at(u - w / 2 - 0.15, back)],
    [f.at(u, front + 0.15), f.at(u, front + 0.15), f.at(u, back), f.at(u, back)],
    yt,
    yt + 0.8,
    ROOF,
  );
  const face = new Frame(f.at(u, front), f.d, f.n);
  b.decal(face, 0, yb + 0.2, 1.3, 2.0, DECAL.archWindow, DECALS);
}

export const ferryBuilding: LandmarkModel = {
  id: 'ferry-building',
  name: 'Ferry Building',
  near: 400,
  drawDistance: 1100,
  height: 41,
  build,
};
