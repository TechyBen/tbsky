// Chatter: live posts from the people you follow arrive as small birds that
// settle in the forest. In wander mode you walk among them; near a bird
// its post shows, and Enter opens the thread on bsky.app.
//
// Query options (set by the content script):
//   chatter=1             turn the birds on
//   me=<did or handle>    whose follows to listen to
//   parent=<origin>       the Bluesky page (where open/leave messages go)
//
// Sources, all public and keyless: app.bsky.graph.getFollows on the public
// AppView for the follow list (cached for 6 hours), and Jetstream, Bluesky's
// JSON firehose, filtered to those accounts for the posts themselves.

const q = new URLSearchParams(location.search);
const ME = (q.get('me') || '').trim();
const CHATTER = q.get('chatter') === '1' && !!ME;
const PARENT = q.get('parent') || 'https://bsky.app';
const APPVIEW = 'https://public.api.bsky.app/xrpc/';
const JETSTREAMS = [
  'jetstream2.us-east.bsky.network', 'jetstream1.us-east.bsky.network',
  'jetstream1.us-west.bsky.network', 'jetstream2.us-west.bsky.network',
];
const MAX_BIRDS = 18;          // the oldest flies off when a new one lands
const STAY = 60 * 60;          // seconds a bird stays perched (unless displaced)
const REPLAY = 3 * 3600e3;     // on start, replay this much recent chatter
const FOLLOWS_TTL = 6 * 3600e3;
const MAX_DIDS = 10000;        // Jetstream's limit on wanted DIDs
const EYE = 1.6, REACH = 3.2;  // eye height and how close you must be to read
const FLUSH = 1.5, FLUSH_WAIT = 1; // closer than ~2 steps for a second (no Enter): it flies
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

import { buildBird, POSES, sizeFor } from './birdmodel.js';
import { material as kit, drawCell } from './kit.js';

const api = await new Promise(res => {
  const t = setInterval(() => { if (window.treeps1) { clearInterval(t); res(window.treeps1); } }, 100);
});
const { THREE, scene, camera, controls, U } = api;

// ---------------------------------------------------------------- feed
let follows = null;
let status = CHATTER ? 'finding who you follow…' : 'sign in to bsky.app (or set your handle in the popup) for chatter';

async function xrpc(method, params) {
  const u = new URL(APPVIEW + method);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${method}: ${r.status}`);
  return r.json();
}

async function loadFollows(actor) {
  const key = `skytree:follows2:${actor}`;
  try {
    const c = JSON.parse(localStorage.getItem(key));
    if (c && Date.now() - c.at < FOLLOWS_TTL) return c;
  } catch { /* no cache */ }
  const people = {};
  let cursor, n = 0;
  do {
    const j = await xrpc('app.bsky.graph.getFollows', { actor, limit: 100, cursor });
    for (const f of j.follows) { people[f.did] = [f.handle, f.displayName || '', f.avatar || '']; n++; }
    cursor = j.cursor;
  } while (cursor && n < MAX_DIDS);
  const c = { at: Date.now(), people };
  try { localStorage.setItem(key, JSON.stringify(c)); } catch { /* full */ }
  return c;
}

// Jetstream, filtered to the follows. The DID list goes in an options_update
// message rather than the URL (it can be thousands long). Reconnects resume
// from the last event seen.
function listen(dids, onPost) {
  let n = 0, backoff = 2, cursor = (Date.now() - REPLAY) * 1000;
  function open() {
    const host = JETSTREAMS[n++ % JETSTREAMS.length];
    const ws = new WebSocket(`wss://${host}/subscribe?requireHello=true&cursor=${cursor}`);
    ws.onopen = () => {
      backoff = 2;
      ws.send(JSON.stringify({
        type: 'options_update',
        payload: { wantedCollections: ['app.bsky.feed.post'], wantedDids: dids, maxMessageSizeBytes: 0 },
      }));
      status = `listening to ${dids.length} people`;
    };
    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.time_us) cursor = m.time_us;
      const c = m.commit;
      if (m.kind !== 'commit' || c?.operation !== 'create' || c.collection !== 'app.bsky.feed.post') return;
      if (c.record?.reply) return; // top-level posts only
      onPost({
        did: m.did, rkey: c.rkey, text: c.record?.text || '', media: !!c.record?.embed,
        at: Date.parse(c.record?.createdAt) || Date.now(),
      });
    };
    ws.onclose = () => {
      status = 'reconnecting…';
      setTimeout(open, backoff * 1000);
      backoff = Math.min(60, backoff * 2);
    };
  }
  open();
}

