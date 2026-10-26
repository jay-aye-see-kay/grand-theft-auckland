// OSM data model and XML parser for the city generator.
//
// The API's /map call returns every way that touches the bbox (with all of
// its nodes) plus relations that reference anything returned, so tiles
// overlap. mergeOsm() dedupes by id; later tasks consume the merged OsmData.
import { readFileSync } from 'node:fs';
import { lonLatToLocal, type BBox, type Local } from './project.ts';

export type Tags = Record<string, string>;
export type OsmNode = { id: number; version: number; lat: number; lon: number; tags: Tags };
export type OsmWay = { id: number; version: number; nodes: number[]; tags: Tags };
export type OsmMember = { type: 'node' | 'way' | 'relation'; ref: number; role: string };
export type OsmRelation = { id: number; version: number; members: OsmMember[]; tags: Tags };
export type OsmData = {
  nodes: Map<number, OsmNode>;
  ways: Map<number, OsmWay>;
  relations: Map<number, OsmRelation>;
};

/** Highway classes cars can drive on, from biggest to smallest. */
export const DRIVEABLE_HIGHWAYS = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'service', 'pedestrian',
] as const;

export function emptyOsm(): OsmData {
  return { nodes: new Map(), ways: new Map(), relations: new Map() };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
}

/**
 * Parses OSM API 0.6 XML. The format is machine-written and flat, so a regex
 * scanner is enough and avoids an XML dependency.
 */
export function parseOsmXml(xml: string, into: OsmData = emptyOsm()): OsmData {
  const open = /<(node|way|relation)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    const kind = m[1] as 'node' | 'way' | 'relation';
    const a = attrs(m[2]);
    let body = '';
    if (m[3] !== '/') {
      const close = xml.indexOf(`</${kind}>`, open.lastIndex);
      if (close < 0) throw new Error(`unterminated <${kind} id=${a.id}>`);
      body = xml.slice(open.lastIndex, close);
      open.lastIndex = close;
    }
    if (a.visible === 'false') continue;
    const tags: Tags = {};
    const nds: number[] = [];
    const members: OsmMember[] = [];
    for (const c of body.matchAll(/<(tag|nd|member)\b([^>]*?)\/>/g)) {
      const ca = attrs(c[2]);
      if (c[1] === 'tag') tags[ca.k] = ca.v;
      else if (c[1] === 'nd') nds.push(Number(ca.ref));
      else members.push({ type: ca.type as OsmMember['type'], ref: Number(ca.ref), role: ca.role ?? '' });
    }
    const id = Number(a.id);
    const version = Number(a.version ?? 0);
    if (kind === 'node') keepNewer(into.nodes, { id, version, lat: Number(a.lat), lon: Number(a.lon), tags });
    else if (kind === 'way') keepNewer(into.ways, { id, version, nodes: nds, tags });
    else keepNewer(into.relations, { id, version, members, tags });
  }
  return into;
}

function keepNewer<T extends { id: number; version: number }>(map: Map<number, T>, el: T) {
  const old = map.get(el.id);
  if (!old || old.version < el.version) map.set(el.id, el);
}

/** Parses and merges OSM XML files (e.g. cached tiles), deduped by id and sorted by id for determinism. */
export function loadOsmFiles(paths: string[]): OsmData {
  const data = emptyOsm();
  for (const p of paths) parseOsmXml(readFileSync(p, 'utf8'), data);
  const sorted = <T>(m: Map<number, T>) => new Map([...m].sort((a, b) => a[0] - b[0]));
  return { nodes: sorted(data.nodes), ways: sorted(data.ways), relations: sorted(data.relations) };
}

/** A way's nodes in local metres. Missing nodes (outside the fetched area) are skipped. */
export function wayLocal(data: OsmData, way: OsmWay): Local[] {
  const out: Local[] = [];
  for (const ref of way.nodes) {
    const n = data.nodes.get(ref);
    if (n) out.push(lonLatToLocal(n.lon, n.lat));
  }
  return out;
}

export function isClosed(way: OsmWay): boolean {
  return way.nodes.length >= 4 && way.nodes[0] === way.nodes[way.nodes.length - 1];
}

export function isBuilding(tags: Tags): boolean {
  return tags.building !== undefined && tags.building !== 'no';
}

export function wayInBBox(data: OsmData, way: OsmWay, bbox: BBox): boolean {
  const [w, s, e, n] = bbox;
  return way.nodes.some((ref) => {
    const p = data.nodes.get(ref);
    return !!p && p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n;
  });
}

/** Ways with a given tag value, e.g. waysNamed(data, 'Queen Street'). */
export function waysNamed(data: OsmData, name: string): OsmWay[] {
  return [...data.ways.values()].filter((w) => w.tags.name === name);
}
