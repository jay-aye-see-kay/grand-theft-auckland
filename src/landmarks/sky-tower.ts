import type { LandmarkInfo } from '../city/format.ts';
import { L } from './atlas.ts';
import type { Builder, Mat, V2, V3 } from './builder.ts';
import type { LandmarkModel } from './landmarks.ts';

// The Sky Tower (1997, 328 m): a 12 m slip-formed concrete shaft on eight
// splayed legs, the glazed pod at 178-200 m (SkyBar, the main observation
// level, the revolving restaurant with its out-leaning glass, the SkyWalk
// ring outside at 192 m), a tapering neck up to the Sky Deck's glass band
// at 220 m, and the steel mast to 328 m with red aircraft lights on top.
// Proportions from the OSM building parts and the LiDAR (pod 16-17 m in
// radius at its widest). The far LOD is the same profile with fewer sides
// and none of the small parts, so the silhouette doesn't change at the switch.

export const SKY_TOWER_HEIGHT = 328;

const CONCRETE: Mat = { layer: L.concrete, colour: 0xd9d8d2, sv: 8 };
const CONCRETE_DARK: Mat = { layer: L.concrete, colour: 0xa9aaa6, sv: 8 };
const WHITE: Mat = { layer: -1, colour: 0xe9eaea };
const PALE: Mat = { layer: -1, colour: 0xc8ccce };
const STEEL: Mat = { layer: -1, colour: 0x8c9296 };
const DARK: Mat = { layer: -1, colour: 0x3c4246 };
const GLASS: Mat = { layer: L.podGlass, colour: 0xffffff };
const RED: Mat = { layer: -1, colour: 0xd62a1e };
const LIGHT: Mat = { layer: -1, colour: 0xff3020, glow: 1.6 };
const BLINK: Mat = { layer: -1, colour: 0xff2a18, glow: 6 };

/** The pod and mast profile, [radius, height above the base] from the bottom up, with each band's surface. */
function profile(): { pts: V2[]; mats: Mat[]; glassPanes: number[] } {
  const rows: [number, number, Mat, number?][] = [
    // [radius, height, surface of the band from here up, panes round if glazed]
    [6.25, 0, CONCRETE],
    [6.0, 150, STEEL],
    [9.4, 153, STEEL],
    [9.6, 158, STEEL],
    [10.5, 160, STEEL],
    [10.55, 165, DARK],
    [10.6, 172, STEEL],
    [10.6, 177, PALE],
    [11.7, 179.5, GLASS, 30],
    [11.8, 183.2, WHITE],
    [13.6, 183.8, GLASS, 36],
    [14.3, 187.4, WHITE],
    [15.1, 188.0, GLASS, 40],
    [17.0, 191.2, GLASS, 40],
    [16.2, 194.2, WHITE],
    [16.4, 194.8, GLASS, 40],
    [15.6, 198.0, WHITE],
    [15.6, 199.2, PALE],
    [13.2, 201.0, PALE],
    [7.4, 215.5, WHITE],
    [7.4, 218.6, WHITE],
    [8.2, 219.6, GLASS, 24],
    [8.7, 223.8, WHITE],
    [8.7, 225.4, PALE],
    [5.5, 228.0, WHITE],
    [5.3, 236.0, STEEL],
    [5.7, 237.0, PALE],
    [3.0, 240.5, WHITE],
    [2.1, 241.0, WHITE],
    [1.9, 289.5, STEEL],
    [1.35, 290.5, WHITE],
    [1.3, 308.0, RED],
    [1.2, 312.0, WHITE],
    [1.1, 316.0, RED],
    [0.7, 320.0, WHITE],
    [0.6, 326.5, RED],
    [0.25, 328.0, RED],
  ];
  return { pts: rows.map((r) => [r[0], r[1]]), mats: rows.map((r) => r[2]), glassPanes: rows.map((r) => r[3] ?? 0) };
}

