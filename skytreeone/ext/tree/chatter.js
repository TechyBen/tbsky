// Chatter: live posts from the people you follow arrive as small pixel birds
// that settle in the forest. In wander mode you walk among them; near a bird
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
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

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
  const key = `skytree:follows:${actor}`;
  try {
    const c = JSON.parse(localStorage.getItem(key));
    if (c && Date.now() - c.at < FOLLOWS_TTL) return c;
  } catch { /* no cache */ }
  const people = {};
  let cursor, n = 0;
  do {
    const j = await xrpc('app.bsky.graph.getFollows', { actor, limit: 100, cursor });
    for (const f of j.follows) { people[f.did] = [f.handle, f.displayName || '']; n++; }
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
// Three 8x8 frames: wings up, wings down, perched. b body, d wing, w belly,
// e eye, k beak and feet.
const ART = [
  ['..d.....', '..dd....', '...dd.bb', '.bbbbbek', 'bbwwwbb.', '..wwbb..', '........', '........'],
  ['........', '........', '......bb', '.bbbbbek', 'bbdddbb.', '..dddb..', '...dd...', '........'],
  ['........', '........', '......bb', '.bbbbbek', 'bbdddbb.', '..wwbb..', '...k.k..', '........'],
];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

const textures = new Map();
function textureFor(did) {
  let t = textures.get(did);
  if (t) return t;
  const hue = hash(did);
  const pal = {
    b: new THREE.Color().setHSL(hue, 0.55, 0.55),
    d: new THREE.Color().setHSL(hue, 0.5, 0.36),
    w: new THREE.Color().setHSL(hue, 0.35, 0.8),
    e: new THREE.Color(0.08, 0.08, 0.1),
    k: new THREE.Color(0.95, 0.62, 0.2),
  };
  const cv = document.createElement('canvas');
  cv.width = 24; cv.height = 8;
  const g = cv.getContext('2d');
  ART.forEach((rows, f) => rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (!pal[ch]) return;
    g.fillStyle = `#${pal[ch].getHexString()}`;
    g.fillRect(f * 8 + x, y, 1, 1);
  })));
  t = new THREE.CanvasTexture(cv);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  textures.set(did, t);
  return t;
}

