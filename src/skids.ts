import * as THREE from 'three';

// Skid marks: one ring buffer of quads in a single mesh. Each tyre lays a
// strip while it's sliding; the oldest marks get overwritten first.

const MAX_QUADS = 2000;
const WIDTH = 0.2;
const MIN_SEGMENT = 0.35; // metres between quad ends

interface Track {
  left: THREE.Vector3;
  right: THREE.Vector3;
}

const _l = new THREE.Vector3();
const _r = new THREE.Vector3();

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private next = 0;
  /** Quads laid since load (for tests). */
  laid = 0;
  private dirty = false;
  private readonly tracks = new Map<string, Track>();

  constructor() {
    this.positions = new Float32Array(MAX_QUADS * 4 * 3);
    this.colors = new Float32Array(MAX_QUADS * 4 * 4);
    const index = new Uint32Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) {
      const v = q * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], q * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    // Bounds never get recomputed, so make them cover the whole map.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        side: THREE.DoubleSide, // strips laid while sliding backwards face down
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Extend the track `id` to a contact point. axle is the wheel's sideways direction. */
  add(id: string, point: THREE.Vector3, axle: THREE.Vector3, intensity: number): void {
    _l.copy(point).addScaledVector(axle, -WIDTH / 2);
    _r.copy(point).addScaledVector(axle, WIDTH / 2);
    _l.y = _r.y = point.y + 0.02;
    const track = this.tracks.get(id);
    if (!track) {
      this.tracks.set(id, { left: _l.clone(), right: _r.clone() });
      return;
    }
    if (track.left.distanceToSquared(_l) < MIN_SEGMENT * MIN_SEGMENT) return;
    // A big jump means a teleport or reset, not a slide: start fresh.
    if (track.left.distanceToSquared(_l) > 9) {
      track.left.copy(_l);
      track.right.copy(_r);
      return;
    }

    const q = this.next;
    this.next = (this.next + 1) % MAX_QUADS;
    this.laid++;
    const p = this.positions;
    const o = q * 12;
    p.set([track.left.x, track.left.y, track.left.z, track.right.x, track.right.y, track.right.z], o);
    p.set([_l.x, _l.y, _l.z, _r.x, _r.y, _r.z], o + 6);
    const a = Math.min(1, intensity) * 0.7;
    for (let v = 0; v < 4; v++) this.colors.set([0.05, 0.05, 0.05, a], q * 16 + v * 4);
    track.left.copy(_l);
    track.right.copy(_r);
    this.dirty = true;
  }

  /** The tyre stopped sliding; the next mark starts a new strip. */
  lift(id: string): void {
    this.tracks.delete(id);
  }

  flush(): void {
    if (!this.dirty) return;
    const geo = this.mesh.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    this.dirty = false;
  }
}
