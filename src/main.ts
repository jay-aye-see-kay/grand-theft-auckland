import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GameAudio } from './audio.ts';
import { ChaseCamera, DRIVING, FLYING, ON_FOOT } from './camera.ts';
import { FLY_CODE, StickCode } from './cheats.ts';
import { TERRAIN_ONLY_QUERY } from './city/building-chunk.ts';
import { Car } from './car.ts';
import { Input } from './input.ts';
import { Player } from './player.ts';
import { SkidMarks } from './skids.ts';
import { Sky } from './sky.ts';
import { SUN_DIRECTION } from './sun.ts';
import { Splash } from './splash.ts';
import { Water } from './city/water.ts';
import { loadMap } from './maps/index.ts';
import { MISSIONS } from './missions/index.ts';
import { MissionHud } from './missions/runtime/hud.ts';
import { MissionMarkers } from './missions/runtime/markers.ts';
import { MissionRunner } from './missions/runtime/runner.ts';
import './style.css';

const FIXED_DT = 1 / 60;
const MAX_STEPS = 5;
/** ?debug step(): ticks run between waits for streaming (1 s of game time). */
const STEP_BATCH = 60;
/** step(): promise hops a mission script gets to run between ticks. */
const SCRIPT_HOPS = 8;
const ENTER_RANGE = 3.6; // m from the car's centre
const params = new URLSearchParams(location.search);
const debug = params.has('debug');
/** Cars that fall this far below sea level (off the map edge) get put back. */
const FALL_LIMIT = -30;
/** Anything this far below the terrain has fallen through it and gets put back on top. */
const UNDERGROUND = 2;
/** Anything that wanders this far outside the map gets brought back in. */
const OUT_OF_BOUNDS = 40;
/** In the water once a car's centre (or the player's feet) is this far under the surface, m. */
const SUBMERGED = 0.3;
/** How long a car or the player stays in the water before being fished out onto dry land, s. */
const SOAK_CAR = 1.8;
const SOAK_PLAYER = 1.2;
/** How far to look for dry land to put them back on, m. */
const SHORE_SEARCH = 300;
/** Cars beyond this from the camera are drawn as just their body; their blob shadows go too, m. */
const CAR_DETAIL = 120;
/** Cars beyond this are not drawn at all (a few pixels in the haze), m. */
const CAR_DRAW = 600;

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
  const blurb = document.getElementById('blurb')!;

  // Only the -compat build needs init(); the browser build (see vite.config.ts) is ready on import.
  await (RAPIER as { init?: () => Promise<void> }).init?.();

  // Renderer: start at a modest pixel ratio on phones and adapt from there.
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  const coarse = matchMedia('(pointer: coarse)').matches;
  // Past 2x the extra pixels cost far more fill rate than they show.
  const maxRatio = Math.min(devicePixelRatio, 2);
  let pixelRatio = Math.min(devicePixelRatio, coarse ? 1.5 : 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Filmic tone mapping: bright sunlit walls roll off instead of clipping,
  // which is most of the step from flat PS1 shading to a PS2/PS3 look.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  app.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  // Blue sky above, warm sunlit pavement bouncing light from below.
  scene.add(new THREE.HemisphereLight(0xc4dcff, 0x9a8a72, 2.4));
  // Afternoon sun in the north-north-west (southern hemisphere), see sun.ts.
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.8);
  sun.position.fromArray(SUN_DIRECTION).multiplyScalar(300);
  scene.add(sun);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  const map = await loadMap(params.get('map'), scene, world, renderer.capabilities.getMaxAnisotropy());
  blurb.textContent = map.blurb;

  const { atmosphere } = map;
  const sky = new THREE.Color(atmosphere.sky);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, atmosphere.fogNear, atmosphere.fogFar);
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, atmosphere.far);
  const skyDome = new Sky(sky, atmosphere.far * 0.9, atmosphere.zenith, sun.position);
  scene.add(skyDome.mesh);

  // The harbour (Auckland only), reflecting a sky a little bluer than the haze.
  const water = map.water
    ? new Water(map.water.level, sky.clone().lerp(new THREE.Color(0x8fb0cc), 0.35), sun.position, map.water.bounds, map.water.seaSouth)
    : null;
  if (water) scene.add(water.mesh);
  const splashes = new Splash();
  scene.add(splashes.points);

  // Cheap blob shadows instead of real-time shadow maps.
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
  const carShadow = new THREE.PlaneGeometry(4.6, 2.1).rotateX(-Math.PI / 2);

  const cars = map.parking.map((spot) => {
    const car = new Car(world, spot.pos, spot.heading, spot.paint, spot.pitch, spot.roll);
    scene.add(car.object);
    const shadow = new THREE.Mesh(carShadow, shadowMat);
    shadow.name = 'shadow';
    scene.add(shadow);
    /** Game time it went into the water, or null if it's dry. */
    return { car, shadow, frozen: false, soaked: null as number | null };
  });

  // Start on foot by the driver's door (right-hand drive) of the purple Corolla.
  const player = new Player(world, map.spawn.feet, map.spawn.heading);
  scene.add(player.object);
  const playerShadow = new THREE.Mesh(new THREE.CircleGeometry(0.4, 12).rotateX(-Math.PI / 2), shadowMat);
  playerShadow.name = 'shadow';
  scene.add(playerShadow);
  player.object.traverse((o) => (o.name = 'player'));

  const skids = new SkidMarks();
  scene.add(skids.mesh);

  // Missions: Auckland only, since their places are real streets (the map's gazetteer).
  const storage = (() => {
    try {
      return localStorage;
    } catch {
      return null; // blocked (some private modes): best times just aren't kept
    }
  })();
  const missions = map.places ? new MissionRunner(MISSIONS, map.places, (x, z) => map.heightAt(x, z), storage) : null;
  const markers = new MissionMarkers();
  scene.add(markers.group);
  const missionHud = new MissionHud(hud);

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

  // Cheat: flick the stick up, up, down, down, left, right, left, right to fly.
  const flyCode = new StickCode(FLY_CODE);
  const setFlying = (on: boolean) => {
    player.setFlying(on);
    input.setFlying(on);
    if (on) return;
    // Landing inside a building would leave the capsule stuck in its
    // collider: step out onto the roof instead.
    const p = player.position;
    let inside = false;
    world.intersectionsWithPoint({ x: p.x, y: p.y + 0.9, z: p.z }, () => !(inside = true), RAPIER.QueryFilterFlags.ONLY_FIXED);
    if (!inside) return;
    const hit = world.castRay(new RAPIER.Ray({ x: p.x, y: 1000, z: p.z }, down), 2000, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
    if (hit) player.place(new THREE.Vector3(p.x, 1000 - hit.timeOfImpact + 0.05, p.z), player.heading);
  };

  const enter = (car: Car) => {
    setFlying(false);
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
    const ground = map.heightAt(spot.x, spot.z);
    spot.y = Math.max(spot.y - 0.6, (Number.isNaN(ground) ? 0 : ground) + 0.05);
    player.place(spot, heading);
    player.setActive(true);
    driving = null;
    exitRequested = false;
    input.setMode('foot');
    for (let i = 0; i < 4; i++) skids.lift(`${cars.findIndex((c) => c.car === car)}:${i}`);
  };

  /** Back on its wheels where it is, never below the ground. */
  const resetCar = (car: Car) => {
    const t = car.body.translation();
    const ground = map.heightAt(t.x, t.z);
    car.reset(Number.isNaN(ground) ? 0 : ground);
  };

  /** Below the world, under the terrain or well off the map: needs putting back. */
  const lost = (p: { x: number; y: number; z: number }) => {
    if (p.y < FALL_LIMIT) return true;
    const c = map.clamp(p.x, p.z);
    if (Math.hypot(c.x - p.x, c.z - p.z) > OUT_OF_BOUNDS) return true;
    const ground = map.heightAt(p.x, p.z);
    return !Number.isNaN(ground) && p.y < ground - UNDERGROUND;
  };

  // ---- In the harbour: splash, sink for a moment, then back on dry land.
  let clock = 0;
  let playerSoaked: number | null = null;

  /** Under the water surface, over ground that's under it too (not a low spot inland). */
  const inWater = (x: number, y: number, z: number) => {
    if (!water || y > water.level - SUBMERGED) return false;
    const ground = map.heightAt(x, z);
    return !Number.isNaN(ground) && water.covers(ground);
  };

  const makeSplash = (x: number, z: number, strength: number, loud: boolean) => {
    if (!water) return;
    splashes.burst(_p.set(x, water.level, z), strength);
    // Only the one you're driving (or yourself) is loud; others are heard faintly.
    audio.splash(loud ? strength : strength * 0.3);
  };

  /** Dry, level, open ground (no building on it), above the water. */
  const dryGround = (x: number, z: number, h: number, minAbove: number) => {
    if (!water || Number.isNaN(h) || h < water.level + minAbove) return false;
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const n = map.heightAt(x + dx, z + dz);
      if (Number.isNaN(n) || Math.abs(n - h) > 0.6) return false;
    }
    const hit = world.castRay(new RAPIER.Ray({ x, y: h + 40, z }, down), 80, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
    return !hit || Math.abs(h + 40 - hit.timeOfImpact - h) < 0.4;
  };

  /** Which way along the road at (x, z): the longest run of road, preferring to face away from `from`. */
  const roadHeading = (x: number, z: number, from: { x: number; z: number }) => {
    const ax = x - from.x;
    const az = z - from.z;
    const al = Math.hypot(ax, az) || 1;
    let best = Math.atan2(-az, ax);
    let bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      let run = 0;
      while (run < 8 && map.surfaceAt?.(x + dx * 2 * (run + 1), z + dz * 2 * (run + 1)) === 'road') run++;
      const score = run + 0.5 * ((dx * ax + dz * az) / al);
      if (score > bestScore) {
        bestScore = score;
        best = Math.atan2(-dz, dx);
      }
    }
    return best;
  };

  /** Out of the water onto the nearest road (or any dry ground), facing along it. */
  const fishOutCar = (c: (typeof cars)[number]) => {
    const t = c.car.body.translation();
    const road = map.nearest?.(t.x, t.z, SHORE_SEARCH, (x, z, surface, h) => surface === 'road' && dryGround(x, z, h, 0.5));
    const spot = road ?? map.nearest?.(t.x, t.z, SHORE_SEARCH, (x, z, _s, h) => dryGround(x, z, h, 0.5)) ?? map.spawn.feet;
    const ground = map.heightAt(spot.x, spot.z);
    c.car.place(new THREE.Vector3(spot.x, (Number.isNaN(ground) ? 0 : ground) + 1, spot.z), roadHeading(spot.x, spot.z, t));
    c.car.body.setLinearDamping(0.05);
    c.car.body.setAngularDamping(0.6);
    c.soaked = null;
    if (c.car === driving) chase.snap();
  };

  const fishOutPlayer = () => {
    const p = player.position;
    const spot = map.nearest?.(p.x, p.z, SHORE_SEARCH, (x, z, _s, h) => dryGround(x, z, h, 0.3)) ?? map.spawn.feet;
    const ground = map.heightAt(spot.x, spot.z);
    // Face inland: away from where they went in.
    const heading = Math.atan2(-(spot.z - p.z), spot.x - p.x);
    player.place(new THREE.Vector3(spot.x, (Number.isNaN(ground) ? 0 : ground) + 0.05, spot.z), heading);
    playerSoaked = null;
    chase.snap(heading);
  };

  /** Fell out of the world: put it back on the ground, just inside the map. */
  const rescue = (car: Car) => {
    const t = car.body.translation();
    const { x, z } = map.clamp(t.x, t.z);
    const ground = map.heightAt(x, z);
    const heading = new THREE.Euler().setFromQuaternion(car.object.quaternion, 'YXZ').y;
    car.place(new THREE.Vector3(x, (Number.isNaN(ground) ? 0 : ground) + 1.5, z), heading);
    if (car === driving) chase.snap();
  };

  // Blob shadows lie on whatever is underneath, tilted to match slopes.
  const down = { x: 0, y: -1, z: 0 };
  const up = new THREE.Vector3(0, 1, 0);
  const _n = new THREE.Vector3();
  const _yawQ = new THREE.Quaternion();
  const shadowRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, down);
  const placeShadow = (shadow: THREE.Mesh, from: THREE.Vector3, yaw: number, exclude: RAPIER.Collider, reach: number) => {
    shadowRay.origin = { x: from.x, y: from.y, z: from.z };
    const hit = world.castRayAndGetNormal(shadowRay, reach, true, undefined, undefined, exclude);
    shadow.visible = !!hit;
    if (!hit) return;
    _n.set(hit.normal.x, hit.normal.y, hit.normal.z);
    shadow.position.set(from.x, from.y - hit.timeOfImpact, from.z).addScaledVector(_n, 0.04);
    shadow.quaternion.setFromUnitVectors(up, _n).multiply(_yawQ.setFromAxisAngle(up, yaw));
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
  splash.addEventListener('pointerup', (e) => {
    // The data credits are links: following one shouldn't also start the game.
    if (!(e.target instanceof Element && e.target.closest('a'))) start();
  });
  addEventListener('keydown', start, { once: true });
  // Some mobile browsers suspend audio when backgrounded; any touch brings it back.
  addEventListener('pointerdown', () => started && audio.unlock());

  /** ?debug fixed viewpoint (screenshots), overriding the chase camera. */
  let debugView: { from: number[]; at: number[] } | null = null;
  // ?debug timing: JS ms per frame, smoothed (physics steps, render submit, whole frame).
  const perf = { physicsMs: 0, renderMs: 0, frameMs: 0 };
  const smooth = (prev: number, v: number) => prev + (v - prev) * 0.1;
  const _euler = new THREE.Euler();
  const _look = new THREE.Vector3();
  let accumulator = 0;
  let last = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;
  let fps = 60;
  const _p = new THREE.Vector3();
  const _a = new THREE.Vector3();

  /**
   * ?debug manual clock (scripts/smoke): the simulation only advances
   * through __game.step(), a fixed tick at a time, so tests don't depend on
   * how fast this machine renders. The animation loop then just draws.
   */
  let manual = false;
  /** Manual mode: draw on the next animation frame (for a screenshot). */
  let drawRequested = false;

  /**
   * One frame of game logic: input, physics steps for `frameDt` of game
   * time, then interpolation, camera, audio and HUD (everything but the
   * draw). `alpha` overrides the interpolation between physics poses.
   */
  const frame = (frameDt: number, alpha?: number) => {
    clock += frameDt;
    input.update();
    if (!started) input.clearPresses();
    // Game time, not wall time: a stalled frame shouldn't spoil a code.
    if (started && !driving && flyCode.feed(input.moveX, input.moveY, clock)) setFlying(!player.flying);
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
      resetCar(driving);
      chase.snap();
    }
    const jump = input.consume('jump');

    // Camera-relative movement on foot: stick up walks away from the camera.
    const cy = chase.yaw;
    const moveX = Math.cos(cy) * input.moveY - Math.sin(cy) * input.moveX;
    const moveZ = Math.sin(cy) * input.moveY + Math.cos(cy) * input.moveX;

    map.update(debugView ? _p.fromArray(debugView.from) : driving ? driving.object.position : player.position);
    // Into the harbour: a splash, a moment sinking (heavily damped, like
    // water), then back on the nearest road.
    for (const c of cars) {
      if (c.frozen) continue;
      const p = c.car.body.translation();
      if (c.soaked === null && inWater(p.x, p.y, p.z)) {
        c.soaked = clock;
        const v = c.car.body.linvel();
        makeSplash(p.x, p.z, Math.hypot(v.x, v.y, v.z) / 12, c.car === driving);
        c.car.body.setLinearDamping(2.5);
        c.car.body.setAngularDamping(3);
      } else if (c.soaked !== null && clock - c.soaked > SOAK_CAR) fishOutCar(c);
    }
    if (!driving && !player.flying) {
      const p = player.position;
      // Feet just under the surface is enough: they may be stuck on the drop by the sea wall.
      if (playerSoaked === null && inWater(p.x, p.y + SUBMERGED - 0.15, p.z)) {
        playerSoaked = clock;
        makeSplash(p.x, p.z, 0.5, true);
      } else if (playerSoaked !== null && clock - playerSoaked > SOAK_PLAYER) fishOutPlayer();
    } else if (driving) playerSoaked = null;
    // Freeze anything standing on ground that hasn't streamed in yet, rather
    // than let it fall through the world.
    for (const c of cars) {
      const p = c.car.body.translation();
      const frozen = !map.hasGround(p.x, p.z);
      if (frozen !== c.frozen) c.car.body.setEnabled(!frozen);
      c.frozen = frozen;
      if (lost(p)) rescue(c.car);
    }
    // The physics body, not the interpolated model, which sits at the origin until the first render.
    const feet = player.body.translation();
    if (!driving && lost(feet)) {
      const { x, z } = map.clamp(feet.x, feet.z);
      const ground = map.heightAt(x, z);
      player.place(new THREE.Vector3(x, (Number.isNaN(ground) ? 0 : ground) + 0.5, z), player.heading);
      chase.snap(player.heading);
    }
    // Flying outruns the streaming sometimes, and there's no ground to fall through.
    const playerFrozen = !driving && !player.flying && !map.hasGround(player.position.x, player.position.z);
    // Fly over the harbour, not along its floor.
    const floor = player.flying ? Math.max(map.heightAt(feet.x, feet.z), water ? water.level : -Infinity) : NaN;

    accumulator += frameDt;
    const tPhys = performance.now();
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      for (const { car, frozen } of cars) {
        if (frozen) continue;
        if (car !== driving) car.update(null, FIXED_DT);
        // Like GTA III: asking to get out at speed brakes to a stop first.
        else if (exitRequested) car.update({ throttle: 0, brake: Math.abs(car.forwardSpeed()) > 1 ? 1 : 0, steer: 0, handbrake: false }, FIXED_DT);
        else car.update(input.drive, FIXED_DT);
      }
      if (!driving && !playerFrozen) player.update({ moveX, moveZ, sprint: input.sprint, jump: jump && steps === 0, rise: input.rise, floor }, FIXED_DT);
      world.step();
      for (const { car, frozen } of cars) if (!frozen) car.afterStep(FIXED_DT);
      if (!driving) player.afterStep();
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) accumulator = 0;
    perf.physicsMs = smooth(perf.physicsMs, performance.now() - tPhys);

    if (driving && exitRequested && Math.abs(driving.forwardSpeed()) < 1.5) exit(driving);

    // Stuck on its roof for a couple of seconds: flip it back over.
    upsideDownTime = driving && driving.isUpsideDown() && Math.abs(driving.forwardSpeed()) < 1 ? upsideDownTime + frameDt : 0;
    if (driving && upsideDownTime > 2) {
      resetCar(driving);
      upsideDownTime = 0;
    }

    map.sync();
    alpha ??= accumulator / FIXED_DT;
    /** The driven car's knock this frame, for missions. */
    let crash = 0;
    for (const [n, { car, shadow }] of cars.entries()) {
      car.render(alpha);
      const seen = car.object.position.distanceTo(camera.position);
      car.setDetail(seen, CAR_DETAIL, CAR_DRAW);
      if (seen < CAR_DETAIL) {
        const yaw = _euler.setFromQuaternion(car.object.quaternion, 'YXZ').y;
        placeShadow(shadow, car.object.position, yaw, car.collider, 2.6);
      } else shadow.visible = false;

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
      if (car === driving) crash = car.impact;
      car.impact = 0;
    }
    skids.flush();
    splashes.update(frameDt);

    if (driving) {
      input.consumeLook(frameDt); // camera stays behind the car
      const speed = driving.forwardSpeed();
      const heading = _euler.setFromQuaternion(driving.object.quaternion, 'YXZ').y;
      chase.update(frameDt, DRIVING, driving.object.position, heading, speed, driving.collider);
      speedo.textContent = `${Math.round(Math.abs(speed) * 3.6)}`;
      audio.setEngine(true, speed, driving.throttle);
      audio.setSkid(driving.skid, speed);
    } else {
      player.render(alpha, frameDt);
      placeShadow(playerShadow, _p.copy(player.position).setY(player.position.y + 0.9), 0, player.collider, 3);
      // Swing in behind only while heading away from the camera, so walking
      // sideways or towards the camera doesn't send it spinning.
      const awayFromCamera = input.moveY > 0.3 && input.moveY > Math.abs(input.moveX) * 0.5;
      chase.rotate(input.consumeLook(frameDt) * 0.006);
      chase.update(frameDt, player.flying ? FLYING : ON_FOOT, player.position, player.heading, player.speed, player.collider, player.speed > 0.5 && awayFromCamera);
      audio.setEngine(false, 0, 0);
      audio.setSkid(0, 0);
      if (player.stepped && !player.flying) audio.footstep();
    }
    player.stepped = false;

    // Missions run on physics poses, not interpolated ones, so stepped tests replay exactly.
    if (missions && started) {
      const at = driving ? driving.body.translation() : player.body.translation();
      missions.tick({ clock, x: at.x, y: at.y, z: at.z, driving: !!driving, speedKmh: driving ? Math.abs(driving.forwardSpeed()) * 3.6 : 0, crash });
      for (const cue of missions.takeCues()) audio.cue(cue);
    }
    // On foot the camera is always close; this only hides them from far debug views.
    player.object.visible = !driving && player.position.distanceTo(camera.position) < CAR_DETAIL;
    playerShadow.visible = player.object.visible;
    speedoBox.classList.toggle('hidden', !driving);
    input.setCanEnter(!!nearby);
    prompt.textContent = nearby
      ? (coarse ? 'Tap 🚗 to get in' : 'Press F to get in')
      : player.flying && !driving
        ? (coarse ? 'Flying: UP / DOWN to climb, the same code to land' : 'Flying: Space / C to climb, Shift for speed, the same code to land')
        : (missions?.view().hint ?? '');

    // Don't follow a sinking car under the water: watch from just above it.
    if (water && camera.position.y < water.level + 0.6) {
      const ground = map.heightAt(camera.position.x, camera.position.z);
      if (!Number.isNaN(ground) && water.covers(ground)) camera.position.y = water.level + 0.6;
    }
    applyDebugView();
    skyDome.follow(camera);
    water?.update(camera, clock);
    if (missions) {
      const view = missions.view();
      const focus = driving ? driving.object.position : player.position;
      markers.update(view, map.heightAt, camera.position, clock);
      camera.updateMatrixWorld();
      missionHud.update(view, camera, focus, map.heightAt);
    }
  };

  const applyDebugView = () => {
    if (!debugView) return;
    camera.position.fromArray(debugView.from);
    camera.lookAt(_look.fromArray(debugView.at));
  };

  renderer.setAnimationLoop((now) => {
    const t0 = performance.now();
    const frameDt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!manual) frame(frameDt);
    else {
      // Paused: fixed viewpoints still stream the city round them, but
      // nothing is drawn until a test asks (software rendering is slow).
      if (debugView) {
        map.update(_p.fromArray(debugView.from));
        map.sync();
        applyDebugView();
        skyDome.follow(camera);
      }
      if (!drawRequested) return;
      drawRequested = false;
    }
    const tRender = performance.now();
    renderer.render(scene, camera);
    const tEnd = performance.now();
    perf.renderMs = smooth(perf.renderMs, tEnd - tRender);
    perf.frameMs = smooth(perf.frameMs, tEnd - t0);

    // Adaptive resolution: trade sharpness for frame rate on slower phones.
    fpsFrames++;
    fpsTime += frameDt;
    if (fpsTime >= 1) {
      fps = fpsFrames / fpsTime;
      if (fps < 45 && pixelRatio > 0.75) pixelRatio = Math.max(0.75, pixelRatio - 0.25);
      else if (fps > 58 && pixelRatio < maxRatio) pixelRatio = Math.min(maxRatio, pixelRatio + 0.25);
      if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
      if (debug) {
        const { render, memory } = renderer.info;
        fpsEl.textContent =
          `${fps.toFixed(0)} fps · ${pixelRatio.toFixed(2)}x · ${render.calls} calls · ${(render.triangles / 1000).toFixed(0)}k tris · ` +
          `${memory.geometries} geo ${memory.textures} tex · js ${perf.frameMs.toFixed(1)} ms (phys ${perf.physicsMs.toFixed(1)}, ` +
          `render ${perf.renderMs.toFixed(1)}) · ${map.debugInfo().loaded ?? 0} chunks`;
      }
      fpsFrames = 0;
      fpsTime = 0;
    }
  });

  /**
   * ?debug: pauses real time (see `manual`) and advances the game `n` fixed
   * ticks of 1/60 s, without drawing. Between batches it waits for the
   * ground round the player (or car, or debug view) to finish streaming,
   * so chunks arrive at the same game time on any machine.
   */
  const step = async (n = 1) => {
    if (!manual) accumulator = 0; // each frame below is then exactly one physics step
    manual = true;
    for (let done = 0; done < n; ) {
      const p = debugView ? _p.fromArray(debugView.from) : driving ? driving.object.position : player.position;
      await map.ensureLoaded(p.x, p.z);
      // Everything the streamer wants from here, not just what a frame happened to start.
      for (map.update(p); map.debugInfo().inFlight; map.update(p)) {
        while (map.debugInfo().inFlight) await new Promise((r) => setTimeout(r, 10));
      }
      const batch = Math.min(STEP_BATCH, n - done);
      // alpha 1: show the latest physics pose, the one the test just stepped to.
      for (let i = 0; i < batch; i++) {
        frame(FIXED_DT, 1);
        // Let mission scripts carry on from this tick before the next, as
        // they would between real frames (a few promise hops deep; microtasks
        // only, so nothing else gets in).
        if (missions?.active) for (let k = 0; k < SCRIPT_HOPS; k++) await null;
      }
      done += batch;
    }
  };

  // State and test hooks for automated tests (scripts/smoke). Only with ?debug.
  if (debug) {
    (window as unknown as { __game: unknown }).__game = {
      state: () => ({
        started,
        mode: driving ? 'car' : 'foot',
        drivingIndex: cars.findIndex((c) => c.car === driving),
        player: player.position.toArray(),
        playerGrounded: player.isGrounded,
        flying: player.flying,
        speedKmh: driving ? Math.abs(driving.forwardSpeed()) * 3.6 : 0,
        skid: driving?.skid ?? 0,
        skidQuads: skids.laid,
        nearCar: !!nearestCar(),
        cars: cars.map(({ car }) => car.object.position.toArray()),
        audio: audio.state,
        fps,
        /** Draw calls and triangles in the last rendered frame. */
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        /** Smoothed JS ms per frame: physics steps, render submission, the whole frame. */
        ...perf,
        map: map.name,
        /** Unit vector towards the sun (north is -z). */
        sun: sun.position.clone().normalize().toArray(),
        /** Sea level, or null if the map has no water. */
        water: water ? water.level : null,
        /** Splashes so far, and whether the player or any car is in the water right now. */
        splashes: splashes.count,
        soaked: playerSoaked !== null || cars.some((c) => c.soaked !== null),
        /** Ground height under the player, or under the car being driven. */
        ground: (() => {
          const p = driving ? driving.object.position : player.position;
          return map.heightAt(p.x, p.z);
        })(),
        /** Surface under the player, or under the car being driven. */
        surface: (() => {
          const p = driving ? driving.object.position : player.position;
          return map.surfaceAt?.(p.x, p.z) ?? null;
        })(),
        ...map.debugInfo(),
      }),
      groundHeight: (x: number, z: number) => map.heightAt(x, z),
      /** Hand-made landmarks loaded: id, position, base and height, detail level drawn. */
      landmarks: () => map.landmarks?.() ?? [],
      /** Fix the camera at `from` looking at `at` ([x, y, z]); pass null to go back to the chase camera. */
      lookFrom: (from: number[] | null, at: number[]) => (debugView = from ? { from, at } : null),
      /**
       * Triangles and meshes in the camera's view by kind (the first word of
       * each mesh's name: terrain, buildings, roads...), for finding what
       * eats the budget.
       */
      breakdown: () => {
        const frustum = new THREE.Frustum().setFromProjectionMatrix(
          new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        );
        const out: Record<string, { meshes: number; tris: number }> = {};
        scene.traverseVisible((o) => {
          if (!(o instanceof THREE.Mesh) || (o.frustumCulled && !frustum.intersectsObject(o))) return;
          const g = o.geometry as THREE.BufferGeometry;
          const count = Math.min(g.index ? g.index.count : g.attributes.position.count, g.drawRange.count);
          const kind = (o.name || 'unnamed').split(' ')[0];
          const e = (out[kind] ??= { meshes: 0, tris: 0 });
          e.meshes++;
          e.tris += Math.floor(count / 3);
          // Merged chunk meshes say how much of each layer they hold.
          for (const [k, v] of Object.entries((o.userData.parts ?? {}) as Record<string, number>)) {
            const p = (out[`${kind}.${k}`] ??= { meshes: 0, tris: 0 });
            p.meshes++;
            p.tris += v;
          }
        });
        return out;
      },
      /**
       * Distance along a ray to the first drawn city surface (chunk meshes:
       * ground, roads, buildings and verandahs, which have no colliders, the
       * landmarks and the far skyline), or null.
       */
      renderHit: (from: number[], dir: number[], far = 50) => {
        scene.updateMatrixWorld(); // paused (manual mode), nothing may have been drawn since chunks arrived
        const ray = new THREE.Raycaster(new THREE.Vector3().fromArray(from), new THREE.Vector3().fromArray(dir).normalize(), 0, far);
        const chunks = scene.children.filter((o) => o.visible && (o.name.startsWith('chunk') || o.name.startsWith('landmark') || o.name === 'skyline'));
        return ray.intersectObjects(chunks, false)[0]?.distance ?? null;
      },
      /** Whether a point is inside the camera's view frustum (not whether something hides it). */
      inView: (p: number[]) => {
        camera.updateMatrixWorld();
        const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        return new THREE.Frustum().setFromProjectionMatrix(m).containsPoint(new THREE.Vector3().fromArray(p));
      },
      /** Camera position. */
      camera: () => camera.position.toArray(),
      /** Names of the map's fixed views (performance budgets are measured from them). */
      views: () => Object.keys(map.views ?? {}),
      /** Fix the camera on one of the map's named views, its heights above the ground there. */
      view: async (name: string) => {
        const v = map.views?.[name];
        if (!v) throw new Error(`no view ${name}`);
        const lift = async ([x, y, z]: number[]) => {
          await map.ensureLoaded(x, z);
          const g = map.heightAt(x, z);
          return [x, (Number.isNaN(g) ? 0 : g) + y, z];
        };
        debugView = { from: await lift(v.from), at: await lift(v.at) };
        return debugView;
      },
      /**
       * Loads the ground at (x, z), then returns the sampled terrain height,
       * the height of the terrain collider straight down from 1 km up (null if
       * none) and of the first fixed collider of any kind (a roof, if there's
       * a building there), plus the surface class there ('road', 'footpath', ...).
       */
      probe: async (x: number, z: number) => {
        await map.ensureLoaded(x, z);
        // New colliders only join scene queries on the next physics step.
        if (manual) await step(2);
        else for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
        const ray = new RAPIER.Ray({ x, y: 1000, z }, down);
        const hit = world.castRay(ray, 2000, true, RAPIER.QueryFilterFlags.ONLY_FIXED, TERRAIN_ONLY_QUERY);
        const top = world.castRay(ray, 2000, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
        return {
          ground: map.heightAt(x, z),
          ray: hit ? 1000 - hit.timeOfImpact : null,
          top: top ? 1000 - top.timeOfImpact : null,
          surface: map.surfaceAt?.(x, z) ?? null,
          canopy: map.canopyAt?.(x, z) ?? null,
        };
      },
      /** Put the player (on foot) at (x, z) on the ground, facing `heading`, with the camera behind. */
      placePlayer: async (x: number, z: number, heading: number) => {
        await map.ensureLoaded(x, z);
        player.place(new THREE.Vector3(x, map.heightAt(x, z) + 0.05, z), heading);
        chase.snap(heading);
      },
      /** Drop the player (index -1) or a car this far below the terrain, to test the fall-out-of-world rescue. */
      sink: async (index: number, depth: number) => {
        const p = index < 0 ? player.position.clone() : cars[index].car.object.position.clone();
        await map.ensureLoaded(p.x, p.z);
        p.y = map.heightAt(p.x, p.z) - depth;
        if (index < 0) player.place(p, player.heading);
        else cars[index].car.place(p, 0);
      },
      /** Parked cars' poses: position and up vector's y (1 = level). */
      carPoses: () => cars.map(({ car, frozen }) => ({
        pos: car.object.position.toArray(),
        up: new THREE.Vector3(0, 1, 0).applyQuaternion(car.object.quaternion).y,
        frozen,
      })),
      /** Missions: what's on screen (banner, subtitle, timer, goal, start markers), how the last one ended, everything said. */
      missions: () => missions?.debugState() ?? null,
      /** Start a mission by id where the player is, abandoning any running one. */
      startMission: (id: string) => missions?.start(id),
      /**
       * The gazetteer: places of a kind (or all), nearest first with `near`, e.g.
       * places('bar', { near: [x, z], within: 200 }). Mission authors find ids here.
       */
      places: (kind?: string, q: { near?: [number, number]; within?: number } = {}) =>
        map.places?.find(kind, { near: q.near && { x: q.near[0], z: q.near[1] }, within: q.within }) ?? [],
      /** One place by id. */
      place: (id: string) => map.places?.get(id) ?? null,
      /** The road graph's size: nodes, edges, km (and km where traffic can always drive on), one-ways, signals. */
      roadGraph: () => map.roads?.stats() ?? null,
      /** The nearest road to (x, z): its edge, how far along, which side, and the street's lanes. */
      roadAt: (x: number, z: number, within?: number) => {
        const r = map.roads?.nearest(x, z, { within, open: false });
        if (!r) return null;
        const { edge: e, ...at } = r;
        return { ...at, edge: e.index, name: e.name, highway: e.highway, fw: e.fw, bw: e.bw, width: e.width, length: e.length, stops: [e.stopA, e.stopB], main: e.main, restricted: e.restricted };
      },
      /**
       * The shortest legal drive between two points: metres, the centreline,
       * and each leg (edge, direction, street, whether it was driven with the
       * traffic, which is always true unless routing is broken, and its midpoint).
       */
      route: (from: [number, number], to: [number, number]) => {
        const r = map.roads?.route({ x: from[0], z: from[1] }, { x: to[0], z: to[1] });
        if (!r) return null;
        return {
          length: r.length,
          points: r.points.map((p) => [p.x, p.z]),
          legs: r.legs.map((l) => {
            const mid = map.roads!.pointAt(l.edge, l.edge.length / 2);
            return { edge: l.edge.index, dir: l.dir, name: l.edge.name, bridge: l.edge.bridge, legal: (l.dir > 0 ? l.edge.fw : l.edge.bw) > 0, mid: [mid.x, mid.y, mid.z] };
          }),
        };
      },
      step,
      /** Manual mode: draw a frame (for a screenshot); resolves once it's on screen. */
      draw: async () => {
        drawRequested = true;
        for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
      },
      /** Back to real time after step(). */
      realtime: () => {
        manual = false;
      },
      /**
       * Back to the start: on foot at the spawn, not flying, every car on its
       * parking spot and out of the water, the chase camera behind, the
       * clock paused (manual). For smoke areas that run on their own (--only).
       */
      reset: async () => {
        debugView = null;
        if (driving) exit(driving);
        setFlying(false);
        for (const [i, c] of cars.entries()) {
          const spot = map.parking[i];
          c.car.place(spot.pos.clone(), spot.heading, spot.pitch, spot.roll);
          c.car.body.setLinearDamping(0.05);
          c.car.body.setAngularDamping(0.6);
          c.soaked = null;
        }
        await map.ensureLoaded(map.spawn.feet.x, map.spawn.feet.z);
        player.place(map.spawn.feet.clone(), map.spawn.heading);
        playerSoaked = null;
        upsideDownTime = 0;
        missions?.reset();
        input.clearPresses();
        chase.snap(map.spawn.heading);
        await step(2); // and stays paused: what follows is stepped from here
      },
      /** Move a car (default: the purple one) to (x, z) on the ground, facing `heading`. */
      teleportCar: async (index: number, x: number, z: number, heading: number) => {
        await map.ensureLoaded(x, z);
        const car = cars[index].car;
        car.place(new THREE.Vector3(x, map.heightAt(x, z) + 0.9, z), heading);
        if (car === driving) chase.snap();
      },
    };
  }
}

main().catch((err) => {
  console.error(err);
  const status = document.getElementById('status');
  if (status) status.textContent = `Couldn't start: ${err instanceof Error ? err.message : err}`;
});
