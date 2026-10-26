import * as THREE from 'three';

// A gradient sky dome: zenith blue fading to the fog colour at the horizon,
// so distant terrain melts into the sky instead of meeting a flat backdrop,
// with a soft glow round the sun. One draw call; it follows the camera so it
// never gets any closer. It isn't tone mapped: the fog is mixed in after
// tone mapping (three's fog_fragment), so the horizon must come out as the
// fog colour exactly, or every distant building would show a seam.

const ZENITH = 0x6f9ccc;
const GLOW = new THREE.Color(0xfff3dc);

export class Sky {
  readonly mesh: THREE.Mesh;

  constructor(horizon: THREE.Color, radius: number, zenith = ZENITH, sunDir?: THREE.Vector3) {
    const geo = new THREE.SphereGeometry(radius, 32, 16);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const top = new THREE.Color(zenith);
    const sun = sunDir?.clone().normalize();
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).divideScalar(radius);
      const t = THREE.MathUtils.clamp(p.y, 0, 1);
      c.copy(horizon).lerp(top, Math.pow(t, 0.55));
      if (sun) c.lerp(GLOW, 0.55 * Math.pow(Math.max(p.dot(sun), 0), 6));
      c.toArray(colors, i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false }),
    );
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
  }
}
