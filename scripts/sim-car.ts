// Headless handling check: node --experimental-strip-types scripts/sim-car.ts
// Prints how the car behaves in a few standard manoeuvres so tuning changes
// can be compared without opening a browser.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Car, type DriveControls } from '../src/car.ts';

const DT = 1 / 60;
await RAPIER.init();

function makeWorld() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0), ground);
  const car = new Car(world, new THREE.Vector3(0, 1, 0), 0);
  return { world, car };
}

const idle: DriveControls = { throttle: 0, brake: 0, steer: 0, handbrake: false };

function run(world: RAPIER.World, car: Car, controls: DriveControls, seconds: number, log?: (t: number) => void) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    car.update(controls, DT);
    world.step();
    car.afterStep();
    if (log && i % 60 === 59) log((i + 1) * DT);
  }
}

const kmh = (c: Car) => (c.forwardSpeed() * 3.6).toFixed(1);
const heading = (c: Car) => {
  const f = new THREE.Vector3(1, 0, 0).applyQuaternion(c.rotation());
  return ((Math.atan2(-f.z, f.x) * 180) / Math.PI).toFixed(1);
};

{
  const { world, car } = makeWorld();
  run(world, car, idle, 2);
  const t = car.body.translation();
  console.log(`rest: chassis y=${t.y.toFixed(3)} susp=${[0, 1, 2, 3].map((i) => car.vehicle.wheelSuspensionLength(i)?.toFixed(3)).join(',')}`);
  const accel: string[] = [];
  let t100 = -1;
  for (let i = 0; i < 25 * 60; i++) {
    car.update({ ...idle, throttle: 1 }, DT);
    world.step();
    car.afterStep();
    if (t100 < 0 && car.forwardSpeed() * 3.6 >= 100) t100 = (i + 1) * DT;
    if (i % 120 === 119) accel.push(kmh(car));
  }
  console.log(`full throttle every 2s km/h: ${accel.join(' ')}  0-100: ${t100.toFixed(1)}s`);
  const x0 = car.body.translation().x;
  let stopT = 0;
  for (let i = 0; i < 20 * 60; i++) {
    car.update({ ...idle, brake: 1 }, DT);
    world.step();
    car.afterStep();
    if (car.forwardSpeed() < 0.5) { stopT = (i + 1) * DT; break; }
  }
  console.log(`braking from top: ${stopT.toFixed(1)}s, ${(car.body.translation().x - x0).toFixed(1)}m`);
  run(world, car, { ...idle, brake: 1 }, 3);
  console.log(`reverse after 3s: ${kmh(car)} km/h`);
}

for (const [label, speedKmh, controls] of [
  ['right turn @40', 40, { ...idle, throttle: 0.4, steer: 1 }],
  ['right turn @100', 100, { ...idle, throttle: 0.6, steer: 1 }],
  ['handbrake left @80', 80, { ...idle, steer: -1, handbrake: true }],
  ['handbrake straight @80', 80, { ...idle, handbrake: true }],
  ['lift-off left @80', 80, { ...idle, steer: -1 }],
] as [string, number, DriveControls][]) {
  const { world, car } = makeWorld();
  run(world, car, idle, 1);
  car.body.setLinvel({ x: speedKmh / 3.6, y: 0, z: 0 }, true);
  const out: string[] = [];
  run(world, car, controls, 3, () => out.push(`${heading(car)}deg/${kmh(car)}`));
  console.log(`${label}: ${out.join('  ')} upsideDown=${car.isUpsideDown()} tilt=${new THREE.Vector3(0, 1, 0).applyQuaternion(car.rotation()).y.toFixed(3)}`);
}
