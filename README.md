# Grand Theft Auckland

A GTA III–flavoured open-world driving game set in Auckland, running in the
browser on phones and desktop. Three.js + Rapier physics + TypeScript + Vite.

Drive and walk the real Auckland CBD, generated from OpenStreetMap and LINZ
LiDAR. Spawn outside Britomart next to your purple '95. Plan:
[docs/BRIEF.md](docs/BRIEF.md) and [issues](https://github.com/jay-aye-see-kay/grand-theft-auckland/issues).

## Play

https://jay-aye-see-kay.github.io/grand-theft-auckland/ (add `?debug` for a
performance overlay, `?map=test` for the old test town).

| | Keyboard | Touch | Gamepad |
|---|---|---|---|
| Walk / steer | WASD / arrows | left stick | left stick |
| Sprint | Shift | RUN | X |
| Jump | Space | JUMP | A |
| Get in / out | F (or E, Enter) | 🚗 | Y |
| Accelerate | W / ↑ | ▲ | RT |
| Brake / reverse | S / ↓ | ◀ | LT |
| Handbrake | Space | HB | A |
| Flip car | R | ⟲ | Back |
| Look around | drag the view | drag the view | right stick |
| Mute | M | 🔊 | |

Getting out at speed brakes to a stop first, like GTA III. You step out of
the driver's door, which is on the right (they're NZ cars).

**Missions:** walk (or drive) into a gold marker to start one. The gold
arrow points to the nearest; once one is running, the pink arrow and beam
show where to go. So far: *Handle With Care* (outside Britomart, where you
start), *Milk Run* (K Road) and *High Tower Sprint* (bring a car).

## Develop

```sh
npm install
npm run dev     # http://localhost:5173, also on your LAN for phone testing
npm run build   # typecheck + production build into dist/
npm run sim     # headless handling report (0-100, braking, cornering)
npm run smoke   # plays the built game in headless Chromium: quick core checks
npm run smoke:full   # every check: city data, driving, harbour, budgets, phone
```

`npm run sim` drives the car through standard manoeuvres without a browser.
Run it before and after touching the numbers in `TUNING` in `src/car.ts`.

`npm run smoke` (after `npm run build`, about 30 s) starts on foot, walks,
jumps, gets in, drives, handbrakes, gets out and rams a building.
`npm run smoke:full` (a few minutes) adds the city data, driving the hills,
the harbour, the fly cheat, every mission, the test town, touch controls on a phone-sized
screen and the triangle/draw-call budgets. Both fail on any console error.
Pick areas with `npm run smoke -- --only=harbour,fly`. The game is stepped a
fixed tick at a time, so results repeat exactly: `--repeat=3` checks that.
CI only builds and deploys, so run it locally.

Project structure and conventions: [CLAUDE.md](CLAUDE.md).

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages. One-time
setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Attribution

The Auckland map is generated from open data (see `tools/citygen/`):

- Streets, buildings and land use: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
  available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
- Terrain (2024 Auckland LiDAR 1 m DEM/DSM): contains data sourced from the
  [LINZ Data Service](https://data.linz.govt.nz/), licensed for reuse under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Both credits are also shown on the game's title screen.
