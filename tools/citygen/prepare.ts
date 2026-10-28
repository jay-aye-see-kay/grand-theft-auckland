// The ground everything else samples: land use painted, and the DEM smoothed
// under streets and park paths. build.ts and the standalone scripts that need
// heights (roadgraph.ts) both start here, so they agree to the centimetre.
import type { CityData } from './fetch.ts';
import { GroundRaster, paintLandUse, paintPaths } from './ground.ts';
import { collectRoads, corridorRadius } from './roads.ts';
import { markCapsule, markLattice, smoothCorridors, type Grid } from './terrain.ts';

/** Smooth street surfaces a little past their edges, so the triangles under a strip's edge are smooth too. */
const CORRIDOR_MARGIN = 2.5;

export function prepareGround(data: CityData, grid: Grid) {
  const corridors = new Set<number>();
  for (const r of collectRoads(data.osm)) {
    if (r.bridge) continue;
    for (let k = 0; k + 1 < r.pts.length; k++) markCapsule(corridors, r.pts[k], r.pts[k + 1], corridorRadius(r) + CORRIDOR_MARGIN);
  }
  // Land use first: paths through parks are smoothed too (real ones are
  // graded), a sample past the painted line, so their strips lie flat on lawn.
  const ground = new GroundRaster(grid);
  const landUse = paintLandUse(data.osm, ground);
  const paths = paintPaths(data.osm, ground);
  ground.each('path', (c, r) => {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) markLattice(corridors, c + dc, r + dr);
  });
  const smoothed = smoothCorridors(data.dem, corridors);
  return { ground, landUse, paths, smoothed };
}
