import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GameAudio } from './audio.ts';
import { ChaseCamera, DRIVING, ON_FOOT } from './camera.ts';
import { Car } from './car.ts';
import { Input } from './input.ts';
import { Player } from './player.ts';
import { SkidMarks } from './skids.ts';
import { buildTown } from './world.ts';
import './style.css';

const FIXED_DT = 1 / 60;
const MAX_STEPS = 5;
const ENTER_RANGE = 3.6; // m from the car's centre
const debug = new URLSearchParams(location.search).has('debug');

async function main() {
  const app = document.getElementById('app')!;
  const hud = document.getElementById('hud')!;
  const speedoBox = document.getElementById('speedo')!;
  const speedo = document.getElementById('speed')!;
  const prompt = document.getElementById('prompt')!;
  const fpsEl = document.getElementById('fps')!;
  const muteBtn = document.getElementById('mute')!;
  const splash = document.getElementById('splash')!;
  const status = document.getElementById('status')!;

  // Only the -compat build needs init(); the browser build (see vite.config.ts) is ready on import.
  await (RAPIER as { init?: () => Promise<void> }).init?.();

  // Renderer: start at a modest pixel ratio on phones and adapt from there.
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  const coarse = matchMedia('(pointer: coarse)').matches;
  const maxRatio = Math.min(devicePixelRatio, coarse ? 2 : 2.5);
  let pixelRatio = Math.min(devicePixelRatio, coarse ? 1.5 : 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  app.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0xf2b27a);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 120, 520);
  scene.add(new THREE.HemisphereLight(0xffe3c4, 0x4a5a3a, 1.6));
  const sun = new THREE.DirectionalLight(0xffd2a0, 2.2);
  sun.position.set(-200, 150, 120);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.2, 1200);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  const town = buildTown(scene, world);

  // Cheap blob shadows instead of real-time shadow maps.
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
  const carShadow = new THREE.PlaneGeometry(4.6, 2.1).rotateX(-Math.PI / 2);

  const cars = town.parking.map((spot) => {
    const car = new Car(world, spot.pos, spot.heading, spot.paint);
    scene.add(car.object);
    const shadow = new THREE.Mesh(carShadow, shadowMat);
    scene.add(shadow);
    return { car, shadow };
  });

  // Start on foot by the driver's door (right-hand drive) of the purple Corolla.
  const first = town.parking[0];
  const player = new Player(world, first.pos.clone().add(new THREE.Vector3(0.5, -1.2, 2.2)), 0);
  scene.add(player.object);
  const playerShadow = new THREE.Mesh(new THREE.CircleGeometry(0.4, 12).rotateX(-Math.PI / 2), shadowMat);
  scene.add(playerShadow);

  const skids = new SkidMarks();
  scene.add(skids.mesh);

  const chase = new ChaseCamera(camera, world);
  const input = new Input(app);
  input.attachLook(renderer.domElement);
  const audio = new GameAudio();

  let driving: Car | null = null;
  let exitRequested = false;
  let upsideDownTime = 0;

  const nearestCar = (): Car | null => {
    let best: Car | null = null;
    let bestD = ENTER_RANGE;
    for (const { car } of cars) {
      const d = car.object.position.distanceTo(player.position);
      if (d < bestD && Math.abs(car.forwardSpeed()) < 3) {
        best = car;
        bestD = d;
      }
    }
    return best;
  };

  const enter = (car: Car) => {
    driving = car;
    exitRequested = false;
    player.setActive(false);
    input.setMode('car');
    car.impact = 0;
  };

  // Step out of the driver's door (right side), or the passenger side or
  // roof if something's in the way.
  const exit = (car: Car) => {
    const pos = car.object.position;
    const rot = car.object.quaternion;
    const heading = new THREE.Euler().setFromQuaternion(rot, 'YXZ').y;
    const options = [new THREE.Vector3(0.3, 0, 1.6), new THREE.Vector3(0.3, 0, -1.6), new THREE.Vector3(0, 1.2, 0)];
    let spot = options[options.length - 1].clone().applyQuaternion(rot).add(pos);
    for (const local of options.slice(0, 2)) {
      const offset = local.clone().applyQuaternion(rot);
      offset.y = 0;
      const dir = offset.clone().normalize();
      const from = { x: pos.x, y: pos.y + 0.3, z: pos.z };
      const hit = world.castRay(new RAPIER.Ray(from, dir), offset.length() + 0.4, true, undefined, undefined, car.collider);
      if (!hit) {
        spot = pos.clone().add(offset);
        break;
      }
    }
    spot.y = Math.max(spot.y - 0.6, 0.05);
    player.place(spot, heading);
    player.setActive(true);
    driving = null;
    exitRequested = false;
    input.setMode('foot');
    for (let i = 0; i < 4; i++) skids.lift(`${cars.findIndex((c) => c.car === car)}:${i}`);
  };

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  const setMuteIcon = () => (muteBtn.textContent = audio.isMuted ? '🔇' : '🔊');
  setMuteIcon();
  muteBtn.addEventListener('pointerup', () => {
    audio.toggleMute();
    setMuteIcon();
  });

  // Tap/click to start: unlock audio, go fullscreen and landscape where the browser allows.
  status.textContent = coarse ? 'Tap to play' : 'Click or press any key to play';
  let started = false;
  const start = async () => {
    if (started) return;
    started = true;
    input.clearPresses(); // the key that started the game shouldn't also do something
    audio.unlock();
    splash.classList.add('hidden');
    hud.classList.remove('hidden');
    if (coarse) {
      try {
        await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
        await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
      } catch {
        // iOS Safari and desktop browsers say no; that's fine.
      }
    }
  };
  splash.addEventListener('pointerup', start);
  addEventListener('keydown', start, { once: true });
  // Some mobile browsers suspend audio when backgrounded; any touch brings it back.
  addEventListener('pointerdown', () => started && audio.unlock());

  let accumulator = 0;
  let last = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;
  let fps = 60;
  const _p = new THREE.Vector3();
  const _a = new THREE.Vector3();

  renderer.setAnimationLoop((now) => {
    const frameDt = Math.min((now - last) / 1000, 0.1);
    last = now;

    input.update();
    if (!started) input.clearPresses();
    if (input.consume('mute')) {
      audio.toggleMute();
      setMuteIcon();
    }
    const nearby = driving ? null : nearestCar();
    if (input.consume('enterExit')) {
      if (driving) exitRequested = true;
      else if (nearby) enter(nearby);
    }
    if (input.consume('reset') && driving) {
      driving.reset();
      chase.snap();
    }
    const jump = input.consume('jump');

    // Camera-relative movement on foot: stick up walks away from the camera.
    const cy = chase.yaw;
    const moveX = Math.cos(cy) * input.moveY - Math.sin(cy) * input.moveX;
    const moveZ = Math.sin(cy) * input.moveY + Math.cos(cy) * input.moveX;

    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      for (const { car } of cars) {
        if (car !== driving) car.update(null, FIXED_DT);
        // Like GTA III: asking to get out at speed brakes to a stop first.
        else if (exitRequested) car.update({ throttle: 0, brake: Math.abs(car.forwardSpeed()) > 1 ? 1 : 0, steer: 0, handbrake: false }, FIXED_DT);
        else car.update(input.drive, FIXED_DT);
      }
      if (!driving) player.update({ moveX, moveZ, sprint: input.sprint, jump: jump && steps === 0 }, FIXED_DT);
      world.step();
      for (const { car } of cars) car.afterStep(FIXED_DT);
      if (!driving) player.afterStep();
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) accumulator = 0;

    if (driving && exitRequested && Math.abs(driving.forwardSpeed()) < 1.5) exit(driving);

    // Stuck on its roof for a couple of seconds: flip it back over.
    upsideDownTime = driving && driving.isUpsideDown() && Math.abs(driving.forwardSpeed()) < 1 ? upsideDownTime + frameDt : 0;
    if (driving && upsideDownTime > 2) {
      driving.reset();
      upsideDownTime = 0;
    }

    town.sync();
    const alpha = accumulator / FIXED_DT;
    for (const [n, { car, shadow }] of cars.entries()) {
      car.render(alpha);
      shadow.position.set(car.object.position.x, 0.03, car.object.position.z);
      shadow.rotation.y = new THREE.Euler().setFromQuaternion(car.object.quaternion, 'YXZ').y;
      shadow.visible = car.object.position.y < 3;

      // Skid marks from any sliding car, not just the one we're in.
      for (let i = 0; i < 4; i++) {
        const id = `${n}:${i}`;
        const rearOrHard = i >= 2 || car.skid > 0.6;
        if (car.skid > 0.25 && rearOrHard && car.wheelContact(i, _p, _a)) skids.add(id, _p, _a, car.skid);
        else skids.lift(id);
      }
      if (car.impact > 4 && car === driving) {
        const strength = Math.min(1, (car.impact - 4) / 12);
        audio.impact(strength);
        chase.shake(strength * 0.6);
      }
      car.impact = 0;
    }
    skids.flush();

    if (driving) {
      input.consumeLook(frameDt); // camera stays behind the car
      const speed = driving.forwardSpeed();
      const heading = new THREE.Euler().setFromQuaternion(driving.object.quaternion, 'YXZ').y;
      chase.update(frameDt, DRIVING, driving.object.position, heading, speed, driving.collider);
      speedo.textContent = `${Math.round(Math.abs(speed) * 3.6)}`;
      audio.setEngine(true, speed, driving.throttle);
      audio.setSkid(driving.skid, speed);
    } else {
      player.render(alpha, frameDt);
      playerShadow.position.set(player.position.x, player.position.y + 0.03, player.position.z);
      // Swing in behind only while heading away from the camera, so walking
      // sideways or towards the camera doesn't send it spinning.
      const awayFromCamera = input.moveY > 0.3 && input.moveY > Math.abs(input.moveX) * 0.5;
      chase.rotate(input.consumeLook(frameDt) * 0.006);
      chase.update(frameDt, ON_FOOT, player.position, player.heading, player.speed, player.collider, player.speed > 0.5 && awayFromCamera);
      audio.setEngine(false, 0, 0);
      audio.setSkid(0, 0);
      if (player.stepped) audio.footstep();
    }
    player.stepped = false;
    playerShadow.visible = !driving;
    speedoBox.classList.toggle('hidden', !driving);
    input.setCanEnter(!!nearby);
    prompt.textContent = nearby ? (coarse ? 'Tap 🚗 to get in' : 'Press F to get in') : '';

    renderer.render(scene, camera);

    // Adaptive resolution: trade sharpness for frame rate on slower phones.
    fpsFrames++;
    fpsTime += frameDt;
    if (fpsTime >= 1) {
      fps = fpsFrames / fpsTime;
      if (fps < 45 && pixelRatio > 0.75) pixelRatio = Math.max(0.75, pixelRatio - 0.25);
      else if (fps > 58 && pixelRatio < maxRatio) pixelRatio = Math.min(maxRatio, pixelRatio + 0.25);
      if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
      if (debug) fpsEl.textContent = `${fps.toFixed(0)} fps · ${pixelRatio.toFixed(2)}x · ${renderer.info.render.calls} calls`;
      fpsFrames = 0;
      fpsTime = 0;
    }
  });

  // Read-only state for automated tests (scripts/smoke.mjs). Only with ?debug.
  if (debug) {
    (window as unknown as { __game: unknown }).__game = {
      state: () => ({
        started,
        mode: driving ? 'car' : 'foot',
        drivingIndex: cars.findIndex((c) => c.car === driving),
        player: player.position.toArray(),
        playerGrounded: player.isGrounded,
        speedKmh: driving ? Math.abs(driving.forwardSpeed()) * 3.6 : 0,
        skid: driving?.skid ?? 0,
        skidQuads: skids.laid,
        nearCar: !!nearestCar(),
        cars: cars.map(({ car }) => car.object.position.toArray()),
        audio: audio.state,
        fps,
      }),
    };
  }
}

main().catch((err) => {
  console.error(err);
  const status = document.getElementById('status');
  if (status) status.textContent = `Couldn't start: ${err instanceof Error ? err.message : err}`;
});