function build(b: Builder, far: boolean, records: LandmarkInfo[]): void {
  const t = records[0];
  const cx = t.x;
  const cz = t.z;
  const y0 = t.base;
  const seg = far ? 14 : 36;
  b.ground = y0;

  // Shaft, pod and mast: one lathe per band so each band has its own UVs.
  const { pts, mats, glassPanes } = profile();
  for (let k = 0; k + 1 < pts.length; k++) {
    const [r0, h0] = pts[k];
    const [r1, h1] = pts[k + 1];
    const m = mats[k];
    const panes = glassPanes[k];
    const thin = r0 < 2.5 && r1 < 2.5;
    const n = thin ? Math.max(8, Math.round(seg / 3)) : seg;
    const around = panes || Math.max(1, Math.round((2 * Math.PI * Math.max(r0, r1)) / 8));
    b.lathe(cx, cz, [[r0, y0 + h0], [r1, y0 + h1]], n, m, m.layer < 0 ? 1 : around, 0, false);
  }
  // The very top is capped by the last band (radius 0.25).

  // SkyWalk: the open ring round the outside of the restaurant level.
  const walk: V2[] = [[17.1, 191.3], [19.6, 191.3], [19.6, 191.75], [17.1, 191.75]];
  b.lathe(cx, cz, walk.map(([r, h]) => [r, y0 + h]), seg, [PALE, PALE, WHITE], 1, 0, false);
  if (!far) {
    // Its railing: a thin band of glass and posts.
    b.lathe(cx, cz, [[19.5, y0 + 191.75], [19.5, y0 + 192.9]], seg, { layer: L.glass, colour: 0xffffff }, 40, 0, false);
  }

  // Eight legs, splayed out to the ground, joining the shaft at ~60 m.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    leg(b, cx, cz, y0, a, far);
  }

  if (!far) {
    // The three lifts' glass fronts up the shaft.
    for (let k = 0; k < 3; k++) {
      const a = Math.PI / 6 + (k / 3) * Math.PI * 2;
      const ox = Math.cos(a);
      const oz = Math.sin(a);
      const px = -oz;
      const pz = ox;
      const w = 0.8;
      const r = 6.1;
      const corner = (s: number, h: number, rr = r): V3 => [cx + ox * rr + px * s * w, y0 + h, cz + oz * rr + pz * s * w];
      b.poly([corner(-1, 62), corner(1, 62), corner(1, 176), corner(-1, 176)], [[0, 0], [1, 0], [1, 38], [0, 38]], { layer: L.glass, colour: 0x9fb4c4, shade: 0.8 }, [ox, 0, oz]);
    }
    // Lobby at the foot, inside the casino podium.
    b.lathe(cx, cz, [[9.5, y0 - 1], [9.5, y0 + 9], [9.5, y0 + 9.6]], 24, [{ layer: L.glass, colour: 0xffffff, sv: 3 }, WHITE], 10, 0, false);
    b.lathe(cx, cz, [[9.5, y0 + 9.6], [6.2, y0 + 10.2]], 24, WHITE, 1, 0, false);
    // Ribs up the plant levels under the pod.
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      b.box(cx + Math.cos(a) * 10.7, cz + Math.sin(a) * 10.7, y0 + 158.5, y0 + 177.5, 0.6, 0.35, -a, PALE);
    }
    // Antenna panels and dishes round the foot of the mast.
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3;
      const x = cx + Math.cos(a) * 2.6;
      const z = cz + Math.sin(a) * 2.6;
      b.box(x, z, y0 + 246 + (k % 2) * 9, y0 + 252 + (k % 2) * 9, 0.5, 1.2, -a, PALE);
    }
    b.lathe(cx, cz, [[1.95, y0 + 268], [3.4, y0 + 268.5], [3.4, y0 + 269.2], [1.95, y0 + 269.6]], 16, [STEEL, PALE, STEEL], 1, 0, false);
  }

  // Aircraft lights: a ring of steady red ones on the pod roof and the Sky
  // Deck, a blinking one on the tip.
  const lights = (r: number, h: number, n: number, m: Mat, s: number) => {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + 0.2;
      b.box(cx + Math.cos(a) * r, cz + Math.sin(a) * r, y0 + h, y0 + h + s, s, s, -a, m);
    }
  };
  if (!far) {
    lights(15.4, 199.2, 8, LIGHT, 0.5);
    lights(8.6, 225.4, 6, LIGHT, 0.45);
    lights(1.4, 290.5, 4, LIGHT, 0.4);
  }
  b.box(cx, cz, y0 + 327.6, y0 + 329.0, far ? 2.2 : 0.9, far ? 2.2 : 0.9, 0, BLINK);

  // Colliders: shaft (and the pod, for anyone who gets up there), legs, lobby.
  if (!far) {
    b.collideCylinder(cx, cz, y0 - 2, y0 + 240, 6.3);
    b.collideCylinder(cx, cz, y0 + 177, y0 + 199, 16.5);
    b.collideCylinder(cx, cz, y0 - 2, y0 + 9.6, 9.6);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const r = 11.5;
      b.collideBox(cx + Math.cos(a) * r, cz + Math.sin(a) * r, y0 - 2, y0 + 12, 4.5, 2.6, -a);
    }
  }
}

/**
 * One leg: a tapering concrete strut from the ground at radius ~14 m to the
 * shaft at 62 m, as eight corners (four at the foot, four at the head).
 */
function leg(b: Builder, cx: number, cz: number, y0: number, a: number, far: boolean): void {
  const ox = Math.cos(a);
  const oz = Math.sin(a);
  // Across the leg (tangential).
  const px = -oz;
  const pz = ox;
  const P = (r: number, s: number, h: number): V3 => [cx + ox * r + px * s, y0 + h, cz + oz * r + pz * s];
  const foot = { rIn: 10.4, rOut: 14.2, w: 1.5, h: -1 };
  const head = { rIn: 5.6, rOut: 6.4, w: 0.95, h: 62 };
  // Where the outer face meets the shaft, a little lower than the inner.
  const fi0 = P(foot.rIn, -foot.w, foot.h);
  const fi1 = P(foot.rIn, foot.w, foot.h);
  const fo0 = P(foot.rOut, -foot.w, foot.h);
  const fo1 = P(foot.rOut, foot.w, foot.h);
  const hi0 = P(head.rIn, -head.w, head.h - 14);
  const hi1 = P(head.rIn, head.w, head.h - 14);
  const ho0 = P(head.rOut, -head.w, head.h);
  const ho1 = P(head.rOut, head.w, head.h);
  const m = CONCRETE;
  const uvs = (len: number): [number, number][] => [[0, 0], [0.4, 0], [0.4, len / 8], [0, len / 8]];
  // Outer face (sloping), the two sides, the inner face.
  b.poly([fo0, fo1, ho1, ho0], uvs(64), m, [ox, 0.3, oz]);
  b.poly([fi0, fo0, ho0, hi0], uvs(64), m, [-px, 0, -pz]);
  b.poly([fo1, fi1, hi1, ho1], uvs(64), m, [px, 0, pz]);
  if (!far) b.poly([fi1, fi0, hi0, hi1], uvs(50), CONCRETE_DARK, [-ox, 0, -oz]);
}

export const skyTower: LandmarkModel = {
  id: 'sky-tower',
  name: 'Sky Tower',
  near: 650,
  drawDistance: Infinity,
  haze: true,
  height: SKY_TOWER_HEIGHT,
  build,
};
