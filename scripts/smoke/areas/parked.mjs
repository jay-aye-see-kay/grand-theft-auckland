// Parked cars: posed at the kerb from OSM data (public/city/cbd/parking.json).
// Each one, once its chunk has streamed in, should sit on its wheels on the
// road (not hovering, sunk or inside a building) and stay put.

export default {
  name: 'parked',
  core: false,
  page: 'auckland',
  async run({ page, check, game, step, shot }) {
    const parked = await page.evaluate(() => fetch('city/cbd/parking.json').then((r) => r.json()));
    check(parked.cars.length >= 6, `${parked.cars.length} cars parked round the CBD`);
    const bad = [];
    for (const [i, c] of parked.cars.entries()) {
      const here = await game('probe', c.x, c.z);
      // Look at it from the kerb behind: this also keeps its chunk streamed in.
      const fx = Math.cos(c.heading);
      const fz = -Math.sin(c.heading);
      await game('lookFrom', [c.x - fx * 9 - fz * 3, c.y + 3, c.z - fz * 9 + fx * 3], [c.x, c.y - 0.3, c.z]);
      let pose = null;
      let calm = 0;
      // Settled = unfrozen and still for a few samples in a row (up to 15 s).
      for (let ticks = 0; ticks < 900 && calm < 4; ticks += 9) {
        await step(9);
        const prev = pose;
        pose = (await game('carPoses'))[i];
        calm = !pose.frozen && prev && Math.hypot(pose.pos[0] - prev.pos[0], pose.pos[1] - prev.pos[1], pose.pos[2] - prev.pos[2]) < 0.01 ? calm + 1 : 0;
      }
      if (i === 7) await shot('12-parked-on-hill');
      const clear = pose.pos[1] - here.ground;
      const drift = Math.hypot(pose.pos[0] - c.x, pose.pos[2] - c.z);
      const roofed = here.top !== null && here.top - here.ground > 0.5;
      const ok = !pose.frozen && clear > 0.4 && clear < 0.9 && pose.up > 0.97 && drift < 0.5 && !roofed && ['road', 'paving'].includes(here.surface);
      if (!ok) bad.push(`${c.osm} ${c.name}: clearance ${clear.toFixed(2)}, up ${pose.up.toFixed(3)}, drift ${drift.toFixed(2)}, ${here.surface}${roofed ? ', under a roof' : ''}${pose.frozen ? ', frozen' : ''}`);
    }
    check(bad.length === 0, `parked cars sit on the road at the kerb (${parked.cars.length - bad.length}/${parked.cars.length})${bad.length ? ': ' + bad.join('; ') : ''}`);
    await game('lookFrom', null, [0, 0, 0]);
  },
};
