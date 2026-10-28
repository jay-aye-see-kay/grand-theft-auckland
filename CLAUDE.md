# Grand Theft Auckland

GTA III-flavoured driving game set in the real Auckland CBD, in the browser on
phones and desktop. Three.js + Rapier (WASM physics) + TypeScript + Vite,
deployed to GitHub Pages. Goal and data sources: `docs/BRIEF.md`.

**Backlog is GitHub issues** on `jay-aye-see-kay/grand-theft-auckland`
(labels: `next`, `later`, `parked`, `needs-owner`, `blocked`, plus areas). Read
the issue you're working on, leave short progress notes there as comments if
you stop partway, and close it with `closes #N` in the commit or PR. Live:
https://jay-aye-see-kay.github.io/grand-theft-auckland/ (`?debug` for perf overlay and test hooks).

## Commands

```sh
npm ci
npm run build   # tsc typecheck + vite build into dist/
npm run sim     # headless car handling report (Node, no browser)
npm run smoke   # after build: core checks in headless Chromium (~30 s)
npm run smoke:full   # every area (a few min); `npm run smoke -- --only=harbour,fly`
npm run dev     # dev server with --host, for phones on the LAN
npm run citygen:build   # regenerate public/city/cbd/ (fetches OSM + LiDAR into .cache/)
npm run citygen:places  # just the gazetteer (places.json), e.g. after editing names or overrides
```

CI (`.github/workflows/deploy.yml`) only builds and deploys from the default
branch; it does not run sim or smoke, so run them before pushing. New features
get a check in an area under `scripts/smoke/areas/` (core ones only if quick).

## Layout

- `src/main.ts`: game loop (fixed 60 Hz physics, render interpolation), enter/exit, HUD, `?debug` hooks
- `src/car.ts` (`TUNING`), `src/corolla.ts` (model, `bake()`), `src/player.ts`, `src/camera.ts`,
  `src/input.ts` (touch/keyboard/gamepad), `src/cheats.ts` (stick-flick codes: ↑↑↓↓←→←→ flies),
  `src/audio.ts` (synthesised), `src/skids.ts`
- `src/sky.ts`, `src/sun.ts`, `src/splash.ts` (title screen with data credits)
- `src/maps/`: `auckland.ts` (default) and `test-town.ts` (`?map=test`)
- `src/missions/`: one file per mission (`defineMission`, picked up by `import.meta.glob`).
  `runtime/`: `mission.ts` (the script API), `runner.ts` (runs scripts in game time, solo
  for now, shaped for a room host per #27), `places.ts` (the gazetteer: `places.json` ids,
  typechecked, plus `nearest`/`random` by kind), `markers.ts` (start rings, goal beam),
  `hud.ts` (banner, timer, arrow). To add a mission: pick places from
  `public/city/cbd/places.json` or `__game.places('bar', { near: [x, z], within: 200 })`
  (pin a nicer id or name with `place` in the overrides), write the file, and play it
  through by teleporting in `scripts/smoke/areas/missions.mjs`.
- `src/city/`: chunk streaming (`streamer.ts`), one merged mesh per chunk (`chunk-mesh.ts`),
  terrain, buildings, facade atlas, skyline LOD, water
- `tools/citygen/`: offline generator. OSM + LINZ LiDAR → projected (origin Britomart) →
  terrain, buildings, roads, ground, piers, sea walls, parking → `public/city/cbd/` (committed,
  deterministic). Hand fixes in `overrides/cbd.json` keyed by OSM id (see `overrides/README.md`).
  Buildings: `roofs.ts` (pitched roofs fitted to the DSM), `rooftops.ts` (towers on podiums,
  rooftop plant), `eras.ts` (facade family, colours and cornices per architectural era).
  Places: `places.ts` (OSM POIs → `places.json`, marker on the kerb outside), `names.ts` (parody
  names: brand table, hand-written lists per kind, templates; no real business name may leak).
  Parks: `ground.ts` (land use, park paths, canopy cover: shade near, canopy tint far), `trees.ts` (OSM trees plus
  LiDAR treetops on green ground and tree-shaped ones over footpaths), `barriers.ts` (park edges: walls, fences,
  hedges, retaining walls, and a default low hedge where a park meets a footpath).
