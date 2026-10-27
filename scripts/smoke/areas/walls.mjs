// Buildings are solid: the car and the player (sprinting) run at the Chief
// Post Office (Britomart station, tagged 20 m). Its slanted east wall runs
// from (-23.4, -43.4) to (-41.2, 8.8), with open ground east of it.
// Anything sliding along it moves in x and z, so penetration is measured as
// distance from the wall's line.

const WALL = [[-23.4, -43.4], [-41.2, 8.8]];
const wallLen = Math.hypot(WALL[1][0] - WALL[0][0], WALL[1][1] - WALL[0][1]);
/** Signed distance from the wall line, positive on the open (east) side. */
export const wallDist = (p) =>
  ((WALL[1][1] - WALL[0][1]) * (p[0] - WALL[0][0]) - (WALL[1][0] - WALL[0][0]) * (p[2] - WALL[0][1])) / wallLen;
/** Square on to the wall (heading along its inward normal), so the car stops against it rather than scraping round the corner. */
export const AT_WALL = Math.atan2(-(WALL[1][0] - WALL[0][0]), -(WALL[1][1] - WALL[0][1]));

/**
 * Holds `keys` for up to `max` ticks, tracking the closest approach to the
 * wall and the top speed, until `settled` has held for a second.
 */
export async function ram(t, keys, max, settled) {
  let minD = Infinity;
  let peak = 0;
  let calm = 0;
  const { s } = await t.run({
    keys,
    max,
    sample: (last) => {
      const p = last.mode === 'car' ? last.cars[0] : last.player;
      minD = Math.min(minD, wallDist(p));
      peak = Math.max(peak, last.mode === 'car' ? last.speedKmh : 0);
      calm = settled({ last, minD, peak }) ? calm + 6 : 0;
    },
    until: () => calm >= 60,
  });
  return { minD, peak, last: s };
}

export default {
  name: 'walls',
  core: true,
  page: 'auckland',
  async run(t) {
    const { check, game, step, getIn, getOut, shot } = t;
    check((await getIn()).mode === 'car', 'gets in to ram the wall');
    await game('teleportCar', 0, -3, -32, AT_WALL);
    await step(36); // settle on the suspension
    let r = await ram(t, ['KeyW'], 1800, ({ last, peak }) => peak > 15 && last.speedKmh < 3);
    // Chassis half-length is 2.1 m: its centre should stop about that far out.
    check(r.peak > 15 && r.minD > 1, `car can't drive through a building (hit at ${r.peak.toFixed(0)} km/h, centre stopped ${r.minD.toFixed(2)} m from the wall)`);
    check(r.last.speedKmh < 5, `car stops at the wall (${r.last.speedKmh.toFixed(1)} km/h)`);
    await shot('9-car-at-wall');

    // Park the car out of the way, get out and sprint at the same wall.
    await game('teleportCar', 0, 10, -20, 0);
    await step(2);
    await getOut();
    await game('placePlayer', -4, -33, AT_WALL);
    await step(30);
    r = await ram(t, ['KeyW', 'ShiftLeft'], 2400, ({ minD }) => minD < 1.5);
    // Capsule radius is 0.3 m; it should reach the wall and stay outside it.
    check(r.last.mode === 'foot' && r.minD < 1.5 && r.minD > 0.2,
      `player can't walk through a building (capsule centre got to ${r.minD.toFixed(2)} m from the wall; ${r.last.mode} at ${r.last.player.map((v) => v.toFixed(1)).join(', ')})`);
  },
};
