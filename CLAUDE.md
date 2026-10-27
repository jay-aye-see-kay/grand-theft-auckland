# Grand Theft Auckland: notes for agents

GTA III-flavoured driving game set in Auckland, in the browser on phones and
desktop. Three.js + Rapier (WASM physics) + TypeScript + Vite, deployed to
GitHub Pages. Current work and plan: `docs/HANDOVER.md` and `docs/TASKS.md`.

## Commands

```sh
npm ci
npm run build   # tsc typecheck + vite build into dist/
npm run sim     # headless car handling report (Node, no browser)
npm run smoke   # after build: plays the game in headless Chromium, asserts core actions
npm run dev     # local dev server (--host, so phones on the LAN can connect)
```

A change is not done until `npm run build && npm run sim && npm run smoke`
all pass locally. CI (`.github/workflows/deploy.yml`) only builds and
deploys (from the default branch); by the owner's choice it does not run sim
or smoke, so run them yourself before pushing. When you add a feature,
add a check for it to `scripts/smoke.mjs`.

## Conventions

- TypeScript with `erasableSyntaxOnly`: no enums, no constructor parameter
  properties. Relative imports keep the `.ts` extension (`./car.ts`), so the
  same files run in Node via `--experimental-strip-types`.
- Code imports `@dimforge/rapier3d-compat` (it works in Node for the
  scripts). `vite.config.ts` aliases it to `@dimforge/rapier3d` for the
  browser so the WASM ships as a separate gzipped file. `RAPIER.init` exists
  only on the compat build, so call it as `init?.()`.
- **Axes:** +y is up. Cars and the player face local +x. `heading` rotates
  about +y, so forward is `(cos h, 0, -sin h)` and local +z is the right-hand
  side. North is -z in the test town.
- **NZ:** drive on the left. Cars are right-hand drive, so you get out on the
  right.
- **Physics:** fixed 60 Hz steps with render interpolation (see `main.ts`).
  Order per step: `car.update()` → `player.update()` → `world.step()` →
  `afterStep()`.
- **Phone budget:** measured from the map's three fixed views
  (`__game.view('spawn' | 'queen-st' | 'aerial')` with `?debug`; the overlay
  and `__game.state()` show triangles, draw calls and JS ms, and
  `__game.breakdown()` splits triangles by layer). Smoke fails past these:

  | View | Budget | Measured (T7b) |
  |---|---|---|
  | Street (`spawn`, `queen-st`) | < 150k triangles, < 60 calls | ~110k, 24–39 calls |
  | Aerial | < 300k triangles, < 100 calls | ~117k, ~41 calls |

  Street-view triangles are roughly terrain 55k, buildings 30k, roads 22k,
  cars, player and sky 3k; calls are ~20 chunks plus cars (8 each up close)
  and the player (5). Each chunk is one draw call (`ChunkMesh` merges its
  terrain, roads and buildings), so put new static chunk geometry in that
  mesh (vertex colours, the shared road material, layer 0) rather than new
  meshes; a new material means one more call per visible chunk (~20 at
  street level), so prefer one shared material or texture atlas for all
  chunks. Bake multi-part models (see `bake()` in `corolla.ts`), use
  instancing for repeated props, LOD anything detailed by distance (cars
  drop wheels past 120 m), and no real-time shadow maps (use blob shadows).
  Ground is 2 m only within 90 m (50 m tiles), 10 m beyond; colliders exist
  only within ~300 m.
- **In-game text:** no real brand names or logos (GTA parody rules). "Corolla"
  appears only in code identifiers.
- Comments explain *why*. Match the existing style: small modules, one class
  per concern.

## Gotchas already paid for

- **Ground collision:** never use one giant thin cuboid. Rapier's character
  controller loses precision against it (the player sinks and sticks). Use a
  heightfield, which real terrain needs anyway, or tiles of ≤ 120 m.
- **Pulsing buttons:** Playwright treats them as never "stable", so tap them
  with `{ force: true }`.
- **Smoke test timing:** the headless browser renders in software at about
  20 fps and the sim can fall behind real time. Movement checks use loose
  thresholds. Close one page before opening the next. The fps it reports
  means nothing about phone performance.
- **Skid marks:** they're double-sided, because strips laid while sliding
  backwards face down.
- **Draped roads:** citygen smooths the ground under streets
  (`smoothCorridors`) before anything samples it, and the game draws the
  2 m ground `PAVED_SINK` lower deep under road strips. Anything else draped
  on the ground must stay a cm or so above the collision surface, or the
  terrain shows through.
- **Playwright version:** the package is pinned to 1.63.0 to match the
  sandbox's preinstalled Chromium at `/opt/pw-browsers`. Don't run
  `playwright install` locally.

## Network (Claude cloud sandbox)

- **Reachable:** OSM API `api.openstreetmap.org/api/0.6/map?bbox=…` (limits
  of 0.25 deg² and 50k nodes per call, so tile bigger areas), LINZ S3
  buckets (`nz-elevation`, `nz-imagery`), npm, PyPI.
- **Blocked:** Overpass API and Geofabrik extracts.

## Attribution (required once real data ships)

- "© OpenStreetMap contributors" (ODbL)
- "Contains data sourced from the LINZ Data Service, CC BY 4.0"

Both go on the title screen.
