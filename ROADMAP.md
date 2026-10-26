# Roadmap

## What "feels like GTA III" means

Not the scale. These five things:

1. **Arcade car handling**: weighty, slidey, forgiving, with satisfying crashes.
2. **Chase camera** that swings behind the car and pulls back with speed.
3. **Get in and out of any car** in one smooth action.
4. **A living city**: traffic, pedestrians, a recognisable skyline.
5. **Trouble**: a wanted level and cops who come after you.

Radio, story, weapons and a big map come later.

## Tech choices

- **Engine:** Three.js + TypeScript + Vite. Light and phone-friendly.
- **Physics:** Rapier (WASM) ray-cast vehicle and character controllers,
  tuned toward arcade, not simulation.
- **Map data:**
  - Roads and building footprints from OpenStreetMap (ODbL, needs attribution).
  - Elevation from LINZ (CC BY 4.0).
  - An offline script turns both into small low-poly map chunks, so the
    browser never handles raw map data.
  - Landmarks are hand-made: Sky Tower, Harbour Bridge, Ferry Building.
- **Art:** low-poly, vertex or atlas colours, fog, a warm sunset sky.
- **Phone performance budget:**
  - Under about 150 draw calls: merge each chunk's statics into one mesh and
    instance repeated props.
  - No real-time shadow maps; a blob shadow under each car.
  - Lower the render resolution when the frame rate drops.
  - Stream chunks in and out as you move.
- **Controls:** touch stick and buttons, keyboard, and gamepad.
- **Hosting:** GitHub Pages now, Cloudflare Pages maybe later.
- **Name:** "Grand Theft Auckland" is a parody. Take-Two Interactive (GTA's
  publisher) protects the GTA brand aggressively, so avoid their logo font
  and trade dress, and keep real car brands out of in-game text.

## Milestones

| Milestone | Goal | Done when |
|---|---|---|
| **M0 Skeleton** ✅ | Vite + Three + Rapier, deploy pipeline, touch/keyboard/gamepad input | A car drives on your phone |
| **M1 Feel** | Tune handling and camera; on-foot character; enter/exit cars | Driving an empty grid is fun. **Spend real time here.** |
| **M2 Auckland** | OSM/LINZ chunk pipeline for the city centre; hand-made Sky Tower | You recognise Queen St from the driver's seat |
| **M3 Life** | Traffic on the road graph (driving on the **left**), pedestrians | The city moves without you |
| **M4 Game** | One mission, wanted level, police chase, HUD and minimap | There's a goal, and a way to fail |

## First playable (end of M4)

About 1 km² of the city centre: Britomart and the waterfront at the
bottom, up Queen St to K Road, Wynyard Quarter and the Viaduct to the west,
with the Sky Tower always on the skyline.

- Spawn on foot outside Britomart and walk up to a parked purple '95 Corolla.
- Get in; the camera swings into chase view.
- Traffic flows up and down Queen St and stops at the lights (mostly).
  Pedestrians scatter when you mount the kerb.
- **Mission:** grab a package from a dairy on K Road and get it to the ferry
  terminal in 90 seconds.
- Clip a cop car and you get one star. Two police cars chase you until you
  lose them or get busted.
- Minimap bottom-left, touch controls bottom-right, smooth on a mid-range
  Android phone.

## Known follow-ups

- The bundle is about 4.9 MB (1.8 MB gzipped), mostly Rapier's inlined WASM.
  Fix: switch to the non-`compat` Rapier build and load the `.wasm` file
  separately, plus a loading bar.
- Handling numbers come from the headless sim. They still need tuning by
  hand on real phones (M1).
