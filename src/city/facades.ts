// The city's texture atlas layout, shared by the offline generator (which
// picks a layer per wall and writes UVs) and the game (which paints the
// layers at load time, see atlas.ts, and samples them in the chunk shader).
// No DOM or Node APIs here.
//
// The atlas is a texture array: one 512 px square layer per material, each
// repeating on its own, so walls tile cleanly and mip-map without bleeding
// into their neighbours. A vertex's `tile` byte picks the layer (0 = plain
// vertex colour, else layer + 1); from MARKED up it's asphalt with lane
// markings painted by the shader (tile = MARKED - 1 + marking).
//
// Facade layers are drawn for a whole number of bays across and floors up,
// and the generator scales each wall's UVs so a bay and a floor land on the
// building's real ones (no stretching). Ground layers (PLANAR) ignore the
// vertex UVs and are mapped from world x/z instead, so road strips, terrain
// and roofs need no UVs at all.

export const ATLAS_SIZE = 512;

/** Atlas layers, in order. */
export const LAYERS = [
  'glass', // curtain wall: towers
  'ribbon', // ribbon windows and spandrel bands: 70s-90s offices
  'grid', // punched windows in precast concrete: mid-rise offices
  'stucco', // painted plaster with framed windows: older mid-rise, flats
  'brick', // heritage brick with arched windows and stone dressings
  'stone', // heritage sandstone/plaster: Edwardian commercial
  'balcony', // apartments with balcony slabs
  'plain', // blank side and party walls
  'shop', // modern glazed shopfronts (ground floor)
  'shop-heritage', // timber shopfronts with stallrisers and recessed doors
  'lobby', // tower lobby: tall glazing between stone columns
  'roof-tin', // corrugated iron on pitched roofs (u across the fall, v down it)
  'roof-tile', // concrete or clay tiles on pitched roofs
  'roof', // membrane and gravel (planar)
  'asphalt', // road surface (planar)
  'paving', // footpath pavers (planar)
  'ground', // generic ground grain for the terrain (planar)
  'concrete', // kerbs, plant rooms (planar)
] as const;
export type Layer = (typeof LAYERS)[number];
export const LAYER = Object.fromEntries(LAYERS.map((l, k) => [l, k])) as Record<Layer, number>;

/** Layers from here on are mapped from world x/z (see PLANAR_METRES). */
export const FIRST_PLANAR = LAYER.roof;
/** Metres of ground one repeat of each planar layer covers. */
export const PLANAR_METRES: Partial<Record<Layer, number>> = { roof: 8, asphalt: 6, paving: 4.8, ground: 12, concrete: 4 };

/**
 * Facade layers: bays across and floors up one repeat of the layer holds,
 * and a bay's natural width (m). The generator fits a whole number of bays
 * to each wall, so the real width stretches a little from this.
 * Ground-floor layers hold exactly one storey (they span the shop band).
 */
export const FACADE: Partial<Record<Layer, { bays: number; floors: number; bay: number }>> = {
  glass: { bays: 4, floors: 4, bay: 1.6 },
  ribbon: { bays: 4, floors: 4, bay: 1.8 },
  grid: { bays: 4, floors: 4, bay: 2.4 },
  stucco: { bays: 4, floors: 4, bay: 3 },
  brick: { bays: 3, floors: 3, bay: 3.2 },
  stone: { bays: 3, floors: 3, bay: 3.4 },
  balcony: { bays: 3, floors: 4, bay: 3.6 },
  plain: { bays: 2, floors: 4, bay: 4 },
  shop: { bays: 2, floors: 1, bay: 4.5 },
  'shop-heritage': { bays: 2, floors: 1, bay: 4.5 },
  lobby: { bays: 2, floors: 1, bay: 4.5 },
};

/** Tile bytes from here up are asphalt with lane markings (see roadMarking). */
export const MARKED = 128;

/** Metres of pitched roof one repeat of a roof layer covers (its UVs run across and down the slope). */
export const ROOF_METRES: Partial<Record<Layer, number>> = { 'roof-tin': 2.4, 'roof-tile': 2.4 };

/** A vertex's tile byte for an atlas layer (and, on asphalt, a marking pattern 1-14). */
export const tileOf = (layer: Layer, marking = 0) => {
  if (marking && layer !== 'asphalt') throw new Error(`lane markings on ${layer}`);
  return marking ? MARKED - 1 + marking : 1 + LAYER[layer];
};

/**
 * Road markings packed into the tile byte's high bits: 0 none; else the
 * lane count (1-7) and whether the road is two-way (the centre line is
 * then where the directions meet). The strip's UVs are then (lane units
 * across from the left edge, metres along the way).
 */
export const roadMarking = (lanes: number, twoWay: boolean) => (lanes < 2 ? 0 : Math.min(lanes, 7) + (twoWay ? 7 : 0));

/** Vertex UVs are stored as int16 in these units (1/64 of a repeat: +-512 repeats). */
export const UV_SCALE = 64;
/** The shade byte stores light x SHADE_ONE (so it can go a little over 1). */
export const SHADE_ONE = 200;
