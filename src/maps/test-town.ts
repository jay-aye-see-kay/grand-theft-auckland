import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameMap } from './types.ts';

// Placeholder test town from M0/M1 (?map=test): a flat grid of blocks with
// roads, kerbs, a few ramps and some crates to smash. Handy for handling
// work away from Auckland's hills. Everything static is merged into a
// handful of meshes to keep draw calls low.

const BLOCKS = 7;
const BLOCK = 56; // block size, m
const ROAD = 14; // road width, m
const CELL = BLOCK + ROAD;
const SIZE = BLOCKS * CELL + ROAD;
const HALF = SIZE / 2;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function coloured(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) color.toArray(colors, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

function addStaticBox(world: RAPIER.World, body: RAPIER.RigidBody, hx: number, hy: number, hz: number, pos: THREE.Vector3, rot?: THREE.Quaternion) {
  const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(pos.x, pos.y, pos.z).setFriction(0.9);
  if (rot) desc.setRotation(rot);
  world.createCollider(desc, body);
}

export function buildTestTown(scene: THREE.Scene, world: RAPIER.World): GameMap {
  const rand = rng(1995);
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  // Ground: asphalt for the town, grass beyond it.
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x5f8f4a }),
  );
  grass.position.y = -0.25; // well below the asphalt to avoid z-fighting at distance
  scene.add(grass);
  const asphalt = new THREE.Mesh(
    new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x3b3d40 }),
  );
  scene.add(asphalt);
  // Flat heightfield for the ground. One giant thin box would be simpler, but
  // Rapier's character controller loses precision against it and the player
  // sinks and sticks. A heightfield also gives us hills later (M2).
  const cells = 8;
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(cells, cells, new Float32Array((cells + 1) * (cells + 1)), { x: 4000, y: 1, z: 4000 }).setFriction(0.9),
    ground,
  );

  const statics: THREE.BufferGeometry[] = [];
  const markings: THREE.BufferGeometry[] = [];
  const footpath = new THREE.Color(0xa7a49c);
  const palette = [0xe8dcc8, 0xc9d6df, 0xd9b99b, 0x9fb4c7, 0xf2e3b3, 0xb8c4b0, 0xd6a59a, 0x8e9aa6].map((c) => new THREE.Color(c));

  const blockCentre = (i: number) => -HALF + ROAD + BLOCK / 2 + i * CELL;
  const plaza = Math.floor(BLOCKS / 2);
  const towerBlock = { i: plaza + 1, j: plaza - 1 };

  for (let i = 0; i < BLOCKS; i++) {
    for (let j = 0; j < BLOCKS; j++) {
      const cx = blockCentre(i);
      const cz = blockCentre(j);
      const isPlaza = i === plaza && j === plaza;

      // Raised footpath slab: a kerb you can bounce over.
      const kerbH = 0.15;
      statics.push(coloured(new THREE.BoxGeometry(BLOCK, kerbH, BLOCK).translate(cx, kerbH / 2, cz), footpath));
      addStaticBox(world, ground, BLOCK / 2, kerbH / 2, BLOCK / 2, new THREE.Vector3(cx, kerbH / 2, cz));

      if (isPlaza || (i === towerBlock.i && j === towerBlock.j)) continue;

      // Four lots per block, each a box building of random height.
      const lot = BLOCK / 2;
      for (const ox of [-1, 1]) {
        for (const oz of [-1, 1]) {
          if (rand() < 0.12) continue; // empty lot / car park
          const w = lot - 4 - rand() * 6;
          const d = lot - 4 - rand() * 6;
          const centralness = 1 - Math.hypot(i - plaza, j - plaza) / BLOCKS;
          const h = 6 + rand() * 18 + centralness * centralness * rand() * 70;
          const x = cx + (ox * lot) / 2;
          const z = cz + (oz * lot) / 2;
          const color = palette[Math.floor(rand() * palette.length)];
          statics.push(coloured(new THREE.BoxGeometry(w, h, d).translate(x, kerbH + h / 2, z), color));
          addStaticBox(world, ground, w / 2, h / 2, d / 2, new THREE.Vector3(x, kerbH + h / 2, z));
          // Darker band of "windows" around each storey-ish, cheap and readable.
          const bandColor = color.clone().multiplyScalar(0.6);
          for (let y = 3; y < h - 1; y += 3.5) {
            statics.push(coloured(new THREE.BoxGeometry(w + 0.1, 1.2, d + 0.1).translate(x, kerbH + y, z), bandColor));
          }
        }
      }
    }
  }

  // Road markings: dashed centre lines along every road.
  const white = new THREE.Color(0xe8e8e0);
  for (let k = 0; k <= BLOCKS; k++) {
    const roadCentre = -HALF + ROAD / 2 + k * CELL;
    for (let t = -HALF; t < HALF; t += 6) {
      markings.push(coloured(new THREE.PlaneGeometry(3, 0.18).rotateX(-Math.PI / 2).translate(t + 1.5, 0.01, roadCentre), white));
      markings.push(coloured(new THREE.PlaneGeometry(0.18, 3).rotateX(-Math.PI / 2).translate(roadCentre, 0.01, t + 1.5), white));
    }
  }

  // Ramps in the central plaza.
  const rampColor = new THREE.Color(0xd0a040);
  const cx = blockCentre(plaza);
  const cz = blockCentre(plaza);
  const ramps = [
    { x: cx - 12, z: cz, yaw: 0, angle: 0.22 },
    { x: cx + 14, z: cz + 14, yaw: Math.PI / 2, angle: 0.3 },
    { x: cx + 14, z: cz - 14, yaw: Math.PI, angle: 0.16 },
  ];
  for (const r of ramps) {
    const len = 10;
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r.yaw, r.angle, 'YXZ'));
    const lift = Math.sin(r.angle) * (len / 2);
    const pos = new THREE.Vector3(r.x, lift - 0.15, r.z);
    const geo = new THREE.BoxGeometry(len, 0.4, 6);
    geo.applyQuaternion(rot).translate(pos.x, pos.y, pos.z);
    statics.push(coloured(geo, rampColor));
    addStaticBox(world, ground, len / 2, 0.2, 3, pos, rot);
  }

  // Placeholder Sky Tower so there's always a landmark to steer by.
  const towerX = blockCentre(towerBlock.i);
  const towerZ = blockCentre(towerBlock.j);
  const concrete = new THREE.Color(0xd8d8d4);
  statics.push(coloured(new THREE.CylinderGeometry(3.2, 6, 186, 12).translate(towerX, 93, towerZ), concrete));
  statics.push(coloured(new THREE.CylinderGeometry(11, 9, 14, 16).translate(towerX, 192, towerZ), concrete));
  statics.push(coloured(new THREE.CylinderGeometry(11.6, 11.6, 4, 16).translate(towerX, 190, towerZ), new THREE.Color(0x4a6b85)));
  statics.push(coloured(new THREE.CylinderGeometry(7, 7, 6, 12).translate(towerX, 202, towerZ), concrete));
  statics.push(coloured(new THREE.CylinderGeometry(0.6, 1.6, 120, 6).translate(towerX, 265, towerZ), new THREE.Color(0xeeeeee)));
  addStaticBox(world, ground, 5, 100, 5, new THREE.Vector3(towerX, 100, towerZ));

  const staticMesh = new THREE.Mesh(mergeGeometries(statics), new THREE.MeshLambertMaterial({ vertexColors: true }));
  scene.add(staticMesh);
  const markingMesh = new THREE.Mesh(mergeGeometries(markings), new THREE.MeshBasicMaterial({ vertexColors: true }));
  scene.add(markingMesh);

  // Crates to plough through, drawn as one instanced mesh.
  const crateSize = 1;
  const crateCount = 24;
  const crates = new THREE.InstancedMesh(
    new THREE.BoxGeometry(crateSize, crateSize, crateSize),
    new THREE.MeshLambertMaterial({ color: 0xb07a3c }),
    crateCount,
  );
  const crateBodies: RAPIER.RigidBody[] = [];
  for (let n = 0; n < crateCount; n++) {
    const row = Math.floor(n / 6);
    const col = n % 6;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(cx - 6 + col * 1.05, 0.65 + row * 1.01, cz - 18),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(crateSize / 2, crateSize / 2, crateSize / 2).setDensity(40), body);
    crateBodies.push(body);
  }
  scene.add(crates);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const sync = () => {
    for (const [n, b] of crateBodies.entries()) {
      const t = b.translation();
      const r = b.rotation();
      crates.setMatrixAt(n, m.compose(p.set(t.x, t.y, t.z), q.set(r.x, r.y, r.z, r.w), one));
    }
    crates.instanceMatrix.needsUpdate = true;
  };
  sync();

  // heading 0 faces +x (east), PI/2 faces -z (north). NZ parks on the left.
  const parking = [
    // Purple '95 Corolla on the road west of the plaza, lined up with the first ramp.
    { pos: new THREE.Vector3(cx - BLOCK / 2 - ROAD / 2, 1.2, cz), heading: 0, paint: 0x7a3db8 },
    { pos: new THREE.Vector3(cx - 6, 1.2, cz + BLOCK / 2 + ROAD / 2 - 3.5), heading: 0, paint: 0xe9e9e4 },
    { pos: new THREE.Vector3(cx + BLOCK / 2 + ROAD / 2 - 3.5, 1.2, cz + 8), heading: Math.PI / 2, paint: 0xa9adb3 },
    { pos: new THREE.Vector3(cx + 10, 1.2, cz - BLOCK / 2 - ROAD / 2 + 3.5), heading: Math.PI, paint: 0x6e1a24 },
  ];

  return {
    name: 'test',
    blurb: "Test town · purple '95 sedan · get in, get out, make some noise",
    atmosphere: { sky: 0xf2b27a, fogNear: 120, fogFar: 520, far: 1200 },
    parking,
    // By the driver's door (right-hand drive) of the purple Corolla.
    spawn: { feet: parking[0].pos.clone().add(new THREE.Vector3(0.5, -1.2, 2.2)), heading: 0 },
    heightAt: () => 0,
    hasGround: () => true,
    clamp: (x, z) => ({ x: THREE.MathUtils.clamp(x, -HALF, HALF), z: THREE.MathUtils.clamp(z, -HALF, HALF) }),
    ensureLoaded: async () => {},
    update: () => {},
    sync,
    debugInfo: () => ({}),
  };
}