// Arrivals queue up and land one at a time (quickly while the forest is
// empty), keeping only the newest when a burst comes in.
const queue = [];
let nextLanding = 0;
function arrive(post) {
  if (!follows?.people[post.did]) return;
  queue.push(post);
  if (queue.length > MAX_BIRDS) queue.splice(0, queue.length - MAX_BIRDS);
}

if (CHATTER) {
  loadFollows(ME)
    .then(c => {
      follows = c;
      const dids = Object.keys(c.people);
      if (!dids.length) { status = 'you don’t follow anyone yet'; return; }
      listen(dids, arrive);
    })
    .catch(err => { status = `couldn’t load who you follow (${err.message})`; });
}

// ---------------------------------------------------------------- birds
// Each bird is the 3D songbird from birdmodel.js, flattened Façade-style: for
// every account, its model (coloured loosely from the profile picture) is lit
// with the forest's current light and rendered into an atlas of billboards,
// 6 poses x 8 view angles. In the forest a bird is a camera-facing quad that
// shows one cell. Position moves smoothly; pose and view angle only step every
// 2-3 seconds, so turning and flapping change billboards slowly.
const POSE_ROWS = ['perch', 'look', 'hop', 'up', 'glide', 'down'];
const FLAP = ['up', 'glide', 'down', 'glide'];
const CW = 48, CH = 36;                 // cell size in pixels
const SPAN = 0.3, CY = 0.06, EL = 0.25; // framing in model metres (as in the lab)
const DRAW = 2.7;                       // drawn larger than life, so they read

const bakeCanvas = document.createElement('canvas');
const baker = new THREE.WebGLRenderer({ canvas: bakeCanvas, alpha: true, antialias: false, preserveDrawingBuffer: true });
baker.setPixelRatio(1);
baker.setSize(8 * CW, POSE_ROWS.length * CH, false);
const bakeScene = new THREE.Scene();

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

// The forest's light as a short key, to notice when it has changed enough to
// rebake (scene changes, sunset, moonrise).
function lightKey() {
  const r = v => v.toFixed(2);
  const d = U.uSunDir.value, c = U.uSunColor.value, a = U.uAmbient.value, k = U.uSunStrength.value;
  return [d.y, c.r * k, c.g * k, c.b * k, a.r, a.g, a.b].map(r).join();
}

// One per account: its colour, size from its follower count, and baked atlas.
const accounts = new Map();
const dirty = new Set();
function account(did) {
  let a = accounts.get(did);
  if (a) return a;
  const fallback = new THREE.Color().setHSL(hash(did), 0.5, 0.5);
  const canvas = document.createElement('canvas');
  canvas.width = 8 * CW;
  canvas.height = POSE_ROWS.length * CH;
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  a = { did, rgb: [fallback.r * 255, fallback.g * 255, fallback.b * 255], size: 1, canvas, tex, baked: '' };
  accounts.set(did, a);
  dirty.add(a);
  const avatar = follows?.people[did]?.[2];
  if (avatar) avatarColour(avatar).then(rgb => { a.rgb = rgb; dirty.add(a); }).catch(() => {});
  xrpc('app.bsky.actor.getProfile', { actor: did }).then(p => { a.size = sizeFor(p.followersCount || 0); }).catch(() => {});
  return a;
}

// Loosely the picture's colour: pixels weighted by saturation squared times
// brightness, so the vivid part wins over a grey background; a mostly grey
// picture gives its plain average.
async function avatarColour(url) {
  const r = await fetch(url.replace('/img/avatar/plain/', '/img/avatar_thumbnail/plain/'));
  if (!r.ok) throw new Error(r.status);
  const bmp = await createImageBitmap(await r.blob());
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let sw = 0, sr = 0, sg = 0, sb = 0, ar = 0, ag = 0, ab = 0;
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    const s = mx ? (mx - mn) / mx : 0, w = s * s * (mx / 255);
    sw += w; sr += w * R; sg += w * G; sb += w * B;
    ar += R; ag += G; ab += B;
  }
  const n = d.length / 4;
  return sw < n * 0.02 ? [ar / n, ag / n, ab / n] : [sr / sw, sg / sw, sb / sw];
}

