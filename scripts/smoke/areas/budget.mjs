// Performance budgets (CLAUDE.md "Phone budget") from the map's fixed views
// once streaming has settled, and the Sky Tower and far skyline seen over
// the city. These are about drawing, so they run in real time; software
// rendering makes the timings meaningless here, so they're only logged.

export default {
  name: 'budget',
  core: false,
  page: 'auckland',
  async run({ page, check, game, state, shot }) {
    await game('realtime');
    const settle = async () => {
      await page.waitForTimeout(1500);
      await page.waitForFunction(() => window.__game.state().inFlight === 0, null, { timeout: 30000 }).catch(() => {});
    };
    const budgets = { spawn: { tris: 150000, calls: 60 }, 'queen-st': { tris: 150000, calls: 60 }, aerial: { tris: 300000, calls: 100 } };
    const views = await game('views');
    check(JSON.stringify(views) === JSON.stringify(Object.keys(budgets)), `the map has the budget views (${views.join(', ')})`);
    for (const [name, budget] of Object.entries(budgets)) {
      await game('view', name);
      await settle();
      await page.waitForTimeout(2500);
      const s = await state();
      check(s.triangles > 1000 && s.triangles < budget.tris && s.drawCalls > 0 && s.drawCalls < budget.calls,
        `budget in the ${name} view: ${(s.triangles / 1000).toFixed(0)}k triangles (< ${budget.tris / 1000}k), ${s.drawCalls} draw calls (< ${budget.calls}); ` +
        `JS ${s.frameMs.toFixed(1)} ms/frame (physics ${s.physicsMs.toFixed(1)}, render ${s.renderMs.toFixed(1)})`, { stable: false });
      if (name === 'spawn') {
        check(s.colliders >= 1 && s.colliders < s.loaded && s.detailed >= 1,
          `colliders and 2 m ground only near the player (${s.colliders} of ${s.loaded} chunks have colliders, ${s.detailed} have 2 m tiles)`, { stable: false });
        const overlay = await page.locator('#fps').innerText();
        check(/calls/.test(overlay) && /tris/.test(overlay) && /phys/.test(overlay), `?debug overlay shows the budget numbers (${overlay})`, { stable: false });
      }
      await shot(`10-view-${name}`);
    }

    // The Sky Tower over the rooftops: in frame from the spawn view, seen
    // unobstructed from Customs St outside Britomart, and from far out over
    // the harbour, where its own chunk isn't loaded: its far model (always
    // drawn) with the far skyline round it.
    const manifest = await page.evaluate(() => fetch('city/cbd/manifest.json').then((r) => r.json()));
    const tower = manifest.landmarks.find((l) => l.id === 'sky-tower');
    const pod = [tower.x, tower.base + 190, tower.z];
    const sightline = async (from) => {
      const d = pod.map((v, k) => v - from[k]);
      const len = Math.hypot(...d);
      const hit = await game('renderHit', from, d, len + 60);
      return { len, hit, seen: hit !== null && hit > len - 45 };
    };
    await game('view', 'spawn');
    await page.waitForTimeout(500);
    const framed = await game('inView', pod);
    const street = await game('probe', -100, 40);
    const fromStreet = await sightline([-100, street.ground + 1.7, 40]);
    check(framed && fromStreet.seen, `Sky Tower in the spawn view's frame (${framed}) and seen over the rooftops from Customs St (hit at ${fromStreet.hit?.toFixed(0)} of ${fromStreet.len.toFixed(0)} m)`, { stable: false });
    const far = [tower.x, 400, tower.z - 1550];
    await game('lookFrom', far, pod);
    await settle();
    const s = await state();
    const fromFar = await sightline(far);
    const towerLod = (await game('landmarks')).find((l) => l.id === 'sky-tower')?.lod;
    check(s.skylineTris > 1000 && s.skylineDrawn > 0 && towerLod === 'far' && fromFar.seen && (await game('inView', pod)),
      `far skyline and the Sky Tower's far model seen from 1.5 km out (${s.skylineDrawn} of ${s.skylineTris} skyline triangles drawn, tower ${towerLod}, hit at ${fromFar.hit?.toFixed(0)} of ${fromFar.len.toFixed(0)} m)`, { stable: false });
    await shot('15-skyline-far');
    await game('lookFrom', null, [0, 0, 0]);
  },
};
