// Construction years and architectural styles for buildings with a
// `wikidata` tag (about 12% in the CBD, mostly the notable ones), for their
// era (eras.ts). Fetched once from the Wikidata Query Service and committed
// as tools/citygen/data/wikidata-<area>.json, so builds stay offline and
// deterministic; re-run to refresh:
//
//   NODE_USE_ENV_PROXY=1 node --experimental-strip-types tools/citygen/wikidata.ts
//
// The query service answers from the Claude sandbox; the wbgetentities API
// is rate-limited there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadCityData } from './fetch.ts';
import { CBD_BBOX } from './project.ts';

export type WikidataFacts = { year?: number; styles?: string[] };

const SPARQL = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'grand-theft-auckland-citygen/0.1 (offline map generator; https://github.com/jay-aye-see-kay/grand-theft-auckland)';
const fileFor = (area: string) => new URL(`./data/wikidata-${area}.json`, import.meta.url);

/** The committed facts for an area, keyed by QID ('Q123'); empty if never fetched. */
export function loadWikidata(area: string): Map<string, WikidataFacts> {
  const file = fileFor(area);
  if (!existsSync(file)) return new Map();
  return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, WikidataFacts>));
}

async function query(qids: string[]): Promise<Map<string, WikidataFacts>> {
  // Inception (P571), else official opening (P1619); style (P149) by English label.
  const q = `SELECT ?item ?inception ?opened ?styleLabel WHERE {
  VALUES ?item { ${qids.map((id) => `wd:${id}`).join(' ')} }
  OPTIONAL { ?item wdt:P571 ?inception }
  OPTIONAL { ?item wdt:P1619 ?opened }
  OPTIONAL { ?item wdt:P149 ?style }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
  const res = await fetch(SPARQL, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query: q }),
  });
  if (!res.ok) throw new Error(`Wikidata query: HTTP ${res.status}`);
  type Binding = Record<string, { value: string } | undefined>;
  const json = (await res.json()) as { results: { bindings: Binding[] } };
  const out = new Map<string, WikidataFacts>();
  for (const b of json.results.bindings) {
    const id = b.item!.value.split('/').pop()!;
    const f = out.get(id) ?? {};
    const date = b.inception?.value ?? b.opened?.value;
    const year = date ? Number(/^-?(\d{4})/.exec(date)?.[1]) : NaN;
    // The earliest date wins (a later refurbishment is sometimes listed too).
    if (year > 0 && !(f.year! <= year)) f.year = year;
    const style = b.styleLabel?.value;
    if (style && !/^Q\d+$/.test(style)) f.styles = [...new Set([...(f.styles ?? []), style])].sort();
    out.set(id, f);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await loadCityData(CBD_BBOX);
  const qids = new Set<string>();
  for (const e of [...data.osm.ways.values(), ...data.osm.relations.values()]) {
    const id = e.tags.wikidata;
    if ((e.tags.building || e.tags['building:part']) && id && /^Q\d+$/.test(id)) qids.add(id);
  }
  const ids = [...qids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  console.log(`${ids.length} buildings with a wikidata tag`);
  const facts = new Map<string, WikidataFacts>();
  for (let k = 0; k < ids.length; k += 100) {
    for (const [id, f] of await query(ids.slice(k, k + 100))) if (f.year || f.styles) facts.set(id, f);
  }
  const sorted = Object.fromEntries([...facts].sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1))));
  mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
  // One line per building keeps diffs small.
  writeFileSync(fileFor('cbd'), `{\n${Object.entries(sorted).map(([id, f]) => `  ${JSON.stringify(id)}: ${JSON.stringify(f)}`).join(',\n')}\n}\n`);
  console.log(`${facts.size} with a year or style: ${[...facts.values()].filter((f) => f.year).length} years, ${[...facts.values()].filter((f) => f.styles).length} styles`);
}
