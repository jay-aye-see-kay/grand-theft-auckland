// Browser smoke test: plays the built game in headless Chromium and checks
// that the core actions work. Run `npm run build` first, then:
//   node scripts/smoke.mjs [screenshot-dir]
// Exits non-zero on failure. Screenshots are for humans; the asserts are
// what CI cares about. Frame rate here is meaningless (software WebGL).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const PORT = 4179;
const URL = `http://localhost:${PORT}/?debug`;
const TEST_TOWN = '&map=test';
const shots = process.argv[2] ?? 'smoke-shots';
mkdirSync(shots, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('preview server did not start');
}

const state = (page) => page.evaluate(() => window.__game.state());
const dist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

async function openGame(context, query = '') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL + query);
  await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
  return { page, errors };
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
try {
  await waitForServer();

  // Desktop, keyboard: the core actions on Auckland, then again in the test town.
  for (const [query, tag] of [['', ''], [TEST_TOWN, ' [test town]']]) {
    const shot = (name) => page.screenshot({ path: `${shots}/${tag ? 'test-' : ''}${name}.png` });
    const { page, errors } = await openGame(await browser.newContext({ viewport: { width: 1280, height: 720 } }), query);
    await page.waitForFunction(() => !/Loading/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
    await shot('1-title');
    if (!tag) {
      // Data credits on the title screen (OSM ODbL, LINZ CC BY 4.0), with links.
      const credits = page.locator('#credits');
      const text = (await credits.isVisible()) ? await credits.innerText() : '';
      const links = await credits.locator('a[href^="https://"]').count();
      check(/© OpenStreetMap contributors/.test(text) && /LINZ Data Service/.test(text) && /CC BY 4\.0/.test(text) && links >= 3,
        `title screen credits OSM and LINZ (${links} links)`);
    }
    await page.keyboard.press('KeyX');
    await page.waitForFunction(() => window.__game.state().started, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    let s = await state(page);
    check(s.started && s.mode === 'foot', `starts on foot${tag}`);
    check(s.map === (tag ? 'test' : 'auckland'), `loads the ${s.map} map${tag}`);
    check(s.nearCar, `spawns next to a car${tag}`);
    check(s.audio === 'running', `audio unlocked (${s.audio})${tag}`);
    await shot('2-on-foot');

    // Walk away from the car and back.
    const p0 = s.player;
    // Hold until it has moved (slow CI frames run the sim behind real time),
    // then walk back for as long.
    await page.keyboard.down('KeyD');
    const walkStart = Date.now();
    await page.waitForTimeout(1500);
    await page.waitForFunction(([x, z]) => {
      const p = window.__game.state().player;
      return Math.hypot(p[0] - x, p[2] - z) > 2;
    }, [p0[0], p0[2]], { timeout: 3000 }).catch(() => {});
    await page.keyboard.up('KeyD');
    const walkMs = Date.now() - walkStart;
    s = await state(page);
    check(dist(p0, s.player) > 1.5, `walks (moved ${dist(p0, s.player).toFixed(1)} m)${tag}`);
    const above = s.player[1] - s.ground;
    check(s.playerGrounded && above > -0.1 && above < 0.4, `stays on the ground (y=${s.player[1].toFixed(2)}, ground ${s.ground.toFixed(2)})${tag}`);
    await shot('3-walked');

    // Sample the peak rather than one moment: CI frame timing varies a lot.
    const standY = s.player[1];
    await page.keyboard.press('Space');
    let peakY = standY;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(50);
      peakY = Math.max(peakY, (await state(page)).player[1]);
    }
    check(peakY - standY > 0.4, `jumps (peak +${(peakY - standY).toFixed(2)} m)${tag}`);
    await page.waitForTimeout(600);

    await page.keyboard.down('KeyA');
    // Back until it's in reach of the car again (or as long as it walked away, and a bit).
    await page.waitForTimeout(walkMs / 2);
    await page.waitForFunction(() => window.__game.state().nearCar, null, { timeout: walkMs }).catch(() => {});
    await page.keyboard.up('KeyA');
    s = await state(page);
    check(s.nearCar, `walks back to the car${tag}`);

    // Slow CI frames can eat a key press, so poll and retry.
    for (let tries = 0; tries < 4 && (await state(page)).mode !== 'car'; tries++) {
      await page.keyboard.press('KeyF');
      await page.waitForFunction(() => window.__game.state().mode === 'car', null, { timeout: 2000 }).catch(() => {});
    }
    s = await state(page);
    check(s.mode === 'car' && s.drivingIndex === 0, `gets into the purple Corolla${tag}`);

    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => window.__game.state().speedKmh > 20, null, { timeout: 10000 }).catch(() => {});
    s = await state(page);
    check(s.speedKmh > 15, `drives (${s.speedKmh.toFixed(0)} km/h)${tag}`);
    await page.keyboard.down('KeyA');
    await page.keyboard.down('Space');
    let maxSkid = 0;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(100);
      maxSkid = Math.max(maxSkid, (await state(page)).skid);
    }
    check(maxSkid > 0.25, `handbrake turn slides (max skid ${maxSkid.toFixed(2)})${tag}`);
    await page.waitForTimeout(400);
    await shot('4b-skid-marks');
    const quads = (await state(page)).skidQuads;
    check(quads > 5, `lays skid marks (${quads} quads)${tag}`);
    await shot('4-handbrake');
    await page.keyboard.up('Space');
    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyW');

    // Exit at speed: should brake to a stop and then get out.
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => window.__game.state().mode === 'foot', null, { timeout: 8000 }).catch(() => {});
    s = await state(page);
    check(s.mode === 'foot', `gets out (after braking)${tag}`);
    const car = s.cars[0];
    check(dist(car, s.player) < 3, `steps out beside the car (${dist(car, s.player).toFixed(1)} m)${tag}`);
    await page.waitForTimeout(500);
    await shot('5-got-out');
    check(errors.length === 0, `no console errors${tag}${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await page.context().close(); // two games rendering at once starves the software renderer
  }

  // Auckland terrain, buildings and roads: streaming, real heights, physics matching
  // the data, hill climbing, chunk seams, solid buildings and draw calls.
  {
    const { page, errors } = await openGame(await browser.newContext({ viewport: { width: 1280, height: 720 } }));
    const game = (fn, ...args) => page.evaluate(([f, a]) => window.__game[f](...a), [fn, args]);
    await page.keyboard.press('KeyX');
    await page.waitForTimeout(500);
    let s = await state(page);
    check(s.loaded >= 9 && s.detailed >= 1 && s.failures === 0, `terrain chunks loaded near spawn (${s.loaded}/${s.chunks}, ${s.detailed} detailed)`);

    // LiDAR ground: Britomart is just above sea level, Queen St / K Road ~66 m.
    const britomart = await game('groundHeight', 0, 0);
    check(Math.abs(britomart - 3.6) < 0.4, `Britomart ground ${britomart.toFixed(2)} m (expect ~3.6)`);
    check(Math.abs(s.player[1] - s.ground) < 0.3, `spawns at ground height (feet ${s.player[1].toFixed(2)} m, ground ${s.ground.toFixed(2)})`);

    // Spawn: outside Britomart (the Chief Post Office), in the open (no roof
    // overhead) and off the carriageway, with the purple Corolla parked
    // beside it at the left kerb.
    {
      const sp = await game('probe', s.player[0], s.player[2]);
      const open = sp.top === null || sp.top - sp.ground < 0.5;
      check(open && sp.surface !== 'road' && Math.hypot(s.player[0] + 40, s.player[2]) < 60,
        `spawns in the open outside Britomart (${s.player[0].toFixed(0)}, ${s.player[2].toFixed(0)}, ${sp.surface}, roof ${sp.top === null ? 'none' : (sp.top - sp.ground).toFixed(1) + ' m'})`);
      check(dist(s.player, s.cars[0]) < 3.6, `purple Corolla parked beside the spawn (${dist(s.player, s.cars[0]).toFixed(1)} m)`);
    }

    // Parked cars: posed at the kerb from OSM data (public/city/cbd/parking.json).
    // Each one, once its chunk has streamed in, should sit on its wheels on
    // the road (not hovering, sunk or inside a building) and stay put.
    {
      const parked = await page.evaluate(() => fetch('city/cbd/parking.json').then((r) => r.json()));
      check(parked.cars.length >= 6, `${parked.cars.length} cars parked round the CBD`);
      const bad = [];
      for (const [i, c] of parked.cars.entries()) {
        const here = await game('probe', c.x, c.z);
        // Look at it from the kerb behind: this also keeps its chunk streamed in.
        const fx = Math.cos(c.heading);
        const fz = -Math.sin(c.heading);
        await game('lookFrom', [c.x - fx * 9 - fz * 3, c.y + 3, c.z - fz * 9 + fx * 3], [c.x, c.y - 0.3, c.z]);
        let pose = null;
        let calm = 0;
        const t0 = Date.now();
        // Settled = unfrozen and still for a few samples in a row.
        while (Date.now() - t0 < 15000 && calm < 4) {
          await page.waitForTimeout(150);
          const prev = pose;
          pose = (await game('carPoses'))[i];
          calm = !pose.frozen && prev && Math.hypot(pose.pos[0] - prev.pos[0], pose.pos[1] - prev.pos[1], pose.pos[2] - prev.pos[2]) < 0.01 ? calm + 1 : 0;
        }
        if (i === 7) await page.screenshot({ path: `${shots}/12-parked-on-hill.png` });
        const clear = pose.pos[1] - here.ground;
        const drift = Math.hypot(pose.pos[0] - c.x, pose.pos[2] - c.z);
        const roofed = here.top !== null && here.top - here.ground > 0.5;
        const ok = !pose.frozen && clear > 0.4 && clear < 0.9 && pose.up > 0.97 && drift < 0.5 && !roofed && here.surface !== null && ['road', 'paving'].includes(here.surface);
        if (!ok) bad.push(`${c.osm} ${c.name}: clearance ${clear.toFixed(2)}, up ${pose.up.toFixed(3)}, drift ${drift.toFixed(2)}, ${here.surface}${roofed ? ', under a roof' : ''}${pose.frozen ? ', frozen' : ''}`);
      }
      check(bad.length === 0, `parked cars sit on the road at the kerb (${parked.cars.length - bad.length}/${parked.cars.length})${bad.length ? ': ' + bad.join('; ') : ''}`);
      await game('lookFrom', null, [0, 0, 0]);
      await game('probe', s.player[0], s.player[2]); // back to the spawn's ground
    }

    // Fall-out-of-world rescue: a player or car under the terrain is put back on top.
    for (const [who, index] of [['player', -1], ['car', 1]]) {
      await game('sink', index, 15);
      await page.waitForFunction(([k]) => {
        const g = window.__game;
        const p = k < 0 ? g.state().player : g.state().cars[k];
        return p[1] > g.groundHeight(p[0], p[2]) - 0.5;
      }, [index], { timeout: 10000 }).catch(() => {});
      const st = await state(page);
      const p = index < 0 ? st.player : st.cars[index];
      const ground = await game('groundHeight', p[0], p[2]);
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
    const park = (await game('probe', 221, 283)).surface;
    check(park === 'grass', `Emily Place Reserve is grass (${park})`);

    // Drive the purple Corolla from the current spot towards a target while
    // tracking the chassis' clearance above the terrain under it.
    const drive = async (until, timeoutMs) => {
      await page.waitForTimeout(600); // settle on the suspension
      const start = await state(page);
      let minClear = Infinity;
      let maxClear = -Infinity;
      let maxStep = 0;
      let prev = null;
      let last = start;
      await page.keyboard.down('KeyW');
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await page.waitForTimeout(80);
        last = await state(page);
        const clear = last.cars[0][1] - last.ground;
        minClear = Math.min(minClear, clear);
        maxClear = Math.max(maxClear, clear);
        if (prev !== null) maxStep = Math.max(maxStep, Math.abs(clear - prev));
        prev = clear;
        if (until(last.cars[0])) break;
      }
      await page.keyboard.up('KeyW');
      return { start: start.cars[0], end: last.cars[0], minClear, maxClear, maxStep, kmh: last.speedKmh };
    };

    // Stand right by the purple Corolla's driver's door (right side, +z at
    // heading 0) and press F until we're in: slow CI frames can eat a press.
    {
      const car = (await state(page)).cars[0];
      await game('placePlayer', car[0], car[2] + 1.8, 0);
      for (let tries = 0; tries < 5 && (await state(page)).mode !== 'car'; tries++) {
        await page.waitForTimeout(300);
        await page.keyboard.press('KeyF');
        await page.waitForFunction(() => window.__game.state().mode === 'car', null, { timeout: 1500 }).catch(() => {});
      }
    }
    check((await state(page)).mode === 'car', 'gets in for the hill climb');

    // Upper Queen St towards K Road: ~10% grade, crossing the z = 1376 seam.
    await game('teleportCar', 0, -532, 1268, Math.atan2(-169, -61));
    let r = await drive((p) => p[2] > 1420, 40000);
    const gain = r.end[1] - r.start[1];
    check(gain > 8, `drives uphill on Queen St (+${gain.toFixed(1)} m, ${r.start[2].toFixed(0)} -> ${r.end[2].toFixed(0)} z, ${r.kmh.toFixed(0)} km/h)`);
    check(r.start[2] < 1376 && r.end[2] > 1376, 'crosses a chunk seam going uphill');
    check(r.minClear > 0.2 && r.maxClear < 1.4 && r.maxStep < 0.5, `stays on the terrain uphill (clearance ${r.minClear.toFixed(2)}..${r.maxClear.toFixed(2)} m, worst jump ${r.maxStep.toFixed(2)})`);
    await page.screenshot({ path: `${shots}/8-queen-st-hill.png` });

    // Customs St East across the x = 6 seam, east of Britomart.
    await game('teleportCar', 0, -90, 51, Math.atan2(-81, 228));
    r = await drive((p) => p[0] > 70, 40000);
    check(r.start[0] < 6 && r.end[0] > 6, `crosses a chunk seam on the flat (${r.start[0].toFixed(0)} -> ${r.end[0].toFixed(0)} x)`);
    check(r.minClear > 0.2 && r.maxClear < 1.4 && r.maxStep < 0.5, `no seam bump on the flat (clearance ${r.minClear.toFixed(2)}..${r.maxClear.toFixed(2)} m, worst jump ${r.maxStep.toFixed(2)})`);

    // Lower Queen St, gently uphill from near Customs St towards Wellesley
    // St: about 380 m dead straight (heading within a degree), 6.6 m of road
    // between buildings. Hands off the wheel, the car should stay on the
    // asphalt and clear of the shopfronts.
    {
      const A = [-147, 113];
      const B = [-245, 494];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const ux = (B[0] - A[0]) / len;
      const uz = (B[1] - A[1]) / len;
      await game('teleportCar', 0, A[0] + ux * 12, A[1] + uz * 12, Math.atan2(-uz, ux));
      await page.waitForTimeout(600);
      const start = (await state(page)).cars[0];
      let samples = 0;
      let onRoad = 0;
      let maxOff = 0;
      let last = await state(page);
      await page.keyboard.down('KeyW');
      const t0 = Date.now();
      while (Date.now() - t0 < 40000) {
        await page.waitForTimeout(80);
        last = await state(page);
        const p = last.cars[0];
        maxOff = Math.max(maxOff, Math.abs((p[0] - A[0]) * uz - (p[2] - A[1]) * ux));
        samples++;
        if (last.surface === 'road') onRoad++;
        if ((p[0] - A[0]) * ux + (p[2] - A[1]) * uz > len - 40) break;
      }
      await page.keyboard.up('KeyW');
      const run = dist(start, last.cars[0]);
      await page.screenshot({ path: `${shots}/11-queen-st-drive.png` });
      check(run > 100 && last.cars[0][1] > start[1], `drives up lower Queen St (${run.toFixed(0)} m, +${(last.cars[0][1] - start[1]).toFixed(1)} m, ${last.speedKmh.toFixed(0)} km/h)`);
      check(onRoad / samples > 0.85 && maxOff < 4.5, `stays on Queen St's road (${onRoad}/${samples} samples on road, up to ${maxOff.toFixed(1)} m off the centreline)`);
    }

    // Buildings: loaded with the terrain, seated on it, and solid. The Chief
    // Post Office (Britomart station, tagged 20 m) has a slanted east wall
    // from (-23.4, -43.4) to (-41.2, 8.8), crossing z = -38 at x = -25.2,
    // with open ground east of it. Anything sliding along it moves in x and
    // z, so penetration is measured as distance from the wall's line.
    s = await state(page);
    check(s.buildingChunks >= 9, `building chunks loaded near spawn (${s.buildingChunks})`);
    const cpo = await game('probe', -50.3, -20.3);
    const cpoRoof = cpo.top === null ? NaN : cpo.top - cpo.ground;
    check(cpoRoof > 15 && cpoRoof < 25, `Chief Post Office roof ${cpoRoof.toFixed(1)} m above the ground (tagged 20 m)`);

    // Overrides (overrides/cbd.json) and the general height rules: the
    // Glasshouse is 16 m (OSM: one level, 3.2 m), the PwC Tower's crown tops
    // out under 180 m above sea level (OSM: 200 m), the kiosk by the Sky
    // Tower is low (LiDAR: 80 m) and the Galway St canopy is a slab at
    // verandah height with open space under it.
    {
      const roofAt = async (x, z) => {
        const p = await game('probe', x, z);
        return p.top === null ? NaN : p.top - p.ground;
      };
      const glass = await roofAt(-23, -14);
      const pwc = (await game('probe', -180, -37)).top;
      const kiosk = await roofAt(-454, 414);
      const canopy = await roofAt(-21, 28);
      check(glass > 14 && glass < 18 && pwc > 170 && pwc < 180 && kiosk < 6 && canopy > 3.5 && canopy < 6,
        `overridden heights: Glasshouse ${glass.toFixed(1)} m, PwC crown top ${pwc?.toFixed(0)} m asl, kiosk ${kiosk.toFixed(1)} m, Galway St canopy ${canopy.toFixed(1)} m`);
      const manifest = await page.evaluate(() => fetch('city/cbd/manifest.json').then((r) => r.json()));
      const ids = new Set((manifest.landmarks ?? []).map((l) => l.id));
      check(['sky-tower', 'ferry-building', 'britomart', 'civic-theatre', 'town-hall', 'wynyard-silos'].every((id) => ids.has(id)),
        `landmarks recorded in the manifest (${[...ids].join(', ')})`);
    }
    const WALL = [[-23.4, -43.4], [-41.2, 8.8]];
    const wallLen = Math.hypot(WALL[1][0] - WALL[0][0], WALL[1][1] - WALL[0][1]);
    /** Signed distance from the wall line, positive on the open (east) side. */
    const wallDist = (p) =>
      ((WALL[1][1] - WALL[0][1]) * (p[0] - WALL[0][0]) - (WALL[1][0] - WALL[0][0]) * (p[2] - WALL[0][1])) / wallLen;
    // Holds the keys until `settled` has held for a second (or `ms` runs
    // out): slow CI runners can simulate well under real time.
    const ram = async (keys, ms, settled) => {
      let minD = Infinity;
      let peak = 0;
      let since = null;
      for (const k of keys) await page.keyboard.down(k);
      const t0 = Date.now();
      let last = await state(page);
      while (Date.now() - t0 < ms) {
        await page.waitForTimeout(80);
        last = await state(page);
        const p = last.mode === 'car' ? last.cars[0] : last.player;
        minD = Math.min(minD, wallDist(p));
        peak = Math.max(peak, last.mode === 'car' ? last.speedKmh : 0);
        if (!settled({ last, minD, peak })) since = null;
        else if (since === null) since = Date.now();
        else if (Date.now() - since > 1000) break;
      }
      for (const k of keys) await page.keyboard.up(k);
      return { minD, peak, last };
    };
    await game('teleportCar', 0, -2, -38, Math.PI);
    await page.waitForTimeout(600);
    r = await ram(['KeyW'], 30000, ({ last, peak }) => peak > 15 && last.speedKmh < 3);
    // Chassis half-length is 2.1 m: its centre should stop about that far out.
    check(r.peak > 15 && r.minD > 1, `car can't drive through a building (hit at ${r.peak.toFixed(0)} km/h, centre stopped ${r.minD.toFixed(2)} m from the wall)`);
    check(r.last.speedKmh < 5, `car stops at the wall (${r.last.speedKmh.toFixed(1)} km/h)`);
    await page.screenshot({ path: `${shots}/9-car-at-wall.png` });

    // Park the car out of the way, get out and walk (sprinting) at the same wall.
    await game('teleportCar', 0, 10, -20, 0);
    for (let tries = 0; tries < 4 && (await state(page)).mode !== 'foot'; tries++) {
      await page.keyboard.press('KeyF');
      await page.waitForFunction(() => window.__game.state().mode === 'foot', null, { timeout: 4000 }).catch(() => {});
    }
    await game('placePlayer', -5, -38, Math.PI);
    await page.waitForTimeout(300);
    r = await ram(['KeyW', 'ShiftLeft'], 30000, ({ minD }) => minD < 1.5);
    // Capsule radius is 0.3 m; it should reach the wall and stay outside it.
    check(r.last.mode === 'foot' && r.minD < 1.5 && r.minD > 0.2, `player can't walk through a building (capsule centre got to ${r.minD.toFixed(2)} m from the wall)`);

    // Harbour: water at sea level over a deep harbour floor, Queens Wharf's
    // deck (dropped by the LiDAR, laid back from OSM), and the car and the
    // player go off the end of it, splash, and are put back on dry land.
    {
      s = await state(page);
      const sea = await game('probe', -101.3, -401.7);
      check(s.water === 0 && sea.ground < -4 && sea.top < 0, `harbour water at sea level (${s.water} m) over the harbour floor (${sea.ground.toFixed(1)} m)`);
      const deck = await game('probe', 20.3, -250.3);
      check(deck.ground > 2 && deck.ground < 4.5, `Queens Wharf deck at ${deck.ground.toFixed(1)} m`);

      const dryLand = async (pos) => {
        const p = await game('probe', pos[0], pos[2]);
        return p.ground > 0.4 && Math.abs(pos[1] - p.ground) < 1.5 ? p : null;
      };
      // Into the car (parked by the Chief Post Office after the wall test).
      const car = (await state(page)).cars[0];
      await game('placePlayer', car[0], car[2] + 1.8, 0);
      for (let tries = 0; tries < 5 && (await state(page)).mode !== 'car'; tries++) {
        await page.waitForTimeout(300);
        await page.keyboard.press('KeyF');
        await page.waitForFunction(() => window.__game.state().mode === 'car', null, { timeout: 1500 }).catch(() => {});
      }
      // On Queens Wharf, north of Shed 10, facing east: 32 m of open deck to the edge.
      await game('teleportCar', 0, 5, -250, 0);
      await page.waitForTimeout(600);
      const before = (await state(page)).splashes;
      await page.keyboard.down('KeyW');
      await page.waitForFunction((n) => window.__game.state().splashes > n, before, { timeout: 25000 }).catch(() => {});
      await page.keyboard.up('KeyW');
      s = await state(page);
      const splashed = s.splashes > before;
      await page.screenshot({ path: `${shots}/13-car-splash.png` });
      const t0 = Date.now();
      let back = null;
      while (splashed && Date.now() - t0 < 15000 && !back) {
        await page.waitForTimeout(250);
        s = await state(page);
        if (!s.soaked) back = await dryLand(s.cars[0]);
      }
      check(splashed && s.mode === 'car', `car driven off Queens Wharf splashes into the harbour (${s.splashes - before} splash, ${s.mode})`);
      check(!!back && back.surface === 'road', `car is back on a road ${((Date.now() - t0) / 1000).toFixed(1)} s later (${s.cars[0].map((v) => v.toFixed(0)).join(', ')}, ${back?.surface})`);
      await page.screenshot({ path: `${shots}/14-car-back-on-land.png` });

      // On foot: walk off the same wharf.
      for (let tries = 0; tries < 4 && (await state(page)).mode !== 'foot'; tries++) {
        await page.keyboard.press('KeyF');
        await page.waitForFunction(() => window.__game.state().mode === 'foot', null, { timeout: 4000 }).catch(() => {});
      }
      await game('placePlayer', 22, -250, 0);
      await page.waitForTimeout(400);
      const before2 = (await state(page)).splashes;
      await page.keyboard.down('KeyW');
      await page.keyboard.down('ShiftLeft');
      await page.waitForFunction((n) => window.__game.state().splashes > n, before2, { timeout: 20000 }).catch(() => {});
      await page.keyboard.up('ShiftLeft');
      await page.keyboard.up('KeyW');
      const t1 = Date.now();
      let ashore = null;
      while (Date.now() - t1 < 10000 && !ashore) {
        await page.waitForTimeout(250);
        s = await state(page);
        if (!s.soaked && s.splashes > before2) ashore = await dryLand(s.player);
      }
      check(s.splashes > before2 && !!ashore, `player who walks off the wharf splashes and is back ashore (${s.player.map((v) => v.toFixed(0)).join(', ')}, ground ${ashore?.ground.toFixed(1)})`);
    }

    // Performance budgets (CLAUDE.md "Phone budget"), from the map's fixed
    // views once streaming has settled: triangles and draw calls rendered.
    // Software rendering makes the timings meaningless here; they're logged.
    const budgets = { spawn: { tris: 150000, calls: 60 }, 'queen-st': { tris: 150000, calls: 60 }, aerial: { tris: 300000, calls: 100 } };
    check(JSON.stringify(await game('views')) === JSON.stringify(Object.keys(budgets)), `the map has the budget views (${(await game('views')).join(', ')})`);
    for (const [name, budget] of Object.entries(budgets)) {
      await game('view', name);
      await page.waitForTimeout(1500);
      await page.waitForFunction(() => window.__game.state().inFlight === 0, null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2500);
      s = await state(page);
      check(s.triangles > 1000 && s.triangles < budget.tris && s.drawCalls > 0 && s.drawCalls < budget.calls,
        `budget in the ${name} view: ${(s.triangles / 1000).toFixed(0)}k triangles (< ${budget.tris / 1000}k), ${s.drawCalls} draw calls (< ${budget.calls}); ` +
        `JS ${s.frameMs.toFixed(1)} ms/frame (physics ${s.physicsMs.toFixed(1)}, render ${s.renderMs.toFixed(1)})`);
      if (name === 'spawn') {
        check(s.colliders >= 1 && s.colliders < s.loaded && s.detailed >= 1, `colliders and 2 m ground only near the player (${s.colliders} of ${s.loaded} chunks have colliders, ${s.detailed} have 2 m tiles)`);
        const overlay = await page.locator('#fps').innerText();
        check(/calls/.test(overlay) && /tris/.test(overlay) && /phys/.test(overlay), `?debug overlay shows the budget numbers (${overlay})`);
      }
      await page.screenshot({ path: `${shots}/10-view-${name}.png` });
    }
    await game('lookFrom', null, [0, 0, 0]);
    check(errors.length === 0, `no console errors on terrain${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await page.context().close();
  }

  // Phone, touch.
  {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 915, height: 412 } });
    const { page, errors } = await openGame(ctx);
    await page.tap('#splash');
    await page.waitForTimeout(800);
    const footButtons = await page.locator('.touch .btn:visible').count();
    check((await page.locator('.btn-sprint').isVisible()) && !(await page.locator('.btn-gas').isVisible()), `on-foot touch layout (${footButtons} buttons)`);
    check(await page.locator('.btn-enter.ready').isVisible(), 'enter button lights up near a car');
    await page.screenshot({ path: `${shots}/6-phone-foot.png` });

    // Drag the stick upwards (walk forward).
    const box = await page.locator('.stick').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: cx, y }] });
    const before = (await state(page)).player;
    await touch('touchStart', cy);
    await touch('touchMove', cy - 50);
    const touchStart = Date.now();
    await page.waitForTimeout(1000);
    await page.waitForFunction(([x, z]) => {
      const p = window.__game.state().player;
      return Math.hypot(p[0] - x, p[2] - z) > 1.5;
    }, [before[0], before[2]], { timeout: 3000 }).catch(() => {});
    const touchMs = Date.now() - touchStart;
    await touch('touchEnd');
    const after = (await state(page)).player;
    check(dist(before, after) > 1, `touch stick walks (moved ${dist(before, after).toFixed(1)} m)`);

    // Walk back and get in with the button.
    await touch('touchStart', cy);
    await touch('touchMove', cy + 50);
    await page.waitForTimeout(touchMs);
    await touch('touchEnd');
    await page.locator('.btn-enter').tap({ force: true }); // it pulses, so never "stable"
    await page.waitForFunction(() => window.__game.state().mode === 'car', null, { timeout: 3000 }).catch(() => {});
    const s = await state(page);
    check(s.mode === 'car', 'touch enter button gets in');
    check(await page.locator('.btn-gas').isVisible(), 'driving touch layout');
    await page.screenshot({ path: `${shots}/7-phone-car.png` });
    check(errors.length === 0, `no console errors on phone${errors.length ? ': ' + errors.join(' | ') : ''}`);
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
