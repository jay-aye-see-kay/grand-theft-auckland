import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

// GTA III-style follow camera: sits behind the target's heading, swings round
// lazily, pulls back and widens the FOV with speed, and ducks in front of
// walls instead of clipping through them. Profiles switch between driving and
// on-foot framing; the smoothing makes the switch a glide rather than a cut.

export interface CameraProfile {
  distance: number;
  height: number;
  lookHeight: number;
  lookAhead: number;
  followRate: number; // how quickly the camera swings behind, 1/s
  speedPullback: number; // extra distance per m/s
}

export const DRIVING: CameraProfile = { distance: 6.5, height: 2.4, lookHeight: 1.1, lookAhead: 2, followRate: 3.5, speedPullback: 0.07 };
export const ON_FOOT: CameraProfile = { distance: 4.2, height: 1.9, lookHeight: 1.55, lookAhead: 0.6, followRate: 1.6, speedPullback: 0.05 };
/** Flying (cheat): further back and a little above, to take in whole buildings. */
export const FLYING: CameraProfile = { distance: 12, height: 3.5, lookHeight: 1, lookAhead: 2, followRate: 1.2, speedPullback: 0.04 };

const _fwd = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _from = new THREE.Vector3();
const _toCam = new THREE.Vector3();

export class ChaseCamera {
  private yawAngle: number | null = null;
  private readonly smoothedPos = new THREE.Vector3();
  private readonly smoothedLook = new THREE.Vector3();
  private readonly baseFov: number;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: RAPIER.World;
  private shakeAmount = 0;
  private distance = DRIVING.distance;

  constructor(camera: THREE.PerspectiveCamera, world: RAPIER.World) {
    this.camera = camera;
    this.world = world;
    this.baseFov = camera.fov;
  }

  /** Direction the camera faces, as atan2(z, x). Used for camera-relative walking. */
  get yaw(): number {
    return this.yawAngle ?? 0;
  }

  update(
    dt: number,
    profile: CameraProfile,
    target: THREE.Vector3,
    heading: number,
    speed: number,
    ignore: RAPIER.Collider,
    follow = true,
  ): void {
    // heading rotates local +x about +y, so forward is (cos h, 0, -sin h).
    const targetYaw = Math.atan2(-Math.sin(heading), Math.cos(heading));
    if (this.yawAngle === null) this.yawAngle = targetYaw;
    if (follow) {
      const delta = Math.atan2(Math.sin(targetYaw - this.yawAngle), Math.cos(targetYaw - this.yawAngle));
      this.yawAngle += delta * (1 - Math.exp(-dt * profile.followRate));
    }

    const s = Math.abs(speed);
    const wantDistance = profile.distance + Math.min(s * profile.speedPullback, 3.5);
    this.distance += (wantDistance - this.distance) * (1 - Math.exp(-dt * 3));
    const height = profile.height + Math.min(s * 0.02, 1);
    const dir = _fwd.set(Math.cos(this.yawAngle), 0, Math.sin(this.yawAngle));
    _look.copy(target).addScaledVector(dir, profile.lookAhead).y += profile.lookHeight;
    _desired.copy(target).addScaledVector(dir, -this.distance).y += height;

    // Pull in if a building is between the target and the camera.
    _from.set(target.x, target.y + profile.lookHeight, target.z);
    _toCam.copy(_desired).sub(_from);
    const len = _toCam.length();
    _toCam.divideScalar(len);
    const hit = this.world.castRay(new RAPIER.Ray(_from, _toCam), len, true, undefined, undefined, ignore);
    if (hit) _desired.copy(_from).addScaledVector(_toCam, Math.max(hit.timeOfImpact - 0.4, 1.2));

    const first = this.smoothedPos.lengthSq() === 0;
    this.smoothedPos.lerp(_desired, first ? 1 : 1 - Math.exp(-dt * 10));
    this.smoothedLook.lerp(_look, first ? 1 : 1 - Math.exp(-dt * 14));
    this.camera.position.copy(this.smoothedPos);
    this.camera.lookAt(this.smoothedLook);

    if (this.shakeAmount > 0.01) {
      const a = this.shakeAmount;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
      this.camera.rotation.z += (Math.random() - 0.5) * a * 0.05;
      this.shakeAmount *= Math.exp(-dt * 9);
    }

    const fov = this.baseFov + Math.min(s * 0.3, 14);
    if (Math.abs(fov - this.camera.fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 3));
      this.camera.updateProjectionMatrix();
    }
  }

  /** Turn the camera by hand (drag to look). */
  rotate(radians: number): void {
    if (this.yawAngle !== null) this.yawAngle += radians;
  }

  /** Jolt the camera, e.g. on a crash. Strength ~0..1. */
  shake(strength: number): void {
    this.shakeAmount = Math.min(1, Math.max(this.shakeAmount, strength));
  }

  /**
   * Snap straight behind the target on the next update (after a reset).
   * Given the target's new heading, the yaw is set now: on-foot movement
   * reads it before the next update, and with the old yaw (or none, which
   * reads as east) the first frame's steps go the wrong way and the camera
   * then follows them.
   */
  snap(heading?: number): void {
    this.yawAngle = heading === undefined ? null : Math.atan2(-Math.sin(heading), Math.cos(heading));
    this.smoothedPos.set(0, 0, 0);
  }
}
