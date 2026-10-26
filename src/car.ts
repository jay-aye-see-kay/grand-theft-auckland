import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { buildCorolla, buildWheel, COROLLA } from './corolla.ts';

export interface DriveControls {
  throttle: number; // 0..1
  brake: number; // 0..1, also reverse when nearly stopped
  steer: number; // -1 (left) .. 1 (right)
  handbrake: boolean;
}

// Handling numbers. These are tuned for arcade feel, not realism: a 1995
// Corolla does not do 0-100 in 5 seconds.
const TUNING = {
  mass: 1100,
  engineForce: 4200, // per driven wheel, N
  reverseForce: 2600,
  brakeForce: 50,
  handbrakeForce: 15,
  maxSteer: 0.6, // rad, at walking pace
  minSteer: 0.12, // rad, at top speed
  steerSpeed: 4.0, // how fast the wheel turns, 1/s
  topSpeed: 50, // m/s, ~180 km/h
  dragCoefficient: 1.5,
  downforce: 3,
  frontGrip: 1.7,
  rearGrip: 1.6,
  handbrakeRearGrip: 1.0,
  suspensionRestLength: 0.3,
  suspensionStiffness: 28,
  suspensionCompression: 2.6,
  suspensionRelaxation: 3.2,
  maxSuspensionTravel: 0.25,
  maxSuspensionForce: 100000,
};

// Chassis collider, centred on the body's rigid body origin.
const CHASSIS_HALF = { x: COROLLA.length / 2 - 0.05, y: 0.3, z: COROLLA.width / 2 - 0.04 };
// Where the body mesh sits relative to the rigid body (its underside).
const MESH_OFFSET_Y = -0.38;
const WHEEL_CONNECTION_Y = -0.1;

const FRONT = [0, 1];
const REAR = [2, 3];
const IDLE: DriveControls = { throttle: 0, brake: 0, steer: 0, handbrake: false };

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Heading about +y, then pitch (nose up, about local z) and roll (left side up, about local x). */
export function carRotation(heading: number, pitch = 0, roll = 0): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(_e.set(roll, heading, pitch, 'YZX'));
}

export class Car {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  readonly object = new THREE.Group();

  private readonly wheelPivots: THREE.Group[] = [];
  /** Wheels and lamp meshes: hidden at a distance, where only the body is worth a draw call. */
  private readonly details: THREE.Object3D[] = [];
  private readonly wheelSpinners: THREE.Group[] = [];
  private readonly brakeLights: THREE.MeshStandardMaterial;
  private steerAngle = 0;
  private braking = false;
  private handbrake = false;
  private readonly prevVel = new THREE.Vector3();

  /** Throttle applied on the last step, 0..1 (for engine sound). */
  throttle = 0;
  /** How hard the tyres are sliding, 0..1 (skid marks, screech). */
  skid = 0;
  /** Largest sudden velocity change since last read, m/s (crash sounds, camera shake). */
  impact = 0;

  // Physics poses either side of the latest fixed step, for interpolation.
  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly currPos = new THREE.Vector3();
  private readonly currQuat = new THREE.Quaternion();

  constructor(world: RAPIER.World, spawn: THREE.Vector3, heading = 0, paint = COROLLA.paint, pitch = 0, roll = 0) {
    const rotation = carRotation(heading, pitch, roll);

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setRotation(rotation)
        .setCanSleep(false)
        // Building walls are thin trimesh sheets: CCD stops a fast car tunnelling through one.
        .setCcdEnabled(true)
        .setAngularDamping(0.6)
        .setLinearDamping(0.05),
    );

