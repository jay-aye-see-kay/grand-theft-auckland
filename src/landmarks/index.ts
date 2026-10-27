import type { LandmarkModel } from './landmarks.ts';
import { chiefPostOffice } from './chief-post-office.ts';
import { civicTheatre } from './civic-theatre.ts';
import { ferryBuilding } from './ferry-building.ts';
import { skyTower } from './sky-tower.ts';

/** Every hand-made landmark model, placed where the manifest has a record with its id. */
export const LANDMARK_MODELS: LandmarkModel[] = [skyTower, ferryBuilding, chiefPostOffice, civicTheatre];