// Render an account's atlas with the forest's current light. The light comes
// from above at the sun's height (atlases aren't per heading, so its compass
// direction is fixed toward the bird's front-left, which suits every view).
function bake(a) {
  const rig = buildBird(a.rgb);
  bakeScene.add(rig.bird);
  const u = kit.uniforms, d = U.uSunDir.value;
  const el = Math.max(0.15, d.y), h = Math.sqrt(Math.max(0, 1 - el * el));
  u.uSunDir.value.set(h * 0.7, el, h * 0.7).normalize();
  u.uSunColor.value.copy(U.uSunColor.value);
  u.uSunStrength.value = U.uSunStrength.value;
  u.uAmbient.value.copy(U.uAmbient.value);
  u.uGrain.value = 4;
  baker.setScissorTest(false);
  baker.setClearColor(0x000000, 0);
  baker.clear();
  baker.setScissorTest(true);
  POSE_ROWS.forEach((pose, row) => {
    POSES[pose](rig);
    for (let k = 0; k < 8; k++) {
      drawCell(baker, bakeScene, k * Math.PI / 4, k * CW, row * CH, { w: CW, h: CH, span: SPAN, cy: CY, el: EL });
    }
  });
  const g = a.canvas.getContext('2d');
  g.clearRect(0, 0, a.canvas.width, a.canvas.height);
  g.drawImage(bakeCanvas, 0, 0);
  a.tex.needsUpdate = true;
  a.baked = lightKey();
  bakeScene.remove(rig.bird);
  rig.bird.traverse(o => o.geometry?.dispose());
}

// Camera-facing quad showing one atlas cell. The bake already has the light;
// here the canopy's dappled shadow darkens the sun's share as a bird passes
// through shade, outline pixels catch a faint rim (more in the dark), and the
// forest's height fog applies. Nothing in the shadow pass.
const VS = /* glsl */ `
uniform vec2 uSize;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vWorld = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}`;
const FS = /* glsl */ `
uniform sampler2D uMap;
uniform vec2 uCell;  // column (view angle), row (pose)
uniform float uSel;
uniform float uPass;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunStrength;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogBase;
uniform float uFogFalloff;
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowBias;
uniform float uShadowOn;
varying vec2 vUv;
varying vec3 vWorld;
const vec2 CELL = vec2(${CW}.0, ${CH}.0);
const vec2 GRID = vec2(8.0, ${POSE_ROWS.length}.0);

float shadowAt(vec3 wp) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  vec3 s = sc.xyz / sc.w;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  return s.z - uShadowBias > texture2D(uShadowMap, s.xy).r ? 0.0 : 1.0;
}

// One pixel of the current cell (px from its bottom-left), nearest.
vec4 cellAt(vec2 px) {
  if (px.x < 0.0 || px.y < 0.0 || px.x > CELL.x - 1.0 || px.y > CELL.y - 1.0) return vec4(0.0);
  vec2 uv = vec2((uCell.x * CELL.x + px.x + 0.5) / (GRID.x * CELL.x),
                 1.0 - ((uCell.y + 1.0) * CELL.y - px.y - 0.5) / (GRID.y * CELL.y));
  return texture2D(uMap, uv);
}

void main() {
  if (uPass > 0.5) discard;
  vec2 px = floor(vUv * CELL);
  vec4 t = cellAt(px);
  if (t.a < 0.5) discard;

  float sunL = dot(uSunColor, vec3(0.333)) * uSunStrength, ambL = dot(uAmbient, vec3(0.333));
  float sunShare = sunL / max(sunL + ambL, 1e-3);
  vec3 col = t.rgb * mix(1.0 - 0.6 * sunShare, 1.0, shadowAt(vWorld + uSunDir * 0.4));

  float edge = 1.0 - min(min(cellAt(px + vec2(1.0, 0.0)).a, cellAt(px - vec2(1.0, 0.0)).a),
                         min(cellAt(px + vec2(0.0, 1.0)).a, cellAt(px - vec2(0.0, 1.0)).a));
  float dark = 1.0 - clamp(ambL + sunL, 0.0, 1.0);
  vec3 rim = mix(uSunColor, vec3(0.75, 0.8, 0.9), 0.5);
  col += rim * edge * (0.03 + 0.2 * dark * dark);

  col += uSel * 0.25;
  float dist = length(vWorld - cameraPosition);
  float hf = exp(-max(vWorld.y - uFogBase, 0.0) * uFogFalloff);
  float f = 1.0 - exp(-dist * uFogDensity * mix(0.3, 1.0, hf));
  gl_FragColor = vec4(mix(col, uFogColor, clamp(f, 0.0, 1.0) * 0.9), 1.0);
}`;

