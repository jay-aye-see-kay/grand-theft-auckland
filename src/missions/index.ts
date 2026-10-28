import type { Mission } from './runtime/mission.ts';

// Every mission file in this folder: adding a mission is adding a file.

const files = import.meta.glob<{ default: Mission }>(['./*.ts', '!./index.ts'], { eager: true });

/** By id, so the order (and so the smoke test) doesn't depend on the bundler. */
export const MISSIONS: readonly Mission[] = Object.entries(files)
  .map(([file, mod]) => {
    const id = file.replace(/^\.\/|\.ts$/g, '');
    if (mod.default?.id !== id) throw new Error(`mission ${file} should export default defineMission({ id: '${id}', ... })`);
    return mod.default;
  })
  .sort((a, b) => a.id.localeCompare(b.id));
