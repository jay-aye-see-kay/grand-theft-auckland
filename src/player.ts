import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// On-foot player: a kinematic capsule moved by Rapier's character controller
// (steps up kerbs, slides along walls, pushes crates) and a low-poly person
// with a procedural walk cycle. Same heading convention as the car: local +x
// is forward, heading rotates about +y.

const RADIUS = 0.3;
const HALF_HEIGHT = 0.6; // capsule cylinder half-length; total height 1.8 m
const CENTRE_Y = HALF_HEIGHT + RADIUS;

const MOVE = {
  jog: 4.6, // m/s, full stick or keyboard
  sprint: 7.2,
  accel: 12, // how quickly velocity reaches the target, 1/s
  turnRate: 12, // rad/s the body turns to face movement
  gravity: 22,
  jumpSpeed: 6,
};

// Flying (a cheat) is for sightseeing: fast, straight through buildings, no
// gravity. Sprint is quick enough to cross the CBD in half a minute.
const FLY = {
  speed: 25, // m/s
  sprint: 90,
  climb: 15,
  climbSprint: 45,
  accel: 3,
  ceiling: 600, // m above sea level: higher than anything worth seeing
};

export interface FootControls {
  /** Desired move direction in world space (x, z), length 0..1. */
  moveX: number;
  moveZ: number;
  sprint: boolean;
  jump: boolean;
  /** Flying: climb (+1) or descend (-1). */
  rise?: number;
  /** Flying: lowest the feet may go (the ground here), or NaN if unknown. */
  floor?: number;
}

const _move = new THREE.Vector3();

export class Player {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly object = new THREE.Group();
  heading = 0;
  /** Horizontal speed, m/s. */
  speed = 0;
  /** Set on each footfall, for footstep sounds. */
  stepped = false;
  /** Flying (cheat): see setFlying(). */
  flying = false;

  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly velocity = new THREE.Vector3();
  private grounded = true;
  private walkPhase = 0;
  private readonly prevPos = new THREE.Vector3();
  private readonly currPos = new THREE.Vector3();
  private readonly limbs: { legL: THREE.Object3D; legR: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D; torso: THREE.Object3D };