const group = new THREE.Group();
group.name = 'skytree-chatter';
const quad = new THREE.PlaneGeometry(1, 1);
const birds = [];
const tmp = new THREE.Vector3(), right = new THREE.Vector3();

// ---------------------------------------------------------------- perches
// Birds stand on real parts of the forest: the trees' own side branches (from
// each tree type's skeleton, placed through every planted copy), the tops of
// shrubs, or the ground. A branch perch is a fairly level section of a side
// branch, neither twig nor bough, 1-5 m up, not buried in a leaf
// cluster; the bird's feet go on top of it.
// Shrubs are leafy billboards, so a bird just stands on the top of the bush.
const KINDS = [['branch', 0.65], ['shrub', 0.2], ['ground', 0.15]];
let perchList = [], perchForest = null;

function perches() {
  const vs = api.variants();
  if (vs[0] === perchForest) return perchList;
  perchForest = vs[0];
  const out = [], p = new THREE.Vector3();
  for (const v of vs) {
    const local = [];
    if (v.species === 'shrub') {
      const top = [...v.tree.clusters].sort((a, b) => b.p.y - a.p.y).slice(0, 3);
      for (const c of top) local.push({ p: c.p.clone().setY(c.p.y + c.size * 0.3), r: 0, kind: 'shrub' });
    } else {
      for (const l of v.tree.limbs) {
        if (l.level < 1) continue;
        for (let i = 0; i < l.pts.length - 1; i++) {
          const a = l.pts[i], b = l.pts[i + 1], len = a.distanceTo(b);
          const r = (l.radii[i] + l.radii[i + 1]) / 2;
          if (len < 1e-3 || Math.abs(b.y - a.y) / len > 0.55 || r < 0.012 || r > 0.12) continue;
          const mid = a.clone().lerp(b, 0.5);
          // Out along the branch (so it shows under the bird), and not buried
          // in a leaf cluster where the bird couldn't be seen.
          if (Math.hypot(mid.x, mid.z) < 0.6) continue;
          if (v.tree.clusters.some(c => c.p.distanceTo(mid) < c.size * 0.55)) continue;
          local.push({ p: mid, r, kind: 'branch' });
        }
      }
    }
    for (const inst of v.instances) {
      for (const c of local) {
        p.copy(c.p).applyMatrix4(inst.m);
        if (c.kind === 'branch') {
          const h = p.y - api.terrainHeight(p.x, p.z);
          if (h < 1 || h > 5) continue;
        }
        out.push({ x: p.x, y: p.y + c.r * inst.scale, z: p.z, kind: c.kind, tx: inst.pos.x, tz: inst.pos.z });
      }
    }
  }
  perchList = out;
  return out;
}

