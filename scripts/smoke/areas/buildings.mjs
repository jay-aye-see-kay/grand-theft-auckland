// Buildings: loaded with the terrain and seated on it, hand overrides
// (overrides/cbd.json), and the hand-made landmark models (src/landmarks).

/** Landmarks with hand-made models (src/landmarks/index.ts). */
const LANDMARK_MODELS = ['sky-tower', 'ferry-building', 'britomart', 'civic-theatre'];

export default {
  name: 'buildings',
  core: false,
  page: 'auckland',
  async run({ page, check, game, state }) {
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
