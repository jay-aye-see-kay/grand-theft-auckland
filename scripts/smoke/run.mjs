// Browser smoke test: plays the built game in headless Chromium and checks
// that it works. Run `npm run build` first, then:
//
//   node scripts/smoke/run.mjs [--full | --only=area,...] [--repeat=N] [screenshot-dir]
//
// With no options it runs the quick core areas; --full runs every area.
// --repeat runs the selection N times on fresh pages and fails if any check
// reads differently between runs (the game is stepped a fixed tick at a
// time, so it should be exactly repeatable). Exits non-zero on failure.
// Screenshots are for humans. Frame rate here is meaningless (software WebGL).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright';
import { openGame, toolkit } from './game.mjs';
import core from './areas/core.mjs';
import walls from './areas/walls.mjs';
import testTown from './areas/test-town.mjs';
import terrain from './areas/terrain.mjs';
import trees from './areas/trees.mjs';
import parks from './areas/parks.mjs';
import parked from './areas/parked.mjs';
import drive from './areas/drive.mjs';
import bridges from './areas/bridges.mjs';
import buildings from './areas/buildings.mjs';
import fly from './areas/fly.mjs';
import harbour from './areas/harbour.mjs';
import missions from './areas/missions.mjs';
import roads from './areas/roads.mjs';
import budget from './areas/budget.mjs';
import rooms from './areas/rooms.mjs';
import realtime from './areas/realtime.mjs';
import phone from './areas/phone.mjs';

/** In running order. Areas on the same page share it, each starting from __game.reset(). */
const AREAS = [core, walls, terrain, trees, parks, parked, drive, bridges, buildings, fly, harbour, budget, missions, roads, rooms, realtime, testTown, phone];

const PORT = 4179;
const URL = `http://localhost:${PORT}/?debug`;
const PAGES = {
  auckland: { query: '', context: { viewport: { width: 1280, height: 720 } } },
  test: { query: '&map=test', prefix: 'test-', context: { viewport: { width: 1280, height: 720 } } },
  phone: { query: '', prefix: 'phone-', context: { ...devices['Pixel 7'], viewport: { width: 915, height: 412 } } },
};

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = opt('only')?.split(',');
const repeat = Number(opt('repeat') ?? 1);
const shots = args.find((a) => !a.startsWith('--')) ?? 'smoke-shots';
const unknown = only?.filter((n) => !AREAS.some((a) => a.name === n)) ?? [];
if (unknown.length) {
  console.error(`unknown area ${unknown.join(', ')}; areas: ${AREAS.map((a) => a.name).join(', ')}`);
  process.exit(2);
}
const selected = AREAS.filter((a) => (only ? only.includes(a.name) : args.includes('--full') || a.core));
mkdirSync(shots, { recursive: true });

const failures = [];
/** Per run, what each stable check read: compared across --repeat runs. */
const readings = [];
let current = [];
const check = (ok, what, { stable = true } = {}) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
  if (stable) current.push(what);
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

/** Opens one page and runs its areas on it, in order. */
async function runPage(browser, kind, areas) {
  const { query, prefix = '', context } = PAGES[kind];
  const ctx = await browser.newContext(context);
  const { page, errors } = await openGame(ctx, URL + query);
  const t = toolkit(page, check, shots, prefix);
  t.context = ctx;
  for (const area of areas) await area.title?.(t);
  if (kind === 'phone') await page.tap('#splash');
  else await page.keyboard.press('KeyX');
  await page.waitForFunction(() => window.__game.state().started, null, { timeout: 5000 });
  for (const area of areas) {
    const t0 = Date.now();
    console.log(`-- ${area.name}`);
    await t.game('reset');
    await area.run(t);
    console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  check(errors.length === 0, `no console errors on the ${kind} page${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await ctx.close(); // two games rendering at once starves the software renderer
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const started = Date.now();
try {
  await waitForServer();
  for (let n = 1; n <= repeat; n++) {
    if (repeat > 1) console.log(`\n== run ${n} of ${repeat}`);
    current = [];
    for (const kind of Object.keys(PAGES)) {
      const areas = selected.filter((a) => a.page === kind);
      if (areas.length) await runPage(browser, kind, areas);
    }
    readings.push(current);
  }
  // Every run should read exactly the same.
  for (const [n, run] of readings.entries()) {
    if (n === 0) continue;
    const diffs = run.map((what, i) => [readings[0][i], what]).filter(([a, b]) => a !== b);
    if (run.length !== readings[0].length) diffs.push([`${readings[0].length} checks`, `${run.length} checks`]);
    check(diffs.length === 0, `run ${n + 1} reads the same as run 1${diffs.length ? ':\n' + diffs.map(([a, b]) => `    run 1: ${a}\n    run ${n + 1}: ${b}`).join('\n') : ''}`, { stable: false });
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${selected.map((a) => a.name).join(', ')} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
console.log(failures.length ? `${failures.length} check(s) failed` : 'All checks passed');
process.exit(failures.length ? 1 : 0);
