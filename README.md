# Grand Theft Auckland

A GTA III–flavoured open-world driving game set in Auckland, running in the
browser on phones and desktop. Three.js + Rapier physics + TypeScript + Vite.

**Status:** M0 (skeleton). A purple 1995 Corolla in a placeholder test town.
See [ROADMAP.md](ROADMAP.md) for the plan.

## Play

Deployed to GitHub Pages on every push. Add `?debug` to the URL for an
FPS / pixel-ratio / draw-call readout.

| | Keyboard | Touch | Gamepad |
|---|---|---|---|
| Accelerate | W / ↑ | ▲ | RT |
| Brake / reverse | S / ↓ | ◀ | LT |
| Steer | A D / ← → | left stick | left stick |
| Handbrake | Space | HB | A |
| Flip car | R | ⟲ | Y |

## Develop

```sh
npm install
npm run dev        # http://localhost:5173, also on your LAN for phone testing
npm run build      # typecheck + production build into dist/
node --experimental-strip-types scripts/sim-car.ts   # headless handling report
```

`scripts/sim-car.ts` drives the car through standard manoeuvres (0–100,
braking, cornering, handbrake turn) without a browser. Run it before and
after touching the numbers in `TUNING` in `src/car.ts`.

## Layout

- `src/main.ts`: renderer, fixed-timestep loop, adaptive resolution
- `src/car.ts`: Rapier ray-cast vehicle and arcade handling
- `src/corolla.ts`: low-poly '95 Corolla model built in code
- `src/camera.ts`: chase camera
- `src/input.ts`: keyboard, touch and gamepad
- `src/world.ts`: placeholder test town (replaced by real Auckland in M2)

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages. One-time
setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
