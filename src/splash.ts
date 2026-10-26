import * as THREE from 'three';

// A splash: a burst of white droplets thrown up and falling back, as one
// THREE.Points (one draw call, and none at all while nothing's splashing).
// Several splashes can overlap; they share the particle pool.

const COUNT = 96;
const LIFE = 1.4;
const GRAVITY = 9.81;

export class Splash {
  readonly points: THREE.Points;
  private readonly pos = new Float32Array(COUNT * 3);
  private readonly vel = new Float32Array(COUNT * 3);
  private readonly age = new Float32Array(COUNT).fill(LIFE);
  private readonly floor = new Float32Array(COUNT);
  private next = 0;
  /** How many splashes so far (for the smoke test). */
  count = 0;

  constructor() {
    for (let k = 0; k < COUNT; k++) this.pos[k * 3 + 1] = -1e4; // parked out of sight until thrown
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.PointsMaterial({ color: 0xeef6f4, size: 0.3, map: droplet(), transparent: true, opacity: 0.9, depthWrite: false });
    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.name = 'splash';
  }

  /** Throw up `n` droplets at `at` (on the water surface), harder for a bigger `strength` (0..1). */
  burst(at: THREE.Vector3, strength: number, n = COUNT / 2): void {
    this.count++;
    const s = THREE.MathUtils.clamp(strength, 0.2, 1);
    for (let i = 0; i < n; i++) {
      const k = this.next;
      this.next = (this.next + 1) % COUNT;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.6 * s;
      this.pos[k * 3] = at.x + Math.cos(a) * r;
      this.pos[k * 3 + 1] = at.y;
      this.pos[k * 3 + 2] = at.z + Math.sin(a) * r;
      const out = (1.5 + Math.random() * 3) * s;
      this.vel[k * 3] = Math.cos(a) * out;
      this.vel[k * 3 + 1] = (3 + Math.random() * 5) * s;
      this.vel[k * 3 + 2] = Math.sin(a) * out;
      this.age[k] = Math.random() * 0.2;
      this.floor[k] = at.y;
    }
    this.points.visible = true;
  }

  update(dt: number): void {
    if (!this.points.visible) return;
    let alive = 0;
    for (let k = 0; k < COUNT; k++) {
      if (this.age[k] >= LIFE) continue;
      this.age[k] += dt;
      this.vel[k * 3 + 1] -= GRAVITY * dt;
      this.pos[k * 3] += this.vel[k * 3] * dt;
      this.pos[k * 3 + 1] += this.vel[k * 3 + 1] * dt;
      this.pos[k * 3 + 2] += this.vel[k * 3 + 2] * dt;
      // Back in the water: gone.
      if (this.pos[k * 3 + 1] < this.floor[k] - 0.2) this.age[k] = LIFE;
      if (this.age[k] < LIFE) alive++;
      else this.pos[k * 3 + 1] = -1e4;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.visible = alive > 0;
  }
}

/** A soft round dot, so droplets aren't squares. */
function droplet(): THREE.Texture {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
