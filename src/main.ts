import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { ChaseCamera } from './camera.ts';
import { Car } from './car.ts';
import { Input } from './input.ts';
import { buildTown } from './world.ts';
import './style.css';

const FIXED_DT = 1 / 60;
const MAX_STEPS = 5;
const debug = new URLSearchParams(location.search).has('debug');

async function main() {
  const app = document.getElementById('app')!;
  const hud = document.getElementById('hud')!;
  const speedo = document.getElementById('speed')!;
  const fpsEl = document.getElementById('fps')!;
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

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 1200);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  const town = buildTown(scene, world);

  const car = new Car(world, town.spawn, town.spawnHeading);
  scene.add(car.object);

  // Cheap blob shadow instead of real-time shadow maps.
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 2.1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  scene.add(blob);

  const chase = new ChaseCamera(camera, world, car.collider);
  const input = new Input(app);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // Tap/click to start: go fullscreen and landscape where the browser allows.
  status.textContent = coarse ? 'Tap to drive' : 'Click or press any key to drive';
  const start = async () => {
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
  splash.addEventListener('pointerup', start, { once: true });
  addEventListener('keydown', () => !splash.classList.contains('hidden') && start(), { once: true });

  let upsideDownTime = 0;
  let accumulator = 0;
  let last = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;
  const _shadowPos = new THREE.Vector3();

  renderer.setAnimationLoop((now) => {
    const frameDt = Math.min((now - last) / 1000, 0.1);
    last = now;

    input.update();
    if (input.resetPressed) {
      input.resetPressed = false;
      car.reset();
      chase.snap();
    }

    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      car.update(input.controls, FIXED_DT);
      world.step();
      car.afterStep();
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) accumulator = 0;

    // Stuck on its roof for a couple of seconds: flip it back over.
    upsideDownTime = car.isUpsideDown() && Math.abs(car.forwardSpeed()) < 1 ? upsideDownTime + frameDt : 0;
    if (upsideDownTime > 2) {
      car.reset();
      upsideDownTime = 0;
    }

    town.sync();
    car.render(accumulator / FIXED_DT);
    const speed = car.forwardSpeed();
    chase.update(frameDt, car.object.position, car.object.quaternion, speed);

    _shadowPos.copy(car.object.position);
    blob.position.set(_shadowPos.x, 0.03, _shadowPos.z);
    blob.rotation.y = new THREE.Euler().setFromQuaternion(car.object.quaternion, 'YXZ').y;
    blob.visible = _shadowPos.y < 3;

    speedo.textContent = `${Math.round(Math.abs(speed) * 3.6)}`;
    renderer.render(scene, camera);

    // Adaptive resolution: trade sharpness for frame rate on slower phones.
    fpsFrames++;
    fpsTime += frameDt;
    if (fpsTime >= 1) {
      const fps = fpsFrames / fpsTime;
      if (fps < 45 && pixelRatio > 0.75) pixelRatio = Math.max(0.75, pixelRatio - 0.25);
      else if (fps > 58 && pixelRatio < maxRatio) pixelRatio = Math.min(maxRatio, pixelRatio + 0.25);
      if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
      if (debug) fpsEl.textContent = `${fps.toFixed(0)} fps · ${pixelRatio.toFixed(2)}x · ${renderer.info.render.calls} calls`;
      fpsFrames = 0;
      fpsTime = 0;
    }
  });
}

main().catch((err) => {
  console.error(err);
  const status = document.getElementById('status');
  if (status) status.textContent = `Couldn't start: ${err instanceof Error ? err.message : err}`;
});
