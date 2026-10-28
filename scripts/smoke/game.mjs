// Helpers the smoke areas share: open a game page, and drive it through the
// ?debug hooks (src/main.ts). Physics advances only through step(), a fixed
// 1/60 s tick at a time, so results don't depend on how fast this machine
// renders: headless Chromium draws in software at ~10-20 fps.

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** Opens the game and waits for it to load (title screen up, not started). */
export async function openGame(context, url) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
  await page.waitForFunction(() => !/Loading/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  return { page, errors };
}

/** The toolkit each area gets: `check` plus ways to look at and play the game. */
export function toolkit(page, check, shots, prefix = '') {
  /** Calls a __game hook in the page. */
  const game = (fn, ...args) => page.evaluate(([f, a]) => window.__game[f](...a), [fn, args]);
  const state = () => game('state');
  /** Advances `n` ticks (1/60 s each) and returns the state after. */
  const step = (n) => page.evaluate(async (k) => {
    await window.__game.step(k);
    return window.__game.state();
  }, n);
  /**
   * Holds `keys` and steps up to `max` ticks, `every` ticks at a time,
   * calling `sample` with each state, until `until` says stop. Returns the
   * last state and the ticks it took.
   */
  const run = async ({ keys = [], max, every = 6, until = () => false, sample = () => {} }) => {
    for (const k of keys) await page.keyboard.down(k);
    let s = await state();
    let ticks = 0;
    try {
      while (ticks < max) {
        const n = Math.min(every, max - ticks);
        s = await step(n);
        ticks += n;
        sample(s);
        if (until(s)) break;
      }
    } finally {
      for (const k of keys) await page.keyboard.up(k);
    }
    return { s, ticks };
  };
  /** Presses a key and steps `ticks` so the game sees it. */
  const press = async (key, ticks = 2) => {
    await page.keyboard.press(key);
    return step(ticks);
  };
  /** Screenshot for humans; the game draws only on request while stepping. */
  const shot = async (name) => {
    await game('draw');
    await page.screenshot({ path: `${shots}/${prefix}${name}.png` });
  };
  /** Stands at the purple Corolla's driver's door (right side, +z at heading 0) and gets in. */
  const getIn = async () => {
    const car = (await state()).cars[0];
    await game('placePlayer', car[0], car[2] + 1.8, 0);
    await step(2);
    return press('KeyF');
  };
  /** Gets out (braking to a stop first if moving). */
  const getOut = async () => {
    await page.keyboard.press('KeyF');
    return (await run({ max: 600, until: (s) => s.mode === 'foot' })).s;
  };
  return { page, check, game, state, step, run, press, shot, getIn, getOut, dist };
}

/**
 * Hosts a room on `page` and opens a second tab that joins it, over a
 * BroadcastChannel (?net=local), not PeerJS: the public broker is no place
 * for a test. The guest is paused (two pages drawing in software starve
 * each other) and stepped with `step`; `g` calls its __game hooks.
 */
export async function openGuest(context, page) {
  const code = await page.evaluate(() => window.__game.host(true));
  const url = new URL(page.url());
  url.search = `?debug&net=local&room=${code}`;
  const guest = await openGame(context, url.toString());
  const g = (fn, ...args) => guest.page.evaluate(([f, a]) => window.__game[f](...a), [fn, args]);
  const step = (n) => guest.page.evaluate(async (k) => {
    await window.__game.step(k);
    return window.__game.state();
  }, n);
  await step(1);
  await guest.page.keyboard.press('KeyX');
  let joined = false;
  for (let i = 0; i < 40 && !joined; i++) {
    await step(6);
    joined = (await g('room')).role === 'guest';
  }
  await step(30); // spawning waits for the ground there to stream in
  return { ...guest, code, joined, g, step };
}
