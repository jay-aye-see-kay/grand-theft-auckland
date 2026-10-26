// Kerbside parking spots and the player's spawn, derived from OSM road
// centrelines and the terrain the game drives on. Written to
// public/city/<area>/parking.json, which the game reads at start-up.
//
//   node --experimental-strip-types tools/citygen/parking.ts
//
// (build.ts also writes it, so a full rebuild keeps it in step.)
//
// Each spot is picked by hand (an OSM way plus a point near where the car
// should go) and then posed from the data: the car is turned to the road's
// direction of travel, pushed to the left kerb (NZ drives on the left),
// pitched and rolled to the terrain under its four wheels, and checked
// against junctions and building footprints. If the requested point fails a
// check, the nearest good point along the same way is used instead.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLength, collectSolids, inRing, type Solid } from './buildings.ts';
import { loadCityData, type CityData } from './fetch.ts';
import { CBD_BBOX, type Local } from './project.ts';
import { Overrides } from './overrides.ts';
import { layPiers } from './piers.ts';
import { collectRoads } from './roads.ts';
import { TerrainSampler } from './terrain.ts';

/** Matches src/corolla.ts (COROLLA). */
const CAR = { length: 4.27, width: 1.685, wheelbase: 2.465, track: 1.46 };
/** Gap between the car's side and the edge of the carriageway, m. */
const KERB_GAP = 0.3;
/** Chassis centre above the ground under the wheels once settled on the suspension, plus a small drop. */
const RIDE_HEIGHT = 0.68;
/** Keep the car's centre this far from any junction node, m. */
const JUNCTION_CLEAR = 10;
/** Steepest slope (rise over run, either axis) a spot may have. */
const MAX_GRADE = 0.25;
/** How far along the way to look for a valid spot either side of the requested one, m. */
const SEARCH = 60;

type Request = {
  /** OSM way id of the carriageway. */
  way: number;
  /** Roughly where the car should go (nearest point on the way is used). */
  near: [number, number];
  /** Park facing against the way's node order (two-way streets only). */
  reverse?: boolean;
  paint: number;
};

/** The player's purple Corolla comes first; the rest are scattered round the CBD. */
const REQUESTS: Request[] = [
  // Galway St, on the plaza side outside Britomart station (Chief Post Office), facing east.
  { way: 926609653, near: [-20, 20], reverse: true, paint: 0x7a3db8 },
  // Commerce St, round the corner from Britomart.
  { way: 149508232, near: [8, 52], paint: 0xe9e9e4 },
  // Lower Queen St, just up from Customs St.
  { way: 1060960693, near: [-135, 78], paint: 0xa9adb3 },
  // Queen St between Victoria St and Wellesley St, uphill.
  { way: 52729793, near: [-228, 430], paint: 0x6e1a24 },
  // Albert St, climbing from Customs St.
  { way: 624534623, near: [-280, 115], reverse: true, paint: 0x1d2c55 },
  // Shortland St, on the slope up from Queen St.
  { way: 1423232816, near: [-50, 270], reverse: true, paint: 0x2f5a3c },
  // Victoria St West.
  { way: 605652622, near: [-290, 503], paint: 0xc8b48a },
  // Upper Queen St on the steep climb to K Road.
  { way: 448067166, near: [-523, 1270], paint: 0xb0201c },
  // Karangahape Road.
  { way: 52729424, near: [-700, 1495], reverse: true, paint: 0x1b1b1d },
];

export type ParkedCar = {
  /** 'way/123' */
  osm: string;
  name: string;
  /** Chassis centre, local metres. */
  x: number;
  y: number;
  z: number;
  /** About +y; 0 faces +x (east), PI/2 faces -z (north). */
  heading: number;
  /** Nose up, radians (about the car's local z). */
  pitch: number;
  /** Left side up, radians (about the car's local x). */
  roll: number;
  paint: number;
};

export type Parking = {
  /** Player's feet and facing at the start: on foot beside the first car. */
  spawn: { x: number; y: number; z: number; heading: number };
  cars: ParkedCar[];
};

const round = (v: number, step: number) => Math.round(v / step) * step;
const r2 = (v: number) => Number(round(v, 0.01).toFixed(2));
const r4 = (v: number) => Number(v.toFixed(4));

