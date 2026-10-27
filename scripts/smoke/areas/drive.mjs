// Driving on Auckland's real ground: up Queen St's hill, across chunk seams
// without a bump, and hands off the wheel up lower Queen St.

export default {
  name: 'drive',
  core: false,
  page: 'auckland',
  async run(t) {
    const { check, game, state, step, run, getIn, shot, dist } = t;

    // Drive the purple Corolla forward from a spot until `until`, tracking
    // the chassis' clearance above the terrain under it.
    const drive = async (until, max) => {
      await step(36); // settle on the suspension
      const start = await state();
      let minClear = Infinity;
      let maxClear = -Infinity;
      let maxStep = 0;
      let prev = null;
      const { s: last } = await run({
        keys: ['KeyW'],
        max,
        every: 5,
        sample: (x) => {
          const clear = x.cars[0][1] - x.ground;
          minClear = Math.min(minClear, clear);
          maxClear = Math.max(maxClear, clear);
          if (prev !== null) maxStep = Math.max(maxStep, Math.abs(clear - prev));
          prev = clear;
        },
        until: (x) => until(x.cars[0]),
      });
      return { start: start.cars[0], end: last.cars[0], minClear, maxClear, maxStep, kmh: last.speedKmh };
    };

    check((await getIn()).mode === 'car', 'gets in for the hill climb');

    // Upper Queen St towards K Road: ~10% grade, crossing the z = 1376 seam.
    await game('teleportCar', 0, -532, 1268, Math.atan2(-169, -61));
    let r = await drive((p) => p[2] > 1420, 2400);
    const gain = r.end[1] - r.start[1];
    check(gain > 8, `drives uphill on Queen St (+${gain.toFixed(1)} m, ${r.start[2].toFixed(0)} -> ${r.end[2].toFixed(0)} z, ${r.kmh.toFixed(0)} km/h)`);
    check(r.start[2] < 1376 && r.end[2] > 1376, 'crosses a chunk seam going uphill');
    check(r.minClear > 0.2 && r.maxClear < 1.4 && r.maxStep < 0.5, `stays on the terrain uphill (clearance ${r.minClear.toFixed(2)}..${r.maxClear.toFixed(2)} m, worst jump ${r.maxStep.toFixed(2)})`);
    await shot('8-queen-st-hill');

    // Customs St East across the x = 6 seam, east of Britomart.
    await game('teleportCar', 0, -90, 51, Math.atan2(-81, 228));
    r = await drive((p) => p[0] > 70, 2400);
    check(r.start[0] < 6 && r.end[0] > 6, `crosses a chunk seam on the flat (${r.start[0].toFixed(0)} -> ${r.end[0].toFixed(0)} x)`);
    check(r.minClear > 0.2 && r.maxClear < 1.4 && r.maxStep < 0.5, `no seam bump on the flat (clearance ${r.minClear.toFixed(2)}..${r.maxClear.toFixed(2)} m, worst jump ${r.maxStep.toFixed(2)})`);

    // Lower Queen St, gently uphill from near Customs St towards Wellesley
    // St: about 380 m dead straight (heading within a degree), 6.6 m of road
    // between buildings. Hands off the wheel, the car should stay on the
    // asphalt and clear of the shopfronts.
    const A = [-147, 113];
    const B = [-245, 494];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const ux = (B[0] - A[0]) / len;
    const uz = (B[1] - A[1]) / len;
    await game('teleportCar', 0, A[0] + ux * 12, A[1] + uz * 12, Math.atan2(-uz, ux));
    const start = (await step(36)).cars[0];
    let samples = 0;
    let onRoad = 0;
    let maxOff = 0;
    const { s: last } = await run({
      keys: ['KeyW'],
      max: 2400,
      every: 5,
      sample: (x) => {
        const p = x.cars[0];
        maxOff = Math.max(maxOff, Math.abs((p[0] - A[0]) * uz - (p[2] - A[1]) * ux));
        samples++;
        if (x.surface === 'road') onRoad++;
      },
      until: (x) => (x.cars[0][0] - A[0]) * ux + (x.cars[0][2] - A[1]) * uz > len - 40,
    });
    const runM = dist(start, last.cars[0]);
    await shot('11-queen-st-drive');
    check(runM > 100 && last.cars[0][1] > start[1], `drives up lower Queen St (${runM.toFixed(0)} m, +${(last.cars[0][1] - start[1]).toFixed(1)} m, ${last.speedKmh.toFixed(0)} km/h)`);
    check(onRoad / samples > 0.85 && maxOff < 4.5, `stays on Queen St's road (${onRoad}/${samples} samples on road, up to ${maxOff.toFixed(1)} m off the centreline)`);
  },
};