    // Low centre of mass and boosted roll inertia keep it on four wheels,
    // which is most of what "arcade handling" means.
    const m = TUNING.mass;
    const lx = CHASSIS_HALF.x * 2;
    const ly = CHASSIS_HALF.y * 2;
    const lz = CHASSIS_HALF.z * 2;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(CHASSIS_HALF.x, CHASSIS_HALF.y, CHASSIS_HALF.z)
        .setMassProperties(
          m,
          { x: 0, y: -0.25, z: 0 },
          {
            x: ((m / 12) * (ly * ly + lz * lz)) * 2.5,
            y: (m / 12) * (lx * lx + lz * lz),
            z: ((m / 12) * (lx * lx + ly * ly)) * 1.2,
          },
          { x: 0, y: 0, z: 0, w: 1 },
        )
        .setFriction(0.4)
        .setRestitution(0.1),
      this.body,
    );

    this.vehicle = world.createVehicleController(this.body);
    const halfBase = COROLLA.wheelbase / 2;
    const halfTrack = COROLLA.track / 2;
    const wheelPositions = [
      { x: halfBase, y: WHEEL_CONNECTION_Y, z: -halfTrack }, // front left
      { x: halfBase, y: WHEEL_CONNECTION_Y, z: halfTrack }, // front right
      { x: -halfBase, y: WHEEL_CONNECTION_Y, z: -halfTrack }, // rear left
      { x: -halfBase, y: WHEEL_CONNECTION_Y, z: halfTrack }, // rear right
    ];
    for (const [i, p] of wheelPositions.entries()) {
      this.vehicle.addWheel(p, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, TUNING.suspensionRestLength, COROLLA.wheelRadius);
      this.vehicle.setWheelSuspensionStiffness(i, TUNING.suspensionStiffness);
      this.vehicle.setWheelSuspensionCompression(i, TUNING.suspensionCompression);
      this.vehicle.setWheelSuspensionRelaxation(i, TUNING.suspensionRelaxation);
      this.vehicle.setWheelMaxSuspensionTravel(i, TUNING.maxSuspensionTravel);
      this.vehicle.setWheelMaxSuspensionForce(i, TUNING.maxSuspensionForce);
      this.vehicle.setWheelFrictionSlip(i, i < 2 ? TUNING.frontGrip : TUNING.rearGrip);
    }

    const model = buildCorolla(paint);
    model.root.position.y = MESH_OFFSET_Y;
    this.object.add(model.root);
    this.brakeLights = model.brakeLights;
    const parts = model.root.children as THREE.Mesh[];
    const size = (m: THREE.Mesh) => m.geometry.attributes.position.count;
    const body = parts.reduce((a, b) => (size(b) > size(a) ? b : a));
    for (const m of parts) {
      m.name = 'car';
      if (m !== body) this.details.push(m);
    }

    for (const p of wheelPositions) {
      const pivot = new THREE.Group();
      pivot.position.set(p.x, p.y, p.z);
      const spinner = buildWheel();
      pivot.add(spinner);
      this.object.add(pivot);
      spinner.traverse((o) => (o.name = 'car'));
      this.wheelPivots.push(pivot);
      this.details.push(pivot);
      this.wheelSpinners.push(spinner);
    }

    this.syncPose();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  /**
   * Level of detail by distance from the camera: the whole car (1 + 7 draw
   * calls) up close, just the body further out, nothing past `far`.
   */
  setDetail(distance: number, near: number, far: number): void {
    this.object.visible = distance < far;
    const detailed = distance < near;
    if (this.details[0].visible !== detailed) for (const d of this.details) d.visible = detailed;
  }

  /** Signed speed along the car's nose, m/s. */
  forwardSpeed(): number {
    const lv = this.body.linvel();
    return _v.set(1, 0, 0).applyQuaternion(this.rotation()).dot(new THREE.Vector3(lv.x, lv.y, lv.z));
  }

  rotation(): THREE.Quaternion {
    const r = this.body.rotation();
    return _q.set(r.x, r.y, r.z, r.w);
  }

  /**
   * Apply controls and run the vehicle controller. Call before world.step().
   * Pass null for a parked car with nobody in it: brakes on, wheels straight.
   */
  update(driver: DriveControls | null, dt: number): void {
    const controls = driver ?? IDLE;
    // Rapier keeps user forces between steps, so clear last step's first.
    this.body.resetForces(true);
    const speed = this.forwardSpeed();
    const absSpeed = Math.abs(speed);
    const v = this.vehicle;

    // Speed-sensitive steering, eased towards the target angle.
    const speedFactor = Math.min(absSpeed / TUNING.topSpeed, 1);
    const maxSteer = THREE.MathUtils.lerp(TUNING.maxSteer, TUNING.minSteer, Math.sqrt(speedFactor));
    const target = -controls.steer * maxSteer; // positive steering turns left
    this.steerAngle += (target - this.steerAngle) * Math.min(1, TUNING.steerSpeed * dt * 2);
    for (const i of FRONT) v.setWheelSteering(i, this.steerAngle);

    // GTA-style pedals: brake reverses once stopped, throttle brakes while rolling back.
    let engine = 0;
    let brake = 0;
    if (controls.throttle > 0) {
      if (speed < -1) brake = TUNING.brakeForce * controls.throttle;
      else if (speed < TUNING.topSpeed) engine = TUNING.engineForce * controls.throttle;
    }
    if (controls.brake > 0) {
      if (speed > 1) brake = Math.max(brake, TUNING.brakeForce * controls.brake);
      else if (speed > -TUNING.topSpeed * 0.3) engine = -TUNING.reverseForce * controls.brake;
    }
    if (!driver) brake = TUNING.brakeForce;
    this.throttle = engine > 0 ? controls.throttle : 0;
    this.braking = brake > 0 && !!driver;
    this.handbrake = controls.handbrake;
    // Front-wheel drive, like the real thing.
    for (const i of FRONT) v.setWheelEngineForce(i, engine);
    for (const i of REAR) v.setWheelEngineForce(i, 0);
    for (let i = 0; i < 4; i++) v.setWheelBrake(i, brake);

    const rearGrip = controls.handbrake ? TUNING.handbrakeRearGrip : TUNING.rearGrip;
    for (const i of REAR) {
      v.setWheelFrictionSlip(i, rearGrip);
      if (controls.handbrake) v.setWheelBrake(i, TUNING.handbrakeForce);
    }

    // Aero drag (sets the top speed) and downforce (keeps it planted).
    const lv = this.body.linvel();
    const vel = _v.set(lv.x, lv.y, lv.z);
    const s = vel.length();
    if (s > 0.1) {
      const drag = vel.multiplyScalar(-TUNING.dragCoefficient * s);
      this.body.addForce({ x: drag.x, y: drag.y - TUNING.downforce * s * s, z: drag.z }, true);
    }
    this.brakeLights.emissiveIntensity = this.braking || controls.handbrake ? 1.4 : 0.15;
    v.updateVehicle(dt);
  }

  /** Call after world.step(). */
  afterStep(dt: number): void {
    const lv = this.body.linvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    const dv = vel.clone().sub(this.prevVel);
    dv.y += 9.81 * dt; // falling isn't an impact; hitting something is
    this.impact = Math.max(this.impact, dv.length());
    this.prevVel.copy(vel);

    let grounded = false;
    for (let i = 0; i < 4; i++) grounded ||= this.vehicle.wheelIsInContact(i);
    const right = _v.set(0, 0, 1).applyQuaternion(this.rotation());
    const lateral = Math.abs(vel.dot(right));
    const speed = Math.abs(this.forwardSpeed());
    let skid = THREE.MathUtils.clamp((lateral - 2) / 5, 0, 1);
    if (this.braking && speed > 6) skid = Math.max(skid, 0.5);
    if (this.handbrake && speed > 4) skid = Math.max(skid, 0.7);
    this.skid = grounded ? skid : 0;

    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.syncPose();
  }

  /** Blend between the last two physics poses and update the visuals. */
  render(alpha: number): void {
    this.object.position.lerpVectors(this.prevPos, this.currPos, alpha);
    this.object.quaternion.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
    for (let i = 0; i < 4; i++) {
      const suspension = this.vehicle.wheelSuspensionLength(i) ?? TUNING.suspensionRestLength;
      const conn = this.vehicle.wheelChassisConnectionPointCs(i);
      if (conn) this.wheelPivots[i].position.set(conn.x, conn.y - suspension, conn.z);
      this.wheelPivots[i].rotation.y = this.vehicle.wheelSteering(i) ?? 0;
      this.wheelSpinners[i].rotation.z = -(this.vehicle.wheelRotation(i) ?? 0);
    }
  }

  /** Put the car back on its wheels where it is, facing the same way, never below `groundY`. */
  reset(groundY = 0): void {
    const t = this.body.translation();
    const fwd = _v.set(1, 0, 0).applyQuaternion(this.rotation());
    const heading = Math.atan2(-fwd.z, fwd.x);
    this.place(new THREE.Vector3(t.x, Math.max(t.y, groundY) + 1.2, t.z), heading);
  }

  place(pos: THREE.Vector3, heading: number, pitch = 0, roll = 0): void {
    const q = carRotation(heading, pitch, roll);
    this.body.setTranslation(pos, true);
    this.body.setRotation(q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevVel.set(0, 0, 0);
    this.steerAngle = 0;
    this.syncPose();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  /** World-space tyre contact point and axle direction, for skid marks. */
  wheelContact(i: number, point: THREE.Vector3, axle: THREE.Vector3): boolean {
    if (!this.vehicle.wheelIsInContact(i)) return false;
    const p = this.vehicle.wheelContactPoint(i);
    if (!p) return false;
    point.set(p.x, p.y, p.z);
    axle.set(0, 0, 1).applyQuaternion(this.rotation());
    return true;
  }

  isUpsideDown(): boolean {
    return _v.set(0, 1, 0).applyQuaternion(this.rotation()).y < 0.3;
  }

  private syncPose(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }
}
