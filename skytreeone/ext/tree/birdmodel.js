// The birds: a low-poly songbird built from code, coloured loosely from a
// profile picture's main colour, posed, and (via kit.js) lit and flattened
// into billboards. Shared by the forest (chatter.js) and lab/bird.html.
import { THREE, reseed, part, prismX, prismDown, material, setLight, bakeCell as bake } from './kit.js';

export { setLight };

// ---------------------------------------------------------------- palette
// Loosely from the picture's colour: the head, back and breast take it (kept
// out of the extremes so every bird still looks like a bird), wings and tail
// go darker, the belly paler, and the beak and legs stay natural.
export function palette(rgb) {
  const base = new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
  const hsl = base.getHSL({});
  const s = Math.min(0.75, Math.max(0.12, hsl.s)), l = Math.min(0.6, Math.max(0.34, hsl.l));
  const c = (h, ss, ll) => new THREE.Color().setHSL(h, Math.min(1, ss), Math.min(1, Math.max(0, ll)));
  return {
    back: c(hsl.h, s, l),
    breast: c(hsl.h, s * 1.05, l + 0.06),
    belly: c(hsl.h, s * 0.35, 0.8),
    wing: c(hsl.h, s * 0.8, l * 0.62),
    flight: c(hsl.h, s * 0.6, l * 0.42),
    wingBar: c(hsl.h, s * 0.35, Math.min(0.72, l + 0.22)),
    tail: c(hsl.h, s * 0.7, l * 0.5),
    eye: new THREE.Color('#141110'),
    beak: new THREE.Color('#3b3328'),
    leg: new THREE.Color('#4a3c32'),
  };
}

// ---------------------------------------------------------------- the bird
// A small songbird about 0.15 m long at 1x (real size; the forest draws it
// larger). Faces +X, Y up, feet at the origin. Pivots: body, head, tail, each
// wing (inner and outer panel), legs.
export function buildBird(rgb) {
  reseed(11);
  const P = palette(rgb);
  const bird = new THREE.Group();
  const body = new THREE.Group();
  body.position.set(0, 0.045, 0);
  bird.add(body);

  // Body: a short teardrop of two prisms, rump to breast.
  part(prismX(-0.05, -0.005, 0.016, 0.034, 6, 0.85), (p, n) => (n.y < -0.4 ? P.belly : n.y > 0.4 ? P.back : P.back.clone().lerp(P.belly, 0.25)), body);
  part(prismX(-0.005, 0.04, 0.034, 0.026, 6, 0.85), (p, n) => (n.y < -0.3 ? P.belly : n.x > 0.2 && n.y < 0.4 ? P.breast : P.back), body);

  // Head, beak, eyes.
  const head = new THREE.Group();
  head.position.set(0.038, 0.022, 0);
  body.add(head);
  part(prismX(-0.012, 0.022, 0.022, 0.018, 6, 0.95), (p, n) => (n.y < -0.4 ? P.breast : P.back), head);
  // Eyes: a small bead on each side.
  for (const side of [1, -1]) {
    part(new THREE.OctahedronGeometry(0.0045), () => P.eye, head, [0.011, 0.006, side * 0.0175]);
  }
  const bk = new THREE.ConeGeometry(0.007, 0.018, 4, 1, false, Math.PI / 4);
  bk.rotateZ(-Math.PI / 2);
  bk.translate(0.03, -0.002, 0);
  part(bk, () => P.beak, head);

  // Tail: a flat fan off the rump.
  const tail = new THREE.Group();
  tail.position.set(-0.048, 0.004, 0);
  body.add(tail);
  const tg = new THREE.CylinderGeometry(0.022, 0.006, 0.06, 4, 1, false, Math.PI / 4);
  tg.rotateZ(Math.PI / 2);
  tg.translate(-0.03, 0, 0);
  tg.scale(1, 0.22, 1);
  part(tg, () => P.tail, tail);

  // Wings: an inner and an outer flat panel each, spanning +Z (left) or -Z
  // (right) from the shoulder. Folding and flapping rotate the groups.
  const wings = {};
  for (const side of [1, -1]) {
    const root = new THREE.Group();
    root.position.set(0.012, 0.016, side * 0.024);
    body.add(root);
    const ig = new THREE.BoxGeometry(0.046, 0.004, 0.05);
    ig.translate(-0.006, 0, side * 0.025);
    part(ig, (p, n) => (Math.abs(p.x) < 0.006 ? P.wingBar : P.wing), root);
    const tip = new THREE.Group();
    tip.position.set(0, 0, side * 0.05);
    root.add(tip);
    const og = new THREE.CylinderGeometry(0.004, 0.024, 0.06, 4, 1, false, Math.PI / 4);
    og.rotateX(side * Math.PI / 2);
    og.translate(-0.008, 0, side * 0.03);
    og.scale(1, 0.18, 1);
    part(og, () => P.flight, tip);
    wings[side > 0 ? 'l' : 'r'] = { root, tip, side };
  }

  // Legs: thin sticks with a toe.
  const legs = [];
  for (const side of [1, -1]) {
    const hip = new THREE.Group();
    hip.position.set(0.004, -0.018, side * 0.01);
    body.add(hip);
    part(prismDown(0.03, 0.003, 0.0025, 4), () => P.leg, hip);
    const toe = new THREE.BoxGeometry(0.016, 0.003, 0.004);
    toe.translate(0.005, -0.03, 0);
    part(toe, () => P.leg, hip);
    legs.push(hip);
  }

  return { bird, body, head, tail, wings, legs };
}

