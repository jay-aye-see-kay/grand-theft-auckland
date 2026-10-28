// The road graph (public/city/cbd/roadgraph.json, src/city/road-graph.ts):
// the drivable network that routing, traffic and police use. Routes between
// far-apart places exist, only ever drive one-ways the right way, run along
// the asphalt, and carry heights that match the ground (and the decks).

export default {
  name: 'roads',
  core: false,
  page: 'auckland',
  async run({ check, game }) {
    const g = await game('roadGraph');
    check(g && g.nodes > 1500 && g.km > 90 && g.mainKm > 60 && g.oneWay > 500 && g.signals > 100,
      `road graph: ${g?.nodes} nodes, ${g?.edges} edges, ${g?.km} km (${g?.mainKm} km where traffic can always drive on), ${g?.oneWay} one-way, ${g?.signals} signals`);

    // Lower Queen St: the nearest road, and its lanes.
    const queen = await game('roadAt', -170, 220);
    check(queen?.name === 'Queen Street' && queen.fw + queen.bw >= 2 && queen.main, `nearest road on lower Queen St: ${queen?.name} (${queen?.highway}, ${queen?.fw}+${queen?.bw} lanes, ${queen?.dist.toFixed(1)} m off)`);

    // The milk run, both ways: one-ways make the two routes differ.
    const dairy = await game('place', 'k-road-dairy');
    const ferry = await game('place', 'ferry-building');
    const straight = Math.hypot(dairy.x - ferry.x, dairy.z - ferry.z);
    const there = await game('route', [dairy.x, dairy.z], [ferry.x, ferry.z]);
    const back = await game('route', [ferry.x, ferry.z], [dairy.x, dairy.z]);
    const streets = (r) => [...new Set(r.legs.map((l) => l.name).filter(Boolean))];
    check(there && there.length > straight && there.length < 1.6 * straight, `K Road dairy to the Ferry Building: ${there?.length.toFixed(0)} m by road (${straight.toFixed(0)} m as the crow flies) via ${there && streets(there).slice(0, 4).join(', ')}, ...`);
    check(back && streets(back).join() !== streets(there).join(), `and back a different way (one-ways): ${back?.length.toFixed(0)} m via ${back && streets(back).slice(0, 4).join(', ')}, ...`);
    const wrong = [...there.legs, ...back.legs].filter((l) => !l.legal);
    check(wrong.length === 0, `every leg drives with the traffic${wrong.length ? `: ${wrong.map((l) => l.name).join(', ')}` : ''}`);

    // Along the way: on the road, and the graph's heights on the ground (or the deck).
    const offRoad = [];
    for (let k = 0; k < there.points.length; k += Math.ceil(there.points.length / 12)) {
      const [x, z] = there.points[k];
      const p = await game('probe', x, z);
      if (p.surface !== 'road' && p.surface !== 'paving') offRoad.push(`${p.surface} at (${x.toFixed(0)}, ${z.toFixed(0)})`);
    }
    check(offRoad.length === 0, `the route runs on the road${offRoad.length ? `, except ${offRoad.join(', ')}` : ''}`);
    // Over the motorway on Upper Queen St's bridge (see the bridges area), where the graph follows the deck.
    const over = await game('route', [-679, 1661], [-731, 1794]);
    check(over?.legs.some((l) => l.bridge), `Upper Queen St over the motorway: ${over?.length.toFixed(0)} m, ${over?.legs.filter((l) => l.bridge).length} legs on the bridge`);
    let worst = { d: 0, at: '' };
    const legs = [...there.legs, ...back.legs].filter((l, k, all) => all.findIndex((m) => m.edge === l.edge) === k).filter((_, k) => k % 6 === 0);
    legs.push(...over.legs.filter((l) => l.bridge));
    for (const l of legs) {
      const [x, y, z] = l.mid;
      const p = await game('probe', x, z);
      const surface = l.bridge ? p.top : p.ground;
      const d = Math.abs(y - surface);
      if (d > worst.d) worst = { d, at: `${l.name || 'unnamed'} (${x.toFixed(0)}, ${z.toFixed(0)})` };
    }
    check(worst.d < 0.2, `graph heights match the ground and decks: worst ${worst.d.toFixed(2)} m${worst.at ? ` on ${worst.at}` : ''}`);
  },
};
