# Handover: making it Auckland

Read `CLAUDE.md` first. This doc is the brief; `docs/TASKS.md` is the live
checklist.

## Where things are (end of first session)

- **Live:** https://jay-aye-see-kay.github.io/grand-theft-auckland/ (add
  `?debug` for fps, draw calls and test hooks).
- **What exists:** a placeholder grid town (`src/world.ts`) with four
  parked '95 Corollas (yours is purple). You can walk, jump, sprint, get in
  and out, drive with arcade handling, handbrake-slide and leave skid marks.
  Engine, tyre, crash and footstep sounds are synthesised in code. Touch,
  keyboard and gamepad all work. CI smoke-tests all of it before deploying.
- **Owner's feedback:** handling and camera "feel a bit all over the place",
  but tuning is parked by choice. **The priority now is making it feel like
  Auckland.** That's the gimmick.

## The goal

Drive and walk the real Auckland CBD: real street grid, real hills, real
building heights, recognisable landmarks. Start with the CBD and grow
outwards. Ambition level is "tier 2" below, with tier 3 as the stretch.

| Tier | What | Rough size |
|---|---|---|
| 1. Real map, grey box | OSM roads and buildings at real heights on LiDAR terrain, with collision, playable | 2–3 sessions |
| 2. Recognisably Auckland | Lane markings, clean junctions, facades, **Queen St / K Road verandahs**, street furniture, trees, harbour, about 6 hand-made landmarks, chunk streaming | +5–8 sessions |
| 3. Whole isthmus | Ponsonby, Parnell, Newmarket, Mt Eden, Harbour Bridge to Devonport, Spaghetti Junction, volcanic cones, LOD and skyline | +8–12 sessions |

**Rejected:** Google Photorealistic 3D Tiles. Their terms forbid this use,
they have no collision, they look melted at street level, and they're too
heavy for phones.

## Decisions (defaults; the owner may override)

- **First area:** waterfront and Britomart up to K Road, Wynyard Quarter and
  Viaduct in the west, Grafton Gully in the east. Roughly bbox
  `174.752,-36.861,174.776,-36.839` (lon/lat), about 5 km² at **1:1
  scale**. The harbour bounds three sides, so the map edges are natural.
- **Look:** stylised. Flat and vertex colours plus procedural facades, with
  aerial photos used only to sample roof and ground colours. Revisit a
  photo-textured ground later.
