import { distanceToRing, inPolygon, type Cavity } from '../city/cavity.ts';
import type { LandmarkInfo } from '../city/format.ts';
import { DECAL, L, SIGN } from './atlas.ts';
import { Frame, rect, type Builder, type Mat, type V2, type V3 } from './builder.ts';
import type { LandmarkModel } from './landmarks.ts';

// Aotea Square and the Civic car park under it. The square itself is the
// ground as generated (paving, the grass terraces, its trees and kiosks);
// this adds the Waharoa (Selwyn Muru's carved gateway, 1990) on the Queen
// St side, the AOTEA CENTRE lettering over the centre's foyer, and the car
// park: one big level dug out under the square (see src/city/cavity.ts),
// entered down a ramp from the end of Greys Ave, as the real one is, with
// columns, painted bays and strip lights. The real car park has two levels
// and runs under the Aotea Centre too; this is the part under the open
// square, kept clear of every building's footings. Anchored on the OSM car
// park skylights (records), but laid out in fixed coordinates: the dig has
// to match the terrain's 2 m lattice and 10 m coarse grid exactly.

/** Car park floor and ceiling, m above sea level (the square above is 19.8-22 m). */
const FLOOR = 16;
const CEIL = 18.6;
/** The ramp: a 10 m wide trench from the end of Greys Ave north into the car park, open to the sky for its top 20 m. */
const RAMP = { x0: -514, x1: -504, bottom: 926, lintel: 936, mid: 946, top: 956, midY: 18.6, ceil: 19.8 };
/** The car park's outline (local metres), one edge open to the ramp (R2 -> R1). */
const MAIN: V2[] = [[-474, 826], [-403, 848], [-417, 892], [-468, 932], [RAMP.x1, RAMP.bottom], [RAMP.x0, RAMP.bottom], [RAMP.x0, 904], [-503, 890], [-488, 866]];
const OPEN_EDGE = 4;
/** Lattice points this close outside the outline are dug too, so no cell crossing a wall slopes up inside it. */
const DIG_MARGIN = 3;
/** The Waharoa's two posts (from its OSM outline), and the ground there. */
const WAHAROA = { a: [-421.85, 844.8] as V2, b: [-420.15, 855.5] as V2, ground: 19.9 };
/** The Aotea Centre's front over the square (its OSM outline's edge): the middle of the lettering and the way it faces. */
const AOTEA_SIGN = { at: [-490.65, 850.4] as V2, out: [0.936, 0.352] as V2, y: 29.5 };

const SHADE = 0.55;
const FLOOR_MAT: Mat = { layer: L.concrete, colour: 0x8a8984, sv: 8, su: 8, shade: SHADE };
const RAMP_MAT: Mat = { layer: -1, colour: 0x3b3e42, shade: 0.7 };
const WALL: Mat = { layer: L.concrete, colour: 0xc9c4b8, sv: 8, su: 8, shade: SHADE };
const STRIPE: Mat = { layer: -1, colour: 0xd9b230, shade: 0.7 };
const CEILING: Mat = { layer: L.concrete, colour: 0xd8d8d4, sv: 8, su: 8, shade: 0.7, glow: 0.08 };
const COLUMN: Mat = { layer: -1, colour: 0xc2bdb2, shade: 0.6 };
const LINE: Mat = { layer: -1, colour: 0xe8e6de, shade: 0.75 };
const LAMP: Mat = { layer: -1, colour: 0xfff3d6, glow: 1.4 };
const PARAPET: Mat = { layer: L.concrete, colour: 0xbcb6aa, sv: 8, su: 8 };
const GANTRY: Mat = { layer: -1, colour: 0x2f3438 };
const SIGNS: Mat = { layer: L.signs, colour: 0xffffff, glow: 0.8 };
const P_SIGN: Mat = { layer: L.decal, colour: 0xffffff, glow: 0.4 };
const WOOD: Mat = { layer: -1, colour: 0x6e3b24 };
const OCHRE: Mat = { layer: -1, colour: 0x9a3220 };
const COPPER: Mat = { layer: L.slate, colour: 0x5f9a82, su: 1.5, sv: 1.5 };
const LETTERS: Mat = { layer: L.signs, colour: 0xffffff, glow: 0.6 };

/** Ramp surface height down its covered part (fixed, so the model can draw it), m. */
function rampY(z: number): number {
  return FLOOR + ((z - RAMP.bottom) / (RAMP.mid - RAMP.bottom)) * (RAMP.midY - FLOOR);
}

