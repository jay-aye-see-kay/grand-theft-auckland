# History

What's been built, for reference. Not needed to start work.

- **M0–M1:** Vite + Three + Rapier skeleton, Pages deploy, touch/keyboard/gamepad;
  walking, jumping, enter/exit, arcade handling, skid marks, synthesised audio.
  Handling and camera tuning parked.
- **T1 Data:** OSM + LiDAR fetch and cache, projection with origin at Britomart.
- **T2 Terrain:** 2 m heightfields in 250 m chunks, Auckland the default map.
- **T3 Buildings:** ~2,500 footprints extruded at OSM or LiDAR heights.
- **T4 Roads:** roads, footpaths and kerbs draped on terrain; land-use ground tint.
- **T5 Play:** Britomart spawn, 9 kerbside parked cars, fall-out-of-world recovery.
- **T6 Overrides:** `overrides/cbd.json` keyed by OSM id; worst glitches fixed.
- **T7 Water:** harbour shader, sea walls, pier decks, splash and reset.
- **T7b Performance:** one draw call per chunk, near-only fine ground and
  colliders, `?debug` perf overlay, budgets enforced in smoke.
- **T8 Attribution:** title screen credits.
- **T8b Street look:** northern sun, ACES tone mapping, haze; procedural facade
  atlas styled from OSM tags; verandahs; road textures, lane lines, crossings;
  always-loaded skyline LOD.
- **Workflow:** the first run used one long-lived orchestrator spawning a
  subagent per task. Dropped for cost: cold-start subagents, a growing
  orchestrator transcript, and slow smoke runs repeated per task. Backlog moved
  to GitHub issues.