// Camera-facing quad lit like the forest: the same ambient + sun (or moon)
// light and the same dappled canopy shadow, so a bird darkens with the time
// of day and passes through sun and shade. Two touches keep it findable in
// the dark: it never drops below a dim floor (a little brighter than the
// trees), and its outline pixels catch a faint rim of the sun or moon light.
// Nothing in the shadow pass.
const VS = /* glsl */ `
uniform float uSize;
uniform float uFlip;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vWorld = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += vec2(position.x * uFlip, position.y) * uSize;
  gl_Position = projectionMatrix * mv;
}`;
const FS = /* glsl */ `
uniform sampler2D uMap;
uniform float uFrame;
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

// The forest's own lookup: 1 = lit, 0 = in shadow, single nearest tap.
float shadowAt(vec3 wp) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  vec3 s = sc.xyz / sc.w;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  return s.z - uShadowBias > texture2D(uShadowMap, s.xy).r ? 0.0 : 1.0;
}

// Alpha of one sprite pixel in the current frame (outside it = empty).
float alphaAt(vec2 px) {
  if (px.x < 0.0 || px.y < 0.0 || px.x > 7.0 || px.y > 7.0) return 0.0;
  return texture2D(uMap, vec2((px.x + 0.5 + uFrame * 8.0) / 24.0, (px.y + 0.5) / 8.0)).a;
}

void main() {
  if (uPass > 0.5) discard;
  vec2 px = floor(vUv * 8.0);
  vec4 t = texture2D(uMap, vec2((px.x + 0.5 + uFrame * 8.0) / 24.0, (px.y + 0.5) / 8.0));
  if (t.a < 0.5) discard;

  // Sun or moon from above, through the canopy (offset toward the light so
  // the bird doesn't shadow itself), plus the scene's ambient.
  float up = 0.6 + 0.4 * max(uSunDir.y, 0.0);
  float sunT = up * shadowAt(vWorld + uSunDir * 0.4);
  vec3 light = uAmbient + uSunColor * (uSunStrength * sunT);
  vec3 col = t.rgb * light * mix(0.85, 1.12, vUv.y); // top pixels face the sky

  // A little brighter than the trees in the dark.
  col = max(col, t.rgb * 0.16);

  // Outline pixels (next to an empty one) catch a faint rim of light, more
  // so the darker it is.
  float edge = 1.0 - min(min(alphaAt(px + vec2(1.0, 0.0)), alphaAt(px - vec2(1.0, 0.0))),
                         min(alphaAt(px + vec2(0.0, 1.0)), alphaAt(px - vec2(0.0, 1.0))));
  float dark = 1.0 - clamp(dot(light, vec3(0.333)), 0.0, 1.0);
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

function land(post, t) {
  const cam = camera.position;
  const a = Math.random() * TAU, r = 7 + Math.random() * 12;
  const perch = new THREE.Vector3(cam.x + Math.cos(a) * r, 0, cam.z + Math.sin(a) * r);
  perch.y = api.terrainHeight(perch.x, perch.z) + 1.2 + Math.random() * 1.4;
  const b = a + (Math.random() - 0.5) * 1.4;
  const from = new THREE.Vector3(cam.x + Math.cos(b) * 50, perch.y + 12 + Math.random() * 8, cam.z + Math.sin(b) * 50);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...U, uMap: { value: textureFor(post.did) }, uFrame: { value: 0 },
      uFlip: { value: 1 }, uSize: { value: 0.55 }, uSel: { value: 0 },
    },
    vertexShader: VS, fragmentShader: FS,
  });
  const mesh = new THREE.Mesh(quad, mat);
  mesh.frustumCulled = false;
  mesh.position.copy(from);
  group.add(mesh);
  birds.push({
    post, mesh, mat, from, perch, to: null, state: 'in', since: t,
    flight: 7 + Math.random() * 4, phase: Math.random() * 10, hopAt: t + 5 + Math.random() * 10,
  });
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

function updateBirds(t, dt) {
  if (!group.parent) scene.add(group);
  if (queue.length && t >= nextLanding) {
    land(queue.shift(), t);
    nextLanding = t + (birds.length < 6 ? 1.5 : 4);
  }
  camera.getWorldDirection(tmp);
  right.set(-tmp.z, 0, tmp.x).normalize();
  for (let i = birds.length - 1; i >= 0; i--) {
    const b = birds[i], m = b.mesh, age = t - b.since;
    let face = null;
    if (b.state === 'in') {
      const k = smooth(age / b.flight);
      m.position.lerpVectors(b.from, b.perch, k);
      m.position.y += Math.sin(k * Math.PI) * 3;
      b.mat.uniforms.uFrame.value = Math.floor(t * 9 + b.phase) % 2;
      face = tmp.subVectors(b.perch, b.from).dot(right);
      if (k >= 1) { b.state = 'perch'; b.since = t; chirp(b); }
    } else if (b.state === 'perch') {
      // Bob, the odd flap, and now and then a little hop.
      m.position.copy(b.perch);
      m.position.y += 0.03 * Math.sin(t * 2.7 + b.phase);
      b.mat.uniforms.uFrame.value = Math.sin(t * 0.9 + b.phase) > 0.97 ? Math.floor(t * 9) % 2 : 2;
      if (t > b.hopAt && b !== selected) {
        b.hopAt = t + 6 + Math.random() * 12;
        const a = Math.random() * TAU;
        b.perch.x += Math.cos(a) * 0.4;
        b.perch.z += Math.sin(a) * 0.4;
        face = Math.cos(a) * right.x + Math.sin(a) * right.z;
      }
      // Stay put while someone is close enough to read.
      const near = wander && m.position.distanceTo(camera.position) < REACH * 2;
      if (age > STAY && !near) flyOff(b, t);
    } else {
      const k = smooth(age / 8);
      m.position.lerpVectors(b.from, b.to, k);
      b.mat.uniforms.uFrame.value = Math.floor(t * 10 + b.phase) % 2;
      face = tmp.subVectors(b.to, b.from).dot(right);
      if (k >= 1) {
        group.remove(m);
        b.mat.dispose();
        birds.splice(i, 1);
        continue;
      }
    }
    // The art faces right; flip it to face the way it's going.
    if (face) b.mat.uniforms.uFlip.value = face < 0 ? -1 : 1;
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
    setWander(false);
    parent.postMessage({ type: 'skytree:open', did, rkey }, PARENT);
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
    const d = tmp.length();
    tmp.y = 0;
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
  if (CHATTER) updateBirds(t, dt);
  if (wander) updateWander(t, dt);
});

// Tell the page we're up (it sends the sound setting, and resumes wander
// mode if the forest was reloaded mid-walk).
parent.postMessage({ type: 'skytree:ready' }, PARENT);

// For testing from the devtools console.
window.skytreeChatter = { birds, queue, status: () => status, setWander, arrive, land: p => land(p, last) };
