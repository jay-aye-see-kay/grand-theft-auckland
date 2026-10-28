// Trees (tools/citygen/trees.ts): a big tree on Albert Park's lawn, found in
// the LiDAR, has a crown drawn over it and a trunk the car can't drive through.

/** The tree, ~19 m tall, with open lawn west of it. */
const TREE = [-46.6, 638.4];

export default {
  name: 'trees',
  core: false,
  page: 'auckland',
  async run(t) {
    const { check, game, step, run, getIn, shot } = t;
    const [x, z] = TREE;
    // Seen from above: the crown, well over head height.
    await game('lookFrom', [x - 30, 80, z - 30], [x, 60, z]);
    await run({ max: 30 });
    const { ground } = await game('probe', x, z);
    const hit = await game('renderHit', [x, ground + 40, z], [0, -1, 0], 40);
    const top = hit === null ? null : 40 - hit;
    await game('lookFrom', null, [0, 0, 0]);
    check(top !== null && top > 10, `Albert Park tree has a crown (${top === null ? 'nothing drawn' : `${top.toFixed(1)} m up`})`);

    // Drive east at the trunk from 25 m out (heading 0 faces +x).
    check((await getIn()).mode === 'car', 'gets in to ram the tree');
    await game('teleportCar', 0, x - 25, z, 0);
    await step(36);
    let furthest = -Infinity;
    let peak = 0;
    const { s } = await run({
      keys: ['KeyW'],
      max: 600,
      sample: (last) => {
        furthest = Math.max(furthest, last.cars[0][0]);
        peak = Math.max(peak, last.speedKmh);
      },
      until: (last) => peak > 15 && last.speedKmh < 3,
    });
    await shot('trees-car-at-trunk');
    // Chassis half-length is 2.1 m: its centre stops about that far short of the trunk.
    check(peak > 15 && furthest < x - 1, `car can't drive through a tree (hit at ${peak.toFixed(0)} km/h, centre stopped ${(x - furthest).toFixed(2)} m short)`);
    check(s.speedKmh < 5, `car stops at the tree (${s.speedKmh.toFixed(1)} km/h)`);
  },
};
