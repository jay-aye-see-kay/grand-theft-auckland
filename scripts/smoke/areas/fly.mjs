// Fly cheat: up, up, down, down, left, right, left, right on the stick
// (arrows here). Climb, descend, fly through the Chief Post Office's wall,
// then the code again lands.
import { AT_WALL, ram } from './walls.mjs';

export default {
  name: 'fly',
  core: false,
  page: 'auckland',
  async run(t) {
    const { page, check, game, state, step, run } = t;
    // Each flick held, and let go, for a couple of ticks so the game sees it.
    const flyCode = async () => {
      await step(2); // stick back to the centre first, or the first flick doesn't count
      for (const k of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight']) {
        await page.keyboard.down(k);
        await step(2);
        await page.keyboard.up(k);
        await step(2);
      }
    };
    // East of the wall, facing it.
    await game('placePlayer', -4, -33, AT_WALL);
    await step(30);
    await flyCode();
    let s = await state();
    const y0 = s.player[1];
    check(s.flying && s.mode === 'foot', `fly cheat turns on flying (${s.flying})`);
    let r = await ram(t, ['Space'], 900, ({ last }) => last.player[1] > y0 + 10);
    check(r.last.player[1] > y0 + 10, `flying climbs (${(r.last.player[1] - y0).toFixed(1)} m up)`);
    // Back down to the wall's height and through it: flying ignores buildings.
    await ram(t, ['KeyC'], 900, ({ last }) => last.player[1] < y0 + 3);
    r = await ram(t, ['KeyW'], 900, ({ minD }) => minD < -3);
    check(r.minD < -3, `flying goes through buildings (${(-r.minD).toFixed(1)} m past the wall)`);
    // Out the other side, land: the same code again, and fall onto whatever is below.
    await run({ keys: ['KeyW'], max: 90 });
    await flyCode();
    ({ s } = await run({ max: 1200, until: (x) => x.playerGrounded }));
    check(!s.flying && s.playerGrounded && s.player[1] > s.ground - 0.5,
      `the code again lands (flying ${s.flying}, grounded ${s.playerGrounded}, feet ${s.player[1].toFixed(1)} m over ground ${s.ground.toFixed(1)} m)`);
  },
};
