# Tasks

Each chunk should fit in one session. Tick it with a one-line note when done.

## Status

- Live: https://jay-aye-see-kay.github.io/grand-theft-auckland/ (`?debug` for perf overlay and test hooks).
- Done: tier 1 and the street-level look (see `docs/HISTORY.md`).
- Branches: `main` and the default branch `claude/gta-style-auckland-game-pffg64`
  are identical. Only the default branch deploys, so push both until one is
  retired. `backup/wip` holds unverified landmark work (chunk 1).
- Regenerating the map in a fresh container re-downloads OSM and ~76 MB of LiDAR into `.cache/`.

## Next

- [ ] **1. Land T9a from `backup/wip`.** Three commits, not yet verified: Sky Tower,
  Ferry Building, Chief Post Office and Civic in `src/landmarks/`, plus a smoke fix
  for walking after a camera snap and ramming the CPO wall. Merge into `main`,
  build/sim/smoke, check budgets and colliders, screenshot each landmark.
- [ ] **2. Fast, deterministic smoke.** Add `__game.step(n)` to advance physics
  without real-time waits; move the walk, drive and wall checks onto it. Split
  into a quick core suite and a full suite, with `--only=<area>`.
- [ ] **3. Wall tunnelling.** On a slow runner a car rammed at the CPO ended up
  ~50 m past the wall. Find out if this can happen in game on a slow phone
  (colliders are built asynchronously within ~300 m), and fix (e.g. CCD).
- [ ] **4. Lane lines** stop at junction mouths.
- [ ] **5. Queen St polish:** tone down garish shop window displays; cut ground
  triangles under paving (a lower Queen St view hits 139–155k).
- [ ] **6. Street sanity pass** on Ponsonby Rd, High St and Wynyard.
- [ ] **7. Landmarks: Town Hall, Wynyard silos.**
- [ ] **8. Landmarks: Harbour Bridge backdrop, Rangitoto on the horizon.**
- [ ] **9. Clean junctions.** Time-box `osm2streets-js` first; fall back to our own code.
- [ ] **10. Street furniture:** lamps, bus stops, traffic signals from OSM, instanced.
- [ ] **11. Trees** from DSM − DEM, instanced.
- [ ] **12. Roof colours** sampled from the LINZ aerials.
- [ ] **13. Coast cleanup:** jagged marina pontoon slopes, saw-toothed distant coastline.
- [ ] **14. Minimap** from road data.
- [ ] **Milestone: tier 2 live.** Ask the owner for a phone test.

## Later (tier 3)

- More areas: Ponsonby, Parnell, Grafton, Newmarket, Mt Eden.
- Drivable Harbour Bridge to Devonport; motorways and Spaghetti Junction.
- Volcanic cones (Mt Eden, One Tree Hill) from the LiDAR.
- Incremental citygen (cache per layer) if regeneration gets slow.

## Parked (owner's choice)

- Handling and camera tuning (a `?debug` slider panel would help).
- Tyre smoke, breakable crates, a loading bar.
- Traffic, pedestrians, police, missions.

## Questions for the owner

- **Phone test of what's live:** frame rate driving up Queen St from spawn;
  does street level read as Auckland, and what's most off; Sky Tower visible
  over the rooftops; touch controls, sound and load time; driving off a wharf
  (should splash and reset).
- **Branches:** make `main` the default (Settings → General, and allow it in
  Settings → Environments → github-pages), then delete
  `claude/gta-style-auckland-game-pffg64`? Or keep working on the default branch.
