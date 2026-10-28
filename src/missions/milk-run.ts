import { defineMission } from './runtime/mission.ts';

// The first mission from the brief: milk from a K Road dairy (Open 25 Hours) to the ferry
// in 90 seconds. Downhill all the way, if you take Queen St.

export default defineMission({
  id: 'milk-run',
  title: 'Milk Run',
  blurb: "Nan's out of milk. Her ferry leaves in 90 seconds.",
  start: 'k-road-dairy',

  async run(m) {
    m.say("Grab a car. Nan's waiting at the Ferry Building and she won't wait long.");
    const winner = await m.race(m.players, 'ferry-building', { seconds: 90, radius: 10, label: 'Get the milk to Nan at the Ferry Building' });
    if (!winner) m.fail('The ferry left without you. Nan is having black tea.');
    m.succeed(`${m.elapsed.toFixed(0)} seconds flat. Nan says you drive like her late husband.`);
  },
});