// A free perch between rMin and rMax from (cx, cz), of a kind picked by the
// weights above (falling back to another kind, then the ground), not too near
// another bird, and (when `away` is given) not near that point either.
function pickPerch(cx, cz, rMin, rMax, away = null, keep = null) {
  const inRing = q => { const d = Math.hypot(q.x - cx, q.z - cz); return d >= rMin && d <= rMax; };
  const free = q => birds.every(b => b === keep || b.perch.distanceToSquared(new THREE.Vector3(q.x, q.y, q.z)) > 0.36) &&
    (!away || Math.hypot(q.x - away.x, q.z - away.z) > 3);
  let roll = Math.random(), want = 'ground';
  for (const [k, w] of KINDS) { if ((roll -= w) < 0) { want = k; break; } }
  for (const kind of want === 'ground' ? [] : [want, want === 'branch' ? 'shrub' : 'branch']) {
    const list = perches().filter(q => q.kind === kind && inRing(q) && free(q));
    if (list.length) {
      const q = list[Math.floor(Math.random() * list.length)];
      return { at: new THREE.Vector3(q.x, q.y, q.z), kind, trunk: [q.tx, q.tz] };
    }
  }
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * TAU, r = rMin + Math.random() * (rMax - rMin);
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const q = { x, y: api.terrainHeight(x, z), z };
    if (free(q) || i === 11) return { at: new THREE.Vector3(q.x, q.y, q.z), kind: 'ground' };
  }
}

// The billboard's centre sits this far above the bird's feet.
const lift = b => CY * DRAW * b.acct.size;

function land(post, t) {
  const cam = camera.position;
  const spot = pickPerch(cam.x, cam.z, 7, 19);
  const perch = spot.at;
  const a = Math.atan2(perch.z - cam.z, perch.x - cam.x);
  const b = a + (Math.random() - 0.5) * 1.4;
  const from = new THREE.Vector3(cam.x + Math.cos(b) * 50, perch.y + 12 + Math.random() * 8, cam.z + Math.sin(b) * 50);
  const acct = account(post.did);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...U, uMap: { value: acct.tex }, uCell: { value: new THREE.Vector2(0, 3) },
      uSize: { value: new THREE.Vector2(1, CH / CW) }, uSel: { value: 0 },
    },
    vertexShader: VS, fragmentShader: FS,
  });
  const mesh = new THREE.Mesh(quad, mat);
  mesh.frustumCulled = false;
  mesh.position.copy(from);
  group.add(mesh);
  const bird = {
    post, acct, mesh, mat, from, perch, kind: spot.kind, trunk: spot.trunk, to: null, state: 'in', since: t,
    flight: 7 + Math.random() * 4, arc: 3, heading: Math.atan2(perch.z - from.z, perch.x - from.x),
    pose: 'up', flap: 0, nextStep: 0, close: 0,
  };
  birds.push(bird);
  step(bird, t);
  // Too many: the longest-perched one flies off.
  const perched = birds.filter(x => x.state !== 'out');
  if (perched.length > MAX_BIRDS) flyOff(perched[0], t);
}

function flyOff(b, t) {
  const a = Math.random() * TAU;
  b.state = 'out';
  b.since = t;
  b.from = b.mesh.position.clone();
  b.to = b.from.clone().add(new THREE.Vector3(Math.cos(a) * 60, 25, Math.sin(a) * 60));
  b.heading = a;
  step(b, t);
}

// Startled, or its perch gone: a short flight to another perch nearby (away
// from `away`, the walker, when given).
function relocate(b, t, away = null) {
  const spot = pickPerch(b.perch.x, b.perch.z, 3, 10, away, b);
  b.from = b.mesh.position.clone();
  b.perch = spot.at;
  b.kind = spot.kind;
  b.trunk = spot.trunk;
  b.state = 'in';
  b.since = t;
  b.flight = 2.5 + Math.random() * 1.5;
  b.arc = 1.2;
  b.close = 0;
  b.heading = Math.atan2(b.perch.z - b.from.z, b.perch.x - b.from.x);
  if (b === selected) select(null);
  step(b, t);
}

// Which of the 8 baked views the camera sees, given the bird's heading (its
// model faces +X; the bake's view k looks from model direction k * 45°).
function viewCell(b) {
  const dx = camera.position.x - b.mesh.position.x, dz = camera.position.z - b.mesh.position.z;
  const c = Math.cos(b.heading), s = Math.sin(b.heading);
  const k = Math.round(Math.atan2(-dx * s + dz * c, dx * c + dz * s) / (Math.PI / 4));
  return ((k % 8) + 8) % 8;
}