function cavity(): Cavity {
  const xs = MAIN.map((p) => p[0]);
  const zs = MAIN.map((p) => p[1]);
  return {
    bounds: { minX: Math.min(...xs) - DIG_MARGIN, maxX: Math.max(...xs) + DIG_MARGIN, minZ: Math.min(...zs) - DIG_MARGIN, maxZ: RAMP.top },
    carve(x, z, ground) {
      if (x >= RAMP.x0 && x <= RAMP.x1 && z >= RAMP.bottom && z <= RAMP.top) {
        if (z <= RAMP.mid) return rampY(z);
        // The last stretch blends into the street at the top, whatever its height.
        const t = (z - RAMP.mid) / (RAMP.top - RAMP.mid);
        return RAMP.midY + (ground(x, RAMP.top) - RAMP.midY) * t;
      }
      if (inPolygon(MAIN, x, z) || distanceToRing(MAIN, x, z) < DIG_MARGIN) return FLOOR;
      return null;
    },
    openings: [[RAMP.x0, RAMP.lintel, RAMP.x1, RAMP.top]],
    openingColour: 0x3b3e42,
  };
}

function build(b: Builder, far: boolean, _records: LandmarkInfo[]): void {
  waharoa(b, far);
  aoteaSign(b);
  if (far) return;
  carPark(b);
}

