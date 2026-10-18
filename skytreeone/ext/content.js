// Puts the forest behind bsky.app.
//  - a fixed, click-through iframe (the extension's tree/ page in saver mode)
//    sits under everything
//  - Bluesky paints its page colour inline on many nested panels; a
//    stylesheet rule makes every panel with that inline colour transparent
//  - one translucent, blurred panel sits behind the feed column so posts stay
//    readable over the trees
//  - wander mode (Alt+Shift+W, or the popup) fades Bluesky out and hands the
//    keyboard and mouse to the forest; birds there are posts from the people
//    you follow, and opening one comes back here to its thread
(() => {
  if (window.__skytree) return;
  window.__skytree = true;

  // Outside the extension (window.SKYTREE_TEST_BASE set) it runs with defaults.
  const ext = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome : null;
  const BASE = ext ? ext.runtime.getURL('tree/index.html') : window.SKYTREE_TEST_BASE;
  const ORIGIN = new URL(BASE).origin;

  let cfg = { ...SKYTREE_DEFAULTS };
  let frame = null, veil = null, glass = null, observer = null, timer = 0, accountTimer = 0;
  let themeBg = '', audioWanted = false, wandering = false;
  const html = document.documentElement;

  // --- forest iframe ---------------------------------------------------------
  function treeUrl() {
    const who = me();
    const q = new URLSearchParams({
      saver: '', audio: cfg.sound ? 1 : 0, vol: cfg.vol, mins: cfg.mins,
      px: cfg.px, fps: cfg.fps, realsun: 1, weather: 0,
      chatter: cfg.chatter && who ? 1 : 0, me: cfg.chatter ? who : '', parent: location.origin,
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

  // --- who's signed in -------------------------------------------------------
  // Whose follows become birds: the handle typed in the popup, else the
  // signed-in account. Bluesky keeps its session in localStorage; only the
  // account's DID is taken from it, and nothing is stored or sent elsewhere.
  function signedInDid() {
    try {
      return JSON.parse(localStorage.getItem('BSKY_STORAGE'))?.session?.currentAccount?.did || '';
    } catch {
      return '';
    }
  }
  function me() {
    return (cfg.handle || '').trim().replace(/^@/, '') || signedInDid();
  }

  // --- wander ----------------------------------------------------------------
  function setWander(on) {
    if (!frame || on === wandering) return;
    wandering = on;
    html.classList.toggle('skytree-wander', on);
    frame.tabIndex = on ? 0 : -1;
    frame.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (on) {
      frame.focus();
      post('skytree:wander');
    } else {
      post('skytree:calm');
      frame.blur();
      window.focus();
    }
  }

  function onKey(e) {
    if (e.altKey && e.shiftKey && e.code === 'KeyW') {
      e.preventDefault();
      e.stopPropagation();
      setWander(!wandering);
    }
  }

  function onFrameMessage(e) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== ORIGIN) return;
    const m = e.data;
    if (m?.type === 'skytree:leave') setWander(false);
    else if (m?.type === 'skytree:open' && /^did:[a-z]+:[\w.:%-]+$/.test(m.did) && /^[\w.~:-]+$/.test(m.rkey)) {
      setWander(false);
      openThread(m.did, m.rkey);
    }
  }

  // Bluesky's router follows history changes, so a pushState plus a popstate
  // opens the thread without reloading the page (or the forest).
  function openThread(did, rkey) {
    history.pushState(null, '', `/profile/${did}/post/${rkey}`);
    dispatchEvent(new PopStateEvent('popstate', { state: null }));
  }

  // Signing in or out changes whose follows to listen to.
  function checkAccount() {
    if (frame && frame.src !== treeUrl()) mountFrame();
  }

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
  // A stylesheet rule with !important beats Bluesky's inline colours, and it
  // applies before the browser paints, so panels that Bluesky re-renders (on
  // scroll, hover, navigation) never flash opaque. The rule is rewritten when
  // the theme changes.
  const rootPanel = () => document.querySelector('#root [style*="min-height: 100dvh"]');
  let pageBg = '', rules = null;
  const screens = new Set();
  let checked = new WeakSet();  // elements already measured, so each is measured once

  // The page colour: Bluesky's full-height outer panel. Before that panel
  // exists, the page's own background.
  function readTheme() {
    return rootPanel()?.style.backgroundColor || pageBg;
  }

  function writeRules() {
    if (!rules) {
      rules = document.createElement('style');
      rules.id = 'skytree-rules';
      document.head.append(rules);
    }
    const sel = [];
    if (themeBg) sel.push(`html.skytree-on #root [style*="background-color: ${themeBg};"]`);
    for (const st of screens) sel.push(`html.skytree-on main [style="${CSS.escape(st)}"]`);
    rules.textContent = sel.length ? `${sel.join(',\n')} { background-color: transparent !important; }` : '';
  }

  // Navigation screens paint their own backdrop in a colour close to the page
  // colour (rgb(1, 1, 1) on the dim theme): an absolute panel inside <main>
  // that fills its parent. Its exact inline style becomes a rule too, so later
  // screens are clear from their first frame. Fixed overlays (the image
  // viewer) are left alone.
  function isScreen(el) {
    if (!near(el.style.backgroundColor, themeBg)) return false;
    // Hover highlights are absolute too, but click-through.
    const cs = getComputedStyle(el);
    if (cs.position !== 'absolute' || cs.pointerEvents === 'none') return false;
    const r = el.getBoundingClientRect(), p = el.parentElement?.getBoundingClientRect();
    return !!p && r.width >= p.width * 0.95 && r.height >= p.height * 0.95;
  }

  function near(a, b) {
    const x = a.match(/[\d.]+/g), y = b.match(/[\d.]+/g);
    return !!x && !!y && x.length === 3 && [0, 1, 2].every(i => Math.abs(x[i] - y[i]) <= 40);
  }

  function sweep() {
    const t = readTheme();
    let dirty = false;
    if (t && t !== themeBg) { themeBg = t; screens.clear(); checked = new WeakSet(); dirty = true; paintGlass(); }
    if (!themeBg) return;
    for (const el of document.querySelectorAll('#root [style*="background-color"]')) {
      if (checked.has(el)) continue;
      checked.add(el);
      if (el.style.backgroundColor === themeBg) {
        // Sticky and fixed bars (tab bar, bottom bar) keep a frosted backdrop
        // so posts scrolling under them don't show through.
        const pos = getComputedStyle(el).position;
        if (pos === 'sticky' || pos === 'fixed') el.setAttribute('data-skytree-bar', '');
        continue;
      }
      const st = el.getAttribute('style');
      if (screens.has(st) || !el.closest('main') || !isScreen(el)) continue;
      screens.add(st);
      dirty = true;
    }
    if (dirty || !rules) writeRules();
  }

  // New screens and theme changes are rare, so a check per frame at most.
  let queued = false;
  function onMutations() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; sweep(); });
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
    html.style.setProperty('--skytree-bg', bg);
    html.style.setProperty('--skytree-bar', rgba(bg, Math.max(0.85, cfg.glass / 100)));
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
      accountTimer = setInterval(checkAccount, 5000);
      addEventListener('keydown', onKey, true);
      addEventListener('message', onFrameMessage);
      addEventListener('resize', placeGlass);
      addEventListener('pointerdown', onGesture, true);
      addEventListener('keydown', onGesture, true);
      document.addEventListener('visibilitychange', onVisibility);
    }
  }

  function stop() {
    setWander(false);
    observer?.disconnect(); observer = null;
    clearInterval(timer);
    clearInterval(accountTimer);
    removeEventListener('keydown', onKey, true);
    removeEventListener('message', onFrameMessage);
    removeEventListener('resize', placeGlass);
    removeEventListener('pointerdown', onGesture, true);
    removeEventListener('keydown', onGesture, true);
    document.removeEventListener('visibilitychange', onVisibility);
    frame?.remove(); veil?.remove(); glass?.remove(); frame = veil = glass = null;
    rules?.remove(); rules = null; screens.clear(); checked = new WeakSet();
    document.querySelectorAll('[data-skytree-bar]').forEach(el => el.removeAttribute('data-skytree-bar'));
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
    // The popup's Wander button.
    ext.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg !== 'skytree:wander') return;
      setWander(cfg.enabled);
      reply(cfg.enabled);
    });
    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const k in changes) cfg[k] = changes[k].newValue;
      apply(Object.keys(changes));
    });
  } else {
    Object.assign(cfg, window.SKYTREE_TEST_CFG || {});
    apply();
    window.__skytreeTest = { stop, setWander, openThread, apply: c => { Object.assign(cfg, c); apply(Object.keys(c)); } };
  }
})();
