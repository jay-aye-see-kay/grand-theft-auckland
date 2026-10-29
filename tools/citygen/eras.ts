// Architectural eras for generic buildings: which family of facades, colours
// and massing details a building gets, so streets read as Auckland's mix of
// Victorian shops, interwar deco, postwar modernism, 70s-80s towers and
// recent glass and cladding, not one texture per material.
//
// Tags are thin (start_date on 7% of buildings, building:architecture on a
// handful), so most of the choice comes from what we can see: height,
// footprint, building type, the streets a building faces and where it is.
// A low-frequency spatial noise nudges neighbours towards the same era, so a
// block reads as of a piece instead of a random shuffle.
import type { Layer } from '../../src/city/facades.ts';
import type { Tags } from './osm.ts';
import type { WikidataFacts } from './wikidata.ts';

export type Era = 'victorian' | 'edwardian' | 'interwar' | 'postwar' | 'late' | 'contemporary' | 'house' | 'industrial';

/** A building's dress: facade layer above the street, what's at street level, colours and details. */
export type FacadeStyle = {
  era: Era;
  upper: Layer;
  ground: 'shop' | 'lobby' | null;
  /** Shopfronts in timber with stallrisers (shop-heritage) rather than aluminium. */
  heritage: boolean;
  palette: number[];
  /** Storey height above the ground floor, m. */
  floor: number;
  /** Parapet height over a flat roof, m. */
  parapet: number;
  /** Projecting cornice at the roof line (depth, m; 0 none), string courses at floor lines. */
  cornice: number;
  courses: boolean;
  /** A raised centre on the street parapet: a pediment (Victorian), a stepped top (deco). */
  crest: 'pediment' | 'stepped' | null;
};

