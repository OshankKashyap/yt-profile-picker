# YT Profile Picker

<p align="center">
  <img src="logos/logo.svg" alt="YT Profile Picker logo" width="96" height="96">
</p>

If you're signed into two or three YouTube accounts like me, you know the pain: you paste a link in the address bar, and whether the right account is watching is basically a coin flip. YouTube has no profile screen — you only find out after the video loads, then you poke through the account menu and start over.

So I wrote a small Firefox extension that fixes exactly that. Now when you open YouTube, you get a quick "Who's watching?" style screen — pick the account, the same page reloads under it, done. Nothing more clever than that, and honestly, that's the point.

---

## Why not just use containers?

Firefox Multi-Account Containers genuinely works for this — separate tabs, separate accounts. But it's a lot of ceremony for watching YouTube. You have to keep track of which container holds which account and open every video in the right one. I tried it, kept losing the thread, and went looking for what YouTube actually does under the hood. Turns out Google supports multiple signed-in accounts in one browser session natively — you just have to append `?authuser=N` to switch who's watching. So that's all this extension does: catch your YouTube navigation, ask you who's watching, and rewrite the URL. No containers, no cookie juggling, nothing else installed in your browser.

---

## What it actually does

- When you open `youtube.com` (or YouTube Music, if you want) — from the address bar, a bookmark, or an outside link — and you're signed into more than one Google account, the tab is redirected to a dark picker screen styled like YouTube. Pick one, and the same tab loads YouTube under that account. Nobody else's tab gets spawned.
- One tap or key is enough: number keys `1`–`4` select directly, arrows move, `Enter` confirms, and `Esc` or "Continue without switching" just loads YouTube as-is under your current account. It won't nag you again on that visit.
- In-site clicks never trigger the picker unless you turn that on — so once you're inside YouTube, browsing around behaves like normal.
- Don't like being asked at all? There's a mode where it silently loads your default account, and the toolbar popup becomes your manual one-click switcher for opening YouTube as a specific account in a new tab.
- Your profiles show "Last used" and "Current" badges, so it's obvious which one is which.
- On the first load after install (or any time the account list is empty), the picker sits on "Finding accounts..." for a moment while it quietly checks youtube.com in a hidden tab, then shows what it found. If it can't, it just moves on — you're never stuck staring at it.
- It keeps tabs on your accounts in the background and re-checks on a schedule you pick (10 min to an hour). Don't want anything running behind your back? Turn auto-refresh off entirely in Settings — the list only changes when you tell it to, whether that's the Refresh button on the picker, the toolbar popup, or normal browsing quietly picking up new signed-in accounts itself.
- It never touches private windows — incognito stays incognito.
- Nothing here is attitude: it's a 20-file WebExtension with one job, no analytics, no tracking, no data going anywhere.

## Installing it for yourself

Fair warning: this isn't on addons.mozilla.org as a get-it-in-one-click listing anymore, so this is the "temporary loading" route. Nothing complicated, it just needs a redo whenever Firefox restarts.

**Step 1 — sign into your accounts first.** Open Firefox, go to youtube.com, avatar → **Switch account** → **Add account**, and sign into the second (or third) Google account in the _same Firefox profile_. That's the trick — they need to live in one session, not separate profiles or separate browsers.

**Step 2 — grab this folder.** Whatever's easiest: `git clone` this repo, or just download the ZIP and unpack it somewhere you'll remember.

**Step 3 — load it temporarily.**

1. New tab → `about:debugging#/runtime/this-firefox`
2. Under **Temporary Extensions**, hit **Load Temporary Add-on...**
3. Navigate to the unpacked folder and pick `manifest.json`.
4. That's it — you'll see the YT Profile Picker icon appear in your toolbar.

**Step 4 — try it.** Type `youtube.com` in the address bar. Should get the picker. Pick an account. Video plays under that account. That's the whole magic show.

## Having a rough day with it?

- **Picker says no accounts detected** — you're probably signed out on youtube.com, or you just signed in and the cache hasn't caught up. Visit any YouTube tab, or hit the extension icon and click Refresh Accounts. There's also a debug inspector in Settings ("Inspect Raw JSON") if you want to see exactly what YouTube told the extension, weird as it may be.
- **Google blocks it with a "Sorry, automated queries" page** — that's Google's anti-bot wall, and it'll only bite you if you poke the accounts-list endpoint from somewhere outside a real browser tab. The extension already avoids this by asking from inside the page itself. If Google throws a CAPTCHA at your browser anyway, solve it once on youtube.com and things go back to normal.
- **An account vanished or the wrong one loads** — accounts can shift around if you sign one out. Open the picker and hit Refresh profiles; it re-checks and settles the list.
- **Something still broken** — open DevTools on the YouTube tab and on the picker; the extension logs what it's doing. And you can open an issue on this repo.

## One more thing

This only runs on Firefox (140 or newer) and only intercepts `youtube.com` / `google.com` pages — it can't see or touch anything else you do in the browser. If you read this far, thanks for checking it out. Hope it saves you the account-switching annoyance it used to save me.