// A pose step, every 2-3 seconds: in flight the wings go up, glide, down,
// glide; perched it mostly sits, sometimes looks round, now and then hops a
// little to a new spot and faces a new way. The view angle and size only
// update here too.
function step(b, t) {
  b.nextStep = t + 2 + Math.random();
  if (b.state === 'perch') {
    const r = Math.random();
    if (r < 0.12 && b !== selected) {
      b.pose = 'hop';
      b.heading = Math.random() * TAU;
      // On a branch it only turns round; on the ground or a bush it steps.
      if (b.kind !== 'branch') {
        b.perch.x += Math.cos(b.heading) * 0.25;
        b.perch.z += Math.sin(b.heading) * 0.25;
        if (b.kind === 'ground') b.perch.y = api.terrainHeight(b.perch.x, b.perch.z);
      }
    } else {
      b.pose = r < 0.4 ? 'look' : 'perch';
    }
  } else {
    b.pose = FLAP[b.flap++ % FLAP.length];
  }
  b.mat.uniforms.uCell.value.set(viewCell(b), POSE_ROWS.indexOf(b.pose));
  const w = SPAN * DRAW * b.acct.size;
  b.mat.uniforms.uSize.value.set(w, w * CH / CW);
}

// Each account gets its own voice from the ambience's synthesised birds, so
// the people you follow each sound the same every time.
const voices = new Map();
function chirp(b) {
  const amb = api.ambience;
  if (!amb?.running) return;
  let v = voices.get(b.post.did);
  if (!v) { v = amb.makeBird(amb.ctx.currentTime, { eager: 0 }); voices.set(b.post.did, v); }
  camera.getWorldDirection(tmp);
  right.set(-tmp.z, 0, tmp.x).normalize();
  const rel = b.mesh.position.clone().sub(camera.position);
  v.pan = clamp(rel.dot(right) / Math.max(1, rel.length()), -0.85, 0.85);
  v.dist = clamp(rel.length() / 40, 0.1, 0.9);
  amb.sing(v, amb.ctx.currentTime + 0.05, 0.7);
}

let lightCheckAt = 0;
function updateBirds(t, dt) {
  if (!group.parent) scene.add(group);
  // Rebake when the light has moved on; one atlas per frame at most.
  if (t > lightCheckAt) {
    lightCheckAt = t + 2;
    const key = lightKey();
    for (const a of accounts.values()) if (a.baked !== key) dirty.add(a);
  }
  if (dirty.size) {
    const a = dirty.values().next().value;
    dirty.delete(a);
    if (accounts.has(a.did)) bake(a);
  }
  // New scene, new trees: birds settle on the new forest (under the fog).
  const forestNow = api.variants()[0];
  if (forestNow !== perchForest && birds.length) {
    perches();
    for (const b of birds) {
      if (b.state === 'out') continue;
      const spot = pickPerch(b.perch.x, b.perch.z, 0, 8, null, b);
      b.perch = spot.at;
      b.kind = spot.kind;
      if (b.state === 'perch') b.mesh.position.copy(b.perch).setY(b.perch.y + lift(b));
    }
  }
  if (queue.length && t >= nextLanding) {
    land(queue.shift(), t);
    nextLanding = t + (birds.length < 6 ? 1.5 : 4);
  }
  for (let i = birds.length - 1; i >= 0; i--) {
    const b = birds[i], m = b.mesh, age = t - b.since;
    if (b.state === 'in') {
      const k = smooth(age / b.flight);
      m.position.lerpVectors(b.from, tmp.copy(b.perch).setY(b.perch.y + lift(b)), k);
      m.position.y += Math.sin(k * Math.PI) * b.arc;
      if (k >= 1) { b.state = 'perch'; b.since = t; step(b, t); chirp(b); }
    } else if (b.state === 'perch') {
      m.position.copy(b.perch).setY(b.perch.y + lift(b));
      const flat = Math.hypot(b.perch.x - camera.position.x, b.perch.z - camera.position.z);
      // Walk right up to it (about 2 steps) without opening it, and after a
      // moment it flies off to settle somewhere nearby.
      b.close = wander && flat < FLUSH ? b.close + dt : 0;
      if (b.close > FLUSH_WAIT) { relocate(b, t, camera.position); continue; }
      // Stay put while someone is close enough to read.
      const near = wander && flat < REACH * 2;
      if (age > STAY && !near) flyOff(b, t);
    } else {
      const k = smooth(age / 8);
      m.position.lerpVectors(b.from, b.to, k);
      if (k >= 1) {
        group.remove(m);
        b.mat.dispose();
        birds.splice(i, 1);
        // Last bird of this account gone: drop its atlas.
        if (!birds.some(x => x.acct === b.acct)) { b.acct.tex.dispose(); accounts.delete(b.acct.did); dirty.delete(b.acct); }
        continue;
      }
    }
    if (t >= b.nextStep) step(b, t);
  }
}