/** FNV-1a: stable per-building randomness from the OSM key. */
export function hash(key: string, salt = 0): number {
  let h = 0x811c9dc5 ^ salt;
  for (let k = 0; k < key.length; k++) h = Math.imul(h ^ key.charCodeAt(k), 0x01000193);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1 over ~`cell` metres, deterministic. */
export function areaNoise(x: number, z: number, cell = 140, salt = 0): number {
  const fx = x / cell;
  const fz = z / cell;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const s = (t: number) => t * t * (3 - 2 * t);
  const tx = s(fx - i);
  const tz = s(fz - j);
  const v = (a: number, b: number) => hash(`${a},${b}`, 77 + salt);
  const top = v(i, j) + (v(i + 1, j) - v(i, j)) * tx;
  const bottom = v(i, j + 1) + (v(i + 1, j + 1) - v(i, j + 1)) * tx;
  return top + (bottom - top) * tz;
}

// sRGB hex, stylised tones per family.
const GLASS = [0x6f8796, 0x7d93a3, 0x5d7484, 0x8aa0ad, 0x667a88, 0x7a8f8f];
const GLASS_NEW = [0x6d8a94, 0x5f7f8c, 0x7a9aa2, 0x8fa6ae, 0x587680, 0x6f8f86];
const GLASS_80S = [0x8a7660, 0x6e6a5e, 0x7d8a8f, 0x5e6c76, 0x947f62];
const CONCRETE = [0xb9b6ad, 0xa8a69f, 0xc9c4b8, 0x9c9a94, 0xd2cdc0, 0xb0aca2];
const CONCRETE_70S = [0xb0a998, 0x9d978a, 0xc1b8a4, 0x8f8b82, 0xa89a84];
const SANDSTONE = [0xcdb991, 0xd8c8a4, 0xc2a979, 0xe0d4b8, 0xbfa888];
const BRICK = [0x9a5a44, 0x8a4d3b, 0xa86a50, 0x7d4a3a, 0x94604a];
const BRICK_DARK = [0x7a4436, 0x6e3e32, 0x84503e, 0x5e3a30];
const PAINTED = [0xe6e0d4, 0xd9d3c7, 0xe8dcc4, 0xcfd3cf];
/** Victorian and Edwardian commercial paint: creams, buffs, stone greys and the odd heritage colour. */
const VICTORIAN_PAINT = [0xe8dcc0, 0xd9c9a6, 0xcfc4b0, 0xe3d6c0, 0xc9b896, 0xd6cdbd, 0xb9a98e, 0xa8b4a6, 0xc7a99a];
/** Interwar plaster: cream, pale pink, mint, buff, the occasional terracotta. */
const DECO = [0xeadfc8, 0xe6cfc2, 0xd6e0cf, 0xe2d4b0, 0xf0e8dc, 0xd9c3a8, 0xc8d4d6];
/** 60s spandrel panels (the tint shows through the curtain wall's opaque panels). */
const SPANDREL = [0x5e7f8c, 0x7f8f6a, 0xb08a4e, 0x8c9496, 0x4f6e7a, 0xa66a48, 0xc9c3b0];
/** Recent cladding: charcoal, white, warm greys, terracotta, timber-ish. */
const CLADDING = [0x3e4246, 0xe8e6e0, 0xb8b0a4, 0xa8684c, 0x8c6a4c, 0x6e7478, 0xd2c8b6];
/** Loud paint on old shopfronts: K Road's pinks, teals, mustards and purples. */
const BOLD = [0xd77fa1, 0x3f9a96, 0xd9a634, 0x7fb5d9, 0x8a68b0, 0xc4573f, 0x7cbf8a, 0xe8836b, 0x2f6f9e, 0xf0d24a];
/** Streets whose old buildings are painted loud, and the share that are. */
const BOLD_STREETS = new Set(['Karangahape Road', 'Pitt Street', 'Mercury Lane', 'Cross Street', "K' Road"]);
const BOLD_THERE = 0.45;
const BOLD_ELSEWHERE = 0.08;
/** Layers that are painted plaster (so a loud colour looks painted on, not dyed into brick or stone). */
const PAINTABLE = new Set<Layer>(['italianate', 'stucco', 'deco', 'stripped']);
const PASTEL = [0xe8dcc0, 0xd9d6c4, 0xe6d6b8, 0xcfd6cc, 0xe3d2c6, 0xd6d0bc];
/** Industrial cladding: greys, off-white, the odd green or blue. */
const SHED = [0xc4c6c2, 0xa9adab, 0xd8d8d0, 0x7d8a84, 0x8c9aa6, 0xb8b2a4];
/** Villas and cottages: white, cream, greys and heritage colours on weatherboards. */
const VILLA = [0xf2efe6, 0xe9e2cf, 0xd8d8d0, 0xc9d1cf, 0xe6dcc6, 0xb8c4b8, 0xd9c8b4, 0xa9b8c4];

export const HOUSES = new Set(['house', 'detached', 'terrace', 'semidetached_house', 'bungalow', 'hut', 'cabin']);
export const FLATS = new Set(['apartments', 'residential', 'dormitory', 'hotel']);
export const SHEDS = new Set(['warehouse', 'industrial', 'service', 'shed', 'garage', 'garages', 'storage_tank', 'transformer_tower', 'construction', 'carport', 'roof', 'container']);
const RETAIL = new Set(['retail', 'commercial', 'shop', 'kiosk', 'supermarket']);

/** Streets whose low-rise buildings are mostly 1880s-1930s. */
const OLD_STREETS = new Set([
  'Karangahape Road', 'Ponsonby Road', 'Vulcan Lane', 'High Street', 'Fort Street', 'Fort Lane', 'Shortland Street', 'Queen Street',
  'Lorne Street', 'Durham Lane', 'Durham Street East', 'Galway Street', 'Tyler Street', 'Customs Street East', 'Commerce Street',
  'Little High Street', 'Exmouth Street', 'Mercury Lane', 'Pitt Street', 'Upper Queen Street', "O'Connell Street", 'Chancery Street',
  'Emily Place', 'Gore Street', 'Swanson Street', 'Wyndham Street', 'Victoria Street West', 'Elliott Street', 'Darby Street',
  'Princes Street', 'Symonds Street', 'Newton Road', 'Great North Road', 'Cross Street', 'East Street',
]);
/** Streets of the reclaimed waterfront, built up since 2000 (Wynyard Quarter, the Viaduct). */
const NEW_STREETS = new Set([
  'Viaduct Harbour Avenue', 'Pakenham Street West', 'Jellicoe Street', 'Daldy Street', 'Hamer Street', 'Beaumont Street', 'Gaunt Street',
  'Halsey Street', 'Halsey Wharf', 'North Wharf Promenade', 'Madden Street', 'Waikokota Lane', 'Tīramarama Way', 'Fish Lane',
  'Māhuru Lane', 'Autahi Lane', 'Pūanga Lane', 'Brigham Street', 'Piripi Lane', 'Te Wero Bridge', 'Eastbourne Road',
]);

/** Year in a start_date ('1886', '~1910', 'C19', '1920s'), NaN if none. */
export function startYear(t: Tags): number {
  const m = /(1[6-9]\d\d|20\d\d)/.exec(t.start_date ?? t['building:start_date'] ?? t.construction_date ?? '');
  if (m) return Number(m[1]);
  if (/^C19$/i.test(t.start_date ?? '')) return 1880;
  return NaN;
}

const eraOfYear = (y: number): Era =>
  y < 1900 ? 'victorian' : y < 1919 ? 'edwardian' : y < 1946 ? 'interwar' : y < 1970 ? 'postwar' : y < 1990 ? 'late' : 'contemporary';

/** `building:architecture` and `architecture` values we understand. */
const ARCHITECTURE: Record<string, Era> = {
  victorian: 'victorian', italianate: 'victorian', gothic_revival: 'victorian', neoclassicism: 'edwardian', classicism: 'edwardian',
  edwardian: 'edwardian', baroque_revival: 'edwardian', art_deco: 'interwar', art_nouveau: 'edwardian', stripped_classicism: 'interwar',
  modern: 'postwar', modernism: 'postwar', international_style: 'postwar', brutalist: 'late', brutalism: 'late', postmodern: 'late',
  contemporary: 'contemporary', 'neo-futurism': 'contemporary', 'high-tech': 'contemporary',
};

export type EraInput = {
  key: string;
  tags: Tags;
  /** Height of the tallest part of the building's family, m. */
  height: number;
  /** Footprint area of the outline, m². */
  area: number;
  /** Faces a retail street (Queen St, K Road...). */
  retailStreet: boolean;
  /** Shops, cafes etc. mapped inside it. */
  shops: number;
  /** Names of the streets its walls face. */
  streets: Set<string>;
  x: number;
  z: number;
  /** Year and styles from Wikidata, for buildings with a `wikidata` tag (see wikidata.ts). */
  wikidata?: WikidataFacts;
};

/** Wikidata architectural styles (English labels) by what they say about the era. */
const STYLE_ERAS: [RegExp, Era][] = [
  [/art deco|streamline|stripped classic/i, 'interwar'],
  [/brutalis|postmodern|high-tech/i, 'late'],
  [/international style|modern/i, 'postwar'],
  [/edwardian|neoclassical|beaux-arts|baroque revival/i, 'edwardian'],
  [/gothic|italianate|romanesque|renaissance revival|moorish|victorian|second empire/i, 'victorian'],
];

/** Picks from weighted options with r in 0..1. */
function pick<T>(r: number, options: [T, number][]): T {
  const total = options.reduce((s, o) => s + o[1], 0);
  let acc = 0;
  for (const [v, w] of options) {
    acc += w / total;
    if (r < acc) return v;
  }
  return options[options.length - 1][0];
}

export function eraOf(e: EraInput): Era {
  const t = e.tags;
  const b = t.building ?? t['building:part'] ?? 'yes';
  const year = startYear(t) || e.wikidata?.year || NaN;
  if (year > 0) return HOUSES.has(b) && year < 1946 ? 'house' : eraOfYear(year);
  const arch = ARCHITECTURE[(t['building:architecture'] ?? t.architecture ?? '').toLowerCase()];
  if (arch) return arch;
  for (const style of e.wikidata?.styles ?? []) {
    const hit = STYLE_ERAS.find(([re]) => re.test(style));
    if (hit) return hit[1];
  }
  if (HOUSES.has(b)) return 'house';
  const material = (t['building:material'] ?? '').toLowerCase();
  if (material.includes('glass')) return e.height > 40 || hash(e.key, 20) < 0.6 ? 'contemporary' : 'late';
  const heritage = t.heritage !== undefined || t['ref:nz:heritage'] !== undefined || t.historic !== undefined || t['heritage:operator'] !== undefined;
  // Neighbours share a bias; each building still has its own say.
  const r = 0.55 * areaNoise(e.x, e.z) + 0.45 * hash(e.key, 21);
  if (heritage || b === 'church' || b === 'cathedral') return pick(r, [['victorian', 4], ['edwardian', 4], ['interwar', 2]]);
  if (b === 'parking') return pick(r, [['late', 3], ['postwar', 1], ['contemporary', 1]]);
  const newArea = [...e.streets].some((s) => NEW_STREETS.has(s));
  const oldArea = [...e.streets].some((s) => OLD_STREETS.has(s));
  if (SHEDS.has(b) && e.height < 20) return newArea ? pick(r, [['industrial', 2], ['contemporary', 1]]) : pick(r, [['industrial', 4], ['victorian', 1], ['interwar', 1]]);
  if (newArea) return e.height < 12 && e.area > 1500 ? 'industrial' : pick(r, [['contemporary', 6], ['late', 1]]);
  if (e.height >= 60) return pick(r, [['late', 4], ['contemporary', 5], ['postwar', 1]]);
  if (FLATS.has(b)) return e.height > 20 ? pick(r, [['contemporary', 5], ['late', 2], ['postwar', 1]]) : pick(r, [['contemporary', 3], ['postwar', 2], ['interwar', 1], ['late', 1]]);
  if (e.height >= 25) {
    return oldArea && e.height < 38 && e.area < 1500
      ? pick(r, [['edwardian', 2], ['interwar', 3], ['postwar', 3], ['late', 2], ['contemporary', 1]])
      : pick(r, [['interwar', 1], ['postwar', 3], ['late', 4], ['contemporary', 3]]);
  }
  // Low-rise. Small frontages on old streets are the Victorian and Edwardian shops.
  const shopRow = e.retailStreet || oldArea || e.shops > 0 || RETAIL.has(b);
  if (shopRow && e.area < 1500) return pick(r, [['victorian', 4], ['edwardian', 4], ['interwar', 3], ['postwar', 2], ['late', 1]]);
  if (e.area > 3000) return pick(r, [['postwar', 2], ['late', 3], ['contemporary', 2]]);
  return pick(r, [['victorian', 1], ['edwardian', 2], ['interwar', 2], ['postwar', 3], ['late', 2], ['contemporary', 2]]);
}

type Variant = { layer: Layer; palette: number[]; weight: number };

/** Facade variants per era, chosen per building, so a street doesn't repeat one texture. */
const VARIANTS: Record<Era, Variant[]> = {
  victorian: [
    { layer: 'italianate', palette: VICTORIAN_PAINT, weight: 4 },
    { layer: 'brick', palette: BRICK, weight: 2 },
    { layer: 'warehouse', palette: BRICK_DARK, weight: 1 },
  ],
  edwardian: [
    { layer: 'stone', palette: SANDSTONE, weight: 3 },
    { layer: 'brick', palette: BRICK, weight: 2 },
    { layer: 'italianate', palette: VICTORIAN_PAINT, weight: 1 },
    { layer: 'warehouse', palette: BRICK, weight: 1 },
  ],
  interwar: [
    { layer: 'deco', palette: DECO, weight: 3 },
    { layer: 'stripped', palette: DECO, weight: 2 },
    { layer: 'stucco', palette: PASTEL, weight: 1 },
  ],
  postwar: [
    { layer: 'modern60', palette: SPANDREL, weight: 3 },
    { layer: 'grid', palette: CONCRETE, weight: 2 },
    { layer: 'stucco', palette: PASTEL, weight: 1 },
  ],
  late: [
    { layer: 'ribbon', palette: CONCRETE_70S, weight: 3 },
    { layer: 'brutal', palette: CONCRETE_70S, weight: 2 },
    { layer: 'glass', palette: GLASS_80S, weight: 2 },
    { layer: 'grid', palette: CONCRETE, weight: 1 },
  ],
  contemporary: [
    { layer: 'glass-b', palette: GLASS_NEW, weight: 3 },
    { layer: 'glass', palette: GLASS, weight: 2 },
    { layer: 'cladding', palette: CLADDING, weight: 3 },
  ],
  house: [
    { layer: 'weatherboard', palette: VILLA, weight: 5 },
    { layer: 'stucco', palette: PASTEL, weight: 1 },
  ],
  industrial: [
    { layer: 'shed', palette: SHED, weight: 3 },
    { layer: 'plain', palette: CONCRETE, weight: 1 },
    { layer: 'warehouse', palette: BRICK_DARK, weight: 1 },
  ],
};

/** Massing details per era (see FacadeStyle). */
const DETAILS: Record<Era, Pick<FacadeStyle, 'parapet' | 'cornice' | 'courses' | 'crest'>> = {
  victorian: { parapet: 1.5, cornice: 0.45, courses: true, crest: 'pediment' },
  edwardian: { parapet: 1.2, cornice: 0.5, courses: true, crest: null },
  interwar: { parapet: 1.1, cornice: 0.2, courses: false, crest: 'stepped' },
  postwar: { parapet: 0.6, cornice: 0, courses: false, crest: null },
  late: { parapet: 0.9, cornice: 0, courses: false, crest: null },
  contemporary: { parapet: 0.5, cornice: 0, courses: false, crest: null },
  house: { parapet: 0, cornice: 0, courses: false, crest: null },
  industrial: { parapet: 0.6, cornice: 0, courses: false, crest: null },
};

/** Natural storey heights per era (floors of tall buildings are tighter than shops'), m. */
const FLOOR: Record<Era, number> = { victorian: 4.3, edwardian: 4.1, interwar: 3.8, postwar: 3.4, late: 3.6, contemporary: 3.4, house: 3, industrial: 4.5 };

/**
 * The full style for a building, deterministic per OSM key. Tagged
 * `building:material` and towers' needs still win: a 100 m tower is never
 * Victorian, flats get balconies, car parks their own layer.
 */
export function eraStyle(e: EraInput): FacadeStyle {
  const t = e.tags;
  const b = t.building ?? t['building:part'] ?? 'yes';
  const era = eraOf(e);
  const material = (t['building:material'] ?? t['building:facade:material'] ?? '').toLowerCase();
  const variants = VARIANTS[era];
  const r = hash(e.key, 22);
  const total = variants.reduce((s, v) => s + v.weight, 0);
  let acc = 0;
  let v = variants[variants.length - 1];
  for (const c of variants) {
    acc += c.weight / total;
    if (r < acc) {
      v = c;
      break;
    }
  }
  let upper = v.layer;
  let palette = v.palette;
  if (material.includes('glass')) [upper, palette] = [era === 'late' ? 'glass' : 'glass-b', era === 'late' ? GLASS_80S : GLASS_NEW];
  else if (material === 'brick' && !['brick', 'warehouse'].includes(upper)) [upper, palette] = [era === 'victorian' || era === 'edwardian' || era === 'industrial' ? 'brick' : upper, BRICK];
  else if ((material === 'stone' || material === 'sandstone') && (era === 'victorian' || era === 'edwardian')) [upper, palette] = ['stone', SANDSTONE];
  else if (material === 'wood' && era === 'house') [upper, palette] = ['weatherboard', VILLA];
  if (b === 'parking') [upper, palette] = ['carpark', CONCRETE];
  // Some of the old painted buildings are painted loud (most on K Road): part of the city's own character.
  if (PAINTABLE.has(upper) && (era === 'victorian' || era === 'edwardian' || era === 'interwar') && e.height < 25) {
    const there = [...e.streets].some((st) => BOLD_STREETS.has(st));
    if (hash(e.key, 24) < (there ? BOLD_THERE : BOLD_ELSEWHERE)) palette = BOLD;
  }
  // Flats: balconies on most recent and late apartment blocks.
  if (FLATS.has(b) && (era === 'contemporary' || era === 'late') && hash(e.key, 23) < 0.6) [upper, palette] = ['balcony', era === 'late' ? CONCRETE_70S : PAINTED];
  const heritage = era === 'victorian' || era === 'edwardian' || era === 'interwar';
  const retail = e.shops > 0 || RETAIL.has(b) || (e.retailStreet && !HOUSES.has(b));
  const ground = e.height >= 40 ? (retail && e.height < 80 ? 'shop' : 'lobby') : retail && !SHEDS.has(b) && era !== 'house' ? 'shop' : null;
  const levels = Number(t['building:levels']);
  const floor = levels >= 2 ? Math.min(4.8, Math.max(2.7, e.height / levels)) : FLOOR[era];
  const details = { ...DETAILS[era] };
  // Pediments and stepped tops are for street fronts of modest buildings.
  if (e.height > 30 || !e.streets.size) details.crest = null;
  if (b === 'parking' || SHEDS.has(b)) Object.assign(details, { cornice: 0, courses: false, crest: null });
  return { era, upper, ground, heritage, palette, floor, ...details };
}
