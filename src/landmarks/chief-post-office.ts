import type { LandmarkInfo } from '../city/format.ts';
import { DECAL, L } from './atlas.ts';
import { Frame, type Builder, type Mat, type V2 } from './builder.ts';
import { longSide } from './ferry-building.ts';
import type { LandmarkModel } from './landmarks.ts';

// The Chief Post Office (1912, John Campbell; Britomart station's entrance
// since 2003) at the foot of Queen St, beside the spawn: Edwardian Baroque,
// a rusticated Coromandel granite ground floor with round-arched windows,
// two tall storeys of pale Oamaru stone between engaged Ionic columns, an
// entablature and balustrade at 20 m, end pavilions on the Queen St front
// (Te Komititanga) each carrying a domed cupola to ~31 m (OSM, LiDAR), a
// pedimented centrepiece over the main entrance, and the station's glazed
// roof behind the parapet. Laid out on the OSM footprint: u runs east along
// Customs St from the south-west corner, v north up the Queen St front.

const STONE_COLOUR = 0xeee2c8;
const BASE: Mat = { layer: L.cpoBase, colour: 0xffffff, su: 5, sv: 5.5 };
const UPPER: Mat = { layer: L.cpoUpper, colour: STONE_COLOUR, su: 5, sv: 12 };
const STONE: Mat = { layer: L.stone, colour: STONE_COLOUR, su: 4, sv: 4 };
const CORNICE: Mat = { layer: L.stone, colour: 0xf6ecd6, su: 4, sv: 1 };
const BALUSTRADE: Mat = { layer: L.balustrade, colour: 0xffffff, su: 2, sv: 1.6 };
const ROOF: Mat = { layer: -1, colour: 0x6f6c68 };
const GLASS: Mat = { layer: L.glass, colour: 0xd8e4ea, su: 3, sv: 3 };
const DOME: Mat = { layer: L.slate, colour: 0x86a294, su: 2, sv: 1.2 };
const DECALS: Mat = { layer: L.decal, colour: 0xffffff };

const GROUND = 5.5;
const ENTABLATURE = 17.4;
const PARAPET = 18.4;
const TOP = 20;

