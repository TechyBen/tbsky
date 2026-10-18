// Puts the forest behind bsky.app.
//  - a fixed, click-through iframe (the extension's tree/ page in saver mode)
//    sits under everything
//  - Bluesky paints its page colour inline on many nested panels; a
//    stylesheet rule makes every panel with that inline colour transparent
//  - one translucent, blurred panel sits behind the feed column so posts stay
//    readable over the trees
//  - wander mode (the tree button, or the popup) fades Bluesky out and hands the
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
  let frame = null, veil = null, glass = null, button = null, observer = null, timer = 0, accountTimer = 0;
  let themeBg = '', audioWanted = false, wandering = false;
  let readyTimer = 0, retryTimer = 0, retried = false;
  const html = document.documentElement;

  // --- forest iframe ---------------------------------------------------------
  function treeUrl() {
    const who = me();
    const q = new URLSearchParams({
      // Sound starts off; it's switched live by message (see sendSound).
      saver: '', audio: 0, mins: cfg.mins,
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
      button = makeButton();
      document.body.append(button);
    }
    const url = treeUrl();
    if (frame.src !== url) load(url);
  }

  // The forest stays hidden (Bluesky's own colour shows) until it reports
  // ready, then fades in slowly once its own fade from black is done, so
  // there's never a white or bright flash. If it hasn't reported in after
  // 20 s, it's loaded once more.
  function load(url) {
    html.classList.remove('skytree-ready');
    clearTimeout(readyTimer);
    clearTimeout(retryTimer);
    frame.src = url;
    retryTimer = setTimeout(() => {
      if (frame && !retried) { retried = true; load(frame.src); }
    }, 20000);
  }
  function onReady() {
    clearTimeout(retryTimer);
    retried = false;
    readyTimer = setTimeout(() => html.classList.add('skytree-ready'), 3000);
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
  // A pixel fir, drawn as rects: [x, y, width] per row of a 12x12 grid.
  const FIR = [[5, 0, 2], [4, 1, 4], [3, 2, 6], [4, 3, 4], [2, 4, 8], [1, 5, 10], [3, 6, 6], [1, 7, 10], [0, 8, 12]];
  function makeButton() {
    const b = document.createElement('button');
    b.id = 'skytree-wander-btn';
    b.type = 'button';
    const rows = FIR.map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="1"/>`).join('');
    b.innerHTML = `<svg viewBox="0 0 12 11" width="22" height="20" aria-hidden="true" shape-rendering="crispEdges">` +
      `<g fill="#5aa86e">${rows}</g><rect x="5" y="9" width="2" height="2" fill="#7a5638"/></svg>`;
    b.addEventListener('click', () => setWander(!wandering));
    labelButton(b);
    return b;
  }
  function labelButton(b = button) {
    if (!b) return;
    const label = wandering ? 'Back to the feed (Esc)' : 'Wander in the forest';
    b.title = label;
    b.setAttribute('aria-label', label);
  }

  // Bottom right, lifted above Bluesky's bottom bar and compose button.
  function placeButton() {
    if (!button) return;
    let lift = 0;
    if (!wandering) {
      const h = innerHeight;
      for (const el of document.querySelectorAll('[data-skytree-bar], [data-testid="composeFAB"]')) {
        const r = el.getBoundingClientRect();
        if (r.height && r.top > h / 2 && r.bottom >= h - 40) lift = Math.max(lift, h - r.top);
      }
    }
    button.style.bottom = `${16 + lift}px`;
  }

  function setWander(on) {
    if (!frame || on === wandering) return;
    wandering = on;
    labelButton();
    placeButton();
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

  // Esc in the forest is handled there; this catches it if focus is back on
  // the page (after clicking the button or using the popup, say). Any other
  // key while wandering hands focus back to the forest so walking carries on.
  function onKey(e) {
    if (!wandering) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      setWander(false);
    } else {
      frame.focus();
    }
  }
  function onPageFocus() {
    if (wandering) frame.focus();
  }

  function onFrameMessage(e) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== ORIGIN) return;
    const m = e.data;
    // The forest (re)loaded: give it the sound setting, and carry on wandering
    // if we were, so a reload can't leave the page faded out with no walking.
    if (m?.type === 'skytree:ready') {
      onReady();
      sendSound();
      if (wandering) { frame.focus(); post('skytree:wander'); }
    } else if (m?.type === 'skytree:leave') setWander(false);
    else if (m?.type === 'skytree:open' && /^did:[a-z]+:[\w.:%-]+$/.test(m.did) && /^[\w.~:-]+$/.test(m.rkey)) {
      setWander(false);
      openThread(m.did, m.rkey, typeof m.handle === 'string' ? m.handle : '');
    }
  }

  // Opening a bird's post. Bluesky's router follows history changes, so a
  // pushState plus a popstate opens the thread without reloading the page (or
  // the forest). Bluesky stays hidden while the thread loads; once the post
  // itself is on the page, the page fades in showing it, and the replies below
  // fade in one by one as they scroll into view.
  let thread = null;
  function openThread(did, rkey, handle) {
    endThread();
    const path = `/profile/${did}/post/${rkey}`;
    html.classList.add('skytree-opening');
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate', { state: null }));
    const t0 = Date.now();
    thread = { path, timer: 0, io: null, mo: null };
    thread.timer = setInterval(() => {
      const anchor = findAnchor(handle);
      if (anchor || Date.now() - t0 > 6000) {
        clearInterval(thread.timer);
        reveal(anchor);
      }
    }, 100);
  }

  // The post itself: the thread item with the expanded counts (only the
  // focused post has them), else the first item by its author.
  function findAnchor(handle) {
    const items = [...document.querySelectorAll('[data-testid^="postThreadItem-by-"]')];
    return items.find(e => e.querySelector('[data-testid$="-expanded"]')) ||
      items.find(e => e.dataset.testid === `postThreadItem-by-${handle}`) || null;
  }

  function reveal(anchor) {
    if (anchor) {
      // Replies (items after the post) wait, then fade in as they scroll in.
      const io = new IntersectionObserver(entries => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.setAttribute('data-skytree-seen', '');
          io.unobserve(e.target);
        }
      }, { threshold: 0.05 });
      const mark = el => {
        if (el.hasAttribute('data-skytree-reply') || !(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
        el.setAttribute('data-skytree-reply', '');
        io.observe(el);
      };
      document.querySelectorAll('[data-testid^="postThreadItem-by-"]').forEach(mark);
      // More replies load as you scroll.
      const mo = new MutationObserver(() => document.querySelectorAll('[data-testid^="postThreadItem-by-"]:not([data-skytree-reply])').forEach(mark));
      mo.observe(document.body, { childList: true, subtree: true });
      thread.io = io;
      thread.mo = mo;
    }
    requestAnimationFrame(() => html.classList.remove('skytree-opening'));
  }

  function endThread() {
    if (!thread) return;
    clearInterval(thread.timer);
    thread.io?.disconnect();
    thread.mo?.disconnect();
    document.querySelectorAll('[data-skytree-reply]').forEach(el => {
      el.removeAttribute('data-skytree-reply');
      el.removeAttribute('data-skytree-seen');
    });
    html.classList.remove('skytree-opening');
    thread = null;
  }

  // Leaving the thread (back, another link) ends the reply fading.
  function checkThread() {
    if (thread && location.pathname !== thread.path) endThread();
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
  function sendSound() {
    post({ type: 'skytree:sound', on: cfg.sound, vol: cfg.vol });
    if (cfg.sound && audioWanted) post('skytree:resume');
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
    placeButton();
    checkThread();
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
      addEventListener('focus', onPageFocus);
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
    removeEventListener('focus', onPageFocus);
    removeEventListener('message', onFrameMessage);
    removeEventListener('resize', placeGlass);
    removeEventListener('pointerdown', onGesture, true);
    removeEventListener('keydown', onGesture, true);
    document.removeEventListener('visibilitychange', onVisibility);
    frame?.remove(); veil?.remove(); glass?.remove(); button?.remove();
    frame = veil = glass = button = null;
    rules?.remove(); rules = null; screens.clear(); checked = new WeakSet();
    document.querySelectorAll('[data-skytree-bar]').forEach(el => el.removeAttribute('data-skytree-bar'));
    clearTimeout(readyTimer);
    clearTimeout(retryTimer);
    endThread();
    html.classList.remove('skytree-on', 'skytree-ready');
    themeBg = ''; audioWanted = false;
  }

  function apply(changed) {
    if (!cfg.enabled) return stop();
    if (!changed || changed.some(k => SKYTREE_RELOAD.includes(k))) start();
    // Sound and volume change live, without reloading the forest.
    if (changed?.includes('sound') || changed?.includes('vol')) {
      if (changed.includes('sound')) audioWanted = false;
      sendSound();
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
