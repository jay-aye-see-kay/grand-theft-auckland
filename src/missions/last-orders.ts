import { defineMission, type MissionPlayer } from './runtime/mission.ts';
import type { PlaceId } from './runtime/places.ts';

// Co-op, two or more: last orders at two bars at opposite ends of town, Wynyard
// and Parnell, too far apart for one car in the time. Split up, get a jug at
// each, then everyone who got one brings it back to the bar you started at.

const HOME: PlaceId = 'shouts-on-you';
const BARS: PlaceId[] = ['the-salty-sheep', 'the-tipsy-weka'];
/** To both bars, s: about one fast car's worth each, not one car for both. */
const LAST_ORDERS = 100;
/** Back to the start, s. */
const FLAT = 110;

export default defineMission({
  id: 'last-orders',
  title: 'Last Orders',
  blurb: 'Two bars, opposite ends of town, one bell. Split up.',
  players: { min: 2, max: 6 },
  start: HOME,

  async run(m) {
    const home = m.place(HOME);
    const bars = BARS.map(m.place);
    const open = new Set(bars);
    const label = () => `Last orders: one of you to ${[...open].map((b) => b.name).join(', one to ')}`;
    m.say(`Last orders at ${bars[0].name} and ${bars[1].name}. You can't do both. Split up!`, 6);
    const bell = m.timer(LAST_ORDERS, "Time, please! The bars shut and you're all on lemonade.");
    const carriers: MissionPlayer[] = [];
    await Promise.all(bars.map(async (bar) => {
      const who = await m.goTo(bar, { radius: 8, label: label() });
      open.delete(bar);
      if (!carriers.some((c) => c.id === who.id)) carriers.push(who);
      m.say(`${who.name} got a jug in at ${bar.name}.`, 3);
      if (open.size) m.objective(label());
    }));
    bell.stop();

    const names = carriers.map((c) => c.name).join(' and ');
    m.say(carriers.length > 1 ? `Both jugs bought. Now get them back to ${home.name} before they go flat.` : `${names} got both jugs? Greedy. Get them back to ${home.name}.`, 4);
    m.timer(FLAT, 'The jugs went flat. Nobody is drinking that.');
    await m.goTo(home, { radius: 10, everyone: carriers, label: `Bring the jugs back to ${home.name}${carriers.length > 1 ? ', both of them' : ''}` });
    m.succeed(`${names} saved last orders. Shout's on them.`);
  },
});
