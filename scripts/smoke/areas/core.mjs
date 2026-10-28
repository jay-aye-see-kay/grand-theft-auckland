// The core actions: start on foot by the purple Corolla, walk, jump, walk
// back, get in, drive, handbrake turn, get out at speed. Run on Auckland
// (core) and again in the test town.

/** The core actions, from just after the title screen. */
export async function coreActions(t, tag = '') {
  const { check, state, run, press, shot, getOut, dist, page } = t;
  let s = await state();
  check(s.started && s.mode === 'foot', `starts on foot${tag}`);
  check(s.map === (tag ? 'test' : 'auckland'), `loads the ${s.map} map${tag}`);
  check(s.nearCar, `spawns next to a car${tag}`);
  check(s.audio === 'running', `audio unlocked (${s.audio})${tag}`);
  await shot('2-on-foot');

  // Walk away from the car for 1.5 s.
  const p0 = s.player;
  ({ s } = await run({ keys: ['KeyD'], max: 90 }));
  check(dist(p0, s.player) > 1.5, `walks (moved ${dist(p0, s.player).toFixed(1)} m)${tag}`);
  const above = s.player[1] - s.ground;
  check(s.playerGrounded && above > -0.1 && above < 0.4, `stays on the ground (y=${s.player[1].toFixed(2)}, ground ${s.ground.toFixed(2)})${tag}`);
  const [bottom, top] = s.playerModelY;
  check(Math.abs(bottom - s.player[1]) < 0.1 && top - bottom > 1.6 && top - bottom < 1.8,
    `person stands on its feet (model ${(bottom - s.player[1]).toFixed(2)} to ${(top - s.player[1]).toFixed(2)} m)${tag}`);
  await shot('3-walked');

  // Jump: the peak over the next second, a tick at a time.
  const standY = s.player[1];
  let peakY = standY;
  await page.keyboard.press('Space');
  await run({ max: 60, every: 1, sample: (x) => (peakY = Math.max(peakY, x.player[1])) });
  check(peakY - standY > 0.4, `jumps (peak +${(peakY - standY).toFixed(2)} m)${tag}`);
  await run({ max: 120, until: (x) => x.playerGrounded });

  // Back until it's in reach of the car again.
  ({ s } = await run({ keys: ['KeyA'], max: 600, every: 2, until: (x) => x.nearCar }));
  check(s.nearCar, `walks back to the car${tag}`);
  s = await press('KeyF');
  check(s.mode === 'car' && s.drivingIndex === 0, `gets into the purple Corolla${tag}`);

  ({ s } = await run({ keys: ['KeyW'], max: 600, until: (x) => x.speedKmh > 20 }));
  check(s.speedKmh > 15, `drives (${s.speedKmh.toFixed(0)} km/h)${tag}`);
  // Handbrake turn, still on the gas: 1.6 s.
  let maxSkid = 0;
  ({ s } = await run({ keys: ['KeyW', 'KeyA', 'Space'], max: 96, sample: (x) => (maxSkid = Math.max(maxSkid, x.skid)) }));
  check(maxSkid > 0.25, `handbrake turn slides (max skid ${maxSkid.toFixed(2)})${tag}`);
  check(s.skidQuads > 5, `lays skid marks (${s.skidQuads} quads)${tag}`);
  await shot('4-handbrake');

  // Exit at speed: should brake to a stop and then get out.
  s = await getOut();
  check(s.mode === 'foot', `gets out (after braking)${tag}`);
  check(dist(s.cars[0], s.player) < 3, `steps out beside the car (${dist(s.cars[0], s.player).toFixed(1)} m)${tag}`);
  await run({ max: 30 });
  await shot('5-got-out');
}

export default {
  name: 'core',
  core: true,
  page: 'auckland',
  /** Before the game starts: data credits on the title screen (OSM ODbL, LINZ CC BY 4.0), with links. */
  async title({ page, check, shot }) {
    await shot('1-title');
    const credits = page.locator('#credits');
    const text = (await credits.isVisible()) ? await credits.innerText() : '';
    const links = await credits.locator('a[href^="https://"]').count();
    check(/© OpenStreetMap contributors/.test(text) && /LINZ Data Service/.test(text) && /CC BY 4\.0/.test(text) && links >= 3,
      `title screen credits OSM and LINZ (${links} links)`);
  },
  run: (t) => coreActions(t),
};