// ---------------------------------------------------------------- wander
let wander = false, selected = null;
let yaw = 0, pitch = 0, dragging = null;
const pos = new THREE.Vector3(), look = new THREE.Vector3();
const keys = new Set();
const MOVE = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight',
]);

const css = document.createElement('style');
css.textContent = `
  body.skytree-wander, body.skytree-wander canvas#view { cursor: grab !important; }
  body.skytree-wander.dragging, body.skytree-wander.dragging canvas#view { cursor: grabbing !important; }
  #skytree-hud, #skytree-card { position: fixed; left: 50%; transform: translateX(-50%); display: none;
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #ecebf3; pointer-events: none; }
  body.skytree-wander #skytree-hud { display: block; }
  #skytree-hud { top: 14px; padding: 6px 14px; border-radius: 999px; background: rgba(12, 14, 20, .55);
    backdrop-filter: blur(6px); font-size: 12px; opacity: .85; white-space: nowrap; }
  #skytree-card { bottom: 28px; width: min(520px, calc(100vw - 32px)); box-sizing: border-box; padding: 14px 16px 12px;
    border-radius: 12px; background: rgba(12, 14, 20, .78); backdrop-filter: blur(8px);
    box-shadow: 0 6px 30px rgba(0, 0, 0, .35); }
  body.skytree-wander #skytree-card.on { display: block; }
  #skytree-card .who b { font-weight: 650; }
  #skytree-card .who span { opacity: .65; }
  #skytree-card p { margin: 6px 0 10px; white-space: pre-wrap; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden; }
  #skytree-card .hint { font-size: 11px; opacity: .6; }
  #skytree-card kbd { font: inherit; padding: 0 4px; border: 1px solid rgba(255, 255, 255, .3); border-radius: 4px; }
`;
const hud = document.createElement('div');
hud.id = 'skytree-hud';
const card = document.createElement('div');
card.id = 'skytree-card';
card.innerHTML = '<div class="who"><b></b> <span></span></div><p></p>' +
  '<div class="hint"><kbd>Enter</kbd> open thread · <kbd>Esc</kbd> back to the feed</div>';
document.head.append(css);
document.body.append(hud, card);

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function select(b) {
  if (b === selected) return;
  if (selected) selected.mat.uniforms.uSel.value = 0;
  selected = b;
  card.classList.toggle('on', !!b);
  if (!b) return;
  b.mat.uniforms.uSel.value = 1;
  const [handle, name] = follows.people[b.post.did] || [b.post.did, ''];
  card.querySelector('b').textContent = name || handle;
  card.querySelector('span').textContent = `@${handle} · ${ago(b.post.at)}`;
  card.querySelector('p').textContent = b.post.text || (b.post.media ? '(image or link)' : '');
}

function setWander(on) {
  if (on === wander) return;
  wander = on;
  document.body.classList.toggle('skytree-wander', on);
  keys.clear();
  if (on) {
    // Start where the screensaver camera is, standing on the ground.
    pos.copy(camera.position);
    look.subVectors(controls.target, camera.position).normalize();
    yaw = Math.atan2(look.z, look.x);
    pitch = clamp(Math.asin(look.y), -0.3, 0.3);
    window.focus();
    api.ambience?.resume(); // a key was just pressed, so sound may start
  } else {
    select(null);
  }
}

function leave() {
  setWander(false);
  parent.postMessage({ type: 'skytree:leave' }, PARENT);
}

addEventListener('message', e => {
  if (e.source !== parent) return;
  if (e.data === 'skytree:wander') setWander(true);
  else if (e.data === 'skytree:calm') setWander(false);
});

