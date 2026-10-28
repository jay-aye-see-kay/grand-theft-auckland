// Buildings: loaded with the terrain and seated on it, hand overrides
// (overrides/cbd.json), and the hand-made landmark models (src/landmarks).

/** Landmarks with hand-made models (src/landmarks/index.ts). */
const LANDMARK_MODELS = ['sky-tower', 'ferry-building', 'britomart', 'civic-theatre', 'town-hall', 'sky-world'];

export default {
  name: 'buildings',
  core: false,
  page: 'auckland',
  async run({ page, check, game, state, step }) {
    const s = await state();
    check(s.buildingChunks >= 9, `building chunks loaded near spawn (${s.buildingChunks})`);
    const roofAt = async (x, z) => {
      const p = await game('probe', x, z);
      return p.top === null ? NaN : p.top - p.ground;
    };
    const cpoRoof = await roofAt(-50.3, -20.3);
    check(cpoRoof > 15 && cpoRoof < 25, `Chief Post Office roof ${cpoRoof.toFixed(1)} m above the ground (tagged 20 m)`);

    // Overrides and the general height rules: the Glasshouse is 16 m (OSM:
    // one level, 3.2 m), the PwC Tower's crown tops out under 180 m above
    // sea level (OSM: 200 m), the kiosk by the Sky Tower is low (LiDAR:
    // 80 m) and the Galway St canopy is a slab at verandah height with open
    // space under it.
    const glass = await roofAt(-23, -14);
    const pwc = (await game('probe', -180, -37)).top;
    const kiosk = await roofAt(-454, 414);
    const canopy = await roofAt(-21, 28);
    check(glass > 14 && glass < 18 && pwc > 170 && pwc < 180 && kiosk < 6 && canopy > 3.5 && canopy < 6,
      `overridden heights: Glasshouse ${glass.toFixed(1)} m, PwC crown top ${pwc?.toFixed(0)} m asl, kiosk ${kiosk.toFixed(1)} m, Galway St canopy ${canopy.toFixed(1)} m`);

    // K Road's verandahs are mapped in OSM (building=roof strips): drawn as
    // one verandah over the footpath at shopfront height, not a slab at a
    // guessed height under a second, generated one.
    await game('placePlayer', -895, 1440, 0);
    await step(60);
    const krd = await game('probe', -895, 1447);
    const under = await game('renderHit', [-895, krd.ground + 1, 1447], [0, 1, 0], 10);
    check(krd.top - krd.ground > 3.4 && krd.top - krd.ground < 4.4 && under > 2.3 && under < 3.3,
      `K Road verandah ${(krd.top - krd.ground).toFixed(1)} m over the footpath, first thing overhead ${(under + 1).toFixed(1)} m up`);

    // Street furniture (tools/citygen/furniture.ts): the bus shelter OSM maps
    // at the Durham St stop on Queen St, its roof found by looking down.
    await game('placePlayer', -230, 400, 0);
    await step(30);
    let roof = 0;
    for (let x = -229.5; x <= -221.5; x += 0.5) {
      for (let z = 400; z <= 408; z += 0.5) {
        const g = await game('groundHeight', x, z);
        const hit = await game('renderHit', [x, g + 10, z], [0, -1, 0], 12);
        if (hit !== null && 10 - hit > 2.4 && 10 - hit < 2.8) roof++;
      }
    }
    check(roof > 10, `a bus shelter at the Durham St stop on Queen St (${roof} points under its roof)`);

    // Shapes read from the LiDAR (tools/citygen/roofs.ts, rooftops.ts): a
    // Freemans Bay house's gabled roof rises from eave to ridge, and West
    // Plaza (one OSM outline, LiDAR median 28 m) is a tall tower on a podium.
    // (Heights above sea level: the house is on a slope.)
    const top = async (x, z) => (await game('probe', x, z)).top ?? NaN;
    const ridge = await top(-1433, 823.9);
    const eave = await top(-1436.8, 822.6);
    const plaza = await top(-289, 8.5);
    const podium = await top(-316, 5);
    check(ridge - eave > 1 && plaza - podium > 40,
      `LiDAR roof shapes: house ridge ${(ridge - eave).toFixed(1)} m over its eave side, West Plaza tower ${plaza.toFixed(0)} m asl on a ${podium.toFixed(0)} m podium`);
    const manifest = await page.evaluate(() => fetch('city/cbd/manifest.json').then((r) => r.json()));
    const ids = new Set((manifest.landmarks ?? []).map((l) => l.id));
    check(['sky-tower', 'ferry-building', 'britomart', 'civic-theatre', 'town-hall', 'wynyard-silos'].every((id) => ids.has(id)),
      `landmarks recorded in the manifest (${[...ids].join(', ')})`);

    // Hand-made landmark models: each at its manifest record, replacing the
    // OSM shape, one mesh with a near and a far LOD.
    const loaded = await game('landmarks');
    for (const id of LANDMARK_MODELS) {
      const l = loaded.find((m) => m.id === id);
      const rec = manifest.landmarks.find((m) => m.id === id);
      const off = l ? Math.hypot(l.x - rec.x, l.z - rec.z) : NaN;
      check(!!l && off < 5 && l.replaces && l.triangles.near > l.triangles.far && l.triangles.far > 0 && l.colliders > 0,
        `landmark model ${id} at its manifest position (${l ? `${off.toFixed(1)} m off, ${l.triangles.near}/${l.triangles.far} tris near/far, ${l.colliders} colliders, replaces OSM: ${l.replaces}` : 'missing'})`);
    }
    const tower = loaded.find((m) => m.id === 'sky-tower');
    const towerHeight = tower ? tower.top - tower.base : NaN;
    check(towerHeight > 322 && towerHeight < 334, `Sky Tower model stands ${towerHeight.toFixed(1)} m (328 m to the tip)`);
  },
};
