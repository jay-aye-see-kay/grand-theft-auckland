// Hand fixes keyed by OSM id, kept in overrides/<area>.json so they survive
// re-imports (see overrides/README.md for the format).
//
// Most fixes are tag patches: they're written into the element's tags
// before anything else reads them, so buildings, roads, land use and
// parking all see the same corrected data. The rest are directives the
// generator acts on itself: `delete` drops the element, `landmark` records
// it in the manifest (and `hide` leaves it out of the mesh), `block` adds an
// invisible collider in its shape, and `deck` pins bridge or pier heights.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OsmData, Tags } from './osm.ts';

export type Override = {
  /** Why: free text, ignored by the generator. */
  note?: string;
  /** Leave the element out entirely. */
  delete?: boolean;
  /** Tag shorthands: height / min_height in metres, colours as #rrggbb or a colour name. */
  height?: number;
  min_height?: number;
  colour?: string;
  roof_colour?: string;
  layer?: number;
  bridge?: boolean;
  /** Any other tag edits; null removes the tag. */
  tags?: Record<string, string | null>;
  /** Landmark id (e.g. "sky-tower"): listed in the manifest for hand-made models (T9). */
  landmark?: string;
  /** Don't draw the element (it keeps an invisible collider unless `block` is false). */
  hide?: boolean;
  /**
   * An invisible collider in the element's shape. An area (a closed way or
   * multipolygon) becomes a solid prism from the ground; a line becomes a
   * wall 0.5 m thick along it (a road block, a bollard line). `true` uses the
   * building's height (areas) or 2 m; a number is the height in metres.
   */
  block?: boolean | number;
  /**
   * Heights in metres above sea level. On a bridge way: one per node (null
   * leaves that node to the generator). On a pier area: its deck height, or
   * false to leave the pier out.
   */
  deck?: number | false | (number | null)[];
};

/** "way/123" or "relation/456". */
export type OsmKey = string;

export class Overrides {
  readonly area: string;
  private readonly entries = new Map<OsmKey, Override>();

  constructor(area: string, entries: Record<OsmKey, Override> = {}) {
    this.area = area;
    for (const [k, v] of Object.entries(entries)) {
      if (k.startsWith('//') || k.startsWith('$')) continue; // comments, $schema
      if (!/^(way|relation)\/\d+$/.test(k)) throw new Error(`overrides/${area}.json: bad key "${k}" (want way/123 or relation/456)`);
      this.entries.set(k, v);
    }
  }

  static load(area: string): Overrides {
    const path = fileURLToPath(new URL(`../../overrides/${area}.json`, import.meta.url));
    if (!existsSync(path)) return new Overrides(area);
    return new Overrides(area, JSON.parse(readFileSync(path, 'utf8')) as Record<OsmKey, Override>);
  }

  get size(): number {
    return this.entries.size;
  }

  /** By OSM key ("way/123") or the generator's short key ("w123", "r456"). */
  get(key: string): Override | undefined {
    return this.entries.get(longKey(key));
  }

  keys(): OsmKey[] {
    return [...this.entries.keys()];
  }

  /**
   * Applies tag patches and deletions to the OSM data in place and returns
   * warnings for ids that aren't in it (deleted or re-mapped upstream).
   */
  apply(osm: OsmData): string[] {
    const warnings: string[] = [];
    for (const [key, o] of this.entries) {
      const [type, idStr] = key.split('/');
      const id = Number(idStr);
      const el = type === 'way' ? osm.ways.get(id) : osm.relations.get(id);
      if (!el) {
        warnings.push(`${key} is not in the OSM data any more${o.note ? ` (${o.note})` : ''}`);
        continue;
      }
      if (o.delete) {
        if (type === 'way') osm.ways.delete(id);
        else osm.relations.delete(id);
        // A deleted way also leaves any relation it was part of, so a
        // multipolygon doesn't drop out for a missing member.
        if (type === 'way') for (const rel of osm.relations.values()) rel.members = rel.members.filter((m) => !(m.type === 'way' && m.ref === id));
        continue;
      }
      patchTags(el.tags, o);
    }
    return warnings;
  }
}

/** "w123" -> "way/123", "r456" -> "relation/456"; long keys pass through. */
export function longKey(key: string): OsmKey {
  if (key[0] === 'w' && /^w\d+$/.test(key)) return `way/${key.slice(1)}`;
  if (key[0] === 'r' && /^r\d+$/.test(key)) return `relation/${key.slice(1)}`;
  return key;
}

function patchTags(tags: Tags, o: Override) {
  const set = (k: string, v: string | number | boolean | undefined) => {
    if (v !== undefined) tags[k] = String(v);
  };
  set('height', o.height);
  set('min_height', o.min_height);
  set('building:colour', o.colour);
  set('roof:colour', o.roof_colour);
  set('layer', o.layer);
  if (o.bridge !== undefined) tags.bridge = o.bridge ? 'yes' : 'no';
  for (const [k, v] of Object.entries(o.tags ?? {})) {
    if (v === null) delete tags[k];
    else tags[k] = v;
  }
}
