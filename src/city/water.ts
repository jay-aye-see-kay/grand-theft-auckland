import * as THREE from 'three';

// The harbour: one big flat quad at sea level that follows the camera (one
// draw call), drawn wherever the terrain is lower. The look is all in the
// fragment shader and costs a handful of sines per pixel: an analytic
// normal from a few travelling waves (each faded out once it's too small
// on screen, so it doesn't shimmer into moire), a fresnel blend from deep green-blue to the sky
// colour, a sun glint, and the scene's fog so it melts into the horizon.
//
// Outside the map it's only drawn to the north (the harbour side): beyond
// the southern edges there's land, which later tasks fill in.

/** Side of the quad, m. Beyond the fog's far end it's all sky colour anyway. */
const SIZE = 8000;
/** The quad snaps to this grid as it follows the camera (the pattern is in world space, so it never swims). */
const SNAP = 100;

const vertexShader = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSky;
uniform vec3 uSunColour;
uniform vec3 uSunDir;
/** Map bounds (minX, minZ, maxX, maxZ) and the latitude (z) south of which there's no sea outside them. */
uniform vec4 uBounds;
uniform float uSeaSouth;
varying vec3 vWorld;
#include <common>
#include <fog_pars_fragment>

// One travelling wave's slope: direction d, wavenumber k, speed s, amplitude
// a. Waves shorter than a few pixels are faded out (fw is the pixel's
// footprint on the water), or they'd alias into moire stripes.
vec2 slope(vec2 p, float fw, vec2 d, float k, float s, float a) {
  float keep = clamp(1.0 - k * fw * 0.6, 0.0, 1.0);
  return d * (k * a * keep * cos(dot(p, d) * k + uTime * s));
}

void main() {
  vec2 p = vWorld.xz;
  bool outside = p.x < uBounds.x || p.y < uBounds.y || p.x > uBounds.z || p.y > uBounds.w;
  if (outside && p.y > uSeaSouth) discard;

  vec3 toEye = cameraPosition - vWorld;
  float dist = length(toEye);
  vec3 v = toEye / dist;
  float fw = length(fwidth(p));
  vec2 g = slope(p, fw, vec2(0.80, 0.60), 0.17, 1.1, 0.30)
         + slope(p, fw, vec2(-0.47, 0.88), 0.11, 0.8, 0.40)
         + slope(p, fw, vec2(0.96, -0.28), 0.71, 2.4, 0.05)
         + slope(p, fw, vec2(-0.69, -0.72), 1.23, 3.1, 0.03)
         + slope(p, fw, vec2(0.21, 0.98), 2.13, 4.0, 0.016)
         + slope(p, fw, vec2(-0.93, 0.37), 3.71, 5.3, 0.008);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));

  float facing = max(dot(n, v), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
  // Broad, slowly drifting patches of lighter and darker water.
  float mottle = 0.5 + 0.25 * sin(p.x * 0.011 + p.y * 0.007 + uTime * 0.05) + 0.25 * sin(p.y * 0.013 - p.x * 0.004);
  vec3 body = mix(uDeep, uShallow, mottle * 0.5 + 0.3 * (1.0 - facing));
  vec3 colour = mix(body, uSky, clamp(fresnel * 0.7, 0.0, 1.0));
  vec3 h = normalize(v + uSunDir);
  float glint = pow(max(dot(n, h), 0.0), 220.0) / (1.0 + dist * 0.002);
  colour += uSunColour * glint * 1.4;

  gl_FragColor = vec4(colour, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class Water {
  readonly mesh: THREE.Mesh;
  readonly level: number;
  private readonly material: THREE.ShaderMaterial;

  /**
   * @param bounds   the map's extent in local metres
   * @param seaSouth outside the map, water is drawn only north of this z
   */
  constructor(level: number, sky: THREE.Color, sunDir: THREE.Vector3, bounds: { minX: number; minZ: number; maxX: number; maxZ: number }, seaSouth: number) {
    this.level = level;
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uDeep: { value: new THREE.Color(0x1d4a55) },
          uShallow: { value: new THREE.Color(0x2f6f73) },
          uSky: { value: sky.clone() },
          uSunColour: { value: new THREE.Color(0xffe2b8) },
          uSunDir: { value: sunDir.clone().normalize() },
          uBounds: { value: new THREE.Vector4(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ) },
          uSeaSouth: { value: seaSouth },
        },
      ]),
    });
    const geo = new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'water';
    this.mesh.position.y = level;
    this.mesh.frustumCulled = false;
    // After the opaque city, so most of it fails the depth test cheaply under the terrain.
    this.mesh.renderOrder = 1;
  }

  /** Per frame: follow the camera and advance the waves. */
  update(camera: THREE.Camera, time: number): void {
    this.mesh.position.x = Math.round(camera.position.x / SNAP) * SNAP;
    this.mesh.position.z = Math.round(camera.position.z / SNAP) * SNAP;
    this.material.uniforms.uTime.value = time;
  }

  /** Is (x, z) open water, given the ground height there? */
  covers(ground: number): boolean {
    return ground < this.level;
  }
}