export function buildParking(data: CityData, terrain = new TerrainSampler(data.dem)): Parking {
  const roads = collectRoads(data.osm);
  const byId = new Map(roads.map((r) => [r.id, r]));
  const nodeUse = new Map<number, number>();
  for (const r of roads) for (const n of new Set(r.nodes)) nodeUse.set(n, (nodeUse.get(n) ?? 0) + 1);
  // Only ground-level, walk-under-able-not footprints block a car (canopies and roofs don't).
  const solids = collectSolids(data.osm).filter((s) => s.tags.building !== 'roof' && !(parseLength(s.tags.min_height) > 2));
  const inBuilding = (x: number, z: number): Solid | undefined =>
    solids.find((s) => s.polygons.some((p) => inRing(p.outer, x, z) && !p.holes.some((h) => inRing(h, x, z))));

  const cars: ParkedCar[] = [];
  for (const req of REQUESTS) {
    const road = byId.get(req.way);
    if (!road) throw new Error(`parking: way ${req.way} is not a road`);
    if (road.bridge) throw new Error(`parking: way ${req.way} is a bridge`);
    const tags = data.osm.ways.get(req.way)!.tags;
    const reverse = tags.oneway === '-1' ? !req.reverse : !!req.reverse;
    if (reverse && tags.oneway === 'yes') throw new Error(`parking: way ${req.way} is one-way; can't park facing against it`);
    const total = road.s[road.s.length - 1];
    const junctions = road.nodes.map((n, k) => ({ n, k })).filter(({ n, k }) => (nodeUse.get(n) ?? 0) > 1 || k === 0 || k === road.nodes.length - 1);

    /** Point and unit direction of travel at arc length s. */
    const at = (s: number) => {
      let k = 0;
      while (k < road.s.length - 2 && road.s[k + 1] < s) k++;
      const a = road.pts[k];
      const b = road.pts[k + 1];
      const len = road.s[k + 1] - road.s[k];
      const f = Math.min(1, Math.max(0, (s - road.s[k]) / len));
      let dx = (b.x - a.x) / len;
      let dz = (b.z - a.z) / len;
      if (reverse) {
        dx = -dx;
        dz = -dz;
      }
      return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, dx, dz };
    };
    // Nearest arc length to the requested point.
    let s0 = 0;
    let best = Infinity;
    for (let s = 0; s <= total; s += 0.5) {
      const p = at(s);
      const d = Math.hypot(p.x - req.near[0], p.z - req.near[1]);
      if (d < best) {
        best = d;
        s0 = s;
      }
    }

    const tryAt = (s: number): { car: ParkedCar; why?: undefined } | { car?: undefined; why: string } => {
      const c = at(s);
      // Left of travel: facing east (+x), north (-z) is on your left.
      const lx = c.dz;
      const lz = -c.dx;
      const lateral = Math.max(0, road.width / 2 - CAR.width / 2 - KERB_GAP);
      const x = c.x + lx * lateral;
      const z = c.z + lz * lateral;
      for (const { n, k } of junctions) {
        if (Math.hypot(road.pts[k].x - x, road.pts[k].z - z) < JUNCTION_CLEAR) return { why: `near node ${n}` };
      }
      const corner = (fwd: number, left: number): Local => ({ x: x + c.dx * fwd + lx * left, z: z + c.dz * fwd + lz * left });
      const hl = CAR.length / 2;
      const hw = CAR.width / 2;
      for (const p of [corner(hl, hw), corner(hl, -hw), corner(-hl, hw), corner(-hl, -hw), { x, z }]) {
        const b = inBuilding(p.x, p.z);
        if (b) return { why: `inside ${b.key}` };
      }
      const wb = CAR.wheelbase / 2;
      const tr = CAR.track / 2;
      const h = (p: Local) => terrain.heightAt(p.x, p.z);
      const fl = h(corner(wb, tr));
      const fr = h(corner(wb, -tr));
      const rl = h(corner(-wb, tr));
      const rr = h(corner(-wb, -tr));
      const pitch = Math.atan2((fl + fr - rl - rr) / 2, CAR.wheelbase);
      const roll = Math.atan2((fl + rl - fr - rr) / 2, CAR.track);
      if (Math.abs(Math.tan(pitch)) > MAX_GRADE || Math.abs(Math.tan(roll)) > MAX_GRADE) return { why: 'too steep' };
      const ground = (fl + fr + rl + rr) / 4;
      return {
        car: {
          osm: `way/${req.way}`,
          name: tags.name ?? '',
          x: r2(x),
          y: r2(ground + RIDE_HEIGHT / Math.cos(pitch) / Math.cos(roll)),
          z: r2(z),
          heading: r4(Math.atan2(-c.dz, c.dx)),
          pitch: r4(pitch),
          roll: r4(roll),
          paint: req.paint,
        },
      };
    };

    let found: ParkedCar | undefined;
    let first = '';
    for (let d = 0; d <= SEARCH && !found; d += 1) {
      for (const s of d ? [s0 + d, s0 - d] : [s0]) {
        if (s < 0 || s > total) continue;
        const r = tryAt(s);
        if (r.car) {
          found = r.car;
          break;
        }
        first ||= r.why;
      }
    }
    if (!found) throw new Error(`parking: no valid spot on way ${req.way} near ${req.near} (${first})`);
    cars.push(found);
  }

  // On foot on the kerb side of the purple Corolla, level with its front
  // door, looking along the street past the bonnet.
  const p = cars[0];
  const fx = Math.cos(p.heading);
  const fz = -Math.sin(p.heading);
  const sx = p.x + fz * 2.6 + fx * 0.6;
  const sz = p.z - fx * 2.6 + fz * 0.6;
  const spawn = { x: r2(sx), y: r2(terrain.heightAt(sx, sz)), z: r2(sz), heading: r4(SPAWN_HEADING) };
  if (inBuilding(sx, sz)) throw new Error(`parking: spawn (${sx}, ${sz}) is inside ${inBuilding(sx, sz)!.key}`);
  return { spawn, cars };
}

/** Which way the player faces at the start: west-north-west, at Britomart's Chief Post Office. */
const SPAWN_HEADING = Math.atan2(0.35, -1);

export function writeParking(parking: Parking, path: string) {
  const lines = parking.cars.map((c) => `    ${JSON.stringify(c)}`);
  writeFileSync(path, `{\n  "spawn": ${JSON.stringify(parking.spawn)},\n  "cars": [\n${lines.join(',\n')}\n  ]\n}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await loadCityData(CBD_BBOX);
  const overrides = Overrides.load('cbd');
  overrides.apply(data.osm); // same corrected data as build.ts
  layPiers(data.osm, data.dem, overrides);
  const parking = buildParking(data);
  const out = fileURLToPath(new URL('../../public/city/cbd/parking.json', import.meta.url));
  writeParking(parking, out);
  for (const c of parking.cars) {
    console.log(`${c.osm} ${c.name}: (${c.x}, ${c.z}) y ${c.y}, pitch ${(c.pitch * 57.3).toFixed(1)}°, roll ${(c.roll * 57.3).toFixed(1)}°`);
  }
  console.log(`Spawn (${parking.spawn.x}, ${parking.spawn.z}) y ${parking.spawn.y}. Wrote ${out}`);
}
