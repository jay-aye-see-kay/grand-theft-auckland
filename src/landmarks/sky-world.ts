import type { LandmarkInfo } from '../city/format.ts';
import { DECAL, L, SIGN } from './atlas.ts';
import { Frame, type Builder, type Mat, type V2, type V3 } from './builder.ts';
import type { LandmarkModel } from './landmarks.ts';

// The old Metro Centre on Queen St between the Civic and Aotea Square
// (1999; OSM: Sky World, here "High World"): a big blank entertainment box
// ~27 m tall, the taller giant-screen cinema box on the Queen St corner
// with MINIMAX across it, and on the corner with the square a glazed
// rotunda under a glass dome, with the Hard Luck Café (a parody) at its
// foot: round logo, giant guitar, red awning. Heights from the LiDAR (main
// roof ~46 m above sea level, cinema box ~51 m, rotunda ~47 m); the cinema
// box and the rotunda are placed from their OSM parts.

const CLADDING: Mat = { layer: L.concrete, colour: 0xcfc4b2, sv: 8 };
const BAND: Mat = { layer: -1, colour: 0x5b2a7a };
const DARK: Mat = { layer: L.concrete, colour: 0x2c3f63, sv: 8 };
const GLASS: Mat = { layer: L.glass, colour: 0xffffff, su: 3, sv: 3 };
const FOYER: Mat = { layer: L.civicGround, colour: 0xffffff, su: 6, sv: 4.4 };
const ROOF: Mat = { layer: -1, colour: 0x8a8781 };
const TRIM: Mat = { layer: -1, colour: 0xe8e2d6 };
const DOME: Mat = { layer: L.podGlass, colour: 0xffffff };
const STEEL: Mat = { layer: -1, colour: 0x4a4f55 };
const VERANDAH: Mat = { layer: -1, colour: 0x2f3438 };
const SOFFIT: Mat = { layer: -1, colour: 0xd8d2c4, glow: 0.15 };
const AWNING: Mat = { layer: -1, colour: 0xa8231c };
const NEON = (glow: number): Mat => ({ layer: L.signs, colour: 0xffffff, glow });
const ROUNDEL: Mat = { layer: L.roundel, colour: 0xffffff, glow: 0.5 };
const GUITAR: Mat = { layer: L.decal, colour: 0xffffff, glow: 0.35 };

const ROOF_Y = 46;
const SHOP_TOP = 22.6;

/** The giant-screen box (OSM part), to 51 m above sea level. */
const CINEMA: V2[] = [[-400.7, 790.8], [-392.9, 770.7], [-390.8, 769.8], [-371.2, 775.7], [-370.9, 779.2], [-378.7, 801.1], [-381.5, 804.1], [-384.2, 803.4], [-395.4, 799.3], [-398.8, 795]];
const CINEMA_TOP = 51;
/** The rotunda on the corner with the square (OSM part: a 10.4 m circle). */
const ROTUNDA = { x: -390, z: 823.8, r: 10.4, top: 45.4 };
/** Which way the corner faces: out over the junction of Queen St and the square, and the footpath there (LiDAR). */
const CORNER: V2 = [0.55, 0.835];
const CORNER_GROUND = 19.2;
/** The Queen St footpath along the front, rising towards the square: [z, height above sea level] (LiDAR). */
const QUEEN_ST: V2[] = [[770, 16.2], [806, 17.0], [816, 17.6], [826, 19.0], [836, 19.6]];

function queenGround(z: number): number {
  for (let k = 0; k + 1 < QUEEN_ST.length; k++) {
    const [z0, y0] = QUEEN_ST[k];
    const [z1, y1] = QUEEN_ST[k + 1];
    if (z <= z1 || k + 2 === QUEEN_ST.length) return y0 + ((Math.min(Math.max(z, z0), z1) - z0) / (z1 - z0)) * (y1 - y0);
  }
  return QUEEN_ST[0][1];
}

