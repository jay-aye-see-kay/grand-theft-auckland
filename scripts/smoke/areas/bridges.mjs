// Overbridges across the motorway trench: the LiDAR DEM has them cut out,
// so citygen carries each deck past its OSM ends onto solid ground (#35).
// Driving straight across, the car should stay up on the deck the whole way
// (never dropping towards the motorway below) and never hit a step.

/**
 * [name, approach start [x, z], far side [x, z], lowest the car may go (a
 * little under the lower approach; the road under the bridge is 5-10 m below)]
 */
const BRIDGES = [
  ['Upper Queen St', [-679, 1661], [-731, 1794], 60.5],
  ['K Road', [-1151, 1547], [-1050, 1510], 63],
  ['Grafton Rd', [233, 1178], [226, 1090], 14.5],
];

export default {
  name: 'bridges',
  core: false,
  page: 'auckland',
  async run({ check, game, step, run, getIn, shot }) {
    check((await getIn()).mode === 'car', 'gets in to cross the motorway');
    for (const [name, [x0, z0], [x1, z1], low] of BRIDGES) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const [ux, uz] = [(x1 - x0) / len, (z1 - z0) / len];
      await game('teleportCar', 0, x0, z0, Math.atan2(-uz, ux));
      await step(36); // settle on the suspension
      let minY = Infinity;
      let maxStep = 0;
      let prev = null;
      const { s } = await run({
        keys: ['KeyW'],
        max: 1500,
        every: 5,
        sample: (x) => {
          const y = x.cars[0][1];
          minY = Math.min(minY, y);
          if (prev !== null) maxStep = Math.max(maxStep, Math.abs(y - prev));
          prev = y;
        },
        until: (x) => (x.cars[0][0] - x0) * ux + (x.cars[0][2] - z0) * uz > len,
      });
      const p = s.cars[0];
      const along = (p[0] - x0) * ux + (p[2] - z0) * uz;
      const off = Math.abs((p[0] - x0) * uz - (p[2] - z0) * ux);
      check(along > len && off < 8 && minY > low, `drives across ${name} on the deck (${along.toFixed(0)}/${len.toFixed(0)} m, ${off.toFixed(1)} m off line, lowest ${minY.toFixed(1)} m, deck from ${low} m)`);
      check(maxStep < 0.6, `no step onto or off ${name} (worst ${maxStep.toFixed(2)} m in 5 ticks)`);
      await shot(`bridge-${name.toLowerCase().replace(/\W+/g, '-')}`);
    }
  },
};
