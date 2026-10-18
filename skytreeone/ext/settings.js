// Shared by the content script and the popup (kept in chrome.storage.sync).
// eslint-disable-next-line no-unused-vars
const SKYTREE_DEFAULTS = {
  enabled: true,
  sound: false,  // muted by default; sound needs one click on the page to start
  vol: 40,       // 0-100, master
  mins: 15,      // minutes per scene
  px: 240,       // render height in pixels
  fps: 30,       // frame cap
  glass: 70,     // opacity of the panel behind the feed, 0-100
  blur: 6,       // blur behind the feed, px
  chatter: true, // posts from people you follow arrive as birds
  handle: '',    // whose follows; blank = the account signed in to bsky.app
};

// Settings that change the forest page itself (the rest only restyle Bluesky).
// eslint-disable-next-line no-unused-vars
const SKYTREE_RELOAD = ['enabled', 'mins', 'px', 'fps', 'chatter', 'handle'];
