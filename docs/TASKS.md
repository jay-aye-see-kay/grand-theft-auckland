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
- [ ] **T2 Terrain.** Depends on T1.
  - Generate per-chunk heightfields at 2 m resolution (render mesh +
    Rapier heightfield).
  - Add Auckland loading in the game, with `?map=test` keeping the old
    town.
  - Done when: you can drive the Corolla over real hills with no seams
    between chunks. A smoke check covers this.
- [ ] **T3 Buildings.** Depends on T2.
  - Extrude footprints using the height rules in HANDOVER.md, seated on
    the terrain.
  - Merge them per chunk, with colliders.
  - Done when: the skyline matches a photo of the CBD from the harbour,
    you can't drive through buildings, and the draw-call budget holds.
- [ ] **T4 Roads v1.** Depends on T2.
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

(none yet)
