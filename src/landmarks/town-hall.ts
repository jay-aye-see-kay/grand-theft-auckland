import type { LandmarkInfo } from '../city/format.ts';
import { DECAL, L } from './atlas.ts';
import { Frame, rect, type Builder, type Mat, type V2 } from './builder.ts';
import type { LandmarkModel } from './landmarks.ts';

// Auckland Town Hall (1911, J.J. & E.J. Clark): a wedge between Queen St and
// Aotea Square, Oamaru stone over a dark bluestone base storey, a cornice
// and balustrade round the roof, the Great Hall's hipped roof rising behind,
// and on the narrow Queen St prow the slender clock tower (~38 m, LiDAR)
// with a clock on each face, an octagonal belfry and a copper dome. Laid
// out on the OSM outline; the tower and the Great Hall are placed from
// their OSM parts (hardcoded: the record only carries the outline).

const OAMARU = 0xe6dbc2;
const BASE: Mat = { layer: L.cpoBase, colour: 0xffffff, su: 5, sv: 6.5 };
const UPPER: Mat = { layer: L.townHall, colour: OAMARU, su: 5, sv: 10.4 };
const STONE: Mat = { layer: L.stone, colour: OAMARU, su: 4, sv: 4 };
const TRIM: Mat = { layer: L.stone, colour: 0xf2ead8, su: 4, sv: 1 };
const BALUSTRADE: Mat = { layer: L.balustrade, colour: 0xffffff, su: 2, sv: 1.1 };
const ROOF: Mat = { layer: -1, colour: 0x7c7a75 };
const SLATE: Mat = { layer: L.roofTiles, colour: 0x5d6466, su: 3, sv: 3 };
const COPPER: Mat = { layer: L.slate, colour: 0x6f9c86, su: 1.6, sv: 1.2 };
const GOLD: Mat = { layer: -1, colour: 0xc9a24f };
const DECALS: Mat = { layer: L.decal, colour: 0xffffff };
const CLOCK: Mat = { layer: L.decal, colour: 0xffffff, glow: 0.25 };

/** Storeys above sea level (the ground falls from ~25 m at the south end of Queen St to ~19.5 m on the square). */
const BASE_TOP = 26.2;
const CORNICE = 36.6;
const ROOF_Y = 37.3;
const PARAPET = 38.4;

/** The clock tower: its OSM part's centre and one edge's direction, and the stages up it (m above sea level). */
const TOWER = { centre: [-414.7, 908.8] as V2, edge: [-2.9, 4.0] as V2, side: 6, top: 59 };
/** The Great Hall's long axis (from the OSM part): two points down its middle, and its width. */
const GREAT_HALL = { a: [-447, 946] as V2, b: [-476, 973] as V2, width: 21 };

