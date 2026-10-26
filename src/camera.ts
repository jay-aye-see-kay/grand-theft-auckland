import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

// GTA III-style chase camera: sits behind the car's heading, swings round
// lazily, pulls back and widens the FOV with speed, and ducks in front of
// walls instead of clipping through them.

const _fwd = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();

export class ChaseCamera {
  private yaw: number | null = null;
  private readonly smoothedPos = new THREE.Vector3();
  private readonly smoothedLook = new THREE.Vector3();
  private readonly baseFov: number;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: RAPIER.World;
  private readonly ignore: RAPIER.Collider;

  constructor(camera: THREE.PerspectiveCamera, world: RAPIER.World, ignore: RAPIER.Collider) {
    this.camera = camera;
    this.world = world;
    this.ignore = ignore;
    this.baseFov = camera.fov;
  }

  update(dt: number, target: THREE.Vector3, rotation: THREE.Quaternion, speed: number): void {
    _fwd.set(1, 0, 0).applyQuaternion(rotation);
    _fwd.y = 0;
    // Reversing: keep looking the way the nose points, like the original.
    const targetYaw = _fwd.lengthSq() > 1e-4 ? Math.atan2(_fwd.z, _fwd.x) : (this.yaw ?? 0);
    if (this.yaw === null) this.yaw = targetYaw;
    let delta = targetYaw - this.yaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.yaw += delta * (1 - Math.exp(-dt * 3.5));

    const s = Math.abs(speed);
    const distance = 6.5 + Math.min(s * 0.07, 3.5);
    const height = 2.4 + Math.min(s * 0.02, 1);
    const dir = _fwd.set(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    _look.copy(target).addScaledVector(dir, 2).y += 1.1;
    _desired.copy(target).addScaledVector(dir, -distance).y += height;

    // Pull in if a building is between the car and the camera.
    const from = new THREE.Vector3(target.x, target.y + 1.2, target.z);
    const toCam = _desired.clone().sub(from);
    const len = toCam.length();
    toCam.divideScalar(len);
    const ray = new RAPIER.Ray(from, toCam);
    const hit = this.world.castRay(ray, len, true, undefined, undefined, this.ignore);
    if (hit) _desired.copy(from).addScaledVector(toCam, Math.max(hit.timeOfImpact - 0.4, 1.5));

    const first = this.smoothedPos.lengthSq() === 0;
    const k = first ? 1 : 1 - Math.exp(-dt * 10);
    this.smoothedPos.lerp(_desired, k);
    this.smoothedLook.lerp(_look, first ? 1 : 1 - Math.exp(-dt * 14));
    this.camera.position.copy(this.smoothedPos);
    this.camera.lookAt(this.smoothedLook);

    const fov = this.baseFov + Math.min(s * 0.3, 14);
    if (Math.abs(fov - this.camera.fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 3));
      this.camera.updateProjectionMatrix();
    }
  }

  /** Snap straight behind the car (after a reset). */
  snap(): void {
    this.yaw = null;
    this.smoothedPos.set(0, 0, 0);
  }
}
