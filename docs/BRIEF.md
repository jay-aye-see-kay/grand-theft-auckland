# Brief

## The goal

Drive and walk the real Auckland CBD at 1:1: real street grid, hills,
building heights and recognisable landmarks, with the feel of GTA III. Start
with the CBD and grow outwards. The owner plays it on a phone.

"Feels like GTA III" means five things, not the scale:

1. Arcade car handling: weighty, slidey, forgiving, satisfying crashes.
2. A chase camera that swings behind the car and pulls back with speed.
3. Get in and out of any car in one smooth action.
4. A living city: traffic, pedestrians, a recognisable skyline.
5. Trouble: a wanted level and cops who come after you.

## Tiers

| Tier | What |
|---|---|
| 1. Real map ✅ | OSM roads and buildings at real heights on LiDAR terrain, collision, playable |
| 2. Recognisably Auckland | Clean junctions, street furniture, trees, ~8 hand-made landmarks |
| 3. Whole isthmus | Ponsonby, Parnell, Newmarket, Mt Eden, Harbour Bridge to Devonport, Spaghetti Junction, volcanic cones |

Later, the game layer (parked for now): traffic driving on the left,
pedestrians, a mission (grab a package from a K Road dairy, get it to the
ferry terminal in 90 s), a wanted level and police chase, HUD and minimap.

## Decisions

- **Area:** waterfront and Britomart up to K Road, Wynyard Quarter to Grafton
  Gully, bbox `174.752,-36.861,174.776,-36.839` (lon/lat), ~5 km².
- **Look:** PS2/PS3-era GTA (San Andreas / IV), not PS1. Textures, atlases,
  baked lighting are fine within the phone budget. Street level must read as
  Auckland.
- **Landmarks, by priority:** Sky Tower, Ferry Building, Britomart / Chief
  Post Office, Civic Theatre (rooftop sign), Town Hall, Wynyard silos, Harbour
  Bridge (backdrop), Rangitoto (horizon).
- **Spawn:** on foot on Queen St at Aotea Square, next to the purple '95 Corolla.
- **Rejected:** Google Photorealistic 3D Tiles (terms forbid it, no collision,
  melted at street level, too heavy for phones).
- **Name:** a parody. Avoid Take-Two's logo font and trade dress; no real car
  brands in game text.

## Data sources

All reachable from the sandbox.

- **OSM API:** `https://api.openstreetmap.org/api/0.6/map?bbox=minLon,minLat,maxLon,maxLat`,
  tiled into ~0.01° calls.
- **LINZ 2024 LiDAR 1 m (EPSG:2193), Cloud-Optimised GeoTIFF.** One tile
  covers the CBD (lon 174.749–174.804, lat −36.878 to −36.813):
  - DEM: `https://nz-elevation.s3.ap-southeast-2.amazonaws.com/auckland/auckland-part-1_2024/dem_1m/2193/BA32_10000_0401.tiff` (33 MB)
  - DSM: same path with `dsm_1m` (43 MB). DSM − DEM gives building heights
    OSM lacks, and tree positions.
  - Other tiles: `…/auckland-part-1_2024/dem_1m/2193/collection.json` (part-2 covers the outer region).
- **LINZ 2024 aerials, 7.5 cm:** `https://nz-imagery.s3.ap-southeast-2.amazonaws.com/auckland/auckland_2024_0.075m/rgb/2193/collection.json`
  (STAC). For colour sampling and modelling reference.
- **Packages:** `geotiff`, `proj4`, `earcut`. `osm2streets-js` 0.1.4 does
  lane-level junction geometry but is stale (2023); worth a try for junctions.
