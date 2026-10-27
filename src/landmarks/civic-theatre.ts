import type { LandmarkInfo } from '../city/format.ts';
import { DECAL, L } from './atlas.ts';
import { Frame, type Builder, type Mat, type V2, type V3 } from './builder.ts';
import type { LandmarkModel } from './landmarks.ts';

// The Civic (1929, Bohringer, Taylor & Johnson), corner of Queen St and
// Wellesley St: an "atmospheric" picture palace in cream render with
// Moorish and Indian ornament, a verandah over both footpaths, the corner
// tower with its lantern and dome (~38 m, LiDAR), and on the roof the steel
// lattice frame carrying the big red neon letters of its own name. Laid out
// on the OSM footprint; q runs south down the Queen St front from the
// street corner, w west along the Wellesley St front.

const CREAM = 0xeadfc6;
const FACADE: Mat = { layer: L.civic, colour: CREAM, su: 5, sv: 8 };
const GROUND_FLOOR: Mat = { layer: L.civicGround, colour: 0xffffff, su: 6, sv: 4.4 };
const RENDER: Mat = { layer: L.stone, colour: 0xd9cfb8, su: 6, sv: 6 };
const TRIM: Mat = { layer: L.stone, colour: 0xf3ead6, su: 4, sv: 1 };
const RED_TRIM: Mat = { layer: -1, colour: 0x9a3b2c };
const ROOF: Mat = { layer: -1, colour: 0x77736d };
const VERANDAH: Mat = { layer: -1, colour: 0x2f3438 };
const SOFFIT: Mat = { layer: -1, colour: 0xd8d2c4, glow: 0.15 };
const DOME: Mat = { layer: L.slate, colour: 0xc7b48a, su: 1.6, sv: 1.2 };
const LATTICE: Mat = { layer: L.lattice, colour: 0xffffff, su: 2, sv: 2 };
const STEEL: Mat = { layer: -1, colour: 0x45494d };
const NEON: Mat = { layer: L.decal, colour: 0xffffff, glow: 1.3 };
const DECALS: Mat = { layer: L.decal, colour: 0xffffff };

/** Footpath height along each front above the base (the street corner), from the LiDAR: [distance, rise]. */
const QUEEN_RISE: V2[] = [[0, 0], [31, 1.0], [48.5, 1.9]];
const WELLESLEY_RISE: V2[] = [[0, 0], [27.7, 1.5], [46.3, 2.6]];

const ROOF_Y = 22.6;
const PARAPET_Y = 24;
const SHOP_TOP = 4.6;

function rise(profile: V2[], d: number): number {
  for (let k = 0; k + 1 < profile.length; k++) {
    const [d0, r0] = profile[k];
    const [d1, r1] = profile[k + 1];
    if (d <= d1 || k + 2 === profile.length) return r0 + ((Math.min(Math.max(d, d0), d1) - d0) / (d1 - d0)) * (r1 - r0);
  }
  return 0;
}

