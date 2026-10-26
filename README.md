# Grand Theft Auckland

A GTA III–flavoured open-world driving game set in Auckland, running in the
browser on phones and desktop. Three.js + Rapier physics + TypeScript + Vite.

**Status:** M1 in progress. Walk around a placeholder test town, get in
and out of four parked Corollas (yours is the purple '95), make engine
noise and leave skid marks. See [ROADMAP.md](ROADMAP.md) for the plan.

## Play

Deployed to GitHub Pages on every push. Add `?debug` to the URL for an
FPS / pixel-ratio / draw-call readout.

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

## Develop

```sh
npm install
npm run dev     # http://localhost:5173, also on your LAN for phone testing
npm run build   # typecheck + production build into dist/
npm run sim     # headless handling report (0-100, braking, cornering)
npm run smoke   # plays the built game in headless Chromium and checks it
```

`npm run sim` drives the car through standard manoeuvres without a browser.
Run it before and after touching the numbers in `TUNING` in `src/car.ts`.

`npm run smoke` (after `npm run build`) starts on foot, walks, jumps, gets
in, drives, handbrakes, gets out, then repeats the basics with touch
controls on a phone-sized screen. It fails on any console error. CI runs it
before every deploy and keeps the screenshots as a build artifact.

## Layout

- `src/main.ts`: game loop, enter/exit, HUD, adaptive resolution
- `src/car.ts`: Rapier ray-cast vehicle and arcade handling
- `src/corolla.ts`: low-poly '95 Corolla model built in code (4 draw calls + wheels)
- `src/player.ts`: on-foot character: capsule controller, walk cycle
- `src/camera.ts`: follow camera with driving and on-foot framing
- `src/input.ts`: keyboard, touch and gamepad
- `src/audio.ts`: synthesised engine, tyres, crashes, footsteps
- `src/skids.ts`: skid marks
- `src/world.ts`: placeholder test town (replaced by real Auckland in M2)

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages. One-time
setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