  constructor(world: RAPIER.World, feet: THREE.Vector3, heading = 0) {
    this.heading = heading;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(feet.x, feet.y + CENTRE_Y, feet.z),
    );
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(HALF_HEIGHT, RADIUS), this.body);

    this.controller = world.createCharacterController(0.02);
    this.controller.enableAutostep(0.4, 0.15, false); // kerbs are 0.15 m
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(80);

    // The model's origin is at its feet, and so is this.object (see syncPose).
    const model = buildPerson();
    this.object.add(model.root);
    this.limbs = model;

    this.syncPose();
    this.prevPos.copy(this.currPos);
  }

  /** Move for one fixed step. Call before world.step(). */
  update(c: FootControls, dt: number): void {
    if (this.flying) return this.fly(c, dt);
    const len = Math.min(1, Math.hypot(c.moveX, c.moveZ));
    const target = len > 0.05 ? (c.sprint ? MOVE.sprint : MOVE.jog) * len : 0;
    const tx = len > 0.05 ? (c.moveX / Math.max(len, 1e-6)) * target : 0;
    const tz = len > 0.05 ? (c.moveZ / Math.max(len, 1e-6)) * target : 0;
    const k = 1 - Math.exp(-MOVE.accel * dt * (this.grounded ? 1 : 0.25));
    this.velocity.x += (tx - this.velocity.x) * k;
    this.velocity.z += (tz - this.velocity.z) * k;

    if (this.grounded) {
      this.velocity.y = c.jump ? MOVE.jumpSpeed : -1;
    } else {
      this.velocity.y -= MOVE.gravity * dt;
    }

    // Face the way we're going.
    if (len > 0.05) {
      const want = Math.atan2(-c.moveZ, c.moveX);
      let d = want - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, MOVE.turnRate * dt);
    }

    // Ground snapping would cancel the start of a jump.
    if (this.velocity.y > 0) this.controller.disableSnapToGround();
    else this.controller.enableSnapToGround(0.4);
    this.controller.computeColliderMovement(this.collider, _move.copy(this.velocity).multiplyScalar(dt));
    const m = this.controller.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.velocity.y < 0) this.velocity.y = -1;
    if (!wasGrounded && this.grounded) this.stepped = true; // landing thud
    // Hitting a ceiling (or a car roof from below) kills upward speed.
    if (this.velocity.y > 0 && m.y < this.velocity.y * dt * 0.5) this.velocity.y = 0;

    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
    this.speed = Math.hypot(m.x, m.z) / dt;
  }

  /**
   * Fly or land. Flying turns off the capsule's collisions (so the camera can
   * get anywhere), and landing turns them back on and drops from where you are.
   */
  setFlying(on: boolean): void {
    if (on === this.flying) return;
    this.flying = on;
    this.collider.setEnabled(!on);
    this.velocity.y = 0;
    this.grounded = false;
  }

  private fly(c: FootControls, dt: number): void {
    const len = Math.min(1, Math.hypot(c.moveX, c.moveZ));
    const speed = c.sprint ? FLY.sprint : FLY.speed;
    const k = 1 - Math.exp(-FLY.accel * dt);
    this.velocity.x += (c.moveX * speed - this.velocity.x) * k;
    this.velocity.z += (c.moveZ * speed - this.velocity.z) * k;
    this.velocity.y += ((c.rise ?? 0) * (c.sprint ? FLY.climbSprint : FLY.climb) - this.velocity.y) * k * 2;
    if (len > 0.05) {
      const want = Math.atan2(-c.moveZ, c.moveX);
      const d = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
      this.heading += d * Math.min(1, MOVE.turnRate * 0.5 * dt);
    }
    const t = this.body.translation();
    let y = t.y + this.velocity.y * dt;
    const floor = (c.floor ?? NaN) + CENTRE_Y;
    if (y < floor) {
      y = floor;
      this.velocity.y = Math.max(0, this.velocity.y);
    }
    if (y > FLY.ceiling) {
      y = FLY.ceiling;
      this.velocity.y = Math.min(0, this.velocity.y);
    }
    this.body.setNextKinematicTranslation({ x: t.x + this.velocity.x * dt, y, z: t.z + this.velocity.z * dt });
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Call after world.step(). */
  afterStep(): void {
    this.prevPos.copy(this.currPos);
    this.syncPose();
  }

  render(alpha: number, dt: number): void {
    this.object.position.lerpVectors(this.prevPos, this.currPos, alpha);
    this.object.rotation.set(0, this.heading, 0);

    // Walk cycle: swing limbs in proportion to speed; tuck when airborne.
    const { legL, legR, armL, armR, torso } = this.limbs;
    const prev = this.walkPhase;
    this.walkPhase += dt * (2 + this.speed * 1.6);
    if (this.grounded && this.speed > 0.5 && Math.floor(prev / Math.PI) !== Math.floor(this.walkPhase / Math.PI)) {
      this.stepped = true;
    }
    const amp = this.grounded ? Math.min(this.speed / MOVE.jog, 1.3) * 0.7 : 0.4;
    const swing = this.grounded ? Math.sin(this.walkPhase) * amp : 0;
    legL.rotation.z = swing;
    legR.rotation.z = -swing;
    armL.rotation.z = -swing * 0.9;
    armR.rotation.z = swing * 0.9;
    if (!this.grounded) {
      legL.rotation.z = 0.5;
      legR.rotation.z = -0.2;
      armL.rotation.z = armR.rotation.z = -0.6;
    }
    torso.rotation.z = -Math.min(this.speed / MOVE.sprint, 1) * 0.2; // lean into a run
  }

  /** Feet position (interpolated), for the camera and enter-car checks. */
  get position(): THREE.Vector3 {
    return this.object.position;
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  /** Teleport, e.g. when stepping out of a car. Position is at the feet. */
  place(feet: THREE.Vector3, heading: number): void {
    this.body.setTranslation({ x: feet.x, y: feet.y + CENTRE_Y, z: feet.z }, true);
    this.body.setNextKinematicTranslation({ x: feet.x, y: feet.y + CENTRE_Y, z: feet.z });
    this.heading = heading;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.grounded = false;
    this.syncPose();
    this.prevPos.copy(this.currPos);
  }

  /**
   * Someone else's player (multiplayer): move the capsule to where they are
   * for the next step, instead of walking it under our own controls.
   */
  follow(x: number, y: number, z: number, heading: number, speed: number, grounded: boolean): void {
    this.body.setNextKinematicTranslation({ x, y: y + CENTRE_Y, z });
    this.heading = heading;
    this.speed = speed;
    this.grounded = grounded;
  }

  /** Remove from the physics world (someone else's player who left). */
  dispose(world: RAPIER.World): void {
    world.removeCharacterController(this.controller);
    world.removeRigidBody(this.body);
  }

  /** Hide and disable collisions while driving. */
  setActive(active: boolean): void {
    this.object.visible = active;
    this.collider.setEnabled(active && !this.flying);
  }

  private syncPose(): void {
    const t = this.body.translation();
    this.currPos.set(t.x, t.y - CENTRE_Y, t.z);
  }
}

// Shorts, a black tee and jandals. Origin at the feet, facing +x. Each
// moving part (torso with head, two arms, two legs) is one vertex-coloured
// mesh, so the whole person is 5 draw calls.
function buildPerson() {
  const root = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const skin = new THREE.Color(0xc68a62);
  const shirt = new THREE.Color(0x1d1d22);
  const shorts = new THREE.Color(0x2f4f7a);
  const hair = new THREE.Color(0x1a120c);
  const jandal = new THREE.Color(0x2a6fd6);

  type Box = [w: number, h: number, d: number, colour: THREE.Color, x: number, y: number, z: number];
  const mesh = (boxes: Box[]) => {
    const geos = boxes.map(([w, h, d, colour, x, y, z]) => {
      const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
      g.deleteAttribute('uv');
      const colours = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < colours.length; i += 3) colour.toArray(colours, i);
      g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      return g;
    });
    return new THREE.Mesh(mergeGeometries(geos), material);
  };

  // Limbs hang from pivots at the hip and shoulder so they can swing.
  const limb = (x: number, y: number, z: number, boxes: Box[]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    pivot.add(mesh(boxes));
    return pivot;
  };

  const leg: Box[] = [
    [0.17, 0.36, 0.17, shorts, 0, -0.16, 0],
    [0.13, 0.46, 0.13, skin, 0, -0.56, 0],
    [0.26, 0.04, 0.12, jandal, 0.04, -0.84, 0],
  ];
  const legL = limb(0, 0.86, -0.11, leg);
  const legR = limb(0, 0.86, 0.11, leg);

  const torso = new THREE.Group();
  torso.position.y = 0.86;
  torso.add(mesh([
    [0.26, 0.56, 0.44, shirt, 0, 0.3, 0],
    [0.12, 0.08, 0.12, skin, 0, 0.62, 0], // neck
    [0.24, 0.26, 0.22, skin, 0.01, 0.78, 0], // head
    [0.26, 0.08, 0.24, hair, -0.01, 0.92, 0],
  ]));
  const arm: Box[] = [[0.13, 0.22, 0.13, shirt, 0, -0.08, 0], [0.1, 0.4, 0.1, skin, 0, -0.38, 0]];
  const armL = limb(0, 0.54, -0.28, arm);
  const armR = limb(0, 0.54, 0.28, arm);
  torso.add(armL, armR);

  root.add(legL, legR, torso);
  return { root, legL, legR, armL, armR, torso };
}