function build(b: Builder, far: boolean, records: LandmarkInfo[]): void {
  const r = records[0];
  const y0 = r.base;
  b.ground = y0;
  const fp = r.footprint;
  // The two street fronts: the longest edges facing east (Queen St) and north (Wellesley St).
  const edge = (out: V2) => {
    let best = 0;
    let score = -Infinity;
    for (let k = 0; k < fp.length; k++) {
      const a = fp[k];
      const c = fp[(k + 1) % fp.length];
      const dx = c[0] - a[0];
      const dz = c[1] - a[1];
      const len = Math.hypot(dx, dz);
      const s = Math.abs((dz * out[0] - dx * out[1]) / len) * len;
      if (s > score) {
        score = s;
        best = k;
      }
    }
    const a = fp[best];
    const c = fp[(best + 1) % fp.length];
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
    return { a, d: [(c[0] - a[0]) / l, (c[1] - a[1]) / l] as V2 };
  };
  const q = edge([1, 0]);
  const w = edge([0, -1]);
  // Down Queen St (southwards) and along Wellesley St (westwards).
  const dQ: V2 = q.d[1] > 0 ? q.d : [-q.d[0], -q.d[1]];
  const dW: V2 = w.d[0] < 0 ? w.d : [-w.d[0], -w.d[1]];
  // The street corner: where the two frontage lines meet.
  const det = dQ[0] * -dW[1] + dW[0] * dQ[1];
  const rx = w.a[0] - q.a[0];
  const rz = w.a[1] - q.a[1];
  const s = (rx * -dW[1] + dW[0] * rz) / det;
  const C: V2 = [q.a[0] + dQ[0] * s, q.a[1] + dQ[1] * s];
  const at = (qq: number, ww: number): V2 => [C[0] + dQ[0] * qq + dW[0] * ww, C[1] + dQ[1] * qq + dW[1] * ww];
  const local = (p: V2): V2 => {
    const x = p[0] - C[0];
    const z = p[1] - C[1];
    return [x * dQ[0] + z * dQ[1], x * dW[0] + z * dW[1]];
  };
  // Facing out of each front.
  const outQ: V2 = [-dW[0], -dW[1]];
  const outW: V2 = [-dQ[0], -dQ[1]];

  // Main mass on the footprint: street fronts get the facade, the rest plain render.
  const front = (a: V2, c: V2): 'queen' | 'wellesley' | null => {
    const la = local(a);
    const lc = local(c);
    if (Math.abs(la[1]) < 2.5 && Math.abs(lc[1]) < 2.5) return 'queen';
    if (Math.abs(la[0]) < 2.5 && Math.abs(lc[0]) < 2.5) return 'wellesley';
    return null;
  };
  const fit = (m: Mat, len: number, bay: number): Mat => ({ ...m, su: len / Math.max(1, Math.round(len / bay)) });
  b.prism(fp, y0 - 3, y0 + SHOP_TOP, (_k, a, c) => (front(a, c) ? fit(GROUND_FLOOR, Math.hypot(c[0] - a[0], c[1] - a[1]), 6) : RENDER), null, { vBase: y0 });
  b.prism(fp, y0 + SHOP_TOP, y0 + ROOF_Y, (_k, a, c) => (front(a, c) ? fit(FACADE, Math.hypot(c[0] - a[0], c[1] - a[1]), 5) : RENDER), ROOF, { vBase: y0 + SHOP_TOP - 1.4 });

  // Parapet and cornice along the two fronts, with a red-tiled coping line.
  const fronts: { o: V2; d: V2; out: V2; len: number; profile: V2[] }[] = [
    { o: at(4.7, 0), d: dQ, out: outQ, len: 0, profile: QUEEN_RISE },
    { o: at(0, 5.2), d: dW, out: outW, len: 0, profile: WELLESLEY_RISE },
  ];
  for (const fr of fronts) {
    // How far the front runs: to the furthest footprint corner on its line.
    let len = 0;
    for (const p of fp) {
      const l = local(p);
      const along = fr.d === dQ ? l[0] : l[1];
      const off = fr.d === dQ ? l[1] : l[0];
      if (Math.abs(off) < 2.5) len = Math.max(len, along);
    }
    fr.len = len;
    const start = fr.d === dQ ? 4.7 : 5.2;
    const f = new Frame(fr.o, fr.d, fr.out);
    const run = len - start;
    const ring: V2[] = [f.at(0, 0.35), f.at(run, 0.35), f.at(run, -0.5), f.at(0, -0.5)];
    b.prism(ring, y0 + ROOF_Y - 0.6, y0 + ROOF_Y, TRIM, TRIM);
    const par: V2[] = [f.at(0, 0.1), f.at(run, 0.1), f.at(run, -0.4), f.at(0, -0.4)];
    b.prism(par, y0 + ROOF_Y, y0 + PARAPET_Y, { ...RENDER, su: 4, sv: 1.4 }, RED_TRIM);
    if (!far) {
      // Stepped merlons along the parapet, every 5 m.
      for (let u = 2.5; u < run - 1; u += 5) {
        const m: V2[] = [f.at(u - 0.8, 0.12), f.at(u + 0.8, 0.12), f.at(u + 0.8, -0.38), f.at(u - 0.8, -0.38)];
        b.prism(m, y0 + PARAPET_Y, y0 + PARAPET_Y + 1.1, { ...TRIM, su: 1.6, sv: 1.1 }, RED_TRIM);
      }
      // The verandah: a flat steel canopy over the footpath, stepping up the
      // hill bay by bay, lit underneath.
      const bays = Math.max(1, Math.round(run / 7));
      const bl = run / bays;
      for (let k = 0; k < bays; k++) {
        const u0 = k * bl;
        const u1 = u0 + bl;
        const g = rise(fr.profile, start + (u0 + u1) / 2);
        const yv = y0 + g + 3.7;
        const slab: V2[] = [f.at(u0, 3.2), f.at(u1, 3.2), f.at(u1, 0), f.at(u0, 0)];
        b.prism(slab, yv, yv + 0.45, VERANDAH, VERANDAH, { bottom: SOFFIT });
      }
    }
  }

  // The corner tower, over the chamfered corner.
  const T: V2[] = [at(4.4, -0.3), at(8.8, -0.3), at(8.8, 8.8), at(-0.3, 8.8), at(-0.3, 4.9)];
  b.prism(T, y0 - 2, y0 + SHOP_TOP, (_k, a, c) => fit(GROUND_FLOOR, Math.hypot(c[0] - a[0], c[1] - a[1]), 6), null, { vBase: y0 });
  b.prism(T, y0 + SHOP_TOP, y0 + 29.5, (_k, a, c) => fit(FACADE, Math.hypot(c[0] - a[0], c[1] - a[1]), 4.5), null, { vBase: y0 + SHOP_TOP - 1.4 });
  const tc = at(4.6, 4.6);
  const Tg = grow(T, 0.4);
  b.prism(Tg, y0 + 29.5, y0 + 30.4, TRIM, ROOF);
  // Stepped crown, then an octagonal lantern with arched openings and a dome.
  const crown: V2[] = [at(1.8, 1.8), at(7.4, 1.8), at(7.4, 7.4), at(1.8, 7.4)];
  b.prism(crown, y0 + 30.4, y0 + 32.4, { ...FACADE, su: 5.6, sv: 8 }, null, { vBase: y0 + 27 });
  b.prism(grow(crown, 0.3), y0 + 32.4, y0 + 32.9, TRIM, ROOF);
  const seg = far ? 8 : 8;
  b.lathe(tc[0], tc[1], [[2.2, y0 + 32.9], [2.2, y0 + 35.6]], seg, { ...RENDER, su: 1.7, sv: 2.7 }, 8, Math.PI / 8, false);
  b.lathe(tc[0], tc[1], [[2.5, y0 + 35.6], [2.5, y0 + 36.0], [2.3, y0 + 36.1]], seg, TRIM, 8, Math.PI / 8, false);
  b.lathe(tc[0], tc[1], [[2.3, y0 + 36.1], [2.5, y0 + 36.8], [2.2, y0 + 37.6], [1.4, y0 + 38.4], [0.5, y0 + 39.0], [0.15, y0 + 39.8]], far ? 8 : 12, DOME, 4, 0, false);
  if (!far) {
    b.lathe(tc[0], tc[1], [[0.12, y0 + 39.7], [0.12, y0 + 41.2], [0.0, y0 + 41.4]], 6, { layer: -1, colour: 0xb8964f }, 1, 0, false);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const o: V2 = [Math.cos(a), Math.sin(a)];
      const face = new Frame([tc[0] + o[0] * 2.05, tc[1] + o[1] * 2.05], [-o[1], o[0]], o);
      b.decal(face, 0, y0 + 33.1, 1.2, 2.4, DECAL.archWindow, DECALS, 0.04);
    }
    // Small corner pinnacles on the crown.
    for (const [qq, ww] of [[1.8, 1.8], [7.4, 1.8], [7.4, 7.4], [1.8, 7.4]]) {
      const [x, z] = at(qq, ww);
      b.lathe(x, z, [[0.45, y0 + 32.9], [0.45, y0 + 33.9], [0.0, y0 + 35.2]], 6, DOME, 1, 0, false);
    }
  }

  // The rooftop sign: a steel lattice frame on the Wellesley St side of the
  // roof, behind the parapet west of the tower, facing north up Queen St,
  // with "CIVIC" in red neon on both faces.
  const signW = 19;
  const sf = new Frame(at(7.5, 11), dW, outW);
  const sb = y0 + ROOF_Y;
  const s0 = y0 + PARAPET_Y + 2.4;
  const s1 = s0 + 6.4;
  const corners = (u: number, y: number, w0 = 0): V3 => sf.p(u, y, w0);
  if (!far) {
    // Lattice panels, double-sided.
    b.poly2([corners(0, s0), corners(signW, s0), corners(signW, s1), corners(0, s1)], [[0, 0], [signW / 2, 0], [signW / 2, (s1 - s0) / 2], [0, (s1 - s0) / 2]], LATTICE);
    // Frame members and legs down to the roof, with raking struts behind.
    b.bar(corners(0, s0), corners(signW, s0), 0.3, STEEL);
    b.bar(corners(0, s1), corners(signW, s1), 0.3, STEEL);
    for (let u = 0; u <= signW + 0.01; u += signW / 4) {
      b.bar(corners(u, sb), corners(u, s1), 0.3, STEEL);
      b.bar(corners(u, sb), corners(u, s0 + 2, 0), 0.2, STEEL);
      b.bar(corners(u, sb, -3), corners(u, s0 + 3), 0.18, STEEL);
    }
  } else {
    b.poly2([corners(0, s0), corners(signW, s0), corners(signW, s1), corners(0, s1)], [[0, 0], [1, 0], [1, 1], [0, 1]], STEEL);
  }
  // The letters, readable from both sides.
  const word = ['C', 'I', 'V', 'I', 'C'] as const;
  const lw = 3.4;
  const lh = 5.4;
  const gap = (signW - word.length * lw) / 2;
  for (const [side, fw] of [[1, 0.35], [-1, -0.35]] as const) {
    for (let k = 0; k < word.length; k++) {
      const cell = DECAL[word[k]];
      // Seen from the back, the word runs the other way along the frame.
      const kk = side === 1 ? k : word.length - 1 - k;
      const uc = gap + (kk + 0.5) * lw;
      const [u0, v0, u1, v1] = cell;
      const pts: V3[] = [corners(uc - (side * lw) / 2, s0 + 0.5, fw), corners(uc + (side * lw) / 2, s0 + 0.5, fw), corners(uc + (side * lw) / 2, s0 + 0.5 + lh, fw), corners(uc - (side * lw) / 2, s0 + 0.5 + lh, fw)];
      b.poly(pts, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], NEON, [sf.n[0] * side, 0, sf.n[1] * side]);
    }
  }

  if (!far) {
    // Colliders: the tower (the OSM footprint's collider covers the rest).
    b.collideBox(tc[0], tc[1], y0 - 2, y0 + 32, 9, 9, Math.atan2(-dQ[1], dQ[0]));
  }
}

/** A convex-ish plan ring pushed out by d metres. */
function grow(ring: V2[], d: number): V2[] {
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return ring.map(([x, z]) => {
    const l = Math.hypot(x - cx, z - cz) || 1;
    return [x + ((x - cx) / l) * d * 1.3, z + ((z - cz) / l) * d * 1.3] as V2;
  });
}

export const civicTheatre: LandmarkModel = {
  id: 'civic-theatre',
  name: 'The Civic',
  near: 400,
  drawDistance: 1100,
  height: 41,
  build,
};
