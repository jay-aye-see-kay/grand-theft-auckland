import * as THREE from 'three';
import { SHADE_ONE, UV_SCALE } from '../city/facades.ts';

// Geometry kit for the hand-made landmarks: walls, boxes, prisms and lathed
// solids written straight into the city's vertex format (see ChunkMesh and
// cityMaterial), so a whole landmark is one mesh and one draw call with the
// shared shader: per-vertex colour, baked light, atlas layer and UVs, plus
// glow for lights and neon. Coordinates are the city's local metres (x east,
// y up, z south); the mesh sits at the origin.

export type V2 = [number, number];
export type V3 = [number, number, number];

/** A surface: an atlas layer (or none, for plain colour) and how it's tinted and lit. */
export interface Mat {
  /** Landmark atlas layer (src/landmarks/atlas.ts), or -1 for plain vertex colour. */
  layer: number;
  /** sRGB hex; multiplies the layer where its tint mask is set. */
  colour: number;
  /** Metres per texture repeat across and up (walls), default 1 (the UVs given are used as is). */
  su?: number;
  sv?: number;
  /** Emitted light (0..2), or 3+ to blink (aircraft lights). */
  glow?: number;
  /** Baked light multiplier (1 = none). */
  shade?: number;
}

/** A static collider, in world coordinates. */
export type ColliderSpec =
  | { kind: 'box'; centre: V3; half: V3; rotY: number }
  | { kind: 'cylinder'; centre: V3; halfHeight: number; radius: number };

const _c = new THREE.Color();

