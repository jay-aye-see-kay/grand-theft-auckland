import { defineMission } from './runtime/mission.ts';
import { place } from './runtime/places.ts';

// Deliver Aunty's pavlova to the Town Hall. Three knocks and it's an Eton
// mess; get out of the car and the seagulls have it.

/** A knock this hard (sudden change of speed, m/s) cracks the meringue. */
const CRACK = 5;
/** One crash scrapes along for a while: one crack per this long, s. */
const COOLDOWN = 1;
const CRACKS = 3;

export default defineMission({
  id: 'pavlova',
  title: 'Handle With Care',
  blurb: "Aunty's pavlova. The Town Hall. Don't you dare crack it.",
  start: place('britomart-plaza'),

  async run(m) {
    await m.waitFor(() => m.player.driving, 'Get in a car. Gently.');
    m.say('Aunty made this pav with her own two hands. Get it to the Town Hall in one piece.');
    m.failIf(() => !m.player.driving, 'You left the pav on the back seat. The seagulls got it.');
    let cracks = 0;
    let lastCrack = -Infinity;
    m.onCrash((strength) => {
      if (strength < CRACK || m.elapsed - lastCrack < COOLDOWN) return;
      cracks++;
      lastCrack = m.elapsed;
      if (cracks >= CRACKS) m.fail("That's not a pavlova any more, that's an Eton mess.");
      m.say(cracks === 1 ? 'Crack! Steady on.' : 'Another crack! One more and Aunty will hear about it.', 3);
      m.objective(`Get the pav to the Town Hall (${'🍰'.repeat(CRACKS - cracks)} left)`);
    });
    m.timer(150, 'The Town Hall do started without dessert.');
    await m.goTo(place('town-hall'), { radius: 10, inCar: true, label: `Get the pav to the Town Hall (${'🍰'.repeat(CRACKS)} left)` });
    m.succeed(cracks ? `Only ${cracks === 1 ? 'one crack' : 'two cracks'}. Nobody will notice under the cream.` : 'Not a crack on it. Aunty is speechless.');
  },
});