- **Landmarks, in priority order:**
  1. Sky Tower
  2. Ferry Building
  3. Britomart station
  4. Civic Theatre (rooftop sign)
  5. Auckland Town Hall
  6. Wynyard silos
  7. Harbour Bridge (in view from the waterfront even before it's drivable)
  8. Rangitoto on the horizon
- **Spawn:** on foot outside Britomart, next to the purple Corolla.

## Verified data sources

All of these were fetched successfully from the sandbox.

- **OpenStreetMap:**
  - API: `https://api.openstreetmap.org/api/0.6/map?bbox=minLon,minLat,maxLon,maxLat`.
  - A 0.01°×0.007° CBD slice is a 7 MB XML file: 3,399 ways, 493 buildings,
    and 490 of them have a `height` or `building:levels` tag.
  - Tile the 5 km² area into calls of about 0.01°×0.01°.
  - Lots of footway, crossing and steps clutter, so filter by highway class.
- **LINZ 2024 LiDAR, 1 m, EPSG:2193 (NZTM2000), Cloud-Optimised GeoTIFF:**
  one tile covers the whole CBD.
  - DEM (bare ground): `https://nz-elevation.s3.ap-southeast-2.amazonaws.com/auckland/auckland-part-1_2024/dem_1m/2193/BA32_10000_0401.tiff` (33 MB)
  - DSM (surface: buildings and trees): same path with `dsm_1m` (43 MB)
  - The tile spans lon 174.749–174.804, lat −36.878 to −36.813.
  - STAC catalogue for other tiles:
    `…/auckland-part-1_2024/dem_1m/2193/collection.json` (part-2 covers the
    outer region).
  - Read windows with the `geotiff` npm package (it supports HTTP range
    requests).
  - Uses: terrain, plus DSM minus DEM for heights of buildings OSM is
    missing, and for tree positions.
- **LINZ 2024 aerial photos, 7.5 cm:**
  `https://nz-imagery.s3.ap-southeast-2.amazonaws.com/auckland/auckland_2024_0.075m/rgb/2193/collection.json`
  (17,739 tiles, STAC). Use it for colour sampling and as a reference for
  hand-modelling.
- **Useful npm packages:**
  - `geotiff` 3.x, `proj4` (WGS84 ↔ NZTM), `earcut` (footprint
    triangulation), `@turf/turf`.
  - `osm2streets-js` 0.1.4 is lane-level street geometry from OSM, but it's
    stale (2023). Try it for tier-2 junctions; fall back to our own code.

## Pipeline design

The key idea: an offline generator, plus an override layer keyed by OSM ID,
so manual fixes survive re-imports.

```
tools/citygen/            Node + TS, run with --experimental-strip-types
  fetch.ts                OSM tiles + DEM/DSM windows → .cache/ (gitignored)
  project.ts              WGS84 → NZTM → local metres. Origin at Britomart
                          (~174.7680, -36.8443); x east, z south (north = -z);
                          y = metres above sea level
  terrain.ts              DEM → heightfield grid (2 m) per chunk
  buildings.ts            footprints → extruded meshes, base at the lowest
                          ground point under the footprint
  roads.ts                centrelines → road / footpath / kerb polygons
                          draped on terrain
  build.ts                writes public/city/<area>/chunk_<i>_<j>.{glb,json}
                          plus manifest.json
overrides/<area>.json     { "way/123": { "delete": true } },
                          { "way/456": { "height": 42 } },
                          { "way/789": { "landmark": "ferry-building" } }, ...
assets/landmarks/*.ts     hand-made landmark models built in code like
                          src/corolla.ts (or .glb), placed via overrides
```

- **What gets committed:**
  - Commit generated output in `public/city/`, so CI and deploys don't need
    network or data downloads.
  - Don't commit raw caches.
  - Re-running the generator must be deterministic.
- **Chunks:**
  - 250 m squares.
  - Each chunk is one merged static mesh with vertex colours, plus a
    collision payload: heightfield, building boxes or convex hulls, and
    kerbs.
  - Budget about 500 KB gzipped and about 30 draw calls per chunk.
- **Building heights:** use `height` if present, else
  `building:levels × 3.2 m`, else the median of DSM minus DEM inside the
  footprint, else 9 m.
- **Roads:**
  - Width comes from `lanes × 3.3 m`, or a default per class: primary 14,
    secondary 11, tertiary 9, residential 7.5, service 4.5.
  - Footpaths are 3 m each side with a 0.15 m kerb.
  - Junctions in tier 1 can be simple overlapping polygons. Tier 2 needs
    proper ones.
- **Game side:**
  - Add `?map=test` to keep the placeholder town; the default becomes
    Auckland.
  - Load chunks around the player.
  - Rapier heightfield per chunk, plus static colliders for buildings.

## How to run this (orchestration)

The owner wants this to run with minimal hand-holding. The orchestrator
keeps its own context small and delegates the building to subagents.

1. **Orchestrator:** read `CLAUDE.md`, this file and `docs/TASKS.md`. Pick
   the next unchecked task whose dependencies are done.
2. **Spawn one subagent per task** with a self-contained brief:
   - the task text from TASKS.md, including its "done when"
   - pointers to the relevant sections of CLAUDE.md and this file
   - "run build, sim and smoke; add smoke checks for what you build; commit
     with a clear message; don't push; report back changes, check results,
     screenshot paths and any open questions in under 200 words"
3. **Run tasks one at a time** by default, because subagents share one
   working tree. Only run truly independent tasks in parallel, each in its
   own git worktree, and merge them yourself.
4. **Verify; don't trust the report:**
   - re-run `npm run build && npm run smoke`
   - look at one or two screenshots yourself ("does this read as Auckland?")
   - skim `git diff --stat`, not whole diffs
   - if something is wrong, send the same subagent back with specifics
5. **Then:** tick the task in TASKS.md (with a one-line note), commit, push,
   and confirm the Pages deploy went green.
6. **Questions for the owner** go in the "Questions" section of TASKS.md.
   Keep going on the defaults above instead of blocking. Tell the owner
   once a milestone (end of tier 1 or tier 2) is live, with the link and
   what to test on their phone.
7. **If the orchestrator's own context gets tight:** update TASKS.md with
   state and notes, push, and say so. A fresh session can pick up from the
   file.

**What only the owner can judge:** real-phone frame rate, whether the sounds
and touch controls feel right, and whether it feels like Auckland. Ask for
these at milestones, with a short list of what to look at.
