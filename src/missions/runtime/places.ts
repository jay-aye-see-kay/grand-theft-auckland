// The gazetteer: named places for missions, generated offline from OSM by
// tools/citygen/places.ts into public/city/<area>/places.json. Businesses
// have parody names, public places their real ones; each place's x, z is a
// marker point on the street outside, so you can drive to it.
//
// Missions name places by id ('k-road-dairy'), typechecked against the
// generated file, or ask for one by kind: nearest('bar', here), random('dairy').
// Find ids in places.json or with ?debug: __game.places('bar', { near: [x, z], within: 200 }).

/** The generated file's shape, so ids and kinds are checked by `npm run build`. */
type PlacesFile = typeof import('../../../public/city/cbd/places.json');

export type PlaceId = keyof PlacesFile['places'];
/** 'dairy', 'bar', 'cafe', 'landmark', 'park', 'wharf', ... (see "kinds" in places.json). */
export type PlaceKind = keyof PlacesFile['kinds'];

export interface Place {
  readonly id: string;
  /** How missions and the HUD refer to it: "Open 25 Hours", "the Ferry Building". */
  readonly name: string;
  readonly kind: string;
  readonly street: string;
  /** Marker point: on the street outside, map metres (origin Britomart, x east, z south). */
  readonly x: number;
  readonly z: number;
  /** The place itself, which may be indoors. */
  readonly at: { readonly x: number; readonly z: number };
}

interface RawPlace {
  name: string;
  kind: string;
  street: string;
  x: number;
  z: number;
  at: [number, number];
}

export interface PlaceQuery {
  /** Around here (default: the map origin, Britomart). */
  near?: { x: number; z: number };
  /** Only places this close to `near`, m. */
  within?: number;
  /** Leave these out (e.g. where the mission started). */
  except?: readonly (Place | string)[];
}

export const PLACES_FORMAT = 1;

export class Gazetteer {
  private readonly byId = new Map<string, Place>();

  constructor(file: { format: number; places: Record<string, RawPlace> }) {
    if (file.format !== PLACES_FORMAT) throw new Error(`places format ${file.format}, expected ${PLACES_FORMAT}`);
    for (const [id, p] of Object.entries(file.places)) {
      this.byId.set(id, Object.freeze({ id, name: p.name, kind: p.kind, street: p.street, x: p.x, z: p.z, at: { x: p.at[0], z: p.at[1] } }));
    }
  }

  static async load(url: URL): Promise<Gazetteer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`places: HTTP ${res.status}`);
    return new Gazetteer(await res.json());
  }

  get size(): number {
    return this.byId.size;
  }

  /** A place by id; unknown ids throw (the typecheck catches typos in missions). */
  get(id: PlaceId | string): Place {
    const p = this.byId.get(id);
    if (!p) throw new Error(`no place '${id}' in places.json`);
    return p;
  }

  /** Places of a kind (or all), nearest first when `near` is given. */
  find(kind?: PlaceKind | string, q: PlaceQuery = {}): Place[] {
    const near = q.near ?? { x: 0, z: 0 };
    const except = new Set((q.except ?? []).map((e) => (typeof e === 'string' ? e : e.id)));
    const d = (p: Place) => Math.hypot(p.x - near.x, p.z - near.z);
    const out = [...this.byId.values()].filter((p) => (!kind || p.kind === kind) && !except.has(p.id) && !(q.within !== undefined && d(p) > q.within));
    return q.near ? out.sort((a, b) => d(a) - d(b) || a.id.localeCompare(b.id)) : out;
  }

  /** The nearest place of a kind, or null if there's none (within `q.within`). */
  nearest(kind: PlaceKind | string, near: { x: number; z: number }, q: Omit<PlaceQuery, 'near'> = {}): Place | null {
    return this.find(kind, { ...q, near })[0] ?? null;
  }

  /** Any place of a kind, picked with `rng` (0..1), or null. */
  random(kind: PlaceKind | string, rng: () => number, q: PlaceQuery = {}): Place | null {
    // Sorted by id first, so the same rng picks the same place on every device.
    const all = this.find(kind, q).sort((a, b) => a.id.localeCompare(b.id));
    return all.length ? all[Math.floor(rng() * all.length) % all.length] : null;
  }
}
