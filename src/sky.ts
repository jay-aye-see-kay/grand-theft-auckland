import * as THREE from 'three';

// A gradient sky dome: zenith blue fading to the fog colour at the horizon,
// so distant terrain melts into the sky instead of meeting a flat backdrop.
// One draw call; it follows the camera so it never gets any closer.

const ZENITH = new THREE.Color(0x6f9ccc);

export class Sky {
  readonly mesh: THREE.Mesh;

  constructor(horizon: THREE.Color, radius: number) {
    const geo = new THREE.SphereGeometry(radius, 24, 12);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.clamp(pos.getY(i) / radius, 0, 1);
      c.copy(horizon).lerp(ZENITH, Math.pow(t, 0.6)).toArray(colors, i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
  }
}
