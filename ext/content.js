// Puts the forest behind bsky.app.
//  - a fixed, click-through iframe (the extension's tree/ page in saver mode)
//    sits under everything
//  - Bluesky paints its page colour inline on many nested panels; every panel
//    whose inline colour equals the page colour is made transparent
//  - one translucent, blurred panel sits behind the feed column so posts stay
//    readable over the trees
(() => {
  if (window.__skytree) return;
  window.__skytree = true;

  // Outside the extension (window.SKYTREE_TEST_BASE set) it runs with defaults.
  const ext = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome : null;
  const BASE = ext ? ext.runtime.getURL('tree/index.html') : window.SKYTREE_TEST_BASE;
  const ORIGIN = new URL(BASE).origin;

  let cfg = { ...SKYTREE_DEFAULTS };
  let frame = null, veil = null, glass = null, observer = null, timer = 0;
  let themeBg = '', audioWanted = false;
  const html = document.documentElement;

  // --- forest iframe ---------------------------------------------------------
  function treeUrl() {
    const q = new URLSearchParams({
      saver: '', audio: cfg.sound ? 1 : 0, vol: cfg.vol, mins: cfg.mins,
      px: cfg.px, fps: cfg.fps, realsun: 1, weather: 0,
    });
    return `${BASE}?${q.toString().replace('saver=', 'saver')}`;
  }

  function mountFrame() {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'skytree-frame';
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      // Lets the forest play sound once the user has clicked on Bluesky.
      frame.allow = 'autoplay';
      veil = document.createElement('div');
      veil.id = 'skytree-veil';
      glass = document.createElement('div');
      glass.id = 'skytree-glass';
      document.body.prepend(frame, veil, glass);
    }
    const url = treeUrl();
    if (frame.src !== url) frame.src = url;
  }

  function post(msg) { frame?.contentWindow?.postMessage(msg, ORIGIN); }

  // Browsers only start audio after a user gesture; the iframe never gets one
  // (it's click-through), so forward the first click or key on Bluesky.
  function onGesture() {
    if (!cfg.sound) return;
    audioWanted = true;
    post('skytree:resume');
  }
  function onVisibility() {
    if (!cfg.sound || !audioWanted) return;
    post(document.hidden ? 'skytree:suspend' : 'skytree:resume');
  }

  // --- see-through Bluesky ---------------------------------------------------
  const rootPanel = () => document.querySelector('#root [style*="min-height: 100dvh"]');
  let pageBg = '';

  // The page colour: Bluesky's full-height outer panel, as Bluesky set it (not
  // as we did). Before that panel exists, the page's own background.
  function readTheme() {
    const el = rootPanel();
    if (!el) return pageBg;
    const s = el.style;
    return s.getPropertyPriority('background-color') === 'important'
      ? el.dataset.skytreeBg || '' : s.backgroundColor;
  }

  function fix(el) {
    const s = el.style;
    if (!s.backgroundColor) return;
    if (s.getPropertyPriority('background-color') === 'important') {
      // Ours. If the theme changed under it, put Bluesky's colour back.
      if (el.dataset.skytreeBg && el.dataset.skytreeBg !== themeBg) unfix(el);
      return;
    }
    if (s.backgroundColor !== themeBg && !isScreen(el)) return;
    el.dataset.skytreeBg = s.backgroundColor;
    s.setProperty('background-color', 'transparent', 'important');
  }

  // Navigation screens paint their own backdrop in a colour close to the page
  // colour (rgb(1, 1, 1) on the dim theme): an absolute panel inside <main>
  // that fills its parent. Fixed overlays (image lightbox) are left alone.
  function isScreen(el) {
    if (!el.closest('main') || !near(el.style.backgroundColor, themeBg)) return false;
    if (getComputedStyle(el).position !== 'absolute') return false;
    const r = el.getBoundingClientRect(), p = el.parentElement?.getBoundingClientRect();
    return !!p && r.width >= p.width * 0.95 && r.height >= p.height * 0.95;
  }

  function near(a, b) {
    const x = a.match(/[\d.]+/g), y = b.match(/[\d.]+/g);
    return !!x && !!y && x.length === 3 && [0, 1, 2].every(i => Math.abs(x[i] - y[i]) <= 40);
  }

  function unfix(el) {
    el.style.setProperty('background-color', el.dataset.skytreeBg);
    delete el.dataset.skytreeBg;
  }

  function sweep(root = document) {
    const t = readTheme();
    if (t && t !== themeBg) { themeBg = t; paintGlass(); }
    if (!themeBg) return;
    if (root.nodeType === 1 && root.hasAttribute('style')) fix(root);
    root.querySelectorAll('[style*="background-color"]').forEach(fix);
  }

  let pending = new Set(), queued = false;
  function onMutations(list) {
    for (const m of list) {
      if (m.type === 'attributes') pending.add(m.target);
      else m.addedNodes.forEach(n => n.nodeType === 1 && pending.add(n));
    }
    if (!queued) {
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const batch = pending; pending = new Set();
        if (batch.size > 400) sweep();
        else batch.forEach(n => n.isConnected && sweep(n));
      });
    }
  }

  // --- glass behind the feed -------------------------------------------------
  function rgba(rgb, a) {
    const m = rgb.match(/[\d.]+/g);
    return m ? `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${a})` : `rgba(0, 0, 0, ${a})`;
  }

  // Light themes have dark text, so the forest behind them is washed out a lot
  // more than behind the dim and dark themes.
  function luma(rgb) {
    const m = rgb.match(/[\d.]+/g);
    return m ? (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 : 0;
  }

  function paintGlass() {
    if (!glass) return;
    const bg = themeBg || 'rgb(0,0,0)';
    veil.style.background = rgba(bg, luma(bg) > 0.5 ? 0.45 : 0.12);
    glass.style.background = rgba(bg, cfg.glass / 100);
    glass.style.backdropFilter = cfg.blur ? `blur(${cfg.blur}px)` : 'none';
    html.style.setProperty('--skytree-bg', themeBg || 'rgb(0,0,0)');
  }

  // The feed column: the tallest panel with Bluesky's 600px max width.
  function placeGlass() {
    if (!glass) return;
    let best = null, bh = 0;
    for (const el of document.querySelectorAll('[style*="max-width: 600px"]')) {
      const h = el.offsetHeight;
      if (h > bh) { bh = h; best = el; }
    }
    const r = best?.getBoundingClientRect();
    const w = r ? r.width : Math.min(600, html.clientWidth);
    const l = r ? r.left : (html.clientWidth - w) / 2;
    glass.style.left = `${l}px`;
    glass.style.width = `${w}px`;
  }

  // --- on / off --------------------------------------------------------------
  function start() {
    if (!html.classList.contains('skytree-on')) pageBg = getComputedStyle(document.body).backgroundColor;
    html.classList.add('skytree-on');
    mountFrame();
    sweep();
    paintGlass();
    placeGlass();
    if (!observer) {
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
      timer = setInterval(placeGlass, 500);
      addEventListener('resize', placeGlass);
      addEventListener('pointerdown', onGesture, true);
      addEventListener('keydown', onGesture, true);
      document.addEventListener('visibilitychange', onVisibility);
    }
  }

  function stop() {
    observer?.disconnect(); observer = null;
    clearInterval(timer);
    removeEventListener('resize', placeGlass);
    removeEventListener('pointerdown', onGesture, true);
    removeEventListener('keydown', onGesture, true);
    document.removeEventListener('visibilitychange', onVisibility);
    frame?.remove(); veil?.remove(); glass?.remove(); frame = veil = glass = null;
    document.querySelectorAll('[data-skytree-bg]').forEach(unfix);
    html.classList.remove('skytree-on');
    themeBg = ''; audioWanted = false;
  }

  function apply(changed) {
    if (!cfg.enabled) return stop();
    if (!changed || changed.some(k => SKYTREE_RELOAD.includes(k))) {
      if (changed?.includes('sound')) audioWanted = false;
      start();
    }
    paintGlass();
  }

  if (ext) {
    ext.storage.sync.get(SKYTREE_DEFAULTS).then(c => { cfg = c; apply(); });
    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const k in changes) cfg[k] = changes[k].newValue;
      apply(Object.keys(changes));
    });
  } else {
    Object.assign(cfg, window.SKYTREE_TEST_CFG || {});
    apply();
    window.__skytreeTest = { stop, apply: c => { Object.assign(cfg, c); apply(Object.keys(c)); } };
  }
})();
