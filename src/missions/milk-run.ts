import { defineMission } from './runtime/mission.ts';

// The first mission from the brief: milk from a K Road dairy (Open 25 Hours) to the ferry
// in 90 seconds. Downhill all the way, if you take Queen St. In a room it's a
// race: everyone gathers at the dairy and the first to Nan wins.

export default defineMission({
  id: 'milk-run',
  title: 'Milk Run',
  blurb: "Nan's out of milk. Her ferry leaves in 90 seconds.",
  players: { min: 1, max: 6 },
  start: 'k-road-dairy',

  async run(m) {
    const racing = m.players.length > 1;
    if (racing) {
      m.say('One bottle of milk, and everyone wants the credit. First to Nan wins.', 3);
      await m.wait(3);
      for (const n of ['3', '2', '1']) {
        m.say(n, 1);
        await m.wait(1);
      }
      m.say('Go!', 1.5);
    } else m.say("Grab a car. Nan's waiting at the Ferry Building and she won't wait long.");
    const go = m.elapsed;
    const winner = await m.race(m.players, 'ferry-building', { seconds: 90, radius: 10, label: 'Get the milk to Nan at the Ferry Building' });
    if (!winner) return m.fail(racing ? 'The ferry left without any of you. Nan is having black tea.' : 'The ferry left without you. Nan is having black tea.');
    if (racing) m.succeed(`${winner.name} got the milk to Nan in ${(m.elapsed - go).toFixed(0)} seconds. Everyone else buys the next round.`);
    m.succeed(`${(m.elapsed - go).toFixed(0)} seconds flat. Nan says you drive like her late husband.`);
  },
});
