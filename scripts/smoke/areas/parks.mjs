// Parks (tools/citygen/barriers.ts, trees.ts): shade under a tree's crown,
// a street tree on Symonds St that only the LiDAR knows about, the low
// hedge along Albert Park's footpath, and a mapped wall the player can't
// walk through.

/** Albert Park's big lawn tree (see trees.mjs), and open lawn west of it. */
const TREE = [-46.6, 638.4];
const LAWN = [-66.6, 638.4];
/** A LiDAR-only street tree on Symonds St's footpath. */
const SYMONDS = [104.55, 965.53];
/** Albert Park's default edging along Wellesley St E: a point on it and the way it runs. */
const EDGING = [-49.56, 537.41];
const EDGING_DIR = [-0.934, 0.356];
/** A mapped garden wall in Grafton, 108 m long and straight, from A to B. */
const WALL = [[-362.91, 1595.41], [-277.89, 1661.87]];

export default {
  name: 'parks',
  core: false,
  page: 'auckland',
  async run(t) {
    const { check, game, run, step, shot } = t;
    /** Points the streamer's focus at (x, z) from above so its chunk and tiles load, then returns the ground there. */
    const look = async ([x, z]) => {
      await game('lookFrom', [x - 30, 80, z - 30], [x, 0, z]);
      await run({ max: 30 });
      return (await game('probe', x, z)).ground;
    };

    await look(TREE);
    const under = (await game('probe', ...TREE)).canopy;
    const open = (await game('probe', ...LAWN)).canopy;
    check(under > 0.9 && open === 0, `the ground is shaded under Albert Park's tree (canopy ${under?.toFixed(2)}) and not on open lawn (${open?.toFixed(2)})`);

    const ys = await look(SYMONDS);
    const hit = await game('renderHit', [SYMONDS[0], ys + 40, SYMONDS[1]], [0, -1, 0], 40);
    const crown = hit === null ? null : 40 - hit;
    check(crown !== null && crown > 8, `a Symonds St street tree from the LiDAR has a crown (${crown === null ? 'nothing drawn' : `${crown.toFixed(1)} m up`})`);

    // Across the edging from either side, low down: something about 3 m off. Over it: nothing.
    const ye = await look(EDGING);
    const [nx, nz] = [-EDGING_DIR[1], EDGING_DIR[0]];
    const across = [];
    for (const s of [1, -1]) {
      const from = [EDGING[0] + nx * s * 3, ye + 0.4, EDGING[1] + nz * s * 3];
      across.push(await game('renderHit', from, [-nx * s, 0, -nz * s], 6));
    }
    const over = await game('renderHit', [EDGING[0] + nx * 3, ye + 1.4, EDGING[1] + nz * 3], [-nx, 0, -nz], 6);
    check(across.every((d) => d !== null && d > 2 && d < 3.5) && over === null,
      `Albert Park has a low hedge along its edge (hit at ${across.map((d) => d?.toFixed(2) ?? 'none').join(' and ')} m, ${over === null ? 'nothing' : `${over.toFixed(2)} m`} over it)`);
    await game('lookFrom', null, [0, 0, 0]);

    // Walk at the middle of the wall, square on, from 5 m out on either side.
    const [a, b] = WALL;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const n = [-u[1], u[0]];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const side = (p) => (p[0] - mid[0]) * n[0] + (p[2] - mid[1]) * n[1];
    for (const s of [1, -1]) {
      // Facing -s * n: heading h faces (cos h, -sin h).
      await game('placePlayer', mid[0] + n[0] * s * 5, mid[1] + n[1] * s * 5, Math.atan2(n[1] * s, -n[0] * s));
      await step(30);
      let closest = Infinity;
      const { s: last } = await run({ keys: ['KeyW'], max: 300, sample: (st) => (closest = Math.min(closest, side(st.player) * s)) });
      check(last.mode === 'foot' && closest > 0.2 && side(last.player) * s > 0, `the player can't walk through a garden wall (side ${s > 0 ? 'A' : 'B'}: closest ${closest.toFixed(2)} m)`);
    }
    await shot('parks-wall');
  },
};