function carPark(b: Builder): void {
  b.ground = FLOOR;
  const inward = inwardNormals(MAIN);
  // Floor, ceiling (a collider too, so the camera stays under it) and the walls.
  b.cap(MAIN, FLOOR + 0.02, FLOOR_MAT, true);
  b.cap(MAIN, CEIL, CEILING, false);
  b.collideFlat(MAIN, CEIL);
  for (let k = 0; k < MAIN.length; k++) {
    if (k === OPEN_EDGE) continue;
    const a = MAIN[k];
    const c = MAIN[(k + 1) % MAIN.length];
    const n = inward[k];
    b.wall(a, c, FLOOR - 0.4, CEIL, WALL, { out: n, vBase: FLOOR });
    // A painted stripe along the wall at bumper height.
    const off = (p: V2): V2 => [p[0] + n[0] * 0.02, p[1] + n[1] * 0.02];
    b.wall(off(a), off(c), FLOOR + 0.6, FLOOR + 0.9, STRIPE, { out: n });
    // Overlapping at the corners, but held back from the way in from the
    // ramp: a wall meeting it at an angle would poke a corner into the lane.
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const d: V2 = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
    const [s0, s1] = k === OPEN_EDGE - 1 ? [-0.4, -1.2] : k === OPEN_EDGE + 1 ? [1.2, 0.4] : [-0.4, 0.4];
    const p0: V2 = [a[0] + d[0] * s0, a[1] + d[1] * s0];
    const p1: V2 = [c[0] + d[0] * s1, c[1] + d[1] * s1];
    b.collideBox((p0[0] + p1[0]) / 2 - n[0] * 0.4, (p0[1] + p1[1]) / 2 - n[1] * 0.4, FLOOR - 1, CEIL + 0.5, len - s0 + s1, 0.8, Math.atan2(-d[1], d[0]));
  }

  // Columns on a 10 m grid, each with a stall line either side and a lamp
  // between rows; the lane up from the ramp is kept clear.
  const lane = (x: number, z: number) => x > RAMP.x0 - 2 && x < RAMP.x1 + 2 && z > 900;
  for (let x = -506; x <= -400; x += 10) {
    for (let z = 834; z <= 930; z += 10) {
      if (!inPolygon(MAIN, x, z) || distanceToRing(MAIN, x, z) < 3 || lane(x, z)) continue;
      b.box(x, z, FLOOR - 0.1, CEIL, 0.6, 0.6, 0, COLUMN, null);
      b.box(x, z, FLOOR - 0.1, FLOOR + 1.0, 0.64, 0.64, 0, STRIPE, null);
      b.collideBox(x, z, FLOOR - 0.5, CEIL, 0.6, 0.6, 0);
      // Stalls: 2.5 m wide, 5 m deep, on the north side of the column row.
      for (let k = -1; k <= 2; k++) {
        const lx = x + k * 2.5;
        const z0 = z - 5;
        if (!inPolygon(MAIN, lx, z0) || distanceToRing(MAIN, lx, z0) < 1 || lane(lx, z0)) continue;
        const ring: V2[] = [[lx - 0.06, z0], [lx + 0.06, z0], [lx + 0.06, z], [lx - 0.06, z]];
        b.cap(ring, FLOOR + 0.03, LINE, true);
      }
    }
  }
  for (let x = -501; x <= -405; x += 10) {
    for (let z = 834; z <= 930; z += 10) {
      if (!inPolygon(MAIN, x, z) || distanceToRing(MAIN, x, z) < 2) continue;
      b.cap(rect(x, z, 2.4, 0.3, 0), CEIL - 0.03, LAMP, false);
    }
  }

  // The ramp: its covered stretch (the open one is the terrain's own
  // ground, drawn at the dug heights), the walls either side rising to a
  // parapet over the square, the lintel where it goes under, the deeper
  // ceiling over it and the beam down to the car park's ceiling.
  const { x0, x1, bottom, lintel, top } = RAMP;
  b.poly([[x0, rampY(bottom) + 0.02, bottom], [x1, rampY(bottom) + 0.02, bottom], [x1, rampY(lintel) + 0.02, lintel], [x0, rampY(lintel) + 0.02, lintel]], [[0, 0], [1, 0], [1, 1], [0, 1]], RAMP_MAT, [0, 1, 0]);
  b.cap([[x0, bottom], [x1, bottom], [x1, lintel], [x0, lintel]], RAMP.ceil, CEILING, false);
  b.collideFlat([[x0, bottom], [x1, bottom], [x1, lintel], [x0, lintel]], RAMP.ceil);
  b.wall([x1, bottom], [x0, bottom], CEIL, RAMP.ceil, WALL, { out: [0, 1] });
  b.cap(rect((x0 + x1) / 2, bottom + 4, 2.4, 0.3, 0), RAMP.ceil - 0.03, LAMP, false);
  /** Parapet height along the open stretch: over the square's edge, lower at the street. */
  const capY = (z: number) => 23.2 + ((z - lintel) / (top - lintel)) * (21 - 23.2);
  for (const [x, side] of [[x0, 1], [x1, -1]] as const) {
    // Inside faces: up to the parapet where it's open, to the ceiling where it's covered.
    b.poly([[x, FLOOR - 0.4, lintel], [x, FLOOR - 0.4, top], [x, capY(top), top], [x, capY(lintel), lintel]], [[0, 0], [2.5, 0], [2.5, 0.9], [0, 0.9]], WALL, [side, 0, 0]);
    b.poly([[x, FLOOR - 0.4, bottom], [x, FLOOR - 0.4, lintel], [x, RAMP.ceil, lintel], [x, RAMP.ceil, bottom]], [[0, 0], [1.25, 0], [1.25, 0.5], [0, 0.5]], WALL, [side, 0, 0]);
    b.wall([x, bottom], [x, top], FLOOR + 0.6, FLOOR + 0.9, STRIPE, { out: [side, 0] });
    // Outside face and the cap of the parapet, above the square.
    const xo = x - side * 0.3;
    b.poly([[xo, 19.2, lintel], [xo, 18.4, top], [xo, capY(top), top], [xo, capY(lintel), lintel]], [[0, 0], [2.5, 0], [2.5, 0.5], [0, 0.5]], PARAPET, [-side, 0, 0]);
    b.poly([[x, capY(lintel), lintel], [x, capY(top), top], [xo, capY(top), top], [xo, capY(lintel), lintel]], [[0, 0], [1, 0], [1, 1], [0, 1]], PARAPET, [0, 1, 0]);
    b.collideBox(x - side * 0.15, (bottom + top) / 2, FLOOR - 1, 23.2, top - bottom, 0.3, Math.PI / 2);
  }
  // The lintel over the way in, faced both sides, with a parapet along its top.
  b.wall([x0, lintel], [x1, lintel], RAMP.ceil, 23.2, PARAPET, { out: [0, 1] });
  b.wall([x1, lintel - 0.3], [x0, lintel - 0.3], 21.5, 23.2, PARAPET, { out: [0, -1] });
  b.cap([[x0, lintel - 0.3], [x1, lintel - 0.3], [x1, lintel], [x0, lintel]], 23.2, PARAPET, true);
  b.collideBox((x0 + x1) / 2, lintel - 0.15, RAMP.ceil, 23.2, x1 - x0, 0.3, 0);

  // A gantry over the mouth: CIVIC CAR PARK, and a P on a post.
  const gy = 21.7;
  b.box((x0 + x1) / 2, top - 0.6, gy, gy + 2.2, x1 - x0, 0.3, 0, GANTRY);
  const face = new Frame([x0, top - 0.45], [1, 0], [0, 1]);
  b.decal(face, (x1 - x0) / 2, gy + 0.1, 8.8, 2.0, SIGN.carPark, SIGNS, 0.02);
  const back = new Frame([x1, top - 0.75], [-1, 0], [0, -1]);
  b.decal(back, (x1 - x0) / 2, gy + 0.1, 8.8, 2.0, SIGN.carPark, SIGNS, 0.02);
  b.box(x1 + 1.4, top + 1.2, 18, 23.6, 0.15, 0.15, 0, GANTRY);
  const post = new Frame([x1 + 1.4 - 0.6, top + 1.3], [1, 0], [0, 1]);
  b.decal(post, 0.6, 22.2, 1.2, 1.2, DECAL.parking, P_SIGN, 0.02);
}

