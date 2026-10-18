// Creature kit: papercraft parts, forest-like shading, and baking a posed 3D
// model into flat billboard cells (the Façade-style flattening). Used by the
// birds in the forest and by the lab test pages (lab/fox.html, lab/bird.html).
import * as THREE from 'three';

export { THREE };

// ---------------------------------------------------------------- geometry
// Every part is a small prism or cone, flat-shaded, coloured per face by a
// function of the face centre in the part's own space, with a slight random
// tone per face: printed card panels, papercraft-like.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
export function reseed(s) { seed = s; }

export function part(geo, colorAt, parent, at = [0, 0, 0]) {
  geo = geo.toNonIndexed();
  const p = geo.attributes.position, n = p.count;
  const cols = new Float32Array(n * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const nrm = new THREE.Vector3(), mid = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    mid.copy(a).add(b).add(c).divideScalar(3);
    nrm.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    const k = colorAt(mid, nrm).clone().multiplyScalar(0.94 + rand() * 0.12);
    for (let j = 0; j < 3; j++) cols.set([k.r, k.g, k.b], (i + j) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const m = new THREE.Mesh(geo, material);
  m.position.set(...at);
  parent.add(m);
  return m;
}

// Prism along +X from x0 to x1 (radii r0 -> r1), `sides` faces, z squash.
export function prismX(x0, x1, r0, r1, sides, squash = 1, rot = Math.PI / sides) {
  const g = new THREE.CylinderGeometry(r1, r0, x1 - x0, sides, 1, false, rot);
  g.rotateZ(-Math.PI / 2);
  g.translate((x0 + x1) / 2, 0, 0);
  g.scale(1, 1, squash);
  return g;
}
// Prism hanging down from the origin, length len (radii r0 at top -> r1).
export function prismDown(len, r0, r1, sides) {
  const g = new THREE.CylinderGeometry(r0, r1, len, sides);
  g.translate(0, -len / 2, 0);
  return g;
}

// ---------------------------------------------------------------- shading
// Flat facets lit by the scene's sun (or moon) and ambient, a soft wrap so
// the shadow side keeps some form, and fine streaks (fur or feathers) running
// along each part. uGrain scales the streaks to the creature's size.
export const material = new THREE.ShaderMaterial({
  uniforms: {
    uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.4).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.93, 0.8) },
    uSunStrength: { value: 1 },
    uAmbient: { value: new THREE.Color(0.42, 0.45, 0.52) },
    uGrain: { value: 1 },
  },
  vertexShader: /* glsl */ `
    attribute vec3 color;
    varying vec3 vColor;
    varying vec3 vLocal;
    varying vec3 vWorld;
    void main() {
      vColor = color;
      vLocal = position;
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform float uSunStrength;
    uniform vec3 uAmbient;
    uniform float uGrain;
    varying vec3 vColor;
    varying vec3 vLocal;
    varying vec3 vWorld;
    float h3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
    float n3(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }
    void main() {
      vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
      float lam = dot(n, uSunDir);
      float wrap = clamp(lam * 0.75 + 0.25, 0.0, 1.0);
      vec3 q = vLocal * uGrain;
      float fur = n3(vec3(q.x * 18.0, q.y * 90.0, q.z * 90.0)) * 0.6 + n3(q * 45.0) * 0.4;
      vec3 c = vColor * (0.82 + 0.3 * fur);
      vec3 light = uAmbient + uSunColor * uSunStrength * wrap * wrap;
      // Never quite as dark as the trees at night.
      gl_FragColor = vec4(max(c * light, c * 0.12), 1.0);
    }`,
});

// ---------------------------------------------------------------- lights
// Approximations of the forest's own day, dusk and moonlit night.
export const LIGHTS = {
  day: { dir: [0.45, 0.75, 0.5], sun: [1, 0.94, 0.82], strength: 1, ambient: [0.42, 0.46, 0.54] },
  dusk: { dir: [0.75, 0.22, 0.6], sun: [1, 0.62, 0.36], strength: 0.95, ambient: [0.2, 0.18, 0.26] },
  night: { dir: [-0.3, 0.7, 0.6], sun: [0.55, 0.65, 0.9], strength: 0.25, ambient: [0.05, 0.06, 0.1] },
};
export function setLight(name) {
  const L = LIGHTS[name], u = material.uniforms;
  u.uSunDir.value.set(...L.dir).normalize();
  u.uSunColor.value.setRGB(...L.sun);
  u.uSunStrength.value = L.strength;
  u.uAmbient.value.setRGB(...L.ambient);
}

// ---------------------------------------------------------------- bake
// Orthographic camera around the model at a slight downward look (el), framing
// `span` metres across centred at height cy, rendered small into a target and
// copied into a 2D cell: the flattened billboard.
export function bakeCell(renderer, scene, angle, { w, h, span, cy, el = 0.2, withRim = true }) {
  const sh = span * h / w;
  const cam = new THREE.OrthographicCamera(-span / 2, span / 2, sh / 2, -sh / 2, 0.01, 20);
  const d = 4;
  cam.position.set(Math.cos(angle) * Math.cos(el) * d, cy + Math.sin(el) * d, Math.sin(angle) * Math.cos(el) * d);
  cam.lookAt(0, cy, 0);
  const rt = new THREE.WebGLRenderTarget(w, h);
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, cam);
  const px = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
  renderer.setRenderTarget(null);
  rt.dispose();
  // Flip rows (GL is bottom-up) into ImageData.
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  if (withRim) rim(img);
  return img;
}

// The forest's way: draw one cell straight into a region of the renderer's own
// canvas (sized to a whole atlas), so a creature's whole atlas is one canvas
// copy with no pixel readback. The rim is added later by the billboard shader.
const cellCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
export function drawCell(renderer, scene, angle, x, y, { w, h, span, cy, el = 0.2 }) {
  const sh = span * h / w, d = 4;
  cellCam.left = -span / 2; cellCam.right = span / 2; cellCam.top = sh / 2; cellCam.bottom = -sh / 2;
  cellCam.updateProjectionMatrix();
  cellCam.position.set(Math.cos(angle) * Math.cos(el) * d, cy + Math.sin(el) * d, Math.sin(angle) * Math.cos(el) * d);
  cellCam.lookAt(0, cy, 0);
  // Viewport y counts from the bottom of the canvas.
  const H = renderer.domElement.height / renderer.getPixelRatio();
  renderer.setViewport(x, H - y - h, w, h);
  renderer.setScissor(x, H - y - h, w, h);
  renderer.render(scene, cellCam);
}

// Outline pixels (next to an empty one) catch a faint rim of the sun or moon
// light, more so the darker the light. In the forest this would happen in the
// billboard shader; here it's applied to the baked cell.
function rim(img) {
  const u = material.uniforms, s = u.uSunColor.value, a = u.uAmbient.value, k = u.uSunStrength.value;
  const lum = (a.r + a.g + a.b + (s.r + s.g + s.b) * k) / 3;
  const dark = 1 - Math.min(1, Math.max(0, lum));
  const amt = (0.03 + 0.2 * dark * dark) * 255;
  const rc = [(s.r + 0.75) / 2, (s.g + 0.8) / 2, (s.b + 0.9) / 2];
  const { width: w, height: h, data: d } = img;
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 127;
  const edges = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (solid(x, y) && !(solid(x + 1, y) && solid(x - 1, y) && solid(x, y + 1) && solid(x, y - 1))) edges.push((y * w + x) * 4);
  }
  for (const i of edges) for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, d[i + c] + rc[c] * amt);
}
