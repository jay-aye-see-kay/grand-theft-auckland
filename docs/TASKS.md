# Tasks

Live checklist for the Auckland work. Brief and orchestration rules:
`docs/HANDOVER.md`. Tick tasks with a one-line note when they're done
and verified.

## Tier 1: real map, grey box

- [x] **T1 Data fetch and projection.** Done: `npm run citygen:stats`; Britomart 3.6 m,
  Queen/K Rd 65.8 m. API: `loadCityData()` (fetch.ts), `lonLatToLocal`, `sampleLocal`, `wayLocal`.
  - Build `tools/citygen/fetch.ts` and `project.ts`. Fetch OSM for the CBD
    bbox in tiles, and DEM/DSM windows for the same area.
  - Cache them in `.cache/` (gitignored).
  - Project everything to local metres, with the origin at Britomart.
  - Done when: a script prints counts of buildings, roads and heights for
    the bbox, plus the ground elevation at Britomart and at the
    Queen St / K Road corner. Sanity check: Britomart should be near sea
    level and K Road somewhere around 60–80 m. If not, the projection or
    the DEM window is wrong.
- [x] **T2 Terrain.** Done: 90 chunks, 1 MB total in `public/city/cbd/`, harbour flat at -2 m
  until T7. Add layers as `<layer>/<i>_<j>.*` listed in chunk `files`, loaded in
  `src/city/streamer.ts`. Aerial views hit 73 draw calls already.
  - Generate per-chunk heightfields at 2 m resolution (render mesh +
    Rapier heightfield).
  - Add Auckland loading in the game, with `?map=test` keeping the old
    town.
  - Done when: you can drive the Corolla over real hills with no seams
    between chunks. A smoke check covers this.
- [x] **T3 Buildings.** Done: 2486 outlines + 367 parts, 1 draw call per chunk, 493 KB total.
  Skyline reads right (Sky Tower parts from OSM). Glitches for T6: w1173588444 (PwC crown 200 m),
  w766845442 (height=1), w464644562 (80 m kiosk from LiDAR), r12738128 (car park at 9 m),
  w24252617 (Glasshouse 3.2 m). Far chunks (e.g. Sky Tower from the harbour) need T13.
  - Extrude footprints using the height rules in HANDOVER.md, seated on
    the terrain.
  - Merge them per chunk, with colliders.
  - Done when: the skyline matches a photo of the CBD from the harbour,
    you can't drive through buildings, and the draw-call budget holds.
- [x] **T4 Roads v1.** Done: roads/footpaths/flush kerbs draped on terrain (1 MB, 452k tris),
  land-use ground tint. `probe(x,z).surface` in debug. T6 glitches: CMJ flyover ramps flat
  (w119020515, w620912278), speckle by K Rd bridge (w8371382), lower Queen St at Britomart is
  pedestrian paving (w51185933, w1250664764). Kerbside parking: lower Queen St (-147,113)→(-245,494).
  - Road, footpath and kerb polygons from OSM centrelines, draped on the
    terrain, with filtered highway classes.
  - Done when: Queen St, Customs St, Albert St and K Road are driveable
    and line up with the buildings.
- [ ] **T5 Spawn, parked cars and play.** Depends on T3 and T4.
  - Spawn at Britomart with the purple Corolla.
  - Park the other Corollas on real streets.
  - Update the smoke test for the Auckland map.
  - Done when: all smoke checks pass on the Auckland map.
- [ ] **T6 Overrides.**
  - `overrides/cbd.json` keyed by OSM ID: delete, height, landmark and
    block.
  - Use it to fix the worst five glitches found in T3–T5.
- [ ] **T7 Water.**
  - Harbour plane, coastline and wharf edges. The car should splash and
    reset, not fall forever.
- [ ] **T7b Performance pass.** Roads alone are 452k triangles and headless fps fell to
  about 11. Simplify road strips (fewer samples on straight flat runs, merge footpath
  and kerb), check triangle counts per view, add a `?debug` tris counter, and keep a
  phone-class budget (aim < 300k triangles in view, < 100 draw calls). Smoke check it.
- [ ] **T8 Attribution.** OSM and LINZ credits on the title screen.
- [ ] **Milestone: tier 1 live.** Add a phone test list to Questions, then carry on.

## Tier 2: recognisably Auckland

- [ ] **T9 Landmarks:**
  - Sky Tower
  - Ferry Building
  - Britomart
  - Civic Theatre
  - Town Hall
  - Wynyard silos
  - Harbour Bridge (backdrop)
  - Rangitoto (skyline)
- [ ] **T10 Road geometry v2:** lane markings, clean junctions, crossings,
  traffic lights from OSM. Try `osm2streets-js` first.
- [ ] **T11 Facades:**
  - window grids from levels, shopfronts on retail streets
  - verandahs on Queen St, K Road and High St
  - roof colours sampled from the aerial photos
- [ ] **T12 Street furniture and trees:** lamps, bus stops and signals from
  OSM; trees from DSM minus DEM. Use instancing.
- [ ] **T13 Chunk streaming and a low-poly skyline for distant views.**
- [ ] **T14 Minimap from road data.**
- [ ] **Milestone: tier 2 live.** Add a phone test list to Questions, then carry on.

## Tier 3: stretch

After tier 3, add the next most valuable tasks here and keep going.

- [ ] More areas: Ponsonby, Parnell, Grafton, Newmarket, Mt Eden.
- [ ] Drivable Harbour Bridge to Devonport; motorways and Spaghetti Junction.
- [ ] Volcanic cones (Mt Eden, One Tree Hill) from the LiDAR.

## Parked (owner chose not to now)

- Handling and camera tuning (a `?debug` slider panel would help)
- Tyre smoke and breakable crates
- Traffic, pedestrians, police, missions (roadmap M3–M4)

## Questions for the owner

- **Deploys from `main` are blocked by the `github-pages` environment** (it
  only allows the repo's default branch, `claude/gta-style-auckland-game-pffg64`).
  Workaround in use: every verified push to `main` is also fast-forwarded to
  that branch, which deploys (the workflow deploys only from the default
  branch). To fix: Settings → General → default branch = `main` (and allow
  `main` in Settings → Environments → github-pages if needed). Then the old
  branch can be deleted; nothing else needs changing.