function build(b: Builder, far: boolean, records: LandmarkInfo[]): void {
  const r = records[0];
  const y0 = r.base;
  b.ground = y0;
  const fp = r.footprint;

  // Which footprint edges face a street: Queen St (east) or the square (south).
  const facing = (a: V2, c: V2): 'queen' | 'square' | null => {
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 3) return null;
    // Outward normal for this ring's winding.
    const n: V2 = ccw(fp) ? [dz / len, -dx / len] : [-dz / len, dx / len];
    if (n[0] > 0.8) return 'queen';
    if (n[1] > 0.8) return 'square';
    return null;
  };

  if (far) {
    b.prism(fp, y0 - 3, ROOF_Y, { ...CLADDING, layer: -1 }, ROOF);
    b.prism(CINEMA, ROOF_Y, CINEMA_TOP, { ...DARK, layer: -1 }, ROOF);
    b.lathe(ROTUNDA.x, ROTUNDA.z, [[ROTUNDA.r, y0], [ROTUNDA.r, ROTUNDA.top], [ROTUNDA.r * 0.7, ROTUNDA.top + 3.2], [0.1, ROTUNDA.top + 4.6]], 10, [GLASS, { ...DOME, layer: -1, colour: 0x6f8798 }], 1, 0, false);
  } else {
    const fit = (m: Mat, len: number, bay: number): Mat => ({ ...m, su: len / Math.max(1, Math.round(len / bay)) });
    // Shopfronts and the cinema foyer along the streets, plain cladding elsewhere.
    b.prism(fp, y0 - 3, SHOP_TOP, (_k, a, c) => {
      const f = facing(a, c);
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      return f === 'square' ? fit(FOYER, len, 6) : f === 'queen' ? fit(GLASS, len, 3) : CLADDING;
    }, null, { vBase: SHOP_TOP - 4.4 });
    b.prism(fp, SHOP_TOP, ROOF_Y, CLADDING, ROOF, { vBase: SHOP_TOP });
    // A purple band at the top and a coping.
    b.prism(fp, ROOF_Y - 2.2, ROOF_Y - 1.2, BAND, null);
    b.prism(fp, ROOF_Y, ROOF_Y + 0.6, TRIM, TRIM);
    // The cinema box: dark blue, standing above the roof.
    b.prism(CINEMA, ROOF_Y - 0.5, CINEMA_TOP, DARK, ROOF, { vBase: ROOF_Y });
    b.prism(CINEMA, CINEMA_TOP, CINEMA_TOP + 0.5, TRIM, TRIM);
    // Verandah over the Queen St footpath, lit underneath, stepping up the hill bay by bay.
    for (let k = 0; k < fp.length; k++) {
      const a = fp[k];
      const c = fp[(k + 1) % fp.length];
      if (facing(a, c) !== 'queen') continue;
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const out = outward(fp, a, c);
      const f = new Frame(a, [c[0] - a[0], c[1] - a[1]], out);
      const bays = Math.max(1, Math.round(len / 6));
      for (let j = 0; j < bays; j++) {
        const u0 = (j * len) / bays;
        const u1 = ((j + 1) * len) / bays;
        const yv = Math.max(queenGround(f.at(u0)[1]), queenGround(f.at(u1)[1])) + 3.8;
        const slab: V2[] = [f.at(u0, 3.0), f.at(u1, 3.0), f.at(u1, 0), f.at(u0, 0)];
        b.prism(slab, yv, yv + 0.4, VERANDAH, VERANDAH, { bottom: SOFFIT });
      }
    }
    // The rotunda: a glass drum with a band at each floor, under a ribbed glass dome.
    b.lathe(ROTUNDA.x, ROTUNDA.z, [[ROTUNDA.r, y0 - 1], [ROTUNDA.r, ROTUNDA.top]], 20, { ...GLASS, su: undefined, sv: 3 }, 20, 0, false);
    for (let y = SHOP_TOP; y < ROTUNDA.top; y += 4.5) {
      b.lathe(ROTUNDA.x, ROTUNDA.z, [[ROTUNDA.r + 0.25, y], [ROTUNDA.r + 0.25, y + 0.5]], 20, TRIM, 1, 0, false);
    }
    b.lathe(ROTUNDA.x, ROTUNDA.z, [[ROTUNDA.r + 0.5, ROTUNDA.top], [ROTUNDA.r + 0.5, ROTUNDA.top + 0.7], [ROTUNDA.r, ROTUNDA.top + 0.8]], 20, TRIM, 1, 0, false);
    const dome: V2[] = [[ROTUNDA.r, ROTUNDA.top + 0.8], [ROTUNDA.r * 0.92, ROTUNDA.top + 2.4], [ROTUNDA.r * 0.72, ROTUNDA.top + 3.8], [ROTUNDA.r * 0.42, ROTUNDA.top + 4.9], [0.1, ROTUNDA.top + 5.4]];
    b.lathe(ROTUNDA.x, ROTUNDA.z, dome, 20, DOME, 20, 0, false);
    // Steel ribs over the dome.
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      for (let j = 0; j + 1 < dome.length; j++) {
        const p = (q: V2): V3 => [ROTUNDA.x + Math.cos(a) * (q[0] + 0.08), q[1] + 0.08, ROTUNDA.z + Math.sin(a) * (q[0] + 0.08)];
        b.bar(p(dome[j]), p(dome[j + 1]), 0.18, STEEL);
      }
    }
  }

  // Signs. MINIMAX across the top of the cinema box, facing Queen St and
  // facing up Queen St (north); HIGH WORLD on the side over the square.
  const cinemaFace = (out: V2) => {
    let best = 0;
    let score = -Infinity;
    for (let k = 0; k < CINEMA.length; k++) {
      const a = CINEMA[k];
      const c = CINEMA[(k + 1) % CINEMA.length];
      const n = outward(CINEMA, a, c);
      const s = (n[0] * out[0] + n[1] * out[1]) * Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (s > score) {
        score = s;
        best = k;
      }
    }
    const a = CINEMA[best];
    const c = CINEMA[(best + 1) % CINEMA.length];
    return { a, c, n: outward(CINEMA, a, c), len: Math.hypot(c[0] - a[0], c[1] - a[1]) };
  };
  const sign = (a: V2, c: V2, n: V2, len: number, y: number, h: number, uv: readonly [number, number, number, number], glow: number) => {
    const w = Math.min(len - 2, h * 4);
    b.decal(reading([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2], n), 0, y, w, h, uv, NEON(glow), 0.12);
  };
  for (const out of [[1, 0], [0, -1]] as V2[]) {
    const { a, c, n, len } = cinemaFace(out);
    sign(a, c, n, len, CINEMA_TOP - 4.6, 4, SIGN.minimax, 1.1);
  }
  {
    let best = 0;
    let longest = 0;
    for (let k = 0; k < fp.length; k++) {
      const a = fp[k];
      const c = fp[(k + 1) % fp.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (facing(a, c) === 'square' && len > longest) {
        longest = len;
        best = k;
      }
    }
    const a = fp[best];
    const c = fp[(best + 1) % fp.length];
    sign(a, c, outward(fp, a, c), longest, ROOF_Y - 8, 5.5, SIGN.highWorld, 0.9);
  }

  // The Hard Luck Café at the foot of the rotunda, facing the corner.
  const [ox, oz] = CORNER;
  const side: V2 = [-oz, ox];
  const at = (rr: number, u: number): V2 => [ROTUNDA.x + ox * rr + side[0] * u, ROTUNDA.z + oz * rr + side[1] * u];
  const face = reading(at(ROTUNDA.r + 0.35, 0), CORNER);
  const g = CORNER_GROUND;
  b.decal(face, 0, g + 5.2, 7, 7, [0, 0, 1, 1], ROUNDEL, 0.1);
  b.decal(face, -5.4, g + 4.4, 3.8, 9.6, DECAL.guitar, GUITAR, 0.15);
  b.decal(face, 5.4, g + 4.4, 3.8, 9.6, DECAL.guitar, GUITAR, 0.15);
  if (!far) {
    // A red awning round the drum over the café's doors.
    const ring: V2[] = [];
    for (let k = -4; k <= 4; k++) {
      const a = Math.atan2(oz, ox) + (k / 4) * 0.9;
      ring.push([ROTUNDA.x + Math.cos(a) * (ROTUNDA.r + 2.6), ROTUNDA.z + Math.sin(a) * (ROTUNDA.r + 2.6)]);
    }
    for (let k = 0; k + 1 < ring.length; k++) {
      const p0 = ring[k];
      const p1 = ring[k + 1];
      const back = (p: V2): V2 => [ROTUNDA.x + (p[0] - ROTUNDA.x) * (ROTUNDA.r / (ROTUNDA.r + 2.6)), ROTUNDA.z + (p[1] - ROTUNDA.z) * (ROTUNDA.r / (ROTUNDA.r + 2.6))];
      const yb = g + 3.4;
      b.poly([[p0[0], yb, p0[1]], [p1[0], yb, p1[1]], [back(p1)[0], yb + 1.2, back(p1)[1]], [back(p0)[0], yb + 1.2, back(p0)[1]]], [[0, 0], [1, 0], [1, 1], [0, 1]], AWNING, [0, 1, 0]);
      b.wall(p0, p1, yb - 0.6, yb, AWNING, { out: [(p0[0] + p1[0]) / 2 - ROTUNDA.x, (p0[1] + p1[1]) / 2 - ROTUNDA.z] });
    }
    // Colliders: the cinema box above the roof and the rotunda (the outline's collider covers the rest).
    const cx = CINEMA.reduce((s, p) => s + p[0], 0) / CINEMA.length;
    const cz = CINEMA.reduce((s, p) => s + p[1], 0) / CINEMA.length;
    b.collideBox(cx, cz, ROOF_Y, CINEMA_TOP, 22, 22, Math.atan2(-(775.7 - 770.7), -371.2 + 392.9));
    b.collideCylinder(ROTUNDA.x, ROTUNDA.z, y0 - 1, ROTUNDA.top + 3, ROTUNDA.r);
  }
}

/** A frame on a wall facing `out`, running to the right as you face it, so lettering reads the right way round. */
function reading(o: V2, out: V2): Frame {
  return new Frame(o, [out[1], -out[0]], out);
}

function ccw(ring: V2[]): boolean {
  let a = 0;
  for (let k = 0; k < ring.length; k++) {
    const [x0, z0] = ring[k];
    const [x1, z1] = ring[(k + 1) % ring.length];
    a += x0 * z1 - x1 * z0;
  }
  return a > 0;
}

/** Outward unit normal of edge a -> c of a ring. */
function outward(ring: V2[], a: V2, c: V2): V2 {
  const dx = c[0] - a[0];
  const dz = c[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  return ccw(ring) ? [dz / len, -dx / len] : [-dz / len, dx / len];
}

export const skyWorld: LandmarkModel = {
  id: 'sky-world',
  name: 'High World',
  near: 350,
  drawDistance: 800,
  height: 34,
  build,
};
