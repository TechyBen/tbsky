const UNITS = { vol: '%', glass: '%', blur: ' px', mins: ' min', px: ' px', fps: ' fps' };

chrome.storage.sync.get(SKYTREE_DEFAULTS).then(cfg => {
  for (const key of Object.keys(SKYTREE_DEFAULTS)) {
    const el = document.getElementById(key);
    if (!el) continue;
    const out = document.querySelector(`output[for="${key}"]`);
    const show = () => { if (out) out.textContent = el.value + (UNITS[key] || ''); };
    if (el.type === 'checkbox') {
      el.checked = cfg[key];
      el.addEventListener('change', () => chrome.storage.sync.set({ [key]: el.checked }));
    } else {
      el.value = cfg[key];
      show();
      el.addEventListener('input', show);
      // Sliders that reload the forest save on release; the rest save live.
      const ev = SKYTREE_RELOAD.includes(key) ? 'change' : 'input';
      el.addEventListener(ev, () => chrome.storage.sync.set({ [key]: +el.value }));
    }
  }
});
