import * as THREE from 'three';
import { ATLAS_SIZE, FACADE, LAYERS, type Layer } from './facades.ts';

// The city's texture atlas, painted with canvas 2D at load time (nothing to
// download): one 512 px layer per material in LAYERS, as a texture array
// so each layer repeats and mip-maps on its own.
//
// Each layer has two paintings: colour (sRGB) and a tint mask in alpha.
// Where the mask is white the chunk shader multiplies the texel by the
// vertex colour (the building's paint, brick or concrete), so tinted areas
// are painted near TINT_GREY and carry only light and texture; glass,
// shopfronts and signs are painted in their own colours with the mask low.
//
// Canvas y runs down the wall (top of the canvas = top of a floor); rows are
// flipped on the way into the texture, where v runs up.

/** Tinted areas are painted about this grey; the shader divides it back out (TINT_GAIN). */
export const TINT_GREY = 224;
/** 1 / (TINT_GREY as linear light): a tinted texel of TINT_GREY comes out as the vertex colour. */
export const TINT_GAIN = 1 / Math.pow(TINT_GREY / 255, 2.2);

export type Ctx = CanvasRenderingContext2D;
export type Painter = (c: Ctx, m: Ctx, rnd: () => number) => void;

const S = ATLAS_SIZE;

export function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const grey = (v: number, a = 1) => `rgba(${v | 0},${v | 0},${v | 0},${a})`;
export const rgb = (r: number, g: number, b: number, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

/** Fills a rect on both paintings: colour, and tint mask 0..1. */
export function rect(c: Ctx, m: Ctx, x: number, y: number, w: number, h: number, colour: string, mask: number) {
  c.fillStyle = colour;
  c.fillRect(x, y, w, h);
  m.fillStyle = grey(mask * 255);
  m.fillRect(x, y, w, h);
}

/** Speckle noise over an area (colour only), wrapping round the layer's edges. */
export function speckle(c: Ctx, rnd: () => number, n: number, size: number, spread: number, x0 = 0, y0 = 0, w = S, h = S) {
  for (let k = 0; k < n; k++) {
    const v = 128 + (rnd() - 0.5) * 255;
    c.fillStyle = grey(v, spread * rnd());
    const s = size * (0.5 + rnd());
    c.fillRect(x0 + rnd() * w, y0 + rnd() * h, s, s);
  }
}

/** Soft blotches (stains, wear), wrapping so the layer still tiles. */
export function blotches(c: Ctx, rnd: () => number, n: number, r0: number, r1: number, dark: number, light: number) {
  for (let k = 0; k < n; k++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = r0 + rnd() * (r1 - r0);
    const shade = rnd() < 0.5 ? `rgba(0,0,0,${dark * rnd()})` : `rgba(255,255,255,${light * rnd()})`;
    for (const dx of [-S, 0, S]) {
      for (const dy of [-S, 0, S]) {
        const g = c.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        g.addColorStop(0, shade);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g;
        c.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
    }
  }
}

/** A tinted base wall with a little grain. */
export function wallBase(c: Ctx, m: Ctx, rnd: () => number, v = TINT_GREY) {
  rect(c, m, 0, 0, S, S, grey(v), 1);
  speckle(c, rnd, 2500, 2, 0.12);
  blotches(c, rnd, 14, 30, 90, 0.08, 0.06);
}

/**
 * Glass that reflects the sky: lighter at the top of each pane, a cooler
 * darker blue below, each pane a little different. `mask` lets some of the
 * building's tint through (bronze, green, silver glass).
 */
export function glass(c: Ctx, m: Ctx, rnd: () => number, x: number, y: number, w: number, h: number, mask: number, dark = 0) {
  const k = 0.85 + rnd() * 0.3 - dark;
  const g = c.createLinearGradient(x, y, x + w * 0.3, y + h);
  g.addColorStop(0, rgb(150 * k, 178 * k, 198 * k));
  g.addColorStop(0.45, rgb(92 * k, 120 * k, 142 * k));
  g.addColorStop(1, rgb(52 * k, 70 * k, 88 * k));
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
  // A diagonal sheen.
  c.fillStyle = `rgba(255,255,255,${0.06 + rnd() * 0.08})`;
  c.beginPath();
  c.moveTo(x + w * 0.2, y);
  c.lineTo(x + w * 0.55, y);
  c.lineTo(x + w * 0.15, y + h);
  c.lineTo(x, y + h);
  c.lineTo(x, y + h * 0.6);
  c.closePath();
  c.fill();
  m.fillStyle = grey(mask * 255);
  m.fillRect(x, y, w, h);
}

/** A dark window with a reveal (shadow along its top and one side) and a sill. */
export function punched(c: Ctx, m: Ctx, rnd: () => number, x: number, y: number, w: number, h: number, frame: string | null, bars: boolean) {
  glass(c, m, rnd, x, y, w, h, 0.05, 0.25);
  // Interior: some windows have blinds down.
  if (rnd() < 0.35) {
    c.fillStyle = `rgba(225,220,205,${0.35 + rnd() * 0.3})`;
    c.fillRect(x, y, w, h * (0.2 + rnd() * 0.5));
  }
  if (frame) {
    c.strokeStyle = frame;
    c.lineWidth = 5;
    c.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
    if (bars) {
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(x + w / 2, y);
      c.lineTo(x + w / 2, y + h);
      c.moveTo(x, y + h * 0.4);
      c.lineTo(x + w, y + h * 0.4);
      c.stroke();
    }
  }
  // Reveal shadow.
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillRect(x, y, w, 6);
  c.fillRect(x, y, 5, h);
  // Sill.
  rect(c, m, x - 4, y + h, w + 8, 6, grey(236), 1);
  c.fillStyle = 'rgba(0,0,0,0.25)';
  c.fillRect(x - 4, y + h + 6, w + 8, 4);
}

/** Bay and floor size in px for a facade layer. */
const cell = (layer: Layer) => ({ bw: S / FACADE[layer]!.bays, fh: S / FACADE[layer]!.floors });

export const painters: Record<Layer, Painter> = {
  glass(c, m, rnd) {
    const { bw, fh } = cell('glass');
    rect(c, m, 0, 0, S, S, grey(TINT_GREY), 1);
    for (let f = 0; f < 4; f++) {
      const y = f * fh;
      for (let b = 0; b < 4; b++) {
        // Two panes per bay, one floor tall, over an opaque spandrel.
        for (let p = 0; p < 2; p++) glass(c, m, rnd, b * bw + p * (bw / 2) + 3, y + 3, bw / 2 - 6, fh - 30, 0.45);
        glass(c, m, rnd, b * bw + 3, y + fh - 24, bw - 6, 21, 0.6, 0.35);
      }
    }
    // Mullions and transoms catch the light.
    for (let b = 0; b <= 8; b++) rect(c, m, b * (bw / 2) - 3, 0, 6, S, grey(b % 2 ? 205 : 235), 1);
    for (let f = 0; f <= 4; f++) rect(c, m, 0, f * fh - 3, S, 6, grey(232), 1);
  },
  ribbon(c, m, rnd) {
    const { fh } = cell('ribbon');
    wallBase(c, m, rnd);
    for (let f = 0; f < 4; f++) {
      const y = f * fh + 10;
      const h = fh * 0.52;
      glass(c, m, rnd, 0, y, S, h, 0.1, 0.3);
      for (let x = 0; x < S; x += S / 8) rect(c, m, x - 2, y, 4, h, grey(40), 0.2);
      // Shadow under the spandrel above, highlight on the sill.
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.fillRect(0, y, S, 7);
      rect(c, m, 0, y + h, S, 5, grey(240), 1);
      // Panel joints in the spandrel.
      c.fillStyle = 'rgba(0,0,0,0.12)';
      for (let x = 0; x < S; x += S / 4) c.fillRect(x, y + h, 2, fh - h);
    }
  },
  grid(c, m, rnd) {
    const { bw, fh } = cell('grid');
    wallBase(c, m, rnd);
    for (let f = 0; f < 4; f++) {
      for (let b = 0; b < 4; b++) punched(c, m, rnd, b * bw + bw * 0.16, f * fh + fh * 0.14, bw * 0.68, fh * 0.6, null, false);
      // Floor line in the precast panels.
      c.fillStyle = 'rgba(0,0,0,0.12)';
      c.fillRect(0, f * fh + fh - 3, S, 3);
    }
    c.fillStyle = 'rgba(0,0,0,0.08)';
    for (let b = 0; b < 4; b++) c.fillRect(b * bw, 0, 3, S);
  },
  stucco(c, m, rnd) {
    const { bw, fh } = cell('stucco');
    wallBase(c, m, rnd, TINT_GREY + 4);
    for (let f = 0; f < 4; f++) {
      for (let b = 0; b < 4; b++) punched(c, m, rnd, b * bw + bw * 0.25, f * fh + fh * 0.2, bw * 0.5, fh * 0.56, '#f2efe8', true);
    }
  },
  brick(c, m, rnd) {
    const { bw, fh } = cell('brick');
    // Courses of bricks, each a little different, on pale grey mortar (barely tinted).
    rect(c, m, 0, 0, S, S, '#c4c0b8', 0.3);
    m.fillStyle = grey(255);
    const course = 8;
    for (let y = 0; y < S; y += course) {
      const off = (y / course) % 2 ? 11 : 0;
      for (let x = -off; x < S; x += 22) {
        const v = TINT_GREY - 14 + (rnd() - 0.5) * 34;
        c.fillStyle = grey(v);
        c.fillRect(x + 1, y + 1, 20, course - 2);
        m.fillRect(x + 1, y + 1, 20, course - 2);
      }
    }
    blotches(c, rnd, 10, 40, 100, 0.12, 0.04);
    for (let f = 0; f < 3; f++) {
      const y0 = f * fh;
      // String course at each floor.
      rect(c, m, 0, y0 + fh - 12, S, 9, grey(238), 0.25);
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(0, y0 + fh - 3, S, 3);
      for (let b = 0; b < 3; b++) {
        const w = bw * 0.42;
        const x = b * bw + (bw - w) / 2;
        const top = y0 + fh * 0.2;
        const h = fh * 0.58;
        // Stone arch and keystone round an arched window.
        c.fillStyle = '#e6dcc6';
        c.beginPath();
        c.arc(x + w / 2, top + w / 2, w / 2 + 9, Math.PI, 0);
        c.lineTo(x + w + 9, top + w / 2 + 4);
        c.lineTo(x - 9, top + w / 2 + 4);
        c.fill();
        m.fillStyle = grey(70);
        m.fillRect(x - 10, top - 10, w + 20, w / 2 + 16);
        c.save();
        c.beginPath();
        c.arc(x + w / 2, top + w / 2, w / 2, Math.PI, 0);
        c.lineTo(x + w, top + h);
        c.lineTo(x, top + h);
        c.closePath();
        c.clip();
        punched(c, m, rnd, x, top, w, h, '#efe9dc', true);
        c.restore();
        rect(c, m, x + w / 2 - 6, top - 10, 12, 14, '#efe6d2', 0.2);
        rect(c, m, x - 6, top + h, w + 12, 7, '#e6dcc6', 0.2);
      }
    }
  },
  stone(c, m, rnd) {
    const { bw, fh } = cell('stone');
    wallBase(c, m, rnd, TINT_GREY + 6);
    // Ashlar joints.
    c.fillStyle = 'rgba(0,0,0,0.1)';
    for (let y = 0; y < S; y += 21) {
      c.fillRect(0, y, S, 2);
      for (let x = ((y / 21) % 2) * 28; x < S; x += 56) c.fillRect(x, y, 2, 21);
    }
    for (let f = 0; f < 3; f++) {
      const y0 = f * fh;
      // Cornice at the floor line: light top, shadow beneath.
      rect(c, m, 0, y0 + fh - 14, S, 8, grey(244), 1);
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.fillRect(0, y0 + fh - 6, S, 6);
      for (let b = 0; b < 3; b++) {
        // Pilasters between bays.
        rect(c, m, b * bw, y0, 16, fh - 14, grey(238), 1);
        c.fillStyle = 'rgba(0,0,0,0.18)';
        c.fillRect(b * bw + 16, y0, 4, fh - 14);
        const w = bw * 0.4;
        const x = b * bw + (bw - w) / 2 + 8;
        const top = y0 + fh * 0.22;
        const h = fh * 0.55;
        punched(c, m, rnd, x, top, w, h, '#f4f0e6', true);
        // Pediment over the window.
        c.fillStyle = grey(242);
        c.beginPath();
        c.moveTo(x - 10, top - 6);
        c.lineTo(x + w / 2, top - 22);
        c.lineTo(x + w + 10, top - 6);
        c.fill();
        c.fillStyle = 'rgba(0,0,0,0.25)';
        c.fillRect(x - 10, top - 6, w + 20, 4);
      }
    }
  },
  balcony(c, m, rnd) {
    const { bw, fh } = cell('balcony');
    wallBase(c, m, rnd, TINT_GREY + 8);
    for (let f = 0; f < 4; f++) {
      const y0 = f * fh;
      for (let b = 0; b < 3; b++) {
        // Sliding doors behind the balcony, and a glass balustrade in front.
        glass(c, m, rnd, b * bw + 10, y0 + 12, bw - 20, fh - 30, 0.05, 0.2);
        c.fillStyle = 'rgba(0,0,0,0.35)';
        c.fillRect(b * bw + 10, y0 + 12, bw - 20, 8);
        c.fillStyle = `rgba(200,215,220,${0.35 + rnd() * 0.1})`;
        c.fillRect(b * bw + 6, y0 + fh - 62, bw - 12, 44);
        c.fillStyle = 'rgba(40,40,40,0.8)';
        c.fillRect(b * bw + 6, y0 + fh - 64, bw - 12, 3);
        // Dividing fin between flats.
        rect(c, m, b * bw - 5, y0, 10, fh, grey(232), 1);
      }
      // Slab edge, bright in the sun, shadow under it.
      rect(c, m, 0, y0 + fh - 18, S, 14, grey(248), 0.35);
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.fillRect(0, y0 + fh - 4, S, 4);
    }
  },
  plain(c, m, rnd) {
    wallBase(c, m, rnd);
    // Precast panel joints and rain streaks.
    c.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = 0; x < S; x += S / 4) c.fillRect(x, 0, 2, S);
    for (let y = 0; y < S; y += S / 4) c.fillRect(0, y, S, 2);
    for (let k = 0; k < 40; k++) {
      const x = rnd() * S;
      const y = (Math.floor(rnd() * 4) * S) / 4;
      const g = c.createLinearGradient(0, y, 0, y + 40 + rnd() * 80);
      g.addColorStop(0, `rgba(0,0,0,${0.06 + rnd() * 0.08})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(x, y, 4 + rnd() * 10, 120);
    }
  },
  shop(c, m, rnd) {
    // One storey, two shops. Top: fascia and sign board (mostly under the verandah).
    const bw = S / 2;
    rect(c, m, 0, 0, S, S, grey(TINT_GREY), 1);
    const signs = [[40, 44, 52], [180, 40, 40], [30, 90, 140], [230, 200, 60], [240, 240, 236], [20, 110, 80], [120, 40, 110]];
    for (let b = 0; b < 2; b++) {
      const x = b * bw;
      const sc = signs[Math.floor(rnd() * signs.length)];
      rect(c, m, x + 6, 10, bw - 12, 80, rgb(sc[0], sc[1], sc[2]), 0);
      // Parody lettering: blocky, unreadable.
      c.fillStyle = sc[0] + sc[1] + sc[2] > 400 ? 'rgba(20,20,20,0.85)' : 'rgba(250,250,245,0.9)';
      let tx = x + 26;
      while (tx < x + bw - 50) {
        const w = 10 + rnd() * 16;
        c.fillRect(tx, 34, w, 32);
        tx += w + 5 + (rnd() < 0.2 ? 14 : 0);
      }
      // Shop window: dark interior, lit displays, reflections.
      const top = 100;
      const h = S - top - 34;
      const g = c.createLinearGradient(0, top, 0, top + h);
      g.addColorStop(0, '#2a3036');
      g.addColorStop(1, '#14181c');
      c.fillStyle = g;
      c.fillRect(x + 6, top, bw - 12, h);
      for (let k = 0; k < 9; k++) {
        c.fillStyle = `hsla(${rnd() * 360},${30 + rnd() * 40}%,${45 + rnd() * 30}%,0.7)`;
        c.fillRect(x + 20 + rnd() * (bw - 70), top + 60 + rnd() * (h - 120), 14 + rnd() * 40, 20 + rnd() * 60);
      }
      c.fillStyle = 'rgba(255,250,235,0.18)';
      c.fillRect(x + 6, top, bw - 12, 30);
      c.fillStyle = 'rgba(190,210,225,0.16)';
      c.beginPath();
      c.moveTo(x + 40, top);
      c.lineTo(x + 110, top);
      c.lineTo(x + 50, top + h);
      c.lineTo(x + 6, top + h);
      c.closePath();
      c.fill();
      m.fillStyle = grey(0);
      m.fillRect(x + 6, top, bw - 12, h);
      // Door in the first shop.
      if (b === 0) {
        rect(c, m, x + bw - 80, top + 30, 60, h - 30, '#1a1e22', 0);
        c.fillStyle = 'rgba(180,200,210,0.25)';
        c.fillRect(x + bw - 74, top + 36, 48, h - 50);
      }
      // Aluminium frames.
      c.fillStyle = '#9ea4a8';
      for (const fx of [x + 6, x + bw / 2, x + bw - 10]) c.fillRect(fx, top, 4, h);
      c.fillRect(x + 6, top, bw - 12, 4);
      c.fillRect(x + 6, top + h - 4, bw - 12, 4);
      // Kick plate.
      rect(c, m, x, S - 34, bw, 34, '#3a3c3e', 0);
    }
    rect(c, m, 0, 0, 6, S, grey(TINT_GREY - 20), 1);
    rect(c, m, bw - 6, 0, 12, S, grey(TINT_GREY - 20), 1);
  },
  'shop-heritage'(c, m, rnd) {
    const bw = S / 2;
    rect(c, m, 0, 0, S, S, grey(TINT_GREY), 1);
    const paints = [[38, 64, 48], [96, 30, 34], [32, 44, 70], [224, 214, 190], [20, 20, 22], [130, 90, 40]];
    for (let b = 0; b < 2; b++) {
      const x = b * bw;
      const p = paints[Math.floor(rnd() * paints.length)];
      const paint = rgb(p[0], p[1], p[2]);
      // Fascia board with painted lettering.
      rect(c, m, x + 4, 8, bw - 8, 60, paint, 0);
      c.fillStyle = 'rgba(235,215,150,0.85)';
      let tx = x + 30;
      while (tx < x + bw - 50) {
        const w = 8 + rnd() * 12;
        c.fillRect(tx, 28, w, 22);
        tx += w + 4 + (rnd() < 0.2 ? 12 : 0);
      }
      // Transom lights: small leaded panes.
      rect(c, m, x + 4, 72, bw - 8, 54, paint, 0);
      for (let k = 0; k < 6; k++) glass(c, m, rnd, x + 10 + k * ((bw - 20) / 6), 78, (bw - 20) / 6 - 6, 42, 0, 0.1);
      // Display windows with timber frames over a tiled stallriser.
      const top = 132;
      const sill = S - 80;
      rect(c, m, x + 4, top, bw - 8, S - top, paint, 0);
      const doorW = 70;
      const winW = (bw - 8 - doorW - 16) / 2;
      for (const wx of [x + 10, x + 10 + winW + doorW + 4]) {
        const g = c.createLinearGradient(0, top, 0, sill);
        g.addColorStop(0, '#303842');
        g.addColorStop(1, '#171b20');
        c.fillStyle = g;
        c.fillRect(wx, top + 6, winW, sill - top - 6);
        for (let k = 0; k < 5; k++) {
          c.fillStyle = `hsla(${rnd() * 360},${30 + rnd() * 40}%,${50 + rnd() * 25}%,0.6)`;
          c.fillRect(wx + 8 + rnd() * (winW - 40), top + 120 + rnd() * 160, 12 + rnd() * 28, 20 + rnd() * 50);
        }
        c.fillStyle = 'rgba(200,215,230,0.14)';
        c.fillRect(wx, top + 6, winW * 0.4, sill - top - 6);
        c.fillStyle = paint;
        c.fillRect(wx + winW / 2 - 2, top + 6, 4, sill - top - 6);
        // Tiled stallriser.
        for (let ty = sill + 8; ty < S - 4; ty += 12) {
          for (let tx2 = wx; tx2 < wx + winW; tx2 += 12) {
            c.fillStyle = rgb(70 + rnd() * 30, 90 + rnd() * 30, 80 + rnd() * 20);
            c.fillRect(tx2 + 1, ty + 1, 10, 10);
          }
        }
      }
      // Recessed door: deep shadow, a panelled door.
      const dx = x + 10 + winW + 2;
      rect(c, m, dx, top + 6, doorW, S - top - 6, '#0e1012', 0);
      rect(c, m, dx + 12, top + 40, doorW - 24, S - top - 50, rgb(p[0] * 0.7, p[1] * 0.7, p[2] * 0.7), 0);
      glass(c, m, rnd, dx + 18, top + 50, doorW - 36, 150, 0, 0.3);
    }
    // Pilasters between the shops.
    for (const px of [0, bw - 8, S - 8]) rect(c, m, px, 0, 16, S, grey(TINT_GREY + 10), 1);
  },
  lobby(c, m, rnd) {
    const bw = S / 2;
    rect(c, m, 0, 0, S, S, grey(TINT_GREY), 1);
    for (let b = 0; b < 2; b++) {
      const x = b * bw;
      // Tall glazing with a warm, lit lobby behind.
      const g = c.createLinearGradient(0, 30, 0, S);
      g.addColorStop(0, '#6f8494');
      g.addColorStop(0.5, '#3a4650');
      g.addColorStop(1, '#5a5245');
      c.fillStyle = g;
      c.fillRect(x + 36, 30, bw - 72, S - 30);
      c.fillStyle = 'rgba(255,230,180,0.18)';
      c.fillRect(x + 36, S * 0.55, bw - 72, S * 0.45);
      c.fillStyle = 'rgba(30,30,30,0.9)';
      for (let k = 1; k < 4; k++) c.fillRect(x + 36 + (k * (bw - 72)) / 4 - 2, 30, 4, S - 30);
      c.fillRect(x + 36, S * 0.35, bw - 72, 4);
      m.fillStyle = grey(0);
      m.fillRect(x + 36, 30, bw - 72, S - 30);
      // Stone-clad columns, a little darker than the tower.
      rect(c, m, x, 0, 36, S, grey(TINT_GREY - 40), 1);
      rect(c, m, x + bw - 36, 0, 36, S, grey(TINT_GREY - 40), 1);
      c.fillStyle = 'rgba(255,255,255,0.12)';
      c.fillRect(x + 4, 0, 8, S);
      c.fillRect(x + bw - 32, 0, 8, S);
      speckle(c, rnd, 300, 2, 0.2, x, 0, 36, S);
    }
    rect(c, m, 0, 0, S, 30, grey(TINT_GREY - 30), 1);
  },
  roof(c, m, rnd) {
    wallBase(c, m, rnd, TINT_GREY - 8);
    speckle(c, rnd, 9000, 2, 0.25);
    c.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = 0; x < S; x += S / 5) c.fillRect(x, 0, 2, S);
    blotches(c, rnd, 12, 40, 120, 0.15, 0.08);
  },
  asphalt(c, m, rnd) {
    wallBase(c, m, rnd);
    speckle(c, rnd, 26000, 1.6, 0.3);
    blotches(c, rnd, 10, 60, 160, 0.07, 0.06);
    // A few hairline cracks and a patch.
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = 1.2;
    for (let k = 0; k < 6; k++) {
      let x = rnd() * S;
      let y = rnd() * S;
      c.beginPath();
      c.moveTo(x, y);
      for (let s = 0; s < 8; s++) {
        x += (rnd() - 0.5) * 30;
        y += (rnd() - 0.5) * 30;
        c.lineTo(x, y);
      }
      c.stroke();
    }
  },
  paving(c, m, rnd) {
    rect(c, m, 0, 0, S, S, grey(TINT_GREY - 30), 1);
    // Grey pavers, 600 x 300 mm in a running bond.
    const pw = 64;
    const ph = 32;
    for (let y = 0; y < S; y += ph) {
      const off = (y / ph) % 2 ? pw / 2 : 0;
      for (let x = -off; x < S; x += pw) {
        c.fillStyle = grey(TINT_GREY - 6 + (rnd() - 0.5) * 22);
        c.fillRect(x + 1.5, y + 1.5, pw - 3, ph - 3);
      }
    }
    speckle(c, rnd, 9000, 1.5, 0.25);
    blotches(c, rnd, 10, 40, 110, 0.12, 0.05);
  },
  ground(c, m, rnd) {
    wallBase(c, m, rnd);
    speckle(c, rnd, 12000, 2, 0.14);
    blotches(c, rnd, 22, 30, 110, 0.14, 0.08);
  },
  concrete(c, m, rnd) {
    wallBase(c, m, rnd, TINT_GREY + 4);
    speckle(c, rnd, 8000, 1.5, 0.2);
    c.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = 0; x < S; x += S / 2) c.fillRect(x, 0, 2, S);
  },
};

/** Paints every layer and uploads them as one mip-mapped texture array. */
export function buildAtlas(maxAnisotropy = 1): THREE.DataArrayTexture {
  return bakeLayers('city-atlas', LAYERS.map((layer) => painters[layer]), maxAnisotropy, 1000);
}

/**
 * Paints layers (colour and tint mask, see the top of this file) with canvas
 * 2D and uploads them as one mip-mapped, repeating texture array of `size`
 * px squares. Also used for the landmarks' own atlas (src/landmarks/atlas.ts).
 */
export function bakeLayers(name: string, paint: Painter[], maxAnisotropy = 1, seed = 1000, size = S): THREE.DataArrayTexture {
  const S = size;
  const make = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    return canvas.getContext('2d', { willReadFrequently: true })!;
  };
  const colour = make();
  const mask = make();
  const data = new Uint8Array(S * S * 4 * paint.length);
  paint.forEach((painter, k) => {
    colour.setTransform(1, 0, 0, 1, 0, 0);
    mask.setTransform(1, 0, 0, 1, 0, 0);
    colour.clearRect(0, 0, S, S);
    mask.clearRect(0, 0, S, S);
    painter(colour, mask, mulberry(seed + k * 7919));
    const c = colour.getImageData(0, 0, S, S).data;
    const a = mask.getImageData(0, 0, S, S).data;
    const base = k * S * S * 4;
    for (let y = 0; y < S; y++) {
      // Flip: canvas row 0 is the top of the wall, texture row 0 is v = 0 (the bottom).
      const src = (S - 1 - y) * S * 4;
      const dst = base + y * S * 4;
      for (let x = 0; x < S * 4; x += 4) {
        data[dst + x] = c[src + x];
        data[dst + x + 1] = c[src + x + 1];
        data[dst + x + 2] = c[src + x + 2];
        data[dst + x + 3] = a[src + x];
      }
    }
  });
  const tex = new THREE.DataArrayTexture(data, S, S, paint.length);
  tex.name = name;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.min(4, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}
