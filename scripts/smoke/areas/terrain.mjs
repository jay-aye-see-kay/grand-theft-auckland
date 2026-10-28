// Auckland's ground and streets: streaming, real heights, the spawn, the
// fall-out-of-world rescue, physics matching the data across chunk seams,
// roads, verandahs and parks.

export default {
  name: 'terrain',
  core: false,
  page: 'auckland',
  async run({ check, game, state, step, run, dist }) {
    let s = await state();
    check(s.loaded >= 9 && s.detailed >= 1 && s.failures === 0, `terrain chunks loaded near spawn (${s.loaded}/${s.chunks}, ${s.detailed} detailed)`);
    // Southern hemisphere: the sun is up in the northern half of the sky (north is -z).
    check(s.sun[1] > 0.3 && s.sun[2] < -0.3, `sun is in the northern sky (direction ${s.sun.map((v) => v.toFixed(2)).join(', ')})`);
    // Facade, road and ground textures: one atlas (a texture array) painted at load time.
    check(s.atlasLayers >= 16 && s.textures >= 2, `texture atlas loaded (${s.atlasLayers} layers, ${s.textures} textures on the GPU)`);

    // LiDAR ground: Britomart is just above sea level, Queen St / K Road ~66 m.
    const britomart = await game('groundHeight', 0, 0);
    check(Math.abs(britomart - 3.6) < 0.4, `Britomart ground ${britomart.toFixed(2)} m (expect ~3.6)`);
    check(Math.abs(s.player[1] - s.ground) < 0.3, `spawns at ground height (feet ${s.player[1].toFixed(2)} m, ground ${s.ground.toFixed(2)})`);

    // Spawn: outside Britomart (the Chief Post Office), in the open (no roof
    // overhead) and off the carriageway, with the purple Corolla parked
    // beside it at the left kerb.
    const sp = await game('probe', s.player[0], s.player[2]);
    const open = sp.top === null || sp.top - sp.ground < 0.5;
    check(open && sp.surface !== 'road' && Math.hypot(s.player[0] + 40, s.player[2]) < 60,
      `spawns in the open outside Britomart (${s.player[0].toFixed(0)}, ${s.player[2].toFixed(0)}, ${sp.surface}, roof ${sp.top === null ? 'none' : (sp.top - sp.ground).toFixed(1) + ' m'})`);
    s = await state();
    check(dist(s.player, s.cars[0]) < 3.6, `purple Corolla parked beside the spawn (${dist(s.player, s.cars[0]).toFixed(1)} m)`);

    // Fall-out-of-world rescue: a player or car under the terrain is put back on top.
    for (const [who, index] of [['player', -1], ['car', 1]]) {
      await game('sink', index, 15);
      let p;
      let ground;
      for (let ticks = 0; ticks < 600; ticks += 6) {
        const x = await step(6);
        p = index < 0 ? x.player : x.cars[index];
        ground = await game('groundHeight', p[0], p[2]);
        if (p[1] > ground - 0.5) break;
      }
      check(p[1] > ground - 0.5, `${who} that falls through the world is put back (y ${p[1].toFixed(1)}, ground ${ground.toFixed(1)})`);
    }
    const kRoad = (await game('probe', -616, 1499)).ground;
    check(kRoad > 60 && kRoad < 72, `Queen St / K Road ground ${kRoad.toFixed(1)} m (expect ~66)`);

    // Physics heightfield vs the sampler, either side of chunk seams (x = 6,
    // z = 126) and round a corner shared by four chunks. Points sit just off
    // the 2 m lattice: Rapier's ray cast can miss a perfectly vertical ray
    // that runs exactly down a heightfield grid line.
    let worst = 0;
    const probes = [[0.3, 0.7], [5.99, 40.7], [6.01, 40.7], [-30.3, 125.99], [-30.3, 126.01], [5.99, 125.99], [6.01, 126.01],
      [-533.3, 1301.7], [-574.1, 1375.9], [-243.9, 876.1], [131.7, -77.9]];
    for (const [x, z] of probes) {
      const { ray, ground } = await game('probe', x, z);
      if (ray === null || Math.abs(ray - ground) > 0.02) console.log(`  probe ${x},${z}: ray ${ray} ground ${ground}`);
      worst = Math.max(worst, ray === null ? Infinity : Math.abs(ray - ground));
    }
    check(worst < 0.02, `physics heightfield matches terrain data (worst ${worst.toFixed(3)} m)`);

    // Roads: the layer streams in with the terrain, and the land use under
    // points on the centrelines of the main streets (OSM way midpoints) is road.
    check(s.roadChunks >= 9, `road chunks loaded near spawn (${s.roadChunks})`);
    const streets = [
      ['Queen St', -229.7, 431.9], ['Queen St (lower)', -180.5, 242.6], ['Customs St East', -28.8, 72.7],
      ['Customs St West', -201.0, 11.6], ['Albert St', -275.8, 107.2], ['K Road', -587.9, 1497.3], ['K Road (west)', -793.9, 1479.1],
    ];
    const offRoad = [];
    for (const [name, x, z] of streets) {
      const { surface } = await game('probe', x, z);
      if (surface !== 'road') offRoad.push(`${name}: ${surface}`);
    }
    check(offRoad.length === 0, `main streets are road (${streets.length - offRoad.length}/${streets.length})${offRoad.length ? ': ' + offRoad.join(', ') : ''}`);

    // Street verandahs along lower Queen St (Customs St to Shortland St):
    // standing on the footpath either side, there's a drawn roof 3-5 m
    // overhead at most points (verandahs have no colliders, so this casts
    // against what's rendered).
    {
      const A = [-147, 113];
      const B = [-180.5, 242.6];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const [ux, uz] = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
      let covered = 0;
      let tried = 0;
      // Look down the street from its middle: chunks draw their small detail only near the focus.
      await game('lookFrom', [-165, 10, 180], [-180, 5, 240]);
      await run({ max: 30 });
      for (const side of [-1, 1]) {
        for (let t = 0.15; t < 0.9; t += 0.1) {
          tried++;
          for (let off = 4.5; off <= 18; off += 1.5) {
            const x = A[0] + (B[0] - A[0]) * t + uz * side * off;
            const z = A[1] + (B[1] - A[1]) * t - ux * side * off;
            const { ground, top } = await game('probe', x, z);
            if (top !== null && top - ground > 0.5) continue; // inside a building
            const hit = await game('renderHit', [x, ground + 1.8, z], [0, 1, 0], 10);
            if (hit !== null && hit > 1.2 && hit < 3.5) {
              covered++;
              break;
            }
          }
        }
      }
      await game('lookFrom', null, [0, 0, 0]);
      check(covered >= tried / 2, `verandahs over lower Queen St's footpaths (${covered}/${tried} points covered)`);
    }
    const park = (await game('probe', 221, 283)).surface;
    check(park === 'grass', `Emily Place Reserve is grass (${park})`);

    // Parks: a path across Albert Park is painted on the ground and drawn as
    // a strip a few cm over it; its flowerbeds are their own surface.
    {
      const [x, z] = [-0.1, 648.0];
      await game('lookFrom', [x - 20, 60, z - 20], [x, 50, z]);
      await run({ max: 30 });
      const { surface, ground } = await game('probe', x, z);
      const hit = await game('renderHit', [x, ground + 1, z], [0, -1, 0], 2);
      const lift = hit === null ? null : 1 - hit;
      await game('lookFrom', null, [0, 0, 0]);
      check(surface === 'path' && lift !== null && lift > 0.005 && lift < 0.12,
        `Albert Park path is a strip over the lawn (${surface}, ${lift === null ? 'nothing drawn' : `${(lift * 100).toFixed(0)} cm up`})`);
      const bed = (await game('probe', 32, 672)).surface;
      check(bed === 'flowerbed', `Albert Park's flowerbeds are flowerbed (${bed})`);
    }
  },
};
