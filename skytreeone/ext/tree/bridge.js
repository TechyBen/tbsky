// Runs inside the forest page, taking messages from the Bluesky tab:
//  - {type: 'skytree:sound', on, vol}: switch the ambience on or off, or
//    change its volume, live (no reload, so wander mode and the birds stay)
//  - 'skytree:resume' / 'skytree:suspend': browsers only start audio after a
//    user gesture, and the forest is click-through, so the tab forwards the
//    user's click; it also pauses the sound while the tab is hidden
import { Ambience } from './src/ambience.js';

addEventListener('message', e => {
  if (e.source !== parent) return;
  const api = window.treeps1;
  if (!api) return;
  const m = e.data;
  if (m?.type === 'skytree:sound') {
    if (m.on && !api.ambience) {
      const amb = new Ambience({ master: m.vol / 100, wind: 0.35, birds: 0.6 });
      amb.start();
      api.ambience = amb;
    } else if (!m.on && api.ambience) {
      api.ambience.stop();
      api.ambience = null;
    } else if (api.ambience) {
      api.ambience.setVolumes({ master: m.vol / 100 });
    }
    return;
  }
  const amb = api.ambience;
  if (!amb?.ctx) return;
  if (m === 'skytree:resume') amb.resume();
  else if (m === 'skytree:suspend') amb.ctx.suspend();
});