- `scripts/smoke/` (Playwright: `run.mjs`, one file per area), `scripts/sim-car.ts`

## Conventions

- TypeScript with `erasableSyntaxOnly`: no enums, no constructor parameter
  properties. Relative imports keep the `.ts` extension so the same files run
  in Node via `--experimental-strip-types`.
- Import `@dimforge/rapier3d-compat`; `vite.config.ts` aliases it to
  `@dimforge/rapier3d` for the browser. `RAPIER.init` exists only on compat,
  so call `init?.()`.
- **Axes:** +y up. Cars and player face local +x; forward is
  `(cos h, 0, -sin h)`; local +z is the right-hand side. North is -z.
- **NZ:** drive on the left; right-hand drive, so you get out on the right.
- **Physics step order:** `car.update()` → `player.update()` → `world.step()` → `afterStep()`.
- **No real brand names or logos** in game text (GTA parody). "Corolla" only in identifiers.
- Comments explain *why*. Small modules, one class per concern.

## Phone budget

Measured at `__game.view('spawn' | 'queen-st' | 'aerial')` with `?debug`
(`__game.state()`, `__game.breakdown()`). `smoke:full` fails past:

| View | Triangles | Draw calls |
|---|---|---|
| Street (`spawn`, `queen-st`) | < 150k | < 60 |
| Aerial | < 300k | < 100 |

Street view is ~146k / ~52 today (a visible mission marker is one call). Each chunk is one draw call: put new static
geometry into `ChunkMesh` (vertex colours, shared materials/atlas), not new
meshes. Small building detail goes in `MeshBuilder.detail()`: near-only
(within 250 m: verandahs, parapets) or fine (120 m: cornices, plant, eaves).
Trees and park edges are grouped by 50 m tile in the building chunks
(`MeshBuilder.group`) and drawn only within `TREE_DRAW` (200 m). Bake
multi-part models, instance repeated props, LOD by distance, blob
shadows only. 2 m ground within 90 m, 10 m beyond; colliders within ~300 m.

## Gotchas

- **Ground collision:** never one giant thin cuboid (the character controller
  sinks). Use heightfields or tiles ≤ 120 m.
- **Draped geometry** must sit ~1 cm above the collision surface. Roads are
  safe: citygen smooths ground under streets and park paths, and the game
  draws the fine (2 m grid) ground `PAVED_SINK` (5 cm) lower under road strips.
- **Skid marks** are double-sided (strips laid sliding backwards face down).
- **Smoke:** headless Chromium renders in software (~10–20 fps), so checks
  never wait on the clock: `__game.step(n)` pauses real time and runs n fixed
  ticks without drawing (keys held by Playwright still count), and areas
  loop on `run({ keys, max, until })`. Then results repeat exactly; keep it
  that way (`--repeat=3`), and mark checks that read wall-clock numbers
  `{ stable: false }`. Each area starts from `__game.reset()`. Its fps means
  nothing for phones. Tap pulsing buttons with `{ force: true }`.
- **Playwright** is pinned to 1.63.0 to match `/opt/pw-browsers`. Don't run
  `playwright install`.

## Network (Claude cloud sandbox)

- Reachable: OSM API `api.openstreetmap.org/api/0.6/map?bbox=…` (≤ 0.25 deg²,
  50k nodes per call), LINZ S3 (`nz-elevation`, `nz-imagery`), npm, PyPI.
- Blocked: Overpass, Geofabrik.

## Attribution

Title screen and README must credit "© OpenStreetMap contributors" (ODbL) and
"Contains data sourced from the LINZ Data Service, CC BY 4.0".
