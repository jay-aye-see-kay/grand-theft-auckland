// Which street a building wall faces, from OSM centrelines: drives the
// shopfronts (buildings.ts) and the street verandahs (verandahs.ts).
import type { OsmData } from './osm.ts';
import type { Local } from './project.ts';
import { collectRoads } from './roads.ts';

/**
 * Auckland's retail streets: continuous verandahs over the footpath and
 * shopfronts at street level (Queen St, K Road, High St and their side
 * streets and lanes).
 */
export const RETAIL_STREETS = new Set([
  'Queen Street', 'Karangahape Road', 'High Street', 'Ponsonby Road', 'Vulcan Lane', 'Lorne Street', 'Victoria Street West',
  'Victoria Street East', 'Wellesley Street West', 'Wellesley Street East', 'Customs Street West', 'Customs Street East',
  'Fort Street', 'Shortland Street', 'Elliott Street', 'Darby Street', 'Durham Street East', 'Durham Street West', 'Durham Lane',
  'Swanson Street', 'Wyndham Street', 'Commerce Street', 'Lower Albert Street', 'Albert Street', 'Upper Queen Street', 'Pitt Street',
  'Federal Street', "O'Connell Street", 'Chancery Street', 'Little High Street', 'Fort Lane', 'Galway Street',
  'Mercury Lane', 'Exmouth Street', 'Hobson Street', 'Nelson Street', 'Wakefield Street', 'Rutland Street', 'Kitchener Street',
]);

/** Streets lined with buildings (not motorways, service lanes or footpaths). */
const FRONTAGE_CLASSES = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian']);

export type Frontage = {
  name: string;
  highway: string;
  /** Wall to the street's centreline, m. */
  dist: number;
  /** Wall to the kerb (the carriageway's edge), m; for pedestrian streets the centreline. */
  kerb: number;
  retail: boolean;
};

type Seg = { a: Local; b: Local; name: string; highway: string; half: number };

const BUCKET = 40;
/** A wall faces a street whose kerb is at most this far out, m. */
const MAX_KERB = 9;

export class Frontages {
  private readonly buckets = new Map<number, Seg[]>();
  private key = (i: number, j: number) => (i + 0x8000) * 0x10000 + (j + 0x8000);

  constructor(osm: OsmData) {
    for (const r of collectRoads(osm)) {
      if (!FRONTAGE_CLASSES.has(r.highway) || r.bridge) continue;
      const name = osm.ways.get(r.id)?.tags.name ?? '';
      const half = r.surface === 'paving' ? 0 : r.width / 2;
      for (let k = 0; k + 1 < r.pts.length; k++) {
        const seg = { a: r.pts[k], b: r.pts[k + 1], name, highway: r.highway, half };
        const i0 = Math.floor(Math.min(seg.a.x, seg.b.x) / BUCKET);
        const i1 = Math.floor(Math.max(seg.a.x, seg.b.x) / BUCKET);
        const j0 = Math.floor(Math.min(seg.a.z, seg.b.z) / BUCKET);
        const j1 = Math.floor(Math.max(seg.a.z, seg.b.z) / BUCKET);
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            const kk = this.key(i, j);
            if (!this.buckets.has(kk)) this.buckets.set(kk, []);
            this.buckets.get(kk)!.push(seg);
          }
        }
      }
    }
  }

  /**
   * The street a wall from a to b (outward normal n) faces: a roughly
   * parallel centreline in front of it with its kerb within MAX_KERB.
   */
  facing(a: Local, b: Local, n: readonly number[]): Frontage | null {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 2) return null;
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    let best: Frontage | null = null;
    const seen = new Set<Seg>();
    const reach = MAX_KERB + 12;
    for (let i = Math.floor((mx - reach) / BUCKET); i <= Math.floor((mx + reach) / BUCKET); i++) {
      for (let j = Math.floor((mz - reach) / BUCKET); j <= Math.floor((mz + reach) / BUCKET); j++) {
        for (const seg of this.buckets.get(this.key(i, j)) ?? []) {
          if (seen.has(seg)) continue;
          seen.add(seg);
          const sx = seg.b.x - seg.a.x;
          const sz = seg.b.z - seg.a.z;
          const sl = Math.hypot(sx, sz);
          if (sl < 0.5 || Math.abs((sx * ux + sz * uz) / sl) < 0.85) continue;
          // Where the wall's middle projects onto the segment (it must land on it, give or take).
          const t = ((mx - seg.a.x) * sx + (mz - seg.a.z) * sz) / (sl * sl);
          if (t < -0.1 || t > 1.1) continue;
          const px = seg.a.x + sx * t;
          const pz = seg.a.z + sz * t;
          const dist = (px - mx) * n[0] + (pz - mz) * n[2];
          const off = Math.hypot(px - mx - n[0] * dist, pz - mz - n[2] * dist);
          if (dist <= 0 || off > 3) continue;
          const kerb = dist - seg.half;
          if (kerb < -0.5 || kerb > MAX_KERB) continue;
          if (!best || dist < best.dist) best = { name: seg.name, highway: seg.highway, dist, kerb, retail: RETAIL_STREETS.has(seg.name) };
        }
      }
    }
    return best;
  }
}