/** The carved gateway: two posts, a lintel and a copper-capped peak over it, in red-ochre and dark wood. */
function waharoa(b: Builder, far: boolean): void {
  const [ax, az] = WAHAROA.a;
  const [bx, bz] = WAHAROA.b;
  const g = WAHAROA.ground;
  const len = Math.hypot(bx - ax, bz - az);
  const rot = Math.atan2(-(bz - az), bx - ax);
  const cx = (ax + bx) / 2;
  const cz = (az + bz) / 2;
  const dir: V2 = [(bx - ax) / len, (bz - az) / len];
  for (const [px, pz] of [WAHAROA.a, WAHAROA.b]) {
    b.box(px, pz, g - 0.5, g + 7, 1.1, 0.8, rot, [WOOD, OCHRE, WOOD, OCHRE], null);
    if (!far) {
      // Carved bands up each post.
      for (let y = g + 0.8; y < g + 6.6; y += 1.1) b.box(px, pz, y, y + 0.45, 1.2, 0.9, rot, OCHRE, null);
      b.collideBox(px, pz, g - 0.5, g + 7, 1.1, 0.8, rot);
    }
  }
  // The lintel, then the peak: a long gable faced in copper.
  b.box(cx, cz, g + 7, g + 8.3, len + 1.6, 0.9, rot, [OCHRE, WOOD, OCHRE, WOOD], WOOD);
  const n: V2 = [-dir[1], dir[0]];
  const end = (s: number, w: number): V2 => [cx + dir[0] * s * (len / 2 + 0.8) + n[0] * w, cz + dir[1] * s * (len / 2 + 0.8) + n[1] * w];
  const yb = g + 8.3;
  const yt = g + 10.2;
  const ridgeA: V3 = [cx - dir[0] * (len / 2 + 0.8), yt, cz - dir[1] * (len / 2 + 0.8)];
  const ridgeB: V3 = [cx + dir[0] * (len / 2 + 0.8), yt, cz + dir[1] * (len / 2 + 0.8)];
  for (const side of [1, -1]) {
    const p0 = end(-1, side * 0.6);
    const p1 = end(1, side * 0.6);
    b.poly([[p0[0], yb, p0[1]], [p1[0], yb, p1[1]], ridgeB, ridgeA], [[0, 0], [len / 1.5, 0], [len / 1.5, 1.4], [0, 1.4]], COPPER, [n[0] * side, 0.4, n[1] * side]);
  }
  for (const s of [-1, 1]) {
    const p0 = end(s, 0.6);
    const p1 = end(s, -0.6);
    const r: V3 = s < 0 ? ridgeA : ridgeB;
    b.poly([[p0[0], yb, p0[1]], [p1[0], yb, p1[1]], r], [[0, 0], [1, 0], [0.5, 1]], OCHRE, [dir[0] * s, 0, dir[1] * s]);
  }
  if (!far) {
    // A figure (tekoteko) on the peak's middle.
    b.lathe(cx, cz, [[0.35, yt - 0.3], [0.4, yt + 0.6], [0.3, yt + 1.0], [0.35, yt + 1.3], [0.0, yt + 1.7]], 6, WOOD, 1, 0, false);
  }
}

/** AOTEA CENTRE across the foyer wall, facing the square. */
function aoteaSign(b: Builder): void {
  const [sx, sz] = AOTEA_SIGN.at;
  const [ox, oz] = AOTEA_SIGN.out;
  // Running to the right as you face it, so it reads the right way round.
  const f = new Frame([sx + ox * 0.6, sz + oz * 0.6], [oz, -ox], AOTEA_SIGN.out);
  b.decal(f, 0, AOTEA_SIGN.y, 15, 3.75, SIGN.aotea, LETTERS, 0);
}

/** Inward unit normal of each edge k (MAIN[k] -> MAIN[k + 1]). */
function inwardNormals(ring: V2[]): V2[] {
  let area = 0;
  for (let k = 0; k < ring.length; k++) {
    const [x0, z0] = ring[k];
    const [x1, z1] = ring[(k + 1) % ring.length];
    area += x0 * z1 - x1 * z0;
  }
  return ring.map((a, k) => {
    const c = ring[(k + 1) % ring.length];
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const l = Math.hypot(dx, dz);
    // Outward is (dz, -dx) for a counter-clockwise ring (as Builder.prism has it).
    return area > 0 ? [-dz / l, dx / l] : [dz / l, -dx / l];
  });
}

export const aoteaSquare: LandmarkModel = {
  id: 'aotea-square',
  name: 'Aotea Square',
  near: 300,
  drawDistance: 650,
  height: 12,
  build,
  cavity,
};