function build(b: Builder, far: boolean, records: LandmarkInfo[]): void {
  const r = records[0];
  const y0 = r.base;
  b.ground = y0;
  const fp = r.footprint;

  if (far) {
    b.prism(fp, y0 - 3, ROOF_Y, { ...STONE, layer: -1 }, ROOF);
  } else {
    // Bays fitted to each wall so the windows don't run off a corner.
    const fit = (m: Mat, len: number): Mat => ({ ...m, su: len / Math.max(1, Math.round(len / m.su!)) });
    const plain = (len: number) => len < 2.5;
    b.prism(fp, y0 - 3, BASE_TOP, (_k, a, c) => {
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      return plain(len) ? { ...BASE, layer: -1, colour: 0x6f6b66 } : fit(BASE, len);
    }, null, { vBase: BASE_TOP - 6.5 });
    b.prism(fp, BASE_TOP, CORNICE, (_k, a, c) => {
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      return plain(len) ? STONE : fit(UPPER, len);
    }, null, { vBase: BASE_TOP });
    // Cornice standing proud, the flat roof, and the balustrade round it.
    b.prism(grow(fp, 0.45), CORNICE, ROOF_Y, TRIM, ROOF);
    b.prism(fp, ROOF_Y, PARAPET, BALUSTRADE, null, { vBase: ROOF_Y });
    // A string course between the base and the stone above.
    b.prism(grow(fp, 0.25), BASE_TOP - 0.1, BASE_TOP + 0.5, TRIM, null);
  }

  // The Great Hall's roof: a clerestory and a long hipped roof in grey slate.
  {
    const [ax, az] = GREAT_HALL.a;
    const [bx, bz] = GREAT_HALL.b;
    const len = Math.hypot(bx - ax, bz - az);
    const rot = Math.atan2(-(bz - az), bx - ax);
    const cx = (ax + bx) / 2;
    const cz = (az + bz) / 2;
    const lower = rect(cx, cz, len, GREAT_HALL.width, rot);
    b.prism(lower, ROOF_Y - 1, 40.6, far ? { ...STONE, layer: -1 } : STONE, null);
    b.prism(rect(cx, cz, len + 0.8, GREAT_HALL.width + 0.8, rot), 40.6, 41.1, TRIM, null);
    const eave = rect(cx, cz, len + 0.8, GREAT_HALL.width + 0.8, rot);
    const ridge = rect(cx, cz, len - GREAT_HALL.width * 0.6, 0.6, rot);
    b.frustum(eave, ridge, 41.1, 44.6, SLATE);
    b.cap(ridge, 44.6, SLATE);
  }

  // The clock tower.
  const [tx, tz] = TOWER.centre;
  const rot = Math.atan2(-TOWER.edge[1], TOWER.edge[0]);
  const s = TOWER.side;
  const sq = (w: number) => rect(tx, tz, w, w, rot);
  b.prism(sq(s), y0 - 1, 44.2, far ? { ...STONE, layer: -1 } : { ...STONE, su: s / 2, sv: 3 }, null);
  b.prism(sq(s + 0.9), 44.2, 44.9, TRIM, ROOF);
  b.prism(sq(s - 0.4), 44.9, 49.6, far ? { ...STONE, layer: -1 } : { ...STONE, su: (s - 0.4) / 2, sv: 3 }, null);
  b.prism(sq(s + 0.6), 49.6, 50.3, TRIM, ROOF);
  // Octagonal belfry, its own cornice, the dome and a gilt finial.
  b.lathe(tx, tz, [[2.3, 50.3], [2.3, 53.4]], 8, { ...STONE, su: 1.8, sv: 3.1 }, 8, Math.PI / 8, false);
  b.lathe(tx, tz, [[2.75, 53.4], [2.75, 53.9], [2.45, 54.0]], 8, TRIM, 8, Math.PI / 8, false);
  b.lathe(tx, tz, [[2.45, 54.0], [2.4, 55.0], [2.0, 56.1], [1.3, 57.0], [0.5, 57.5], [0.12, 57.7]], far ? 8 : 12, COPPER, 4, 0, false);
  if (!far) {
    b.lathe(tx, tz, [[0.14, 57.6], [0.14, 58.6], [0.32, 58.7], [0.0, TOWER.top]], 6, GOLD, 1, 0, false);
    // Faces: a clock on each side of the clock stage, a tall arched window
    // under it, and a louvred arch on each face of the belfry.
    for (let k = 0; k < 4; k++) {
      const a = rot + (k * Math.PI) / 2;
      const out: V2 = [Math.cos(a), -Math.sin(a)];
      const along: V2 = [-out[1], out[0]];
      const half = (s - 0.4) / 2;
      const face = new Frame([tx + out[0] * half, tz + out[1] * half], along, out);
      b.decal(face, 0, 45.6, 3.4, 3.4, DECAL.clock, CLOCK, 0.06);
      const lower = new Frame([tx + out[0] * (s / 2), tz + out[1] * (s / 2)], along, out);
      b.decal(lower, 0, 39.2, 2.0, 3.8, DECAL.archWindow, DECALS, 0.04);
      // Corner urns on the tower's first cornice.
      const [ux, uz] = [tx + (out[0] + along[0]) * (s / 2 + 0.1), tz + (out[1] + along[1]) * (s / 2 + 0.1)];
      b.lathe(ux, uz, [[0.25, 44.9], [0.45, 45.3], [0.35, 45.9], [0.12, 46.2]], 6, TRIM, 1, 0, false);
    }
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const o: V2 = [Math.cos(a), Math.sin(a)];
      const face = new Frame([tx + o[0] * 2.14, tz + o[1] * 2.14], [-o[1], o[0]], o);
      b.decal(face, 0, 50.6, 1.3, 2.5, DECAL.louvre, DECALS, 0.04);
    }
    // The tower above the roof: it's slender, and the outline's collider stops at the roof.
    b.collideBox(tx, tz, ROOF_Y, 50.3, s, s, rot);
  }
}

/** A plan ring pushed out by about d metres (roughly: from its centroid). */
function grow(ring: V2[], d: number): V2[] {
  // Offset each corner along the average of its two edges' outward normals.
  let area = 0;
  for (let k = 0; k < ring.length; k++) {
    const [x0, z0] = ring[k];
    const [x1, z1] = ring[(k + 1) % ring.length];
    area += x0 * z1 - x1 * z0;
  }
  const sign = area > 0 ? 1 : -1;
  return ring.map((p, k) => {
    const prev = ring[(k + ring.length - 1) % ring.length];
    const next = ring[(k + 1) % ring.length];
    const n = (a: V2, c: V2): V2 => {
      const dx = c[0] - a[0];
      const dz = c[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      return [(sign * dz) / l, (-sign * dx) / l];
    };
    const n0 = n(prev, p);
    const n1 = n(p, next);
    let nx = n0[0] + n1[0];
    let nz = n0[1] + n1[1];
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    // Sharper corners need a longer push to keep the edges d out (capped).
    const cos = Math.max(0.5, nx * n0[0] + nz * n0[1]);
    return [p[0] + (nx * d) / cos, p[1] + (nz * d) / cos] as V2;
  });
}

export const townHall: LandmarkModel = {
  id: 'town-hall',
  name: 'the Town Hall',
  near: 350,
  drawDistance: 950,
  height: 40,
  build,
};
