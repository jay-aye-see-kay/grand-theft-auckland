// Harbour: water at sea level over a deep harbour floor, Queens Wharf's deck
// (dropped by the LiDAR, laid back from OSM), and the car and the player go
// off the end of it, splash, and are put back on dry land.

export default {
  name: 'harbour',
  core: false,
  page: 'auckland',
  async run({ check, game, state, step, run, getIn, getOut, shot }) {
    let s = await state();
    const sea = await game('probe', -101.3, -401.7);
    check(s.water === 0 && sea.ground < -4 && sea.top < 0, `harbour water at sea level (${s.water} m) over the harbour floor (${sea.ground.toFixed(1)} m)`);
    const deck = await game('probe', 20.3, -250.3);
    check(deck.ground > 2 && deck.ground < 4.5, `Queens Wharf deck at ${deck.ground.toFixed(1)} m`);

    const dryLand = async (pos) => {
      const p = await game('probe', pos[0], pos[2]);
      return p.ground > 0.4 && Math.abs(pos[1] - p.ground) < 1.5 ? p : null;
    };
    /** Steps until out of the water and on dry land: where, and the ticks it took. */
    const ashore = async (who, max) => {
      for (let ticks = 0; ticks < max; ticks += 15) {
        s = await step(15);
        const land = s.soaked ? null : await dryLand(who(s));
        if (land) return { land, ticks };
      }
      return { land: null, ticks: max };
    };

    // On Queens Wharf, north of Shed 10, facing east: 32 m of open deck to the edge.
    await getIn();
    await game('teleportCar', 0, 5, -250, 0);
    const before = (await step(36)).splashes;
    ({ s } = await run({ keys: ['KeyW'], max: 1500, until: (x) => x.splashes > before }));
    const splashed = s.splashes > before;
    await shot('13-car-splash');
    const car = splashed ? await ashore((x) => x.cars[0], 900) : { land: null, ticks: 0 };
    check(splashed && s.mode === 'car', `car driven off Queens Wharf splashes into the harbour (${s.splashes - before} splash, ${s.mode})`);
    check(car.land?.surface === 'road', `car is back on a road ${(car.ticks / 60).toFixed(1)} s later (${s.cars[0].map((v) => v.toFixed(0)).join(', ')}, ${car.land?.surface})`);
    await shot('14-car-back-on-land');

    // On foot: sprint off the same wharf.
    await getOut();
    await game('placePlayer', 22, -250, 0);
    const before2 = (await step(24)).splashes;
    ({ s } = await run({ keys: ['KeyW', 'ShiftLeft'], max: 1200, until: (x) => x.splashes > before2 }));
    const wet = s.splashes > before2;
    const back = wet ? await ashore((x) => x.player, 600) : { land: null };
    check(wet && !!back.land, `player who walks off the wharf splashes and is back ashore (${s.player.map((v) => v.toFixed(0)).join(', ')}, ground ${back.land?.ground.toFixed(1)})`);
  },
};
