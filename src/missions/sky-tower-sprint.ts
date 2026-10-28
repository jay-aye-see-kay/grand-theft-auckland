import { defineMission, formatTime } from './runtime/mission.ts';
import { place } from './runtime/places.ts';

// A checkpoint race round the CBD from the foot of the Sky Tower, against
// your own best time on this device.

const CHECKPOINTS = [place('albert-st'), place('lower-queen-st'), place('mid-queen-st'), place('sky-tower')];

export default defineMission({
  id: 'sky-tower-sprint',
  title: 'Sky Tower Sprint',
  blurb: 'Down to the waterfront, up Queen St, back to the Tower. Beat your best.',
  start: place('sky-tower'),
  needsCar: true,

  async run(m) {
    for (const n of ['3', '2', '1']) {
      m.say(n, 1);
      await m.wait(1);
    }
    m.say('Go!', 1.5);
    m.failIf(() => !m.player.driving, 'Out of the car? That rules you out.');
    m.timer(180, 'Too slow. The Tower has been there since 1997, it can wait, but not that long.');
    const watch = m.stopwatch();
    for (const [i, cp] of CHECKPOINTS.entries()) {
      const last = i === CHECKPOINTS.length - 1;
      await m.goTo(cp, { radius: 12, inCar: true, label: last ? 'Back to the Sky Tower' : `Checkpoint ${i + 1} of ${CHECKPOINTS.length - 1}: ${cp.name}` });
      if (!last) m.say(`Checkpoint ${i + 1}: ${formatTime(watch.seconds, true)}`, 2);
    }
    const time = watch.seconds;
    const { best, isNew } = m.record(time);
    m.succeed(isNew ? `${formatTime(time, true)}. A new best!` : `${formatTime(time, true)}. Your best is ${formatTime(best, true)}.`);
  },
});
