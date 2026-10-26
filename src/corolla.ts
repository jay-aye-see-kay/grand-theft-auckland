import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Low-poly 1995 (E100-generation) Corolla sedan, built from extruded side
// profiles so it has the right silhouette without any external assets.
// Local frame: +x is forward, +y is up, +z is the car's right side.
// y = 0 is the underside of the body; the car's origin sits at mid-length.

export const COROLLA = {
  length: 4.27,
  width: 1.685,
  height: 1.385,
  wheelbase: 2.465,
  track: 1.46,
  wheelRadius: 0.3,
  wheelWidth: 0.19,
  paint: 0x7a3db8, // purple mica
};

const L = COROLLA.length / 2;

// Lower body (bumpers, doors, bonnet, boot) side profile, front at +x.
const bodyProfile: [number, number][] = [
  [-L + 0.02, 0.0],
  [L - 0.04, 0.0],
  [L + 0.02, 0.28],
  [L - 0.02, 0.5],
  [L - 0.18, 0.62], // nose
  [0.9, 0.72], // base of windscreen
  [-1.4, 0.76], // base of rear window
  [-L + 0.06, 0.74], // boot lid
  [-L, 0.5],
  [-L + 0.02, 0.28],
];

// Glasshouse profile, sitting on the belt line.
const cabinProfile: [number, number][] = [
  [0.92, 0.71],
  [-1.42, 0.75],
  [-0.82, 1.14],
  [0.22, 1.16],
];

function extrude(points: [number, number][], depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 1,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

export interface CorollaModel {
  root: THREE.Group;
  /** Brake lights, so the car can light them up. */
  brakeLights: THREE.MeshStandardMaterial;
}

export function buildCorolla(paintColor = COROLLA.paint): CorollaModel {
  const root = new THREE.Group();
  root.name = 'corolla';

  const paint = new THREE.MeshStandardMaterial({ color: paintColor, metalness: 0.5, roughness: 0.35 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2430, metalness: 0.2, roughness: 0.1 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xcfd3d6, metalness: 0.9, roughness: 0.25 });
  const headlight = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff1c0, emissiveIntensity: 0.6 });
  const amber = new THREE.MeshStandardMaterial({ color: 0xffa020, emissive: 0x803000, emissiveIntensity: 0.4 });
  const brakeLights = new THREE.MeshStandardMaterial({ color: 0xb01010, emissive: 0xff1010, emissiveIntensity: 0.15 });

  const halfW = COROLLA.width / 2;

  // Body and glasshouse. The cabin is narrower than the body (tumblehome).
  root.add(new THREE.Mesh(extrude(bodyProfile, COROLLA.width - 0.08), paint));
  root.add(new THREE.Mesh(extrude(cabinProfile, COROLLA.width - 0.34), glass));

  // Painted roof skin and B-pillars over the glass.
  const roof = box(1.0, 0.04, COROLLA.width - 0.36, paint, -0.3, 1.19, 0);
  root.add(roof);
  for (const side of [-1, 1]) {
    const pillar = box(0.1, 0.42, 0.04, paint, -0.25, 0.94, side * (halfW - 0.13));
    root.add(pillar);
  }

  // Black rubbing strips down the doors and across the bumpers.
  for (const side of [-1, 1]) {
    root.add(box(3.2, 0.06, 0.03, trim, -0.1, 0.38, side * (halfW + 0.01)));
  }
  root.add(box(0.04, 0.08, COROLLA.width - 0.2, trim, L + 0.03, 0.3, 0));
  root.add(box(0.04, 0.08, COROLLA.width - 0.2, trim, -L - 0.01, 0.3, 0));

  // Front: wide slim headlights, small grille, amber corners.
  for (const side of [-1, 1]) {
    root.add(box(0.06, 0.13, 0.42, headlight, L - 0.06, 0.5, side * 0.5));
    root.add(box(0.06, 0.1, 0.1, amber, L - 0.1, 0.5, side * (halfW - 0.08)));
  }
  root.add(box(0.05, 0.1, 0.5, trim, L - 0.02, 0.5, 0));
  root.add(box(0.03, 0.02, 0.12, chrome, L + 0.0, 0.5, 0)); // badge

  // Rear: full-width tail light band with a garnish panel in the middle.
  for (const side of [-1, 1]) {
    root.add(box(0.05, 0.16, 0.48, brakeLights, -L + 0.02, 0.6, side * 0.55));
  }
  root.add(box(0.05, 0.12, 0.6, trim, -L + 0.02, 0.6, 0));

  // Mirrors and door handles.
  for (const side of [-1, 1]) {
    root.add(box(0.12, 0.1, 0.12, trim, 0.72, 0.84, side * (halfW + 0.04)));
    root.add(box(0.12, 0.03, 0.02, trim, 0.25, 0.62, side * (halfW + 0.01)));
    root.add(box(0.12, 0.03, 0.02, trim, -0.75, 0.62, side * (halfW + 0.01)));
  }

  // Wheel arches: dark boxes so the wheels read against the body.
  for (const x of [COROLLA.wheelbase / 2, -COROLLA.wheelbase / 2]) {
    for (const side of [-1, 1]) {
      root.add(box(0.72, 0.38, 0.06, trim, x, 0.17, side * (halfW - 0.05)));
    }
  }

  // ~35 parts would be ~35 draw calls per car; bake them down to 4.
  const body = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.45 });
  return { root: bake(root, [headlight, amber, brakeLights], body), brakeLights };
}

/** One wheel: tyre plus hubcap, spinning about its local z axis. */
export function buildWheel(): THREE.Group {
  const wheel = new THREE.Group();
  const tyre = new THREE.Mesh(
    new THREE.CylinderGeometry(COROLLA.wheelRadius, COROLLA.wheelRadius, COROLLA.wheelWidth, 14),
    new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }),
  );
  tyre.rotation.x = Math.PI / 2;
  wheel.add(tyre);
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.19, 0.19, COROLLA.wheelWidth + 0.02, 8),
    new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.7, roughness: 0.35 }),
  );
  hub.rotation.x = Math.PI / 2;
  wheel.add(hub);
  // A spoke so you can see the wheels turn.
  const spoke = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.05, COROLLA.wheelWidth + 0.04),
    new THREE.MeshStandardMaterial({ color: 0x55595d, metalness: 0.5, roughness: 0.5 }),
  );
  wheel.add(spoke);
  return bake(wheel, [], wheelMaterial);
}

const wheelMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.6 });

/**
 * Merge a group of meshes into one mesh per listed material, plus one mesh
 * for everything else with each part's colour baked into vertex colours.
 */
function bake(group: THREE.Group, keep: THREE.Material[], rest: THREE.Material): THREE.Group {
  group.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = o.material as THREE.MeshStandardMaterial;
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    g.deleteAttribute('uv');
    const colors = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) mat.color.toArray(colors, i);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const target = keep.includes(mat) ? mat : rest;
    buckets.set(target, [...(buckets.get(target) ?? []), g]);
  });
  const out = new THREE.Group();
  for (const [mat, geos] of buckets) out.add(new THREE.Mesh(mergeGeometries(geos), mat));
  return out;
}
