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
  // Grey-green rather than navy: Auckland's towers are mostly tinted or silvered glass.
  g.addColorStop(0, rgb(158 * k, 180 * k, 190 * k));
  g.addColorStop(0.45, rgb(98 * k, 118 * k, 124 * k));
  g.addColorStop(1, rgb(58 * k, 72 * k, 78 * k));
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

// ---------------------------------------------------------------- shopfronts
//
// A shop layer is one storey (4.2 m) by two shops (4.5 m each), so a metre is
// SX px across but SY px up: shapes are painted narrow to come out right.
// From the top: wall above the verandah, the shop's sign under it, the
// window (an interior you can read from the street, not a pattern), and a
// kick plate. Each shop is one of a few kinds, so a row reads as different
// businesses.

const SX = S / 9;
const SY = S / 4.2;
/** Canvas y of the verandah's underside (3.7 m up): signs hang below it. */
const UNDER = Math.round((4.2 - 3.65) * SY);

type ShopKind = 'cafe' | 'fashion' | 'dairy' | 'bright' | 'bar' | 'vacant' | 'books';
/** Shop kinds per layer, two each (left, right): the three modern layers and two heritage ones. */
const SHOP_PAIRS: Record<string, [ShopKind, ShopKind]> = {
  shop: ['cafe', 'fashion'],
  'shop-b': ['dairy', 'bright'],
  'shop-c': ['bar', 'vacant'],
  'shop-heritage': ['books', 'cafe'],
  'shop-heritage-b': ['fashion', 'dairy'],
};

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h | 0},${s | 0}%,${l | 0}%,${a})`;

/** Blocky parody lettering, centred in a box. */
function lettering(c: Ctx, rnd: () => number, x: number, y: number, w: number, h: number, colour: string) {
  const words = 1 + Math.floor(rnd() * 2);
  const glyphs: number[] = [];
  for (let k = 0; k < words; k++) {
    if (k) glyphs.push(-1);
    for (let n = 3 + Math.floor(rnd() * 5); n > 0; n--) glyphs.push(0.45 + rnd() * 0.35);
  }
  const unit = Math.min(h * 0.42, w / (glyphs.reduce((s, g) => s + (g < 0 ? 0.6 : g + 0.18), 0) + 0.5));
  let tx = x + (w - glyphs.reduce((s, g) => s + (g < 0 ? 0.6 : g + 0.18), 0) * unit) / 2;
  c.fillStyle = colour;
  for (const g of glyphs) {
    if (g < 0) {
      tx += unit * 0.6;
      continue;
    }
    // Letters as a stem and a bar or two: reads as type at a distance, says nothing.
    const gw = g * unit;
    const gh = h * 0.5;
    const gy = y + (h - gh) / 2;
    c.fillRect(tx, gy, Math.max(2, gw * 0.3), gh);
    const bar = rnd();
    if (bar < 0.7) c.fillRect(tx, gy, gw, Math.max(2, gh * 0.18));
    if (bar > 0.3) c.fillRect(tx, gy + gh * 0.82, gw, Math.max(2, gh * 0.18));
    if (bar > 0.5 && bar < 0.85) c.fillRect(tx + gw * 0.7, gy, Math.max(2, gw * 0.3), gh);
    tx += gw + unit * 0.18;
  }
}

/** A shop's interior, seen through its window from x, y (w by h px). */
function interior(c: Ctx, rnd: () => number, kind: ShopKind, x: number, y: number, w: number, h: number) {
  const floorY = y + h * 0.86;
  const warm = kind === 'cafe' || kind === 'bar' || kind === 'books';
  const lightL = kind === 'bright' || kind === 'dairy' ? 78 : kind === 'bar' ? 22 : kind === 'vacant' ? 30 : 55;
  // Back wall and ceiling, floor in front, lit from the ceiling.
  const wallH = warm ? 32 + rnd() * 10 : 200 + rnd() * 30;
  const g = c.createLinearGradient(0, y, 0, floorY);
  g.addColorStop(0, hsl(wallH, warm ? 35 : 8, lightL * 0.55));
  g.addColorStop(0.25, hsl(wallH, warm ? 40 : 10, lightL));
  g.addColorStop(1, hsl(wallH, warm ? 30 : 8, lightL * 0.8));
  c.fillStyle = g;
  c.fillRect(x, y, w, floorY - y);
  c.fillStyle = hsl(wallH, 15, lightL * 0.45);
  c.fillRect(x, floorY, w, y + h - floorY);
  // Downlights.
  c.fillStyle = kind === 'bar' ? 'rgba(255,190,110,0.9)' : 'rgba(255,250,235,0.85)';
  for (let lx = x + 10; lx < x + w - 6; lx += 22 + rnd() * 10) c.fillRect(lx, y + 8, 7, 3);
  const dark = (a = 0.85) => `rgba(28,24,22,${a})`;
  switch (kind) {
    case 'cafe': {
      // Counter along the back with a coffee machine, a menu board, tables in front.
      c.fillStyle = hsl(25, 35, 26);
      c.fillRect(x + w * 0.35, floorY - 1.0 * SY, w * 0.62, 1.0 * SY);
      c.fillStyle = '#b8b8b4';
      c.fillRect(x + w * 0.55, floorY - 1.45 * SY, 0.6 * SX, 0.45 * SY);
      c.fillStyle = '#1e1e1e';
      c.fillRect(x + w * 0.4, y + 0.25 * SY, w * 0.45, 0.55 * SY);
      c.fillStyle = 'rgba(240,235,220,0.75)';
      for (let k = 0; k < 6; k++) c.fillRect(x + w * 0.43, y + 0.32 * SY + k * 0.07 * SY, w * (0.15 + rnd() * 0.22), 3);
      // Pendant lamps.
      for (let k = 0; k < 3; k++) {
        const px = x + w * (0.2 + k * 0.28);
        c.fillStyle = 'rgba(40,36,32,0.9)';
        c.fillRect(px, y, 1.5, 0.5 * SY);
        c.fillStyle = 'rgba(255,214,150,0.95)';
        c.fillRect(px - 5, y + 0.5 * SY, 11, 7);
      }
      for (let k = 0; k < 2; k++) {
        const tx = x + w * (0.12 + k * 0.45);
        c.fillStyle = dark();
        c.fillRect(tx, floorY - 0.75 * SY, 0.7 * SX, 5);
        c.fillRect(tx + 0.33 * SX, floorY - 0.75 * SY, 3, 0.75 * SY);
        c.fillRect(tx - 0.25 * SX, floorY - 0.9 * SY, 3, 0.9 * SY);
        c.fillRect(tx + 0.95 * SX, floorY - 0.9 * SY, 3, 0.9 * SY);
      }
      break;
    }
    case 'fashion': {
      // Mannequins in the window, rails of clothes behind.
      for (let k = 0; k < 2; k++) {
        const rx = x + w * (0.08 + k * 0.48);
        c.fillStyle = '#6a6a6a';
        c.fillRect(rx, floorY - 1.55 * SY, w * 0.4, 3);
        for (let gx = rx + 3; gx < rx + w * 0.4 - 4; gx += 5 + rnd() * 3) {
          c.fillStyle = hsl(rnd() * 360, 12 + rnd() * 25, 25 + rnd() * 45);
          c.fillRect(gx, floorY - 1.52 * SY, 4, (0.6 + rnd() * 0.45) * SY);
        }
      }
      for (let k = 0; k < 2; k++) {
        const mx = x + w * (0.25 + k * 0.45);
        const tone = hsl(30, 10, 82);
        c.fillStyle = tone;
        c.fillRect(mx - 0.1 * SX, floorY - 1.78 * SY, 0.2 * SX, 0.2 * SY);
        c.fillStyle = hsl(rnd() * 360, 25 + rnd() * 30, 30 + rnd() * 30);
        c.fillRect(mx - 0.22 * SX, floorY - 1.56 * SY, 0.44 * SX, 0.75 * SY);
        c.fillStyle = hsl(rnd() * 360, 10, 20 + rnd() * 25);
        c.fillRect(mx - 0.18 * SX, floorY - 0.82 * SY, 0.36 * SX, 0.72 * SY);
        c.fillStyle = '#444';
        c.fillRect(mx - 0.25 * SX, floorY - 0.1 * SY, 0.5 * SX, 0.1 * SY);
      }
      break;
    }
    case 'dairy': {
      // Shelves of stock to the ceiling, a fridge glowing, posters stuck to the glass.
      for (let sy = y + 0.35 * SY; sy < floorY - 0.2 * SY; sy += 0.38 * SY) {
        c.fillStyle = '#d0d0cc';
        c.fillRect(x, sy + 0.3 * SY, w, 3);
        for (let px = x + 2; px < x + w - 4; px += 3 + rnd() * 4) {
          c.fillStyle = hsl(rnd() * 360, 45 + rnd() * 35, 35 + rnd() * 35);
          const ph = (0.12 + rnd() * 0.16) * SY;
          c.fillRect(px, sy + 0.3 * SY - ph, 2 + rnd() * 3, ph);
        }
      }
      c.fillStyle = 'rgba(200,235,255,0.55)';
      c.fillRect(x + w * 0.7, y + 0.3 * SY, w * 0.26, floorY - y - 0.3 * SY);
      for (let k = 0; k < 2 + Math.floor(rnd() * 2); k++) {
        const pw = (0.5 + rnd() * 0.3) * SX;
        const ph = (0.7 + rnd() * 0.4) * SY;
        const px = x + 6 + rnd() * (w * 0.6 - pw);
        const py = y + (0.6 + rnd() * 0.5) * SY;
        c.fillStyle = hsl([0, 210, 45, 120, 280][Math.floor(rnd() * 5)], 70, 45);
        c.fillRect(px, py, pw, ph);
        c.fillStyle = 'rgba(255,255,255,0.9)';
        c.fillRect(px + 4, py + ph * 0.12, pw - 8, ph * 0.18);
        c.fillStyle = 'rgba(255,240,120,0.95)';
        c.fillRect(px + 4, py + ph * 0.6, pw * 0.6, ph * 0.22);
      }
      break;
    }
    case 'bright': {
      // A phone shop or bank: white and bright, a long counter, screens on the back wall.
      c.fillStyle = '#f2f2ee';
      c.fillRect(x + w * 0.1, floorY - 0.95 * SY, w * 0.8, 0.95 * SY);
      c.fillStyle = hsl(200 + rnd() * 40, 60, 40);
      c.fillRect(x + w * 0.1, floorY - 0.95 * SY, w * 0.8, 0.08 * SY);
      for (let k = 0; k < 3; k++) {
        c.fillStyle = '#1b2a3a';
        c.fillRect(x + w * (0.12 + k * 0.28), y + 0.45 * SY, w * 0.2, 0.42 * SY);
        c.fillStyle = hsl(rnd() * 360, 60, 55, 0.8);
        c.fillRect(x + w * (0.12 + k * 0.28) + 3, y + 0.45 * SY + 3, w * 0.2 - 6, 0.42 * SY - 6);
      }
      break;
    }
    case 'bar': {
      // Dark, warm: a lit bar back with bottles, stools.
      c.fillStyle = 'rgba(255,170,80,0.35)';
      c.fillRect(x + w * 0.1, y + 0.45 * SY, w * 0.8, 0.8 * SY);
      for (let sy = y + 0.6 * SY; sy < y + 1.2 * SY; sy += 0.3 * SY) {
        for (let px = x + w * 0.12; px < x + w * 0.88; px += 4 + rnd() * 3) {
          c.fillStyle = hsl(20 + rnd() * 120, 50, 25 + rnd() * 30, 0.9);
          c.fillRect(px, sy, 3, 0.2 * SY);
        }
      }
      c.fillStyle = hsl(20, 40, 16);
      c.fillRect(x + w * 0.05, floorY - 1.1 * SY, w * 0.9, 1.1 * SY);
      c.fillStyle = 'rgba(255,190,110,0.5)';
      c.fillRect(x + w * 0.05, floorY - 1.1 * SY, w * 0.9, 3);
      break;
    }
    case 'books': {
      // Bookcases to the ceiling, a table of books in the window.
      for (let sy = y + 0.3 * SY; sy < floorY - 0.2 * SY; sy += 0.32 * SY) {
        c.fillStyle = hsl(25, 35, 22);
        c.fillRect(x, sy + 0.26 * SY, w, 4);
        for (let px = x + 1; px < x + w - 3; px += 2 + rnd() * 2) {
          c.fillStyle = hsl(rnd() * 360, 20 + rnd() * 30, 20 + rnd() * 35);
          const bh = (0.16 + rnd() * 0.08) * SY;
          c.fillRect(px, sy + 0.26 * SY - bh, 2, bh);
        }
      }
      c.fillStyle = hsl(25, 35, 20);
      c.fillRect(x + w * 0.15, floorY - 0.8 * SY, w * 0.7, 0.8 * SY);
      break;
    }
    case 'vacant': {
      // Papered over, a leasing sign.
      c.fillStyle = 'rgba(232,228,214,0.92)';
      c.fillRect(x, y + 0.15 * SY, w, h - 0.15 * SY);
      c.fillStyle = 'rgba(0,0,0,0.06)';
      for (let k = 0; k < 6; k++) c.fillRect(x + rnd() * w, y + 0.15 * SY, 2, h - 0.15 * SY);
      const sw = w * 0.5;
      c.fillStyle = hsl(rnd() < 0.5 ? 0 : 215, 70, 38);
      c.fillRect(x + (w - sw) / 2, y + 0.7 * SY, sw, 0.7 * SY);
      lettering(c, rnd, x + (w - sw) / 2 + 4, y + 0.75 * SY, sw - 8, 0.3 * SY, '#fff');
      c.fillStyle = '#fff';
      c.fillRect(x + (w - sw) / 2 + 8, y + 1.15 * SY, sw - 16, 0.12 * SY);
      break;
    }
  }
}

/** Glass over an interior: the street reflected low down, a sheen, darker at the edges. */
function shopGlass(c: Ctx, rnd: () => number, x: number, y: number, w: number, h: number) {
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, 'rgba(20,24,28,0.35)');
  g.addColorStop(0.2, 'rgba(20,24,28,0.05)');
  g.addColorStop(0.65, 'rgba(160,175,185,0.08)');
  g.addColorStop(1, 'rgba(150,160,165,0.28)');
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
  c.fillStyle = `rgba(220,232,240,${0.1 + rnd() * 0.08})`;
  c.beginPath();
  c.moveTo(x + w * 0.15, y);
  c.lineTo(x + w * 0.38, y);
  c.lineTo(x + w * 0.12, y + h);
  c.lineTo(x, y + h);
  c.lineTo(x, y + h * 0.55);
  c.closePath();
  c.fill();
}

/** Sign colours: the fascia board, and its lettering. */
const SIGNS: [string, string][] = [
  ['#1d1f22', '#f4f0e6'], ['#f2f0ea', '#1d1f22'], ['#9e2a2b', '#fff6e8'], ['#1f4e79', '#ffffff'], ['#e3b23c', '#1d1f22'],
  ['#2d5a3d', '#f1e8d0'], ['#5b2a6e', '#ffffff'], ['#c8553d', '#ffffff'], ['#3b3f45', '#e3b23c'], ['#e8e0d0', '#9e2a2b'],
];

/** Modern aluminium shopfronts: two shops of the given kinds. */
function modernShops(kinds: [ShopKind, ShopKind]): Painter {
  return (c, m, rnd) => {
    const bw = S / 2;
    rect(c, m, 0, 0, S, S, grey(TINT_GREY), 1);
    speckle(c, rnd, 600, 2, 0.1, 0, 0, S, UNDER);
    for (let b = 0; b < 2; b++) {
      const x = b * bw;
      const kind = kinds[b];
      const [board, ink] = SIGNS[Math.floor(rnd() * SIGNS.length)];
      // Sign box under the verandah line, full width of the shop.
      const sy = UNDER + 6;
      const sh = Math.round(0.42 * SY);
      rect(c, m, x + 6, sy, bw - 12, sh, board, 0);
      c.fillStyle = 'rgba(255,255,255,0.08)';
      c.fillRect(x + 6, sy, bw - 12, 4);
      lettering(c, rnd, x + 16, sy + 4, bw - 32, sh - 8, ink);
      // The window and door.
      const top = sy + sh + 6;
      const bottom = S - Math.round(0.32 * SY);
      rect(c, m, x + 6, top, bw - 12, bottom - top, '#000', 0);
      interior(c, rnd, kind, x + 10, top + 4, bw - 20, bottom - top - 4);
      shopGlass(c, rnd, x + 10, top + 4, bw - 20, bottom - top - 4);
      // Door: on the left or right, a darker leaf with a push bar.
      const dw = Math.round(1.0 * SX);
      const dx = rnd() < 0.5 ? x + 14 : x + bw - 14 - dw;
      c.fillStyle = 'rgba(10,12,14,0.35)';
      c.fillRect(dx, top + 0.15 * SY, dw, bottom - top - 0.15 * SY);
      c.fillStyle = '#a8adb0';
      c.fillRect(dx + 4, top + (bottom - top) * 0.55, dw - 8, 4);
      // Frames: aluminium or black.
      c.fillStyle = rnd() < 0.6 ? '#9ea4a8' : '#26282a';
      c.fillRect(x + 6, top, bw - 12, 5);
      for (const fx of [x + 6, dx - 2, dx + dw - 2, x + bw - 11]) c.fillRect(fx, top, 5, bottom - top);
      c.fillRect(x + 6, top + 0.12 * SY + 4, bw - 12, 3);
      // Kick plate and step.
      rect(c, m, x + 6, bottom, bw - 12, S - bottom, kind === 'vacant' ? '#5a5a58' : '#3a3c3e', 0);
      c.fillStyle = 'rgba(255,255,255,0.08)';
      c.fillRect(x + 6, bottom, bw - 12, 3);
    }
    // Piers between and either side of the shops (the building's own wall).
    rect(c, m, 0, UNDER, 6, S - UNDER, grey(TINT_GREY - 20), 1);
    rect(c, m, bw - 6, UNDER, 12, S - UNDER, grey(TINT_GREY - 20), 1);
    rect(c, m, S - 6, UNDER, 6, S - UNDER, grey(TINT_GREY - 20), 1);
  };
}

/** Victorian and Edwardian timber shopfronts: painted fascia, transom lights, stallrisers, recessed doors. */
function heritageShops(kinds: [ShopKind, ShopKind]): Painter {
  return (c, m, rnd) => {
    const bw = S / 2;
    rect(c, m, 0, 0, S, S, grey(TINT_GREY), 1);
    const paints = [[38, 64, 48], [96, 30, 34], [32, 44, 70], [224, 214, 190], [20, 20, 22], [130, 90, 40], [70, 78, 60]];
    for (let b = 0; b < 2; b++) {
      const x = b * bw;
      const p = paints[Math.floor(rnd() * paints.length)];
      const paint = rgb(p[0], p[1], p[2]);
      const light = p[0] + p[1] + p[2] > 400;
      // Fascia board with signwritten lettering, under the verandah line.
      const fy = UNDER + 4;
      const fh = Math.round(0.4 * SY);
      rect(c, m, x + 4, fy, bw - 8, fh, paint, 0);
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(x + 4, fy + fh - 4, bw - 8, 4);
      lettering(c, rnd, x + 18, fy + 4, bw - 36, fh - 8, light ? '#3a2a1a' : 'rgba(235,215,150,0.95)');
      // Transom lights over the windows.
      const ty = fy + fh + 2;
      const th = Math.round(0.3 * SY);
      rect(c, m, x + 4, ty, bw - 8, th + 6, paint, 0);
      for (let k = 0; k < 6; k++) glass(c, m, rnd, x + 10 + k * ((bw - 20) / 6), ty + 4, (bw - 20) / 6 - 6, th - 2, 0, 0.1);
      // Display windows either side of a recessed door, over tiled stallrisers.
      const top = ty + th + 8;
      const sill = S - Math.round(0.55 * SY);
      rect(c, m, x + 4, top, bw - 8, S - top, paint, 0);
      const doorW = Math.round(1.1 * SX);
      const winW = (bw - 8 - doorW - 16) / 2;
      for (const wx of [x + 10, x + 10 + winW + doorW + 4]) {
        rect(c, m, wx, top + 6, winW, sill - top - 6, '#000', 0);
        interior(c, rnd, kinds[b], wx, top + 6, winW, sill - top - 6);
        shopGlass(c, rnd, wx, top + 6, winW, sill - top - 6);
        c.fillStyle = paint;
        c.fillRect(wx + winW / 2 - 2, top + 6, 4, sill - top - 6);
        // Tiled stallriser.
        for (let ty2 = sill + 8; ty2 < S - 4; ty2 += 12) {
          for (let tx2 = wx; tx2 < wx + winW; tx2 += 12) {
            const v = rnd() * 20;
            c.fillStyle = light ? rgb(150 + v, 60 + v, 50 + v) : rgb(70 + v, 90 + v, 80 + v);
            c.fillRect(tx2 + 1, ty2 + 1, 10, 10);
          }
        }
      }
      // Recessed door: deep shadow, a panelled door with a glazed top.
      const dx = x + 10 + winW + 2;
      rect(c, m, dx, top + 6, doorW, S - top - 6, '#0e1012', 0);
      rect(c, m, dx + 10, top + 30, doorW - 20, S - top - 40, rgb(p[0] * 0.7, p[1] * 0.7, p[2] * 0.7), 0);
      glass(c, m, rnd, dx + 16, top + 40, doorW - 32, 0.9 * SY, 0, 0.3);
    }
    // Pilasters between the shops.
    for (const px of [0, bw - 8, S - 8]) rect(c, m, px, UNDER, 16, S - UNDER, grey(TINT_GREY + 10), 1);
  };
}

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
  italianate(c, m, rnd) {
    // Victorian commercial in painted plaster: a moulded string course at each
    // floor, pilasters between bays, round-arched windows under hood moulds.
    const { bw, fh } = cell('italianate');
    wallBase(c, m, rnd, TINT_GREY + 2);
    for (let f = 0; f < 3; f++) {
      const y0 = f * fh;
      // String course with dentils: light top, shadow under.
      rect(c, m, 0, y0 + fh - 18, S, 10, grey(246), 1);
      for (let x = 0; x < S; x += 12) rect(c, m, x, y0 + fh - 8, 7, 5, grey(236), 1);
      c.fillStyle = 'rgba(0,0,0,0.28)';
      c.fillRect(0, y0 + fh - 3, S, 3);
      for (let b = 0; b < 3; b++) {
        const x0 = b * bw;
        // Pilaster with a shadowed side.
        rect(c, m, x0, y0, 14, fh - 18, grey(240), 1);
        c.fillStyle = 'rgba(0,0,0,0.16)';
        c.fillRect(x0 + 14, y0, 4, fh - 18);
        const w = bw * 0.36;
        const x = x0 + (bw - w) / 2 + 7;
        const top = y0 + fh * 0.2;
        const h = fh * 0.56;
        c.save();
        c.beginPath();
        c.arc(x + w / 2, top + w / 2, w / 2, Math.PI, 0);
        c.lineTo(x + w, top + h);
        c.lineTo(x, top + h);
        c.closePath();
        c.clip();
        punched(c, m, rnd, x, top, w, h, '#f4f0e6', true);
        c.restore();
        // Hood mould over the arch, ending in little corbels.
        c.strokeStyle = grey(250);
        c.lineWidth = 7;
        c.beginPath();
        c.arc(x + w / 2, top + w / 2, w / 2 + 7, Math.PI, 0);
        c.stroke();
        c.strokeStyle = 'rgba(0,0,0,0.25)';
        c.lineWidth = 2;
        c.beginPath();
        c.arc(x + w / 2, top + w / 2 + 4, w / 2 + 10, Math.PI * 1.05, -Math.PI * 0.05);
        c.stroke();
        rect(c, m, x - 13, top + w / 2 - 2, 9, 12, grey(244), 1);
        rect(c, m, x + w + 4, top + w / 2 - 2, 9, 12, grey(244), 1);
        rect(c, m, x + w / 2 - 6, top - 12, 12, 16, grey(250), 1);
        rect(c, m, x - 6, top + h, w + 12, 7, grey(246), 1);
      }
    }
  },
  warehouse(c, m, rnd) {
    // Brick warehouse: piers between bays, segmental-arched windows of small panes.
    const { bw, fh } = cell('warehouse');
    rect(c, m, 0, 0, S, S, '#b8b2a8', 0.3);
    m.fillStyle = grey(255);
    const course = 8;
    for (let y = 0; y < S; y += course) {
      const off = (y / course) % 2 ? 10 : 0;
      for (let x = -off; x < S; x += 20) {
        c.fillStyle = grey(TINT_GREY - 20 + (rnd() - 0.5) * 40);
        c.fillRect(x + 1, y + 1, 18, course - 2);
        m.fillRect(x + 1, y + 1, 18, course - 2);
      }
    }
    blotches(c, rnd, 14, 40, 110, 0.16, 0.04);
    for (let b = 0; b < 4; b++) {
      // Piers catch the light on one side.
      c.fillStyle = 'rgba(255,255,255,0.1)';
      c.fillRect(b * bw, 0, 6, S);
      c.fillStyle = 'rgba(0,0,0,0.18)';
      c.fillRect(b * bw + 18, 0, 4, S);
    }
    for (let f = 0; f < 3; f++) {
      const y0 = f * fh;
      for (let b = 0; b < 4; b++) {
        const w = bw * 0.56;
        const x = b * bw + (bw - w) / 2 + 6;
        const top = y0 + fh * 0.2;
        const h = fh * 0.58;
        const rise = 12;
        // Segmental head: a shallow curve over the opening.
        c.save();
        c.beginPath();
        c.moveTo(x, top + rise);
        c.quadraticCurveTo(x + w / 2, top - rise, x + w, top + rise);
        c.lineTo(x + w, top + h);
        c.lineTo(x, top + h);
        c.closePath();
        c.clip();
        glass(c, m, rnd, x, top, w, h, 0.05, 0.3);
        // Small panes in painted timber.
        c.strokeStyle = '#e8e2d2';
        c.lineWidth = 3;
        c.beginPath();
        for (let k = 1; k < 3; k++) {
          c.moveTo(x + (w * k) / 3, top);
          c.lineTo(x + (w * k) / 3, top + h);
        }
        for (let k = 1; k < 4; k++) {
          c.moveTo(x, top + (h * k) / 4);
          c.lineTo(x + w, top + (h * k) / 4);
        }
        c.stroke();
        c.restore();
        // Arch of headers (paler brick) and a stone sill.
        c.strokeStyle = grey(TINT_GREY + 10);
        c.lineWidth = 9;
        c.beginPath();
        c.moveTo(x - 4, top + rise + 2);
        c.quadraticCurveTo(x + w / 2, top - rise - 4, x + w + 4, top + rise + 2);
        c.stroke();
        rect(c, m, x - 6, top + h, w + 12, 8, '#d8d2c4', 0.15);
        c.fillStyle = 'rgba(0,0,0,0.3)';
        c.fillRect(x, top + 3, 5, h - 3);
      }
    }
  },
  deco(c, m, rnd) {
    // Interwar: fluted pilasters running the full height, windows recessed
    // between them over spandrel panels with chevrons.
    const { bw, fh } = cell('deco');
    wallBase(c, m, rnd, TINT_GREY + 4);
    for (let b = 0; b < 3; b++) {
      const x0 = b * bw;
      const pw = 34;
      for (let f = 0; f < 4; f++) {
        const y0 = f * fh;
        const wx = x0 + pw + 10;
        const ww = bw - pw - 20;
        const top = y0 + 10;
        const h = fh * 0.6;
        punched(c, m, rnd, wx, top, ww, h, '#3a3e40', false);
        // Steel glazing bars: three panes up, two across.
        c.fillStyle = '#2e3234';
        for (let k = 1; k < 3; k++) c.fillRect(wx, top + (h * k) / 3, ww, 3);
        c.fillRect(wx + ww / 2 - 1, top, 3, h);
        // Spandrel: a recessed panel with a chevron frieze.
        const sy = top + h + 8;
        const sh = fh - h - 26;
        rect(c, m, wx, sy, ww, sh, grey(TINT_GREY - 18), 1);
        c.strokeStyle = grey(250);
        c.lineWidth = 3;
        c.beginPath();
        for (let x = wx + 6; x < wx + ww - 12; x += 18) {
          c.moveTo(x, sy + sh - 6);
          c.lineTo(x + 9, sy + 6);
          c.lineTo(x + 18, sy + sh - 6);
        }
        c.stroke();
        c.fillStyle = 'rgba(0,0,0,0.3)';
        c.fillRect(wx, sy, ww, 3);
      }
      // The pilaster: lit face, three flutes, shadowed return.
      rect(c, m, x0, 0, pw, S, grey(244), 1);
      c.fillStyle = 'rgba(0,0,0,0.14)';
      for (let k = 1; k < 4; k++) c.fillRect(x0 + (pw * k) / 4 - 1, 0, 2, S);
      c.fillStyle = 'rgba(0,0,0,0.28)';
      c.fillRect(x0 + pw, 0, 6, S);
    }
  },
  stripped(c, m, rnd) {
    // Stripped classical: wide steel multi-pane windows, speed lines at the sills.
    const { bw, fh } = cell('stripped');
    wallBase(c, m, rnd, TINT_GREY + 6);
    for (let f = 0; f < 4; f++) {
      const y0 = f * fh;
      for (let b = 0; b < 3; b++) {
        const w = bw * 0.72;
        const x = b * bw + (bw - w) / 2;
        const top = y0 + fh * 0.18;
        const h = fh * 0.5;
        glass(c, m, rnd, x, top, w, h, 0.05, 0.28);
        c.fillStyle = '#2b2f31';
        for (let k = 1; k < 4; k++) c.fillRect(x + (w * k) / 4 - 1, top, 3, h);
        for (let k = 1; k < 3; k++) c.fillRect(x, top + (h * k) / 3 - 1, w, 2);
        c.strokeStyle = '#2b2f31';
        c.lineWidth = 4;
        c.strokeRect(x + 2, top + 2, w - 4, h - 4);
        c.fillStyle = 'rgba(0,0,0,0.3)';
        c.fillRect(x, top, w, 6);
      }
      // Three speed lines under the windows, right across.
      for (let k = 0; k < 3; k++) {
        const y = y0 + fh * 0.18 + fh * 0.5 + 10 + k * 8;
        c.fillStyle = 'rgba(0,0,0,0.22)';
        c.fillRect(0, y, S, 2);
        c.fillStyle = 'rgba(255,255,255,0.25)';
        c.fillRect(0, y + 2, S, 2);
      }
    }
  },
  modern60(c, m, rnd) {
    // 1960s curtain wall: vision glass above, coloured spandrel panels below
    // (the building's tint), behind a light aluminium grid.
    const { bw, fh } = cell('modern60');
    rect(c, m, 0, 0, S, S, grey(TINT_GREY), 1);
    for (let f = 0; f < 4; f++) {
      const y0 = f * fh;
      const vision = fh * 0.56;
      for (let b = 0; b < 4; b++) {
        glass(c, m, rnd, b * bw, y0, bw, vision, 0.05, 0.15);
        // Spandrel panel: tinted, a little mottled like enamel or mosaic.
        const v = TINT_GREY - 10 + (rnd() - 0.5) * 16;
        rect(c, m, b * bw, y0 + vision, bw, fh - vision, grey(v), 1);
        speckle(c, rnd, 120, 3, 0.2, b * bw, y0 + vision, bw, fh - vision);
      }
      // Transom between glass and panel.
      rect(c, m, 0, y0 + vision - 3, S, 6, '#c8ccce', 0);
    }
    for (let b = 0; b <= 4; b++) {
      rect(c, m, b * bw - 4, 0, 8, S, '#d4d8da', 0);
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(b * bw + 4, 0, 3, S);
    }
    for (let f = 0; f <= 4; f++) rect(c, m, 0, f * fh - 3, S, 6, '#c4c8ca', 0);
  },
  brutal(c, m, rnd) {
    // 1970s precast: chunky frames, windows set deep in them, board marks.
    const { bw, fh } = cell('brutal');
    wallBase(c, m, rnd, TINT_GREY - 4);
    c.fillStyle = 'rgba(0,0,0,0.05)';
    for (let y = 0; y < S; y += 9) c.fillRect(0, y, S, 1);
    blotches(c, rnd, 18, 30, 90, 0.14, 0.04);
    for (let f = 0; f < 4; f++) {
      const y0 = f * fh;
      for (let b = 0; b < 3; b++) {
        const w = bw * 0.56;
        const h = fh * 0.5;
        const x = b * bw + (bw - w) / 2;
        const top = y0 + fh * 0.2;
        // Chamfered surround: a lit lower bevel, a dark upper one.
        c.fillStyle = 'rgba(255,255,255,0.22)';
        c.fillRect(x - 12, top + h, w + 24, 10);
        c.fillStyle = 'rgba(0,0,0,0.25)';
        c.fillRect(x - 12, top - 10, w + 24, 10);
        glass(c, m, rnd, x, top, w, h, 0.02, 0.4);
        // Deep reveal: heavy shadow on the top and one side.
        const g = c.createLinearGradient(0, top, 0, top + 22);
        g.addColorStop(0, 'rgba(0,0,0,0.6)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g;
        c.fillRect(x, top, w, 22);
        c.fillStyle = 'rgba(0,0,0,0.4)';
        c.fillRect(x, top, 14, h);
        c.fillStyle = 'rgba(30,30,30,0.9)';
        c.fillRect(x + w / 2 - 2, top, 4, h);
      }
      // Grooves between panels.
      c.fillStyle = 'rgba(0,0,0,0.2)';
      c.fillRect(0, y0 + fh - 4, S, 4);
    }
    for (let b = 0; b < 3; b++) {
      c.fillStyle = 'rgba(0,0,0,0.18)';
      c.fillRect(b * bw, 0, 4, S);
    }
  },
  'glass-b'(c, m, rnd) {
    // Recent unitised curtain wall: floor-to-ceiling glass, a fritted band at
    // each slab, and vertical fins that catch the light.
    const { bw, fh } = cell('glass-b');
    rect(c, m, 0, 0, S, S, grey(TINT_GREY), 1);
    for (let f = 0; f < 4; f++) {
      const y0 = f * fh;
      for (let b = 0; b < 4; b++) {
        glass(c, m, rnd, b * bw, y0, bw, fh - 16, 0.4, 0.05);
        glass(c, m, rnd, b * bw, y0 + fh - 16, bw, 16, 0.55, 0.4);
        // Frit dots on the slab band.
        c.fillStyle = 'rgba(230,235,235,0.35)';
        for (let x = b * bw + 3; x < (b + 1) * bw; x += 6) for (let y = y0 + fh - 14; y < y0 + fh - 2; y += 6) c.fillRect(x, y, 2, 2);
      }
      rect(c, m, 0, y0 + fh - 18, S, 3, '#9aa4a8', 0.3);
    }
    for (let b = 0; b < 4; b++) {
      // A fin: lit face and the shadow it throws.
      rect(c, m, b * bw - 5, 0, 10, S, grey(232), 0.6);
      c.fillStyle = 'rgba(0,0,0,0.22)';
      c.fillRect(b * bw + 5, 0, 7, S);
    }
  },
  cladding(c, m, rnd) {
    // Recent apartments and offices: a grid of cladding panels in a few tones
    // and tall windows in a rhythm that shifts floor to floor.
    const { bw, fh } = cell('cladding');
    for (let f = 0; f < 4; f++) {
      for (let b = 0; b < 4; b++) {
        const v = TINT_GREY + (rnd() < 0.3 ? -26 : rnd() < 0.5 ? 12 : 0) + (rnd() - 0.5) * 8;
        rect(c, m, b * bw, f * fh, bw, fh, grey(v), 1);
      }
    }
    speckle(c, rnd, 2000, 2, 0.08);
    for (let f = 0; f < 4; f++) {
      const y0 = f * fh;
      for (let b = 0; b < 4; b++) {
        const kind = rnd();
        const w = kind < 0.5 ? bw * 0.62 : kind < 0.8 ? bw * 0.34 : bw * 0.82;
        const x = b * bw + (kind < 0.5 ? bw * 0.19 : kind < 0.8 ? (rnd() < 0.5 ? bw * 0.12 : bw * 0.54) : bw * 0.09);
        const top = y0 + fh * 0.1;
        const h = fh * 0.76;
        // A deep charcoal frame round the glass.
        rect(c, m, x - 6, top - 6, w + 12, h + 12, '#2e3134', 0);
        glass(c, m, rnd, x, top, w, h, 0.02, 0.15);
        c.fillStyle = 'rgba(0,0,0,0.3)';
        c.fillRect(x, top, w, 8);
        if (rnd() < 0.4) {
          c.fillStyle = 'rgba(40,44,46,0.85)';
          c.fillRect(x, top + h * 0.62, w, 3);
        }
      }
      // Panel joints.
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(0, y0, S, 2);
    }
    c.fillStyle = 'rgba(0,0,0,0.2)';
    for (let b = 0; b < 4; b++) c.fillRect(b * bw, 0, 2, S);
  },
  weatherboard(c, m, rnd) {
    // Villas and cottages: weatherboards and pairs of double-hung sashes.
    const { bw, fh } = cell('weatherboard');
    rect(c, m, 0, 0, S, S, grey(TINT_GREY + 6), 1);
    for (let y = 0; y < S; y += 12) {
      const g = c.createLinearGradient(0, y, 0, y + 12);
      g.addColorStop(0, 'rgba(255,255,255,0.08)');
      g.addColorStop(0.8, 'rgba(0,0,0,0.04)');
      g.addColorStop(1, 'rgba(0,0,0,0.3)');
      c.fillStyle = g;
      c.fillRect(0, y, S, 12);
    }
    speckle(c, rnd, 800, 2, 0.06);
    for (let f = 0; f < 2; f++) {
      const y0 = f * fh;
      for (let b = 0; b < 2; b++) {
        const pw = 62;
        const gap = 10;
        const x = b * bw + (bw - 2 * pw - gap) / 2;
        const top = y0 + fh * 0.22;
        const h = fh * 0.56;
        // Facings round the pair.
        rect(c, m, x - 14, top - 18, 2 * pw + gap + 28, h + 30, '#f2f0ea', 0);
        c.fillStyle = 'rgba(0,0,0,0.2)';
        c.fillRect(x - 14, top + h + 12, 2 * pw + gap + 28, 4);
        for (const wx of [x, x + pw + gap]) {
          glass(c, m, rnd, wx, top, pw, h, 0, 0.2);
          if (rnd() < 0.5) {
            c.fillStyle = `rgba(235,228,210,${0.5 + rnd() * 0.3})`;
            c.fillRect(wx, top, pw, h * (0.15 + rnd() * 0.3));
          }
          // Sash frames and the meeting rail.
          c.strokeStyle = '#f6f4ee';
          c.lineWidth = 6;
          c.strokeRect(wx + 3, top + 3, pw - 6, h - 6);
          c.fillStyle = '#f6f4ee';
          c.fillRect(wx, top + h / 2 - 3, pw, 6);
        }
      }
    }
  },
  carpark(c, m, rnd) {
    // Parking building: open decks (dark, a lit ceiling, cars) between concrete bands.
    const { bw, fh } = cell('carpark');
    wallBase(c, m, rnd, TINT_GREY - 2);
    for (let f = 0; f < 4; f++) {
      const y0 = f * fh;
      const open = fh * 0.55;
      const g = c.createLinearGradient(0, y0, 0, y0 + open);
      g.addColorStop(0, '#5a5c5c');
      g.addColorStop(0.25, '#2a2c2e');
      g.addColorStop(1, '#1a1c1e');
      c.fillStyle = g;
      c.fillRect(0, y0, S, open);
      m.fillStyle = grey(0);
      m.fillRect(0, y0, S, open);
      // Strip lights on the soffit.
      c.fillStyle = 'rgba(240,240,220,0.6)';
      for (let x = 20; x < S; x += 64) c.fillRect(x, y0 + 6, 30, 3);
      // Cars nose-on, glimpsed over the parapet.
      for (let x = 8; x < S - 50; x += 56 + rnd() * 30) {
        if (rnd() < 0.3) continue;
        const col = [[180, 30, 30], [30, 60, 120], [200, 200, 205], [40, 40, 44], [120, 125, 130], [90, 110, 70]][Math.floor(rnd() * 6)];
        c.fillStyle = rgb(col[0], col[1], col[2]);
        c.fillRect(x, y0 + open - 26, 44, 26);
        c.fillStyle = 'rgba(20,30,40,0.8)';
        c.fillRect(x + 6, y0 + open - 34, 32, 10);
      }
      // The concrete band, lit along its top edge.
      rect(c, m, 0, y0 + open, S, 5, grey(246), 1);
      c.fillStyle = 'rgba(0,0,0,0.12)';
      c.fillRect(0, y0 + fh - 3, S, 3);
    }
    // Columns.
    for (let b = 0; b < 2; b++) {
      for (let f = 0; f < 4; f++) rect(c, m, b * bw, f * fh, 22, fh * 0.55, grey(TINT_GREY - 14), 1);
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(b * bw + 22, 0, 4, S);
    }
  },
  shed(c, m, rnd) {
    // Industrial cladding: vertical ribs every 20 cm, translucent panels
    // under the eaves of each storey, a darker kick strip at the foot.
    wallBase(c, m, rnd, TINT_GREY);
    for (let x = 0; x < S; x += S / 64) {
      c.fillStyle = 'rgba(255,255,255,0.14)';
      c.fillRect(x, 0, 2, S);
      c.fillStyle = 'rgba(0,0,0,0.16)';
      c.fillRect(x + 2, 0, 3, S);
    }
    for (let b = 0; b < 4; b++) {
      const x = (b * S) / 4;
      rect(c, m, x + 6, 26, S / 4 - 12, 70, '#d8dcd4', 0.25);
      c.fillStyle = 'rgba(0,0,0,0.12)';
      for (let k = 1; k < 4; k++) c.fillRect(x + 6 + ((S / 4 - 12) * k) / 4, 26, 2, 70);
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.fillRect(x + 6, 96, S / 4 - 12, 4);
    }
    blotches(c, rnd, 12, 30, 110, 0.12, 0.05);
    rect(c, m, 0, S - 30, S, 30, grey(TINT_GREY - 40), 1);
  },
  shop: modernShops(SHOP_PAIRS.shop),
  'shop-b': modernShops(SHOP_PAIRS['shop-b']),
  'shop-c': modernShops(SHOP_PAIRS['shop-c']),
  'shop-heritage': heritageShops(SHOP_PAIRS['shop-heritage']),
  'shop-heritage-b': heritageShops(SHOP_PAIRS['shop-heritage-b']),
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
  'roof-tin'(c, m, rnd) {
    // Corrugated iron: ridges run down the slope (canvas y), 2.4 m across in
    // 32 corrugations, sheet laps every 1.2 m down, a little rust and fading.
    wallBase(c, m, rnd, TINT_GREY);
    for (let x = 0; x < S; x += S / 32) {
      const g = c.createLinearGradient(x, 0, x + S / 32, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.16)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0.16)');
      c.fillStyle = g;
      c.fillRect(x, 0, S / 32, S);
    }
    for (let y = 0; y < S; y += S / 2) {
      c.fillStyle = 'rgba(0,0,0,0.22)';
      c.fillRect(0, y, S, 3);
      c.fillStyle = 'rgba(255,255,255,0.1)';
      c.fillRect(0, y + 3, S, 2);
    }
    // Rows of screws along the purlins.
    c.fillStyle = 'rgba(0,0,0,0.25)';
    for (let y = S / 8; y < S; y += S / 4) for (let x = S / 64; x < S; x += S / 8) c.fillRect(x, y, 3, 3);
    blotches(c, rnd, 10, 30, 90, 0.12, 0.05);
  },
  'roof-tile'(c, m, rnd) {
    // Concrete or clay tiles: courses across the slope, 16 per 2.4 m, staggered.
    rect(c, m, 0, 0, S, S, grey(TINT_GREY - 40), 1);
    const course = S / 16;
    const tw = S / 8;
    for (let y = 0; y < S; y += course) {
      const off = (y / course) % 2 ? tw / 2 : 0;
      for (let x = -off; x < S; x += tw) {
        const v = TINT_GREY - 6 + (rnd() - 0.5) * 30;
        const g = c.createLinearGradient(0, y, 0, y + course);
        g.addColorStop(0, grey(v + 14));
        g.addColorStop(1, grey(v - 26));
        c.fillStyle = g;
        c.fillRect(x + 1, y + 1, tw - 2, course - 2);
        // The roll of the tile.
        c.fillStyle = 'rgba(255,255,255,0.1)';
        c.fillRect(x + tw * 0.3, y + 1, tw * 0.2, course - 3);
      }
      // Shadow under each course's lower edge.
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.fillRect(0, y + course - 3, S, 3);
    }
    blotches(c, rnd, 12, 30, 100, 0.14, 0.05);
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
