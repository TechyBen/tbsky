# skytreeone privacy

skytreeone has no servers of its own and no analytics. It never logs in as you and can't post, like, follow or change anything on your account.

## What it reads

- **Who you are signed in as.** To find whose follows to listen to, it reads the account ID (your DID, a public identifier like `did:plc:…`) of the account signed in to bsky.app, from the page's own storage. Nothing else from that storage is kept or sent. You can type a handle in the popup instead, or switch the birds off.
- **Who you follow.** Your follow list is fetched from Bluesky's public API (`public.api.bsky.app`), the same public data anyone can see on your profile. It's cached in the extension for six hours.
- **What the birds look like.** Each account's bird is coloured loosely from its profile picture and sized by its follower count. For that, the extension loads the small public profile picture from Bluesky's image server (`cdn.bsky.app`, which is why the extension asks to read data there) and the public follower count from Bluesky's API. Only a single colour is kept, in memory.
- **New posts from those people.** It listens to Jetstream (`jetstream*.bsky.network`), Bluesky's public live stream of posts, filtered to the accounts you follow. Sending that list of accounts to Jetstream is how the filtering works. Only top-level posts are shown, as birds in the forest; they're held in memory and gone when you close the tab.

Those Bluesky services see your IP address and which accounts' pictures and posts are fetched, as any Bluesky app would. Nothing goes anywhere else.

## What it doesn't do

- No tracking, no analytics, no ads, no data sold or shared.
- It doesn't read your posts, messages, notifications or feed.
- It only runs on `bsky.app`. Apart from the birds, it only changes how the page's backgrounds look.

## Settings and location

- Your settings (sound, volume, scene length, an optional handle and so on) are kept in your browser's extension storage (`chrome.storage.sync`), which your browser may sync between your own devices if you're signed in to it.
- The sun, moon and stars use an approximate location estimated on your device from its time zone. It never leaves your device.

Questions: open an issue at https://github.com/TechyBen/tbsky/issues.
