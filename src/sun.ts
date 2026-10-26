// Where the sun is, shared by the game's lights and the offline generator's
// baked shading (tools/citygen bakes a sun-facing term into building colours).
// No DOM or Node APIs, so both sides can import it.
//
// Auckland is in the southern hemisphere: the sun crosses the northern sky.
// Mid-afternoon it's in the north-north-west, about 50 degrees up, which
// lights Queen St's west-facing shopfronts and the harbour-facing towers.
// Axes: x east, y up, z south (north is -z).

const AZIMUTH = (-25 * Math.PI) / 180; // from north, positive towards east: -25 deg is NNW
const ELEVATION = (50 * Math.PI) / 180;

/** Unit vector from the ground towards the sun. */
export const SUN_DIRECTION: readonly [number, number, number] = [
  Math.sin(AZIMUTH) * Math.cos(ELEVATION),
  Math.sin(ELEVATION),
  -Math.cos(AZIMUTH) * Math.cos(ELEVATION),
];
