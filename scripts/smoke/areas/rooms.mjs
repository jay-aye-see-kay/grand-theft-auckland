// Rooms (#26): a second tab joins this one's room and each sees the other
// move, on foot and in a car. Over a BroadcastChannel between the tabs
// (?net=local), not PeerJS: the public broker is no place for a test.
// Poses arrive between steps on the other page's clock, so these readings
// aren't exactly repeatable.

import { openGame } from '../game.mjs';

const loose = { stable: false };

export default {
  name: 'rooms',
  core: false,
  page: 'auckland',
  async run({ page, context, check, game, state, step, run, getIn, getOut, dist }) {
    const code = await game('host', true);
    check(/^[A-Z2-9]{4}$/.test(code), `hosts a room with a four-letter code (${code})`, loose);

    const url = new URL(page.url());
    url.search = `?debug&net=local&room=${code}`;
    const guest = await openGame(context, url.toString());
    const g = (fn, ...args) => guest.page.evaluate(([f, a]) => window.__game[f](...a), [fn, args]);
    const gStep = (n) => guest.page.evaluate(async (k) => {
      await window.__game.step(k);
      return window.__game.state();
    }, n);
    await gStep(1); // paused: two pages drawing in software starve each other
    await guest.page.keyboard.press('KeyX');
    let joined = false;
    for (let i = 0; i < 40 && !joined; i++) {
      await gStep(6);
      joined = (await g('room')).role === 'guest';
    }
    check(joined, 'a second tab joins by the room code');
    await gStep(30); // spawning waits for the ground there to stream in

    const host = await game('room');
    check(host.members.length === 2 && host.role === 'host', 'the host sees two players');
    const near = dist((await gStep(1)).player, (await state()).player);
    check(near < 4, `the guest spawns beside the host (${near.toFixed(1)} m)`, loose);

    // Each page only sends poses while it's stepped, and the other shows them a little behind.
    const settle = async () => {
      await step(30);
      await gStep(30);
      await step(30);
    };

    // Host walks; the guest sees them arrive.
    const before = (await state()).player;
    await run({ keys: ['KeyW'], max: 120 });
    await settle();
    let hostAt = (await state()).player;
    let seen = (await g('room')).remotes.find((r) => r.id === 0);
    const lag = seen ? dist(seen.at, hostAt) : Infinity;
    check(dist(before, hostAt) > 4 && lag < 1, `the guest sees the host walk (${dist(before, hostAt).toFixed(1)} m, off by ${lag.toFixed(2)} m)`, loose);

    // Host drives the purple car; on the guest's screen it follows them.
    await getIn();
    await run({ keys: ['KeyW'], max: 150 });
    await run({ keys: ['KeyS'], max: 300, until: (s) => s.speedKmh < 1 });
    await settle();
    let hostCar = (await state()).cars[0];
    let guestCar = (await gStep(1)).cars[0];
    const remoteCar = (await g('remoteCars'))[0];
    check(remoteCar && dist(hostCar, guestCar) < 1, `the guest sees the host drive the purple car (off by ${dist(hostCar, guestCar).toFixed(2)} m)`, loose);

    await getOut();
    await settle();
    hostCar = (await state()).cars[0];
    guestCar = (await gStep(1)).cars[0];
    const released = !(await g('remoteCars'))[0];
    check(released && dist(hostCar, guestCar) < 1.5, `got out: the car stays where the host parked it on the guest's screen (off by ${dist(hostCar, guestCar).toFixed(2)} m)`, loose);

    // The guest walks; the host sees them.
    const gBefore = (await gStep(1)).player;
    await guest.page.keyboard.down('KeyW');
    await gStep(90);
    await guest.page.keyboard.up('KeyW');
    await gStep(30);
    await step(30);
    const gAt = (await gStep(1)).player;
    seen = (await game('room')).remotes.find((r) => r.id === 1);
    const gLag = seen ? dist(seen.at, gAt) : Infinity;
    check(dist(gBefore, gAt) > 3 && gLag < 1, `the host sees the guest walk (${dist(gBefore, gAt).toFixed(1)} m, off by ${gLag.toFixed(2)} m)`, loose);

    // The guest leaves: the host is a room of one again.
    await g('leaveRoom');
    await page.waitForFunction(() => window.__game.room().members.length === 1, null, { timeout: 5000 }).catch(() => {});
    hostAt = await game('room');
    check(hostAt.members.length === 1 && hostAt.remotes.length === 0, 'the guest leaves and the host is on their own again');

    check(guest.errors.length === 0, `no console errors on the guest's page${guest.errors.length ? ': ' + guest.errors.join(' | ') : ''}`);
    await guest.page.close();
  },
};
