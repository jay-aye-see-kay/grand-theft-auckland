# Overrides

Hand fixes to the OSM data, one file per area (`cbd.json`), keyed by OSM id.
`tools/citygen/build.ts` applies them before generating anything, so they
survive re-imports. Ids that no longer exist in the data are reported as
warnings on every build: re-check those against the map.

```json
{
  "// any key starting with //": "is a comment",
  "way/123":      { "height": 42, "note": "why, with the evidence (LiDAR, photo, source)" },
  "relation/456": { "delete": true }
}
```

Fix the cause in the generator instead when it's general (a whole class of
buildings wrong); use an override for one-offs.

| Field | On | Effect |
|---|---|---|
| `note` | anything | Free text: why the fix is right. Ignored by the generator. |
| `delete` | anything | Drop the element (a way is also removed from its relations). |
| `height`, `min_height` | buildings, parts | Metres above the building's base (the lowest ground under it). Sets the tags, so they win over `building:levels` and LiDAR. `min_height` > 0 floats it (a canopy, a crown). |
| `colour`, `roof_colour` | buildings | `#rrggbb` or a colour name; sets `building:colour` / `roof:colour`. |
| `layer`, `bridge` | roads | Set those tags (a bridge is lifted onto a deck). |
| `tags` | anything | Any other tag edits, e.g. `{ "building:min_level": null }` (null removes). |
| `deck` | bridge way | Deck height per node, metres above sea level (`null` = let the generator decide). Pinned nodes act as anchors; the rest is graded between them. |
| `deck` | `man_made=pier` area | Deck height of a pier the LiDAR missed, metres above sea level (default: the dry part of it, else 2.8 m; floating pontoons 0.5 m). `false` leaves it out. |
| `landmark` | buildings | Id like `"sky-tower"`: listed in `manifest.json` (`landmarks`: footprint, base, top) for hand-made models (T9). The OSM shape is still drawn unless `hide` is set. Several elements may share an id. |
| `hide` | buildings | Leave it (and its parts) out of the mesh. Its collider stays unless `block` is `false`. |
| `block` | areas, lines | An invisible collider. An area (closed way or multipolygon) becomes a solid prism from the ground; a line becomes a 0.5 m wall along it (a road block, a bollard line). `true` = 2 m high, a number = that height. |

Heights in the CBD are best checked against the LiDAR: the median of DSM
minus DEM inside a footprint (`tools/citygen` has the rasters cached in
`.cache/`).