// Capture phase, so the forest's own WASD walk never sees these keys.
addEventListener('keydown', e => {
  if (!wander) return;
  if (e.code === 'Escape') { e.preventDefault(); leave(); return; }
  if (e.code === 'Enter' && selected) {
    e.preventDefault();
    const { did, rkey } = selected.post;
    const handle = follows?.people[did]?.[0] || '';
    setWander(false);
    parent.postMessage({ type: 'skytree:open', did, rkey, handle }, PARENT);
    return;
  }
  if (MOVE.has(e.code)) { keys.add(e.code); e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
addEventListener('keyup', e => {
  keys.delete(e.code);
  if (wander) e.stopImmediatePropagation();
}, true);
addEventListener('blur', () => keys.clear());

addEventListener('pointerdown', e => {
  if (!wander) return;
  dragging = { x: e.clientX, y: e.clientY };
  document.body.classList.add('dragging');
  api.ambience?.resume();
});
addEventListener('pointermove', e => {
  if (!dragging) return;
  yaw += (e.clientX - dragging.x) * 0.004;
  pitch = clamp(pitch - (e.clientY - dragging.y) * 0.004, -1.2, 1.2);
  dragging = { x: e.clientX, y: e.clientY };
});
addEventListener('pointerup', () => { dragging = null; document.body.classList.remove('dragging'); });

function updateWander(t, dt) {
  const has = c => keys.has(c);
  // Arrow keys turn, A/D step sideways, Shift runs.
  yaw += ((has('ArrowRight') ? 1 : 0) - (has('ArrowLeft') ? 1 : 0)) * 1.6 * dt;
  const fwd = (has('KeyW') || has('ArrowUp') ? 1 : 0) - (has('KeyS') || has('ArrowDown') ? 1 : 0);
  const side = (has('KeyD') ? 1 : 0) - (has('KeyA') ? 1 : 0);
  const speed = (has('ShiftLeft') || has('ShiftRight') ? 7 : 2.8) * dt;
  const cx = Math.cos(yaw), sz = Math.sin(yaw);
  pos.x += (cx * fwd - sz * side) * speed;
  pos.z += (sz * fwd + cx * side) * speed;
  const moving = fwd || side;
  pos.y = api.terrainHeight(pos.x, pos.z) + EYE + (moving ? 0.03 * Math.sin(t * 9) : 0);
  look.set(cx * Math.cos(pitch), Math.sin(pitch), sz * Math.cos(pitch));
  camera.position.copy(pos);
  controls.target.copy(pos).addScaledVector(look, 5);

  // The nearest perched bird in front of you, within reach.
  let best = null, bd = REACH;
  for (const b of birds) {
    if (b.state !== 'perch') continue;
    tmp.subVectors(b.mesh.position, pos);
    if (Math.abs(tmp.y) > 5) continue;
    tmp.y = 0;
    const d = tmp.length();
    tmp.normalize();
    if (d < bd && tmp.x * cx + tmp.z * sz > 0.5) { bd = d; best = b; }
  }
  select(best);

  const n = birds.filter(b => b.state !== 'out').length;
  hud.textContent = (CHATTER && follows
    ? `${n} ${n === 1 ? 'bird' : 'birds'} · ` : `${status} · `) +
    'WASD walk · drag to look · Esc back';
}

// After the screensaver's camera move, so wander mode can take over.
let last = performance.now() / 1000;
api.beforeFrame.push(now => {
  const t = now / 1000, dt = Math.min(0.1, t - last);
  last = t;
  // Wander first, so the birds see where you actually are this frame.
  if (wander) updateWander(t, dt);
  if (CHATTER) updateBirds(t, dt);
});

// Tell the page we're up (it sends the sound setting, and resumes wander
// mode if the forest was reloaded mid-walk).
parent.postMessage({ type: 'skytree:ready' }, PARENT);

// For testing from the devtools console.
window.skytreeChatter = { birds, queue, status: () => status, setWander, arrive, land: p => land(p, last), perches, relocate: b => relocate(b, last, camera.position),
  // Stand at (x, z) in wander mode, looking at point p.
  stand: (x, z, p) => { pos.set(x, 0, z); yaw = Math.atan2(p.z - z, p.x - x); pitch = Math.atan2(p.y - (api.terrainHeight(x, z) + EYE), Math.hypot(p.x - x, p.z - z)); } };