function build(b: Builder, far: boolean, records: LandmarkInfo[]): void {
  const r = records[0];
  const y0 = r.base;
  b.ground = y0;
  // Customs St along the south side; the frame's origin is its west end.
  const { f, length: W, depth: D } = longSide(r.footprint, [0, 1]);
  const P = (u: number, v: number): V2 => f.at(u, -v);
  const fit = (mat: Mat, bay: number) => (_k: number, a: V2, c: V2): Mat => {
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    return { ...mat, su: len / Math.max(1, Math.round(len / bay)) };
  };

  // Plan: pavilions at both ends of the Queen St (west) front stand 2.3 m
  // proud of the recessed centre between them.
  const PAV = 10.4;
  const RECESS = 2.3;
  const outline: V2[] = [P(0, 0), P(W, 0), P(W, D), P(0, D), P(0, D - 9.2), P(RECESS, D - 9.2), P(RECESS, PAV), P(0, PAV)];
  b.prism(outline, y0 - 1.5, y0 + GROUND, fit(BASE, 5), null, { vBase: y0 });
  b.prism(outline, y0 + GROUND, y0 + ENTABLATURE, fit(UPPER, 5), null, { vBase: y0 + GROUND });
  const grown = grow(outline, 0.5);
  b.prism(grown, y0 + ENTABLATURE, y0 + PARAPET, CORNICE, CORNICE);
  b.prism(grow(outline, 0.15), y0 + GROUND - 0.4, y0 + GROUND, CORNICE, null);
  b.cap(outline, y0 + PARAPET, ROOF);

  // Balustrade along the parapet (both faces, it's a cut-out), but not over the pavilions.
  if (!far) {
    const rail = grow(outline, 0.05);
    for (let k = 0; k < rail.length; k++) {
      const a = rail[k];
      const c = rail[(k + 1) % rail.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const m = { ...BALUSTRADE, su: len / Math.max(1, Math.round(len / 2)) };
      b.wall(a, c, y0 + PARAPET, y0 + TOP, m, {});
      b.wall(c, a, y0 + PARAPET, y0 + TOP, { ...m }, { u0: 0 });
    }
  } else {
    b.prism(outline, y0 + PARAPET, y0 + TOP - 0.6, STONE, ROOF);
  }

  // Pavilions: an attic storey with an oculus, a cornice, then the cupola.
  const pavilions: [V2[], number][] = [
    [[P(0, 0), P(11.4, 0), P(11.4, PAV), P(0, PAV)], 0],
    [[P(0, D - 9.2), P(11.4, D - 9.2), P(11.4, D), P(0, D)], 1],
  ];
  for (const [ring, k] of pavilions) {
    const att = grow(ring, 0.25);
    b.prism(att, y0 + PARAPET, y0 + 21.8, STONE, null, { vBase: y0 + PARAPET });
    b.prism(grow(ring, 0.6), y0 + 21.8, y0 + 22.5, CORNICE, ROOF);
    const cu = 5.7;
    const cv = k === 0 ? 5.2 : D - 4.6;
    const [cx, cz] = P(cu, cv);
    // Square plinth, round drum, cornice ring, dome, finial.
    b.box(cx, cz, y0 + 22.5, y0 + 23.6, 6.6, 6.6, f.heading, STONE, CORNICE);
    const seg = far ? 8 : 16;
    b.lathe(cx, cz, [[2.75, y0 + 23.6], [2.75, y0 + 28.1]], seg, { ...STONE, su: 2, sv: 2 }, 4, 0, false);
    b.lathe(cx, cz, [[2.75, y0 + 28.1], [3.15, y0 + 28.3], [3.15, y0 + 28.7], [2.95, y0 + 28.8]], seg, CORNICE, 4, 0, false);
    b.lathe(cx, cz, [[2.95, y0 + 28.8], [2.85, y0 + 29.6], [2.45, y0 + 30.4], [1.75, y0 + 31.0], [0.9, y0 + 31.4], [0.25, y0 + 31.55]], seg, DOME, 6, 0, false);
    if (!far) {
      b.lathe(cx, cz, [[0.25, y0 + 31.5], [0.25, y0 + 32.2], [0.08, y0 + 33.2]], 6, { layer: -1, colour: 0x4f5d55 }, 1, 0, false);
      // Arched openings round the drum.
      for (let s = 0; s < 6; s++) {
        const a = (s / 6) * Math.PI * 2 + Math.PI / 6;
        const o: V2 = [Math.cos(a), Math.sin(a)];
        const face = new Frame([cx + o[0] * 2.75, cz + o[1] * 2.75], [-o[1], o[0]], o);
        b.decal(face, 0, y0 + 24.2, 1.35, 3.1, DECAL.louvre, DECALS, 0.06);
      }
      // Oculus in each attic face.
      const sides: [V2, V2][] = [
        [P(0, k === 0 ? 0 : D), P(11.4, k === 0 ? 0 : D)],
        [P(0, k === 0 ? PAV : D - 9.2), P(0, k === 0 ? 0 : D)],
      ];
      for (const [a, c] of sides) {
        const mid: V2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
        const out = outward(ring, a, c);
        const face = new Frame([mid[0] + out[0] * 0.25, mid[1] + out[1] * 0.25], [c[0] - a[0], c[1] - a[1]], out);
        b.decal(face, 0, y0 + PARAPET + 0.4, 2.4, 2.4, DECAL.oculus, DECALS, 0.04);
      }
    }
  }

  // Pedimented centrepieces: the main entrance on the Queen St front, and
  // a smaller one on Customs St.
  const westMid = (PAV + D - 9.2) / 2;
  centrepiece(b, f, P, y0, 'west', westMid, 10.6, RECESS, far);
  centrepiece(b, f, P, y0, 'south', W * 0.56, 9, 0, far);

  // The station's glazed roof behind the parapet.
  const gl: V2[] = [P(13, 15), P(W - 3, 15), P(W - 3, D - 15), P(13, D - 15)];
  const ridge: V2[] = [P(13, D / 2), P(W - 3, D / 2), P(W - 3, D / 2), P(13, D / 2)];
  b.frustum(gl, ridge, y0 + PARAPET, y0 + 23.4, GLASS);

  if (!far) {
    // Colliders: the block (the OSM footprint's stays too) and the porch.
    const c = P(W / 2, D / 2);
    b.collideBox(c[0], c[1], y0 - 2, y0 + TOP, W, D, f.heading);
  }
}

/**
 * A slightly projecting frontispiece `width` wide centred `at` metres along
 * the given front: a big arched entrance, columns, an entablature breaking
 * forward and a pediment with a carved cartouche.
 */
function centrepiece(b: Builder, f: Frame, P: (u: number, v: number) => V2, y0: number, front: 'west' | 'south', at: number, width: number, inset: number, far: boolean): void {
  const proj = 0.8;
  // A frame along this front, from its left end seen from outside.
  const face = front === 'south' ? new Frame(P(at, -0.01), f.d, f.n) : new Frame(P(inset, at), [f.n[0], f.n[1]], [-f.d[0], -f.d[1]]);
  const ring: V2[] = [face.at(-width / 2, proj), face.at(width / 2, proj), face.at(width / 2, -0.3), face.at(-width / 2, -0.3)];
  b.prism(ring, y0 - 1.5, y0 + GROUND, { ...BASE, su: width / 2 }, null, { vBase: y0 });
  b.prism(ring, y0 + GROUND, y0 + ENTABLATURE, { ...UPPER, su: width / 2 }, null, { vBase: y0 + GROUND });
  const big: V2[] = [face.at(-width / 2 - 0.4, proj + 0.6), face.at(width / 2 + 0.4, proj + 0.6), face.at(width / 2 + 0.4, -0.3), face.at(-width / 2 - 0.4, -0.3)];
  b.prism(big, y0 + ENTABLATURE, y0 + PARAPET + 0.3, CORNICE, CORNICE);
  // Pediment: a gable whose ridge runs back into the roof.
  const h = front === 'west' ? 4.4 : 3.4;
  const lower: V2[] = [face.at(-width / 2 - 0.3, proj + 0.5), face.at(width / 2 + 0.3, proj + 0.5), face.at(width / 2 + 0.3, -2.5), face.at(-width / 2 - 0.3, -2.5)];
  const upper: V2[] = [face.at(0, proj + 0.5), face.at(0, proj + 0.5), face.at(0, -2.5), face.at(0, -2.5)];
  b.frustum(lower, upper, y0 + PARAPET + 0.3, y0 + PARAPET + 0.3 + h, { ...CORNICE, su: 2, sv: 2 });
  if (far) return;
  const front3 = new Frame(face.at(0, proj + 0.5), face.d, face.n);
  b.decal(front3, 0, y0 + PARAPET + 0.6, 2.0, 2.3, DECAL.cartouche, DECALS, 0.05);
  // The entrance: a tall arch in a granite surround, with steps.
  const door = new Frame(face.at(0, proj), face.d, face.n);
  b.decal(door, 0, y0 + 0.3, 3.6, 5.6, DECAL.archWindow, DECALS, 0.05);
  for (let s = 0; s < 3; s++) {
    const steps: V2[] = [door.at(-2.6 + s * 0.2, 1.4 - s * 0.45), door.at(2.6 - s * 0.2, 1.4 - s * 0.45), door.at(2.6 - s * 0.2, 0), door.at(-2.6 + s * 0.2, 0)];
    b.prism(steps, y0 - 0.5, y0 + 0.17 * (s + 1), { layer: L.cpoBase, colour: 0xffffff, su: 2, sv: 2 }, { layer: L.cpoBase, colour: 0xffffff, su: 2, sv: 2 });
  }
  // Pairs of free-standing columns either side of the entrance, two storeys tall.
  for (const s of [-1, 1]) {
    for (const k of [0, 1]) {
      const [x, z] = face.at(s * (1.75 + k * 0.95), proj + 0.45);
      b.lathe(x, z, [[0.36, y0 + GROUND], [0.3, y0 + ENTABLATURE - 0.5], [0.45, y0 + ENTABLATURE]], 10, { ...STONE, su: 1, sv: 3 }, 1, 0, true);
      b.box(x, z, y0 + GROUND - 0.5, y0 + GROUND, 1.0, 1.0, face.heading, CORNICE);
    }
  }
}

/** A plan polygon pushed out by d metres (corners mitred), any winding. */
function grow(ring: V2[], d: number): V2[] {
  const n = ring.length;
  let area = 0;
  for (let k = 0; k < n; k++) area += ring[k][0] * ring[(k + 1) % n][1] - ring[(k + 1) % n][0] * ring[k][1];
  const s = area > 0 ? 1 : -1;
  const normal = (a: V2, c: V2): V2 => {
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const l = Math.hypot(dx, dz);
    return [(s * dz) / l, (-s * dx) / l];
  };
  return ring.map((p, k) => {
    const prev = ring[(k + n - 1) % n];
    const next = ring[(k + 1) % n];
    const n0 = normal(prev, p);
    const n1 = normal(p, next);
    const mx = n0[0] + n1[0];
    const mz = n0[1] + n1[1];
    const dotp = (mx * n1[0] + mz * n1[1]) || 1;
    return [p[0] + (mx * d) / dotp, p[1] + (mz * d) / dotp] as V2;
  });
}

/** Outward normal of edge a->c of a ring. */
function outward(ring: V2[], a: V2, c: V2): V2 {
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const dx = c[0] - a[0];
  const dz = c[1] - a[1];
  const l = Math.hypot(dx, dz);
  let n: V2 = [dz / l, -dx / l];
  if (n[0] * ((a[0] + c[0]) / 2 - cx) + n[1] * ((a[1] + c[1]) / 2 - cz) < 0) n = [-n[0], -n[1]];
  return n;
}


export const chiefPostOffice: LandmarkModel = {
  id: 'britomart',
  name: 'Chief Post Office (Britomart)',
  near: 400,
  drawDistance: 1100,
  height: 33,
  build,
};
