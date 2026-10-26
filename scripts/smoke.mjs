// Browser smoke test: plays the built game in headless Chromium and checks
// that the core actions work. Run `npm run build` first, then:
//   node scripts/smoke.mjs [screenshot-dir]
// Exits non-zero on failure. Screenshots are for humans; the asserts are
// what CI cares about. Frame rate here is meaningless (software WebGL).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const PORT = 4179;
const URL = `http://localhost:${PORT}/?debug`;
const shots = process.argv[2] ?? 'smoke-shots';
mkdirSync(shots, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('preview server did not start');
}

const state = (page) => page.evaluate(() => window.__game.state());
const dist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

async function openGame(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL);
  await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
  return { page, errors };
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
try {
  await waitForServer();

  // Desktop, keyboard.
  {
    const { page, errors } = await openGame(await browser.newContext({ viewport: { width: 1280, height: 720 } }));
    await page.screenshot({ path: `${shots}/1-title.png` });
    await page.keyboard.press('KeyX');
    await page.waitForTimeout(800);
    let s = await state(page);
    check(s.started && s.mode === 'foot', 'starts on foot');
    check(s.nearCar, 'spawns next to a car');
    check(s.audio === 'running', `audio unlocked (${s.audio})`);
    await page.screenshot({ path: `${shots}/2-on-foot.png` });

    // Walk away from the car and back.
    const p0 = s.player;
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyD');
    s = await state(page);
    check(dist(p0, s.player) > 1.5, `walks (moved ${dist(p0, s.player).toFixed(1)} m)`);
    check(s.playerGrounded && s.player[1] > -0.1 && s.player[1] < 0.5, `stays on the ground (y=${s.player[1].toFixed(2)})`);
    await page.screenshot({ path: `${shots}/3-walked.png` });

    // Sample the peak rather than one moment: CI frame timing varies a lot.
    await page.keyboard.press('Space');
    let peakY = 0;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(50);
      peakY = Math.max(peakY, (await state(page)).player[1]);
    }
    check(peakY > 0.4, `jumps (peak y=${peakY.toFixed(2)})`);
    await page.waitForTimeout(600);

    await page.keyboard.down('KeyA');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyA');
    s = await state(page);
    check(s.nearCar, 'walks back to the car');

    await page.keyboard.press('KeyF');
    await page.waitForTimeout(300);
    s = await state(page);
    check(s.mode === 'car' && s.drivingIndex === 0, 'gets into the purple Corolla');

    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2500);
    s = await state(page);
    check(s.speedKmh > 15, `drives (${s.speedKmh.toFixed(0)} km/h)`);
    await page.keyboard.down('KeyA');
    await page.keyboard.down('Space');
    let maxSkid = 0;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(100);
      maxSkid = Math.max(maxSkid, (await state(page)).skid);
    }
    check(maxSkid > 0.25, `handbrake turn slides (max skid ${maxSkid.toFixed(2)})`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/4b-skid-marks.png` });
    const quads = (await state(page)).skidQuads;
    check(quads > 5, `lays skid marks (${quads} quads)`);
    await page.screenshot({ path: `${shots}/4-handbrake.png` });
    await page.keyboard.up('Space');
    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyW');

    // Exit at speed: should brake to a stop and then get out.
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => window.__game.state().mode === 'foot', null, { timeout: 8000 }).catch(() => {});
    s = await state(page);
    check(s.mode === 'foot', 'gets out (after braking)');
    const car = s.cars[0];
    check(dist(car, s.player) < 3, `steps out beside the car (${dist(car, s.player).toFixed(1)} m)`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${shots}/5-got-out.png` });
    check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await page.context().close(); // two games rendering at once starves the software renderer
  }

  // Phone, touch.
  {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 915, height: 412 } });
    const { page, errors } = await openGame(ctx);
    await page.tap('#splash');
    await page.waitForTimeout(800);
    const footButtons = await page.locator('.touch .btn:visible').count();
    check((await page.locator('.btn-sprint').isVisible()) && !(await page.locator('.btn-gas').isVisible()), `on-foot touch layout (${footButtons} buttons)`);
    check(await page.locator('.btn-enter.ready').isVisible(), 'enter button lights up near a car');
    await page.screenshot({ path: `${shots}/6-phone-foot.png` });

    // Drag the stick upwards (walk forward).
    const box = await page.locator('.stick').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: cx, y }] });
    const before = (await state(page)).player;
    await touch('touchStart', cy);
    await touch('touchMove', cy - 50);
    await page.waitForTimeout(1000);
    await touch('touchEnd');
    const after = (await state(page)).player;
    check(dist(before, after) > 1, `touch stick walks (moved ${dist(before, after).toFixed(1)} m)`);

    // Walk back and get in with the button.
    await touch('touchStart', cy);
    await touch('touchMove', cy + 50);
    await page.waitForTimeout(1000);
    await touch('touchEnd');
    await page.locator('.btn-enter').tap({ force: true }); // it pulses, so never "stable"
    await page.waitForTimeout(300);
    const s = await state(page);
    check(s.mode === 'car', 'touch enter button gets in');
    check(await page.locator('.btn-gas').isVisible(), 'driving touch layout');
    await page.screenshot({ path: `${shots}/7-phone-car.png` });
    check(errors.length === 0, `no console errors on phone${errors.length ? ': ' + errors.join(' | ') : ''}`);
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