export class Builder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  readonly uv: number[] = [];
  readonly tile: number[] = [];
  readonly shade: number[] = [];
  readonly glow: number[] = [];
  readonly idx: number[] = [];
  readonly colliders: ColliderSpec[] = [];
  /**
   * Ground level the baked light darkens towards (the base of the building):
   * walls are a little darker in their first few metres, like the city's.
   */
  ground = -Infinity;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangles(): number {
    return this.idx.length / 3;
  }

  private vertex(p: V3, n: V3, uv: V2, m: Mat): number {
    const k = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    _c.setHex(m.colour); // sRGB in, linear out
    this.col.push(_c.r, _c.g, _c.b);
    this.uv.push(uv[0] * UV_SCALE, uv[1] * UV_SCALE);
    this.tile.push(m.layer < 0 ? 0 : m.layer + 1);
    // Darker at the foot of walls (light bounced off the street, not the sky).
    const foot = Number.isFinite(this.ground) && Math.abs(n[1]) < 0.7 ? 0.78 + 0.22 * Math.min(1, Math.max(0, (p[1] - this.ground) / 5)) : 1;
    this.shade.push((m.shade ?? 1) * foot * SHADE_ONE);
    this.glow.push(m.glow ?? 0);
    return k;
  }

  /**
   * A flat polygon (3 or 4 corners, convex) with UVs per corner. Facing:
   * counter-clockwise seen from the front; with `out` given, it's turned to
   * face that way whatever the order.
   */
  poly(p: V3[], uv: V2[], m: Mat, out?: V3, flip = false): void {
    let n = normal(p[0], p[1], p[2]);
    if ((out && dot(n, out) < 0) !== flip) {
      p = [...p].reverse();
      uv = [...uv].reverse();
      n = [-n[0], -n[1], -n[2]];
    }
    const base = p.map((q, k) => this.vertex(q, n, uv[k], m));
    for (let k = 1; k + 1 < base.length; k++) this.idx.push(base[0], base[k], base[k + 1]);
  }

  /** Same, seen from both sides (signs, lattices). */
  poly2(p: V3[], uv: V2[], m: Mat): void {
    this.poly(p, uv, m);
    this.poly(p, uv, m, undefined, true);
  }

  /**
   * A vertical wall from a to b (plan points), y0 to y1, facing `out` (or
   * to the left of a->b seen from above with north up, i.e. normal (dz, -dx)
   * in x/z... see wallOut). UVs: u along the wall from a in repeats of
   * m.su metres (or `fitU` whole repeats), v up from `vBase` in m.sv metres.
   */
  wall(a: V2, b: V2, y0: number, y1: number, m: Mat, opts: { out?: V2; u0?: number; fitU?: number; vBase?: number; v1?: number } = {}): void {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const su = m.su ?? len;
    const sv = m.sv ?? y1 - y0;
    const u0 = opts.u0 ?? 0;
    const u1 = opts.fitU ? u0 + opts.fitU : u0 + len / su;
    const vb = opts.vBase ?? y0;
    const va = (y0 - vb) / sv;
    const vt = opts.v1 ?? (y1 - vb) / sv;
    const out: V3 | undefined = opts.out ? [opts.out[0], 0, opts.out[1]] : [b[1] - a[1], 0, -(b[0] - a[0])];
    this.poly(
      [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]],
      [[u0, va], [u1, va], [u1, vt], [u0, vt]],
      m,
      out,
    );
  }

  /**
   * A closed ring of walls round a plan polygon (any winding), each facing
   * outwards, with an optional flat top (and bottom). Returns nothing; UVs
   * run on round the ring so textures don't jump at corners.
   */
  prism(ring: V2[], y0: number, y1: number, side: Mat | ((k: number, a: V2, b: V2) => Mat | null), top: Mat | null, opts: { bottom?: Mat; vBase?: number } = {}): void {
    const ccw = signedArea(ring) > 0; // counter-clockwise in (x, z) maths terms
    let u = 0;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      const m = typeof side === 'function' ? side(k, a, b) : side;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (m) {
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const out: V2 = ccw ? [dz, -dx] : [-dz, dx];
        this.wall(a, b, y0, y1, m, { out, u0: m.su ? u / m.su : 0, vBase: opts.vBase });
      }
      u += len;
    }
    if (top) this.cap(ring, y1, top, true);
    if (opts.bottom) this.cap(ring, y0, opts.bottom, false);
  }

  /** A flat horizontal polygon at height y facing up (or down), UVs in metres / su. */
  cap(ring: V2[], y: number, m: Mat, up = true): void {
    const tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)), []);
    const su = m.su ?? 4;
    const sv = m.sv ?? su;
    for (const t of tris) {
      const p = t.map((i) => [ring[i][0], y, ring[i][1]] as V3);
      this.poly(p, t.map((i) => [ring[i][0] / su, -ring[i][1] / sv] as V2), m, [0, up ? 1 : -1, 0]);
    }
  }

  /**
   * An oriented box: centre (x, z) at height y0..y1, size along its own
   * axes (`along` points along heading `rot`, radians from +x towards -z,
   * like the game's headings), all five visible faces (no bottom).
   */
  box(cx: number, cz: number, y0: number, y1: number, along: number, across: number, rot: number, m: Mat | Mat[], top?: Mat | null): void {
    const ring = rect(cx, cz, along, across, rot);
    const mats = Array.isArray(m) ? m : [m, m, m, m];
    this.prism(ring, y0, y1, (k) => mats[k % mats.length], top === undefined ? mats[0] : top);
  }

  /**
   * A solid of revolution about the vertical axis through (cx, cz): the
   * profile is [radius, y] from the bottom up, each band between two
   * profile points one ring of quads (smooth round, hard between bands).
   * `mats` gives each band's surface (or the last for the rest); u wraps
   * round `repeats` times, v runs up each band 0..1 unless the band's
   * material has `sv` (metres).
   */
  lathe(cx: number, cz: number, profile: V2[], segments: number, mats: Mat | Mat[], repeats = 1, phase = 0, caps = true): void {
    const list = Array.isArray(mats) ? mats : [mats];
    for (let k = 0; k + 1 < profile.length; k++) {
      const [r0, y0] = profile[k];
      const [r1, y1] = profile[k + 1];
      if (r0 === 0 && r1 === 0) continue;
      const m = list[Math.min(k, list.length - 1)];
      const dy = y1 - y0;
      const dr = r1 - r0;
      const l = Math.hypot(dy, dr) || 1;
      const v0 = m.sv ? y0 / m.sv : 0;
      const v1 = m.sv ? y1 / m.sv : 1;
      const ring: number[][] = [];
      for (let s = 0; s <= segments; s++) {
        const t = phase + (s / segments) * Math.PI * 2;
        const c = Math.cos(t);
        const sn = Math.sin(t);
        // Outward and up as the radius shrinks.
        const n: V3 = [(c * dy) / l, -dr / l, (sn * dy) / l];
        const u = (s / segments) * repeats;
        ring.push([
          this.vertex([cx + c * r0, y0, cz + sn * r0], n, [u, v0], m),
          this.vertex([cx + c * r1, y1, cz + sn * r1], n, [u, v1], m),
        ]);
      }
      for (let s = 0; s < segments; s++) {
        const [a0, a1] = ring[s];
        const [b0, b1] = ring[s + 1];
        // Seen from outside, with z south, increasing angle runs clockwise from above.
        if (dy >= 0) this.idx.push(a0, a1, b0, b0, a1, b1);
        else this.idx.push(a0, b0, a1, b0, b1, a1);
      }
    }
    // A flat cap where the profile ends at a radius (looking up or down).
    const capEnd = (r: number, y: number, up: boolean, m: Mat) => {
      if (r <= 0) return;
      const ring: V2[] = [];
      for (let s = 0; s < segments; s++) {
        const t = phase + (s / segments) * Math.PI * 2;
        ring.push([cx + Math.cos(t) * r, cz + Math.sin(t) * r]);
      }
      this.cap(ring, y, m, up);
    };
    if (!caps) return;
    const first = profile[0];
    const last = profile[profile.length - 1];
    capEnd(first[0], first[1], false, list[0]);
    capEnd(last[0], last[1], true, list[Math.min(profile.length - 2, list.length - 1)]);
  }

  /**
   * Sloping sides between two rings of the same number of corners (a
   * mansard, a hipped or pyramid roof when `upper` shrinks to a point), each
   * face facing away from the rings' centre. UVs in metres / su along, up the slope / sv.
   */
  frustum(lower: V2[], upper: V2[], y0: number, y1: number, m: Mat): void {
    const cx = lower.reduce((s, p) => s + p[0], 0) / lower.length;
    const cz = lower.reduce((s, p) => s + p[1], 0) / lower.length;
    const su = m.su ?? 4;
    const sv = m.sv ?? su;
    for (let k = 0; k < lower.length; k++) {
      const a = lower[k];
      const b = lower[(k + 1) % lower.length];
      const c = upper[(k + 1) % upper.length];
      const d = upper[k];
      const mx = (a[0] + b[0]) / 2 - cx;
      const mz = (a[1] + b[1]) / 2 - cz;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const top = Math.hypot(c[0] - d[0], c[1] - d[1]);
      const slope = Math.hypot(y1 - y0, Math.hypot((a[0] + b[0] - c[0] - d[0]) / 2, (a[1] + b[1] - c[1] - d[1]) / 2));
      const inset = (len - top) / 2;
      const pts: V3[] = [[a[0], y0, a[1]], [b[0], y0, b[1]], [c[0], y1, c[1]], [d[0], y1, d[1]]];
      const uv: V2[] = [[0, 0], [len / su, 0], [(len - inset) / su, slope / sv], [inset / su, slope / sv]];
      if (top < 1e-6) {
        this.poly([pts[0], pts[1], pts[2]], [uv[0], uv[1], [len / 2 / su, slope / sv]], m, [mx, 0.5, mz]);
      } else {
        this.poly(pts, uv, m, [mx, 0.5, mz]);
      }
    }
  }

  /** A flat decal quad (atlas cell `uv` = [u0, v0, u1, v1]) on a facade frame, `w` metres proud of it. */
  decal(f: Frame, u: number, y: number, width: number, height: number, uv: readonly [number, number, number, number], m: Mat, w = 0.04): void {
    const [u0, v0, u1, v1] = uv;
    this.poly(
      [f.p(u - width / 2, y, w), f.p(u + width / 2, y, w), f.p(u + width / 2, y + height, w), f.p(u - width / 2, y + height, w)],
      [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
      m,
      f.out3,
    );
  }

  /** A straight bar (lattice members, masts) between two points, square section `w`. */
  bar(a: V3, b: V3, w: number, m: Mat): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d);
    const ax: V3 = [d[0] / len, d[1] / len, d[2] / len];
    // Two axes across the bar.
    const ref: V3 = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const p = norm(cross(ax, ref));
    const q = cross(ax, p);
    const h = w / 2;
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([s, t]) => [p[0] * s * h + q[0] * t * h, p[1] * s * h + q[1] * t * h, p[2] * s * h + q[2] * t * h] as V3);
    for (let k = 0; k < 4; k++) {
      const c0 = corners[k];
      const c1 = corners[(k + 1) % 4];
      const out: V3 = [(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2, (c0[2] + c1[2]) / 2];
      this.poly(
        [add(a, c0), add(a, c1), add(b, c1), add(b, c0)],
        [[0, 0], [1, 0], [1, 1], [0, 1]],
        m,
        out,
      );
    }
  }

  collideBox(cx: number, cz: number, y0: number, y1: number, along: number, across: number, rot: number): void {
    this.colliders.push({ kind: 'box', centre: [cx, (y0 + y1) / 2, cz], half: [along / 2, (y1 - y0) / 2, across / 2], rotY: rot });
  }

  collideCylinder(cx: number, cz: number, y0: number, y1: number, radius: number): void {
    this.colliders.push({ kind: 'cylinder', centre: [cx, (y0 + y1) / 2, cz], halfHeight: (y1 - y0) / 2, radius });
  }

  /** The geometry, in the city's attribute layout (cityMaterial with the landmark option). */
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const n = this.vertexCount;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('roadLayer', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('aShade', new THREE.Float32BufferAttribute(this.shade, 1));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aTile', new THREE.Float32BufferAttribute(this.tile, 1));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    g.setIndex(n > 0xffff ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Corners of a rectangle centred on (cx, cz), `along` long in direction `rot` (game heading), `across` wide. */
export function rect(cx: number, cz: number, along: number, across: number, rot: number): V2[] {
  const ux = Math.cos(rot);
  const uz = -Math.sin(rot);
  // Right-hand side (local +z) of the heading.
  const vx = -uz;
  const vz = ux;
  const a = along / 2;
  const w = across / 2;
  return [
    [cx - ux * a - vx * w, cz - uz * a - vz * w],
    [cx + ux * a - vx * w, cz + uz * a - vz * w],
    [cx + ux * a + vx * w, cz + uz * a + vz * w],
    [cx - ux * a + vx * w, cz - uz * a + vz * w],
  ];
}

/**
 * A frame along a facade: origin `o` (plan), direction `dir` (unit, plan)
 * along the facade, `out` the outward normal. at(u, w) is the plan point u
 * metres along and w metres out.
 */
export class Frame {
  readonly o: V2;
  readonly d: V2;
  readonly n: V2;
  constructor(o: V2, along: V2, outHint: V2) {
    const l = Math.hypot(along[0], along[1]);
    this.o = o;
    this.d = [along[0] / l, along[1] / l];
    // The normal on the side of outHint.
    const n: V2 = [-this.d[1], this.d[0]];
    this.n = n[0] * outHint[0] + n[1] * outHint[1] >= 0 ? n : [-n[0], -n[1]];
  }

  at(u: number, w = 0): V2 {
    return [this.o[0] + this.d[0] * u + this.n[0] * w, this.o[1] + this.d[1] * u + this.n[1] * w];
  }

  /** The game heading (radians) of the facade's direction. */
  get heading(): number {
    return Math.atan2(-this.d[1], this.d[0]);
  }

  /** 3D point u along, y up, w out. */
  p(u: number, y: number, w = 0): V3 {
    const [x, z] = this.at(u, w);
    return [x, y, z];
  }

  get out3(): V3 {
    return [this.n[0], 0, this.n[1]];
  }
}

function signedArea(ring: V2[]): number {
  let a = 0;
  for (let k = 0; k < ring.length; k++) {
    const [x0, z0] = ring[k];
    const [x1, z1] = ring[(k + 1) % ring.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
function normal(a: V3, b: V3, c: V3): V3 {
  return norm(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
}
