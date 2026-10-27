// Everything else steps the game by hand: make sure the real-time loop still
// plays it on its own. Last on its page, as how far it gets depends on this
// machine's speed.

export default {
  name: 'realtime',
  core: true,
  page: 'auckland',
  async run({ page, check, game, state, dist }) {
    await game('realtime');
    const p0 = (await state()).player;
    await page.keyboard.down('KeyD');
    await page.waitForFunction(([x, z]) => {
      const p = window.__game.state().player;
      return Math.hypot(p[0] - x, p[2] - z) > 0.5;
    }, [p0[0], p0[2]], { timeout: 10000 }).catch(() => {});
    await page.keyboard.up('KeyD');
    const moved = dist(p0, (await state()).player);
    check(moved > 0.5, `walks in real time, unstepped (moved ${moved.toFixed(1)} m)`, { stable: false });
  },
};
