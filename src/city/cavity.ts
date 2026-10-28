// Space dug out under the ground at run time: an underground car park under
// a square, say. The terrain collider is a heightfield, a single surface,
// so a car can't drive under it and back out: somewhere on the way in it
// would have to pass through the slope from the floor up to the ceiling.
// Instead, inside a cavity the heightfield is lowered to the cavity's floor
// (so the floor is the heightfield and the car is never under it), and the
// ground that was there becomes a separate roof: a trimesh at the original
// heights over every cell the carving touched, except the openings, which
// are left open to the sky (a ramp down from the street). The ground is
// still drawn at its original heights, as it was (a landmark model draws the
// inside and the walls), except over the openings, where it's drawn at the
// carved heights instead (the ramp).
//
// Openings are whole 10 m cells of the terrain's coarse grid, so the far
// ground can leave out exactly the same cells as the near ground.

export type V2 = [number, number];

export interface Cavity {
  /** Rough bounds of everything carved, for a quick test (local metres). */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  /**
   * Height of the collision surface at a lattice point, or null to leave it
   * as it is. `ground` reads the original heights (any lattice point in the
   * same chunk, apron included).
   */
  carve(x: number, z: number, ground: (x: number, z: number) => number): number | null;
  /** Rectangles open to the sky, [minX, minZ, maxX, maxZ], on the 10 m coarse grid. */
  openings: [number, number, number, number][];
  /** sRGB colour of the ground drawn in the openings (the ramp's asphalt). */
  openingColour: number;
}

/** Whether a point is inside a polygon (any winding). */
export function inPolygon(ring: V2[], x: number, z: number): boolean {
  let inside = false;
  for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
    const [xi, zi] = ring[k];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a polygon's outline. */
export function distanceToRing(ring: V2[], x: number, z: number): number {
  let best = Infinity;
  for (let k = 0; k < ring.length; k++) {
    const [ax, az] = ring[k];
    const [bx, bz] = ring[(k + 1) % ring.length];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

/** Whether (x, z) lies in an opening (inclusive of its edges when `closed`). */
export function inOpening(c: Cavity, x: number, z: number, closed = false): boolean {
  for (const [x0, z0, x1, z1] of c.openings) {
    if (closed ? x >= x0 && x <= x1 && z >= z0 && z <= z1 : x > x0 && x < x1 && z > z0 && z < z1) return true;
  }
  return false;
}
