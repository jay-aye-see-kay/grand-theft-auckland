// Named spots for missions, in map metres (origin Britomart, x east, z south).
// Hand-picked on the ground with __game.probe() until the OSM gazetteer
// (#28) replaces them: each sits on open road, footpath or plaza, clear of
// buildings, and the smoke test checks they stay that way.

export interface Place {
  readonly id: string;
  /** How missions and the HUD refer to it. Real street and landmark names, never businesses. */
  readonly name: string;
  readonly x: number;
  readonly z: number;
}

const define = <const T extends Record<string, Omit<Place, 'id'>>>(places: T) =>
  Object.fromEntries(Object.entries(places).map(([id, p]) => [id, { id, ...p }])) as { [K in keyof T]: Place };

export const PLACES = define({
  /** Galway St plaza, in front of the spawn outside Britomart. */
  'britomart-plaza': { name: 'Britomart', x: -32, z: 10 },
  /** Footpath on the south side of K Road, by the parked car. */
  'k-road-dairy': { name: 'the K Road dairy', x: -708, z: 1504 },
  /** Quay St at the Ferry Building's front door. */
  'ferry-building': { name: 'the Ferry Building', x: -100, z: -121 },
  /** Victoria St West at the foot of the Sky Tower. */
  'sky-tower': { name: 'the Sky Tower', x: -515, z: 418 },
  /** Queen St outside the Town Hall. */
  'town-hall': { name: 'the Town Hall', x: -407, z: 950 },
  /** Kerbside on Albert St. */
  'albert-st': { name: 'Albert St', x: -284, z: 114 },
  /** Bottom of Queen St, by Customs St. */
  'lower-queen-st': { name: 'lower Queen St', x: -136, z: 78 },
  /** Queen St, halfway up the hill. */
  'mid-queen-st': { name: 'Queen St', x: -229, z: 421 },
});

export type PlaceId = keyof typeof PLACES;

/** A place by id. Missions call this so a typo fails the typecheck. */
export const place = (id: PlaceId): Place => PLACES[id];