// ---------------------------------------------------------------- poses
function fold(r) {
  // Wings swept back along the body's sides, the outer panel tucked under.
  for (const w of Object.values(r.wings)) {
    w.root.rotation.set(0, -w.side * 1.45, 0);
    w.root.rotation.order = 'YXZ';
    w.root.rotation.x = -w.side * 0.12;
    w.tip.rotation.set(0, -w.side * 0.25, 0);
  }
}
function spread(r, up, tipUp) {
  // Wings out to the sides; up > 0 raises them.
  for (const w of Object.values(r.wings)) {
    w.root.rotation.order = 'XYZ';
    w.root.rotation.set(-w.side * up, -w.side * 0.15, 0);
    w.tip.rotation.set(-w.side * tipUp, -w.side * 0.12, 0);
  }
}
function base(r) {
  r.bird.position.set(0, 0, 0);
  r.body.position.set(0, 0.045, 0);
  r.body.rotation.set(0, 0, 0);
  r.head.rotation.set(0, 0, 0);
  r.tail.rotation.set(0, 0, 0);
  for (const l of r.legs) { l.visible = true; l.rotation.set(0, 0, 0); }
}

export const POSES = {
  // Perched: body tilted up ~25°, tail down, wings folded.
  perch(r) {
    base(r); fold(r);
    r.body.rotation.z = 0.45;
    r.head.rotation.z = -0.4;
    r.tail.rotation.z = 0.25;
    for (const l of r.legs) l.rotation.z = -0.45;
  },
  // Looking round, tail flicked up.
  look(r) {
    POSES.perch(r);
    r.head.rotation.order = 'YZX';
    r.head.rotation.y = 0.9;
    r.tail.rotation.z = -0.25;
  },
  // Crouched for a hop, wings just lifting.
  hop(r) {
    POSES.perch(r);
    r.body.position.y = 0.036;
    r.body.rotation.z = 0.2;
    r.head.rotation.z = -0.15;
    for (const w of Object.values(r.wings)) w.root.rotation.x = -w.side * 0.45;
    for (const l of r.legs) l.rotation.z = -0.9;
  },
  // Flight: level body, legs tucked, tail spread a little.
  up(r) {
    base(r); spread(r, 0.95, 0.35);
    r.body.position.y = 0.05;
    r.body.rotation.z = 0.12;
    r.head.rotation.z = -0.12;
    for (const l of r.legs) l.visible = false;
  },
  down(r) {
    base(r); spread(r, -0.55, -0.35);
    r.body.position.y = 0.05;
    r.body.rotation.z = 0.05;
    r.head.rotation.z = -0.05;
    for (const l of r.legs) l.visible = false;
  },
  glide(r) {
    base(r); spread(r, 0.08, 0.12);
    r.body.position.y = 0.05;
    for (const l of r.legs) l.visible = false;
  },
};

// Size from follower count: 1x up to ~300 followers, 2x at a million, on a
// log scale between ("younger/older", never more than 2x).
export function sizeFor(followers) {
  const t = (Math.log10(Math.max(1, followers)) - 2.5) / 3.5;
  return 1 + Math.min(1, Math.max(0, t));
}

// ---------------------------------------------------------------- bake
export const CELL_W = 64, CELL_H = 48;
// Spans at 2x so every size fits the same frame; cy is the body height.
export function bakeCell(renderer, scene, angle, w = CELL_W, h = CELL_H, span = 0.42) {
  material.uniforms.uGrain.value = 4; // feathers: finer streaks than fur
  return bake(renderer, scene, angle, { w, h, span, cy: 0.06, el: 0.25 });
}
