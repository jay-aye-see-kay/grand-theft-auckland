// Missions (src/missions/) and the gazetteer they name places from
// (public/city/cbd/places.json): the places missions use are on open ground,
// start markers start them, and each mission can be played through by teleporting to its
// objectives, passed and failed. The fake player here is the template for
// checking a new mission without playing it.

import { AT_WALL, ram } from './walls.mjs';

export default {
  name: 'missions',
  core: false,
  page: 'auckland',
  async run(t) {
    const { check, game, state, step, run, getIn, getOut, shot, page } = t;
    const missions = () => game('missions');
    /** Steps until the mission ends (or `max` ticks): how it ended. */
    const finish = async (max) => {
      for (let n = 0; n < max; n += 30) {
        await step(30);
        const m = await missions();
        if (!m.active) return m;
      }
      return missions();
    };
    // The gazetteer: parody names for businesses, real ones for landmarks, and kinds to ask for.
    const all = await game('places');
    const place = (id) => game('place', id);
    const dairy = await place('k-road-dairy');
    const ferry = await place('ferry-building');
    check(all.length > 1000 && dairy?.name === 'Open 25 Hours' && ferry?.name === 'the Ferry Building', `${all.length} places; the milk run goes from ${dairy?.name} to ${ferry?.name}`);
    const kRoadBars = await game('places', 'bar', { near: [dairy.x, dairy.z], within: 300 });
    check(kRoadBars.some((p) => p.id === 'sharona') && kRoadBars.every((p) => p.kind === 'bar'), `bars near the K Road dairy, nearest first: ${kRoadBars.slice(0, 3).map((p) => p.name).join(', ')}`);
    const tower = await place('sky-tower');
    check(tower.name === 'the High Tower' && (await place('casino')).name === 'High City Casino', `${tower.name}, and ${(await place('casino')).name} next door`);

    // Places the missions use, and the hand-picked ones beside them, sit on open ground: not inside or on a building.
    const used = ['britomart-plaza', 'town-hall', 'lower-queen-st', 'k-road-dairy', 'ferry-building', 'sky-tower', 'albert-st', 'mid-queen-st', 'sharona', 'casino', 'shouts-on-you', 'the-salty-sheep', 'the-tipsy-weka'];
    const bad = [];
    for (const id of used) {
      const p = await place(id);
      const g = await game('probe', p.x, p.z);
      if (!g.surface || (g.top !== null && g.top - g.ground > 0.5)) bad.push(`${p.id} (${g.surface}, top ${g.top?.toFixed(1)} over ${g.ground.toFixed(1)})`);
    }
    check(bad.length === 0, `all ${used.length} mission places are on open ground${bad.length ? ': ' + bad.join(', ') : ''}`);
    await game('reset');

    // At the spawn on Queen St, the Sky Tower sprint up the road is the nearest mission.
    let m = await missions();
    const solo = m.missions.filter((x) => x.id !== 'last-orders');
    check(solo.length >= 3 && m.starts.length === solo.length, `${m.missions.length} missions, a start marker for each but Last Orders (two or more) when alone: ${m.starts.map((x) => x.id).join(', ')}`);
    check(m.nearest?.id === 'sky-tower-sprint' && !m.active, `nearest to the spawn is ${m.nearest?.id}, nothing running`);

    // Near a marker, the hint names its mission.
    const pav = await place('britomart-plaza');
    await game('placePlayer', pav.x + 12, pav.z, Math.PI);
    await step(2);
    m = await missions();
    check(m.nearest?.id === 'pavlova' && /Handle With Care/.test(m.hint), `the hint by the pavlova's marker names it ("${m.hint}")`);
    await shot('20-mission-marker');

    // Pavlova: walk into the marker, get in, crack it on a wall, deliver it.
    await game('placePlayer', pav.x + 5, pav.z, Math.PI);
    await run({ keys: ['KeyW'], max: 150 });
    m = await missions();
    check(m.active === 'pavlova' && m.banner?.kind === 'start', `walking into the marker starts the pavlova (${m.active}, "${m.banner?.title}")`);
    check(/Get in a car/.test(m.objective), `first objective: "${m.objective}"`);
    await shot('21-mission-title-card');
    await getIn();
    await step(30);
    m = await missions();
    check(m.target?.label === 'the Town Hall' && m.clock?.down, `in the car: off to ${m.target?.label}, ${m.clock?.seconds.toFixed(0)} s on the clock`);
    await step(150);
    await shot('22-mission-goal-beam');
    await game('teleportCar', 0, -3, -32, AT_WALL);
    await step(36);
    await ram(t, ['KeyW'], 900, ({ last, peak }) => peak > 15 && last.speedKmh < 3);
    m = await missions();
    check(m.said.some((x) => /Crack!/.test(x)) && m.active === 'pavlova', `ramming a wall cracks the pav (${m.objective})`);
    const hall = await place('town-hall');
    await game('teleportCar', 0, hall.x, hall.z, Math.PI / 2);
    m = await finish(120);
    check(m.last?.id === 'pavlova' && m.last.result === 'passed', `delivered to the Town Hall: ${m.last?.result} ("${m.last?.message}")`);
    await shot('23-mission-passed');

    // Getting out with the pav fails it.
    const queen = await place('lower-queen-st');
    await game('teleportCar', 0, queen.x, queen.z, 0);
    await step(30);
    await game('startMission', 'pavlova');
    await step(30);
    await getOut();
    m = await finish(60);
    check(m.last?.result === 'failed' && /seagulls/.test(m.last.message), `getting out with the pav fails (${m.last?.message})`);

    // Milk run: K Road to the Ferry Building against the clock.
    await game('reset');
    await game('placePlayer', dairy.x, dairy.z, 0);
    await step(30);
    m = await missions();
    check(m.active === 'milk-run' && m.clock?.down && m.clock.seconds > 85, `stepping on the K Road marker starts the milk run (${m.clock?.seconds.toFixed(0)} s left)`);
    await step(240);
    await shot('24-milk-run-arrow');
    await game('placePlayer', ferry.x, ferry.z, 0);
    m = await finish(120);
    check(m.last?.id === 'milk-run' && m.last.result === 'passed', `milk delivered to the ferry: ${m.last?.result} ("${m.last?.message}")`);
    // Stood still, the ferry leaves.
    await game('placePlayer', dairy.x, dairy.z + 30, 0);
    await game('startMission', 'milk-run');
    m = await finish(60 * 95);
    check(m.last?.result === 'failed' && /ferry left/.test(m.last.message), `the ferry leaves after 90 s (${m.last?.message})`);
    await shot('25-mission-failed');

    // High Tower Sprint: needs a car; checkpoints in order, then a best time.
    await game('reset');
    await game('placePlayer', tower.x, tower.z, 0);
    await step(30);
    m = await missions();
    check(!m.active && /bring a car/.test(m.hint), `on foot, the sprint waits for a car ("${m.hint}")`);
    await getIn();
    await game('teleportCar', 0, tower.x, tower.z, 0);
    await step(30);
    m = await missions();
    check(m.active === 'sky-tower-sprint', `driving onto the marker starts the sprint (${m.active})`);
    await step(60 * 4); // 3, 2, 1, go
    let order = [];
    for (let i = 0; i < 4; i++) {
      m = await missions();
      order.push(m.target?.label);
      if (!m.target) break;
      if (i === 1) await shot('26-sprint-checkpoint');
      await game('teleportCar', 0, m.target.x, m.target.z, 0);
      await step(60 * 5);
    }
    m = await finish(60);
    check(m.last?.id === 'sky-tower-sprint' && m.last.result === 'passed' && /new best/i.test(m.last.message), `sprint through ${order.join(' → ')}: ${m.last?.result} ("${m.last?.message}")`);

    check((await state()).started, 'still running after the missions');
  },
};
