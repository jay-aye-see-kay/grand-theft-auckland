// Phone, touch: the on-foot and driving layouts, the stick walks, the enter
// button gets in. Touches go through CDP, so they reach the game the same
// way a finger does.

export default {
  name: 'phone',
  core: false,
  page: 'phone',
  async run({ page, context, check, state, step, run, shot, dist }) {
    await step(30);
    const footButtons = await page.locator('.touch .btn:visible').count();
    check((await page.locator('.btn-sprint').isVisible()) && !(await page.locator('.btn-gas').isVisible()), `on-foot touch layout (${footButtons} buttons)`);
    check(await page.locator('.btn-enter.ready').isVisible(), 'enter button lights up near a car');
    await shot('6-foot');

    // Drag the stick upwards (walk forward) for a second.
    const box = await page.locator('.stick').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: cx, y }] });
    const before = (await state()).player;
    await touch('touchStart', cy);
    await touch('touchMove', cy - 50);
    const { s: walked } = await run({ max: 60 });
    await touch('touchEnd');
    check(dist(before, walked.player) > 1, `touch stick walks (moved ${dist(before, walked.player).toFixed(1)} m)`);

    // Walk back until the car is in reach and get in with the button.
    await touch('touchStart', cy);
    await touch('touchMove', cy + 50);
    await run({ max: 600, every: 2, until: (x) => x.nearCar });
    await touch('touchEnd');
    await page.locator('.btn-enter').tap({ force: true }); // it pulses, so never "stable"
    const s = await step(2);
    check(s.mode === 'car', 'touch enter button gets in');
    check(await page.locator('.btn-gas').isVisible(), 'driving touch layout');
    await shot('7-car');
  },
};
