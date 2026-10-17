// Runs inside the forest page. The Bluesky tab forwards the user's first click
// (the forest itself is click-through) so sound can start, and pauses it while
// the tab is hidden.
addEventListener('message', e => {
  if (e.source !== parent) return;
  const amb = window.treeps1?.ambience;
  if (!amb?.ctx) return;
  if (e.data === 'skytree:resume') amb.resume();
  else if (e.data === 'skytree:suspend') amb.ctx.suspend();
});
