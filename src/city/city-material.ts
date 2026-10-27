import * as THREE from 'three';
import { TINT_GAIN } from './atlas.ts';
import { FIRST_PLANAR, LAYERS, PLANAR_METRES, SHADE_ONE, UV_SCALE } from './facades.ts';

// The one material every city chunk is drawn with (so each chunk stays one
// draw call): Lambert lighting with vertex colours as the tint, plus
// - the texture atlas (atlas.ts): per-vertex layer and UVs for facades,
//   world x/z for ground layers (roads, footpaths, terrain, roofs);
// - baked light per vertex (canyon occlusion, sun facing; see buildings.ts);
// - lane markings drawn procedurally on road strips (no extra triangles);
// - the per-layer depth bias for overlapping road surfaces.

/**
 * Depth bias per road draw layer, in normalised device depth. Overlapping
 * road surfaces (paving < footpath < road < kerb) already sit a few cm apart,
 * which is plenty up close; further out that falls below the depth buffer's
 * precision (about d^2 / 2^24 / near), so each layer is also pulled towards
 * the camera by this much: about 3 cm per layer at 100 m, 30 cm at 300 m.
 */
const ROAD_DEPTH_BIAS = 2e-6;

const f = (v: number) => v.toFixed(5);

export interface CityMaterialOptions {
  /**
   * For the far skyline and the Sky Tower: its own, longer fog (colour in
   * output sRGB, like three's), so landmarks stand out of the haze well past
   * where the scene's fog swallows the ground. Without it the scene's fog applies.
   */
  haze?: { colour: THREE.Color; near: number; far: number };
  /**
   * For the hand-made landmarks (src/landmarks), whose atlas has its own
   * layers, all mapped by vertex UVs (no planar ground layers):
   * - `cutout`: bit k set = layer k is a cut-out (its alpha is coverage,
   *   not tint: below 0.5 is discarded), for lattices, balustrades, letters;
   * - an `aGlow` vertex attribute: that much of the surface colour is added
   *   as emitted light (neon, warning lights); 3 or more blinks;
   * - `time`: the uniform (seconds) the blinking reads.
   */
  landmark?: { cutout: number; time: { value: number } };
}

export function cityMaterial(atlas: THREE.Texture, opts: CityMaterialOptions = {}): THREE.MeshLambertMaterial {
  const { haze, landmark } = opts;
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, fog: !haze });
  const planar = landmark ? [] : LAYERS.slice(FIRST_PLANAR).map((l) => 1 / (PLANAR_METRES[l] ?? 4));
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlas = { value: atlas };
    if (landmark) {
      shader.uniforms.uTime = landmark.time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aGlow;
uniform float uTime;
varying float vGlow;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
// Aircraft warning lights: a short flash every 1.5 s.
vGlow = aGlow > 2.5 ? (aGlow - 2.0) * step(0.82, fract(uTime / 1.5)) : aGlow;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying float vGlow;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vGlow;`);
    }
    if (haze) {
      shader.uniforms.uHaze = { value: haze.colour };
      shader.uniforms.uHazeRange = { value: new THREE.Vector2(haze.near, haze.far) };
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `{
  float hd = length(vCityPos - cameraPosition);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, smoothstep(uHazeRange.x, uHazeRange.y, hd));
}`,
      );
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float roadLayer;
attribute float aShade;
attribute vec2 aUv;
attribute float aTile;
varying float vShade;
varying vec2 vAtlasUv;
varying float vTile;
varying vec3 vCityPos;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
gl_Position.z -= roadLayer * ${ROAD_DEPTH_BIAS.toExponential()} * gl_Position.w;
vShade = aShade / ${f(SHADE_ONE)};
vAtlasUv = aUv / ${f(UV_SCALE)};
vTile = aTile;
vCityPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform highp sampler2DArray uAtlas;
uniform vec3 uHaze;
uniform vec2 uHazeRange;
varying float vShade;
varying vec2 vAtlasUv;
varying float vTile;
varying vec3 vCityPos;
${planar.length ? `const float PLANAR[${planar.length}] = float[](${planar.map(f).join(', ')});` : ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float tile = floor(vTile + 0.5);
  if (tile > 0.5) {
    float t = tile - 1.0;
    float layer = mod(t, 16.0);
    float marking = floor(t / 16.0);
    vec2 uv = vAtlasUv;
    ${planar.length ? `if (layer >= ${f(FIRST_PLANAR)} - 0.5) uv = vCityPos.xz * PLANAR[int(layer) - ${FIRST_PLANAR}];` : ''}
    vec4 tex = texture(uAtlas, vec3(uv, layer));
    ${landmark ? `if (((${landmark.cutout} >> int(layer)) & 1) == 1) {
      if (tex.a < 0.5) discard;
      tex.a = 0.0;
    }` : ''}
    diffuseColor.rgb = tex.rgb * mix(vec3(1.0), diffuseColor.rgb * ${f(TINT_GAIN)}, tex.a);
    if (marking > 0.5) {
      // Lane lines: u is lanes across from the left edge, v is 9 m dash periods along.
      float lanes = marking > 7.5 ? marking - 7.0 : marking;
      float k = floor(vAtlasUv.x + 0.5);
      float d = abs(vAtlasUv.x - k);
      float du = fwidth(vAtlasUv.x);
      bool centre = marking > 7.5 && abs(k - lanes * 0.5) < 0.01;
      float on = step(0.5, k) * step(k, lanes - 0.5);
      float dash = centre ? (lanes > 3.5 ? 1.0 : step(fract(vAtlasUv.y), 0.5)) : step(fract(vAtlasUv.y), 0.33);
      float w = centre && lanes > 3.5 ? 0.06 : 0.035;
      float line = on * dash * (1.0 - smoothstep(w - du, w + du, d));
      // Gone before they're thinner than a pixel, rather than shimmering.
      line *= clamp(1.5 - du * 25.0, 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.75, 0.72), line);
    }
  }
  diffuseColor.rgb *= vShade;
}`,
      );
  };
  material.customProgramCacheKey = () => `city${haze ? '-haze' : ''}${landmark ? `-landmark${landmark.cutout}` : ''}`;
  return material;
}
