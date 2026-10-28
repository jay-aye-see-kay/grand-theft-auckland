import * as THREE from 'three';
import { formatTime } from './mission.ts';
import type { MissionView } from './runner.ts';

// The mission HUD, drawn in the DOM over the game: title cards and MISSION
// PASSED banners, subtitles, the timer and objective line, and an arrow to
// the goal (pink), or while idle to the nearest mission (gold). The arrow
// sits over the goal when it's on screen and clings to the screen edge,
// pointing the way, when it isn't. Stands in for a minimap until #14.

/** The arrow keeps this far inside the screen edge, px. */
const EDGE = 56;
/** On screen means inside this much of the view (NDC), else it goes to the edge. */
const INSIDE = 0.86;
/** Point the arrow at this height above the goal's ground, m. */
const LIFT = 4;
/** The idle arrow to the nearest mission only shows within this, m. */
const IDLE_RANGE = 1500;

const CHEVRON = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 4 L21 12 L4 20 L8 12 Z" fill="currentColor" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>';

const el = (parent: HTMLElement, cls: string, html = '') => {
  const e = document.createElement('div');
  e.className = cls;
  e.innerHTML = html;
  parent.appendChild(e);
  return e;
};

export class MissionHud {
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerText: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly objective: HTMLElement;
  private readonly arrow: HTMLElement;
  private readonly arrowHead: HTMLElement;
  private readonly arrowLabel: HTMLElement;
  private readonly _v = new THREE.Vector3();
  private readonly _fwd = new THREE.Vector3();
  /** Last text written to each element, so unchanged frames don't touch the DOM. */
  private readonly written = new Map<HTMLElement, string>();

  constructor(hud: HTMLElement) {
    const root = el(hud, 'mission');
    this.banner = el(root, 'mission-banner hidden');
    this.bannerTitle = el(this.banner, 'mission-banner-title');
    this.bannerText = el(this.banner, 'mission-banner-text');
    this.clock = el(root, 'mission-clock hidden');
    this.objective = el(root, 'mission-objective hidden');
    this.subtitle = el(root, 'mission-subtitle hidden');
    this.arrow = el(root, 'mission-arrow hidden');
    this.arrowHead = el(this.arrow, 'mission-arrow-head', CHEVRON);
    this.arrowLabel = el(this.arrow, 'mission-arrow-label');
  }

  update(view: MissionView, camera: THREE.PerspectiveCamera, from: THREE.Vector3, heightAt: (x: number, z: number) => number): void {
    const b = view.banner;
    this.show(this.banner, !!b);
    if (b) {
      this.banner.dataset.kind = b.kind;
      this.text(this.bannerTitle, b.title);
      this.text(this.bannerText, b.text);
    }
    this.show(this.subtitle, !!view.subtitle);
    this.text(this.subtitle, view.subtitle ?? '');
    this.show(this.objective, !!view.objective);
    this.text(this.objective, view.objective);
    const c = view.clock;
    this.show(this.clock, !!c);
    if (c) {
      this.text(this.clock, formatTime(c.seconds, !c.down));
      this.clock.classList.toggle('urgent', c.down && c.seconds < 10.5);
    }

    const idle = view.nearest && Math.hypot(view.nearest.x - from.x, view.nearest.z - from.z) < IDLE_RANGE ? view.nearest : null;
    // The gold arrow to the next mission waits until the last one's banner has gone.
    const goal = view.target ?? (view.active || view.banner ? null : idle);
    this.show(this.arrow, !!goal);
    if (!goal) return;
    this.arrow.dataset.kind = view.target ? 'goal' : 'start';
    const d = Math.hypot(goal.x - from.x, goal.z - from.z);
    const name = view.target ? '' : `${(goal as { title: string }).title} · `;
    this.text(this.arrowLabel, `${name}${d < 1000 ? `${Math.round(d / 5) * 5} m` : `${(d / 1000).toFixed(1)} km`}`);
    this.point(goal.x, goal.z, heightAt(goal.x, goal.z), camera);
  }

  /** Over the goal if it's in view, else on the screen edge pointing at it. */
  private point(x: number, z: number, ground: number, camera: THREE.PerspectiveCamera): void {
    const w = innerWidth;
    const h = innerHeight;
    const v = this._v.set(x, (Number.isNaN(ground) ? camera.position.y : ground) + LIFT, z);
    camera.getWorldDirection(this._fwd);
    const behind = v.clone().sub(camera.position).dot(this._fwd) < 0;
    v.project(camera);
    let px: number;
    let py: number;
    let angle: number;
    if (!behind && Math.abs(v.x) < INSIDE && Math.abs(v.y) < INSIDE) {
      px = ((v.x + 1) / 2) * w;
      py = ((1 - v.y) / 2) * h;
      angle = 90; // pointing down at it
    } else {
      // Behind the camera, projection mirrors it: flip, and keep it off the top edge.
      let sx = behind ? -v.x : v.x;
      let sy = behind ? v.y : -v.y;
      if (behind) sy = Math.max(sy, 0.3);
      const len = Math.hypot(sx, sy) || 1;
      sx /= len;
      sy /= len;
      const k = Math.min((w / 2 - EDGE) / Math.max(Math.abs(sx), 1e-3), (h / 2 - EDGE) / Math.max(Math.abs(sy), 1e-3));
      px = w / 2 + sx * k;
      py = h / 2 + sy * k;
      angle = (Math.atan2(sy, sx) * 180) / Math.PI;
    }
    this.arrow.style.transform = `translate(${px.toFixed(0)}px, ${py.toFixed(0)}px)`;
    this.arrowHead.style.transform = `rotate(${angle.toFixed(0)}deg)`;
  }

  private show(e: HTMLElement, on: boolean): void {
    if (e.classList.contains('hidden') === on) e.classList.toggle('hidden', !on);
  }

  private text(e: HTMLElement, t: string): void {
    if (this.written.get(e) === t) return;
    this.written.set(e, t);
    e.textContent = t;
  }
}
