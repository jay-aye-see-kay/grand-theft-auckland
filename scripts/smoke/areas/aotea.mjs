// Aotea Square (src/landmarks/aotea-square.ts, town-hall.ts, sky-world.ts):
// the Town Hall's clock tower, the old Metro Centre with MINIMAX and the
// Hard Luck Café, and the Civic car park dug out under the square
// (src/city/cavity.ts): walk on the square over it, drive down the ramp
// from Greys Ave, park underneath with the camera under the ceiling, get
// out and back in down there, and drive back up the ramp into the street.

/** Car park floor and ceiling (aotea-square.ts), and the square above, m above sea level. */
const FLOOR = 16;
const CEIL = 18.6;
/** The end of Greys Ave, below the ramp's mouth, facing north up it. */
const MOUTH = [-509, 972];

export default {
  name: 'aotea',
  core: false,
  page: 'auckland',
  async run(t) {
    const { check, game, step, run, press, getIn, getOut, shot } = t;

    const loaded = await game('landmarks');
    const get = (id) => loaded.find((l) => l.id === id);
    const hall = get('town-hall');
    const world = get('sky-world');
    const square = get('aotea-square');
    check(!!hall && hall.replaces && hall.top > 57 && hall.top < 61,
      `Town Hall model replaces the OSM shape, clock tower to ${hall?.top.toFixed(1)} m above sea level (LiDAR ~59 m)`);
    check(!!world && world.replaces && world.top > 49 && world.top < 54,
      `High World (Sky World) model replaces the OSM shape, cinema box to ${world?.top.toFixed(1)} m above sea level (LiDAR ~51 m)`);
    check(!!square && square.colliders > 20 && square.triangles.near > 1000, `Aotea Square model: ${square?.triangles.near} tris near, ${square?.colliders} colliders`);
    const cafe = await game('places', 'restaurant', { near: [-382, 836], within: 30 });
    check(cafe.some((p) => p.id === 'hard-luck-cafe'), `the Hard Luck Café is in the gazetteer (${cafe.map((p) => p.name).join(', ')})`);

    // Over the car park the ground is the square: walkable, with the floor 4 m below.
    const p = await game('probe', -450, 870);
    check(p.top > 19.5 && Math.abs(p.top - p.ground) < 0.1, `the square over the car park is solid ground (${p.top?.toFixed(2)} m, ground ${p.ground.toFixed(2)} m)`);
    await game('placePlayer', -450, 870, 0);
    const { s: onSquare } = await run({ keys: ['KeyW'], max: 120, every: 20 });
    check(onSquare.player[1] > 19.5 && onSquare.playerGrounded, `walks across the square on top (${onSquare.player.map((v) => v.toFixed(0)).join(', ')})`);
    await game('placePlayer', -455, 880, Math.atan2(-(908 - 880), -414 + 455));
    await step(20);
    await shot('aotea-1-town-hall');

    // Down the ramp from the end of Greys Ave into the car park.
    check((await getIn()).mode === 'car', 'gets in to drive down to the car park');
    await game('teleportCar', 0, MOUTH[0], MOUTH[1], Math.PI / 2);
    await step(30);
    const { s: down } = await run({ keys: ['KeyW'], max: 900, every: 10, until: (x) => x.cars[0][2] < 918 });
    const { s: parked } = await run({ keys: ['Space'], max: 120, every: 10, until: (x) => x.speedKmh < 1 });
    const camHigh = (await game('camera'))[1];
    const car = parked.cars[0];
    check(car[2] < 918 && car[1] < FLOOR + 1.2 && car[1] > FLOOR,
      `drives down the ramp into the car park (${car.map((v) => v.toFixed(0)).join(', ')}, ${down.speedKmh.toFixed(0)} km/h on the way)`);
    check(parked.ground > FLOOR - 0.1 && parked.ground < FLOOR + 0.1, `the ground under the car down there is the car park floor (${parked.ground.toFixed(2)} m)`);
    // The camera follows drawn frames, not ticks: its exact height varies.
    check(camHigh < CEIL - 0.3, `the camera stays under the car park ceiling (${camHigh.toFixed(2)} m, ceiling ${CEIL} m)`, { stable: false });
    await shot('aotea-2-car-park');

    // A minute parked down there: not rescued up onto the square.
    const { s: later } = await run({ max: 300, every: 60 });
    check(later.cars[0][1] < FLOOR + 1.2, `stays in the car park, not rescued (${later.cars[0][1].toFixed(2)} m)`);

    // Out on foot under the square, then back in and back up the ramp.
    const out = await getOut();
    check(out.mode === 'foot' && out.player[1] < FLOOR + 1 && out.player[1] > FLOOR - 0.2, `gets out on the car park floor (${out.player[1].toFixed(2)} m)`);
    check((await press('KeyF')).mode === 'car', 'gets back in down there');
    // From the foot of the ramp, facing up it.
    await game('teleportCar', 0, -509, 918, -Math.PI / 2, FLOOR + 0.5);
    await step(30);
    const { s: up } = await run({ keys: ['KeyW'], max: 900, every: 10, until: (x) => x.cars[0][2] > 966 });
    check(up.cars[0][2] > 966 && up.cars[0][1] > 19, `drives back up the ramp into Greys Ave (${up.cars[0].map((v) => v.toFixed(0)).join(', ')})`);
    await run({ keys: ['Space'], max: 60, every: 10 });
    await shot('aotea-3-ramp');
  },
};
