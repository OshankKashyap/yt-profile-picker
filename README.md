# YT Profile Picker

A lightweight Firefox WebExtension (Manifest V2) that provides a Netflix-style profile picker when navigating to YouTube or YouTube Music. It lets you choose which signed-in Google account should watch, then seamlessly loads the page under that account via URL rewriting (`authuser=N`). Zero containers, zero cookie swapping, instant UX.

---

## Features

- **Netflix-Style Profile UX**: Dark theme matching YouTube (`#0f0f0f` background, `#181818` card, `#ff0000` red accent).
- **Same-Tab Flow**: Replaces the YouTube request in the same tab—never spawns unwanted tabs.
- **Fast & Responsive**: Cached accounts resolve synchronously in <1ms; perceived UI latency <50ms.
- **Keyboard First**: Direct selection with number keys (`1`–`4`), arrow navigation (`↑`/`↓`/`←`/`→`), `Enter` to confirm, and `Esc` to cancel and proceed untouched.
- **Defensive InnerTube Resolution**: Queries YouTube's native `POST /youtubei/v1/account/accounts_list` endpoint with fallback to `SAPISIDHASH` authorization and defensive JSON tree-walking.
- **Badges**: Shows "Last used" and "Current" badges on your profiles.
- **Toolbar Quick-Switcher**: Popup allows one-click opening of YouTube under any account in a new tab.
- **Configurable Modes**:
  1. _Ask when I open YouTube_ (Default): Prompts only for top-level visits (address bar, bookmarks, external links). In-site clicks never prompt.
  2. _Always use default account_: Never prompts. YouTube loads directly; use popup for manual switching.
  3. _Ask every time_: Prompts on in-site navigations too (for power users).
- **YouTube Music Toggle**: Enable or disable profile prompting on `music.youtube.com`.
- **Diagnostics**: Built-in debug inspector in Settings to view the raw InnerTube response.

---

## How It Works

1. **Google Multi-Login**: Google stores multiple authenticated accounts in a single browser cookie jar.
2. **Account Switching**: Account switching on YouTube is done by appending the `authuser=N` query parameter (where `N` is the account's index: 0, 1, 2...).
3. **Interception**: A blocking `webRequest.onBeforeRequest` listener intercepts `main_frame` navigations to `*.youtube.com`. If 2 or more accounts are signed in, it redirects the tab to the extension picker page (`picker/picker.html?target=<target>`).
4. **Resolution**: On account selection, the tab is redirected to `target?authuser=N`. On cancel (`Esc`), the target URL is loaded untouched without re-prompting.

---

## Setup & Installation

### 1. Prerequisites: Sign Into Multiple Accounts

1. Open Firefox.
2. Go to [youtube.com](https://www.youtube.com).
3. Click your profile avatar in the top-right corner and select **Switch account** -> **Add account**.
4. Sign into at least two Google accounts in this same Firefox profile.

### 2. Load Extension via `about:debugging`

1. Open a new tab in Firefox and navigate to:
   ```text
   about:debugging#/runtime/this-firefox
   ```
2. In the **Temporary Extensions** section, click **Load Temporary Add-on...**.
3. File picker will open. Navigate to the project directory:
   ```text
   /home/oshank/Projects/yt-profile-picker
   ```
4. Select `manifest.json`.
5. The extension **YT Profile Picker** will appear in your list of loaded temporary extensions with its toolbar icon.

---

## Verification & Test Checklist

- [ ] **Initial Visit Prompt**: Type `youtube.com` into the address bar and press Enter. The "Who's watching?" profile picker appears in the same tab showing your accounts.
- [ ] **Keyboard Selection (1–4)**: Press `1` or `2` on your keyboard. YouTube immediately loads under that account (`authuser=0` or `authuser=1`).
- [ ] **Arrow Keys & Enter**: Navigate again to `youtube.com`. Use `Arrow Down` / `Arrow Up` to focus an account card, then press `Enter`.
- [ ] **Cancel / Untouched Navigation**: Navigate to `youtube.com`. Press `Esc` or click "Continue without switching". The page opens untouched under your default account without re-prompting.
- [ ] **In-Site Clicks (Mode 1)**: Once on YouTube, click any video link or sidebar item. Notice it does **not** prompt (in-site clicks pass through silently).
- [ ] **Single Account Silence**: If only 0 or 1 account is logged in, YouTube loads directly without prompting.
- [ ] **Incognito Windows**: Open a Private Window (`Ctrl+Shift+P`) and visit `youtube.com`. The extension leaves private windows untouched.
- [ ] **Toolbar Quick-Switcher**: Click the extension icon in the Firefox toolbar. A compact account list opens. Click an account to launch YouTube in a new tab under that identity.
- [ ] **Settings / Mode 2**: Click the gear icon in the popup or visit the extension options. Select "Always use default account". Visit `youtube.com`—prompts are suppressed.
- [ ] **Diagnostics / Debug Pre**: In Settings, click "Inspect Raw JSON". The raw JSON payload from YouTube InnerTube is displayed with a "Copy JSON" button.

---

## Project Structure

```text
yt-profile-picker/
├── manifest.json              # WebExtension Manifest V2 specification
├── background.js              # Blocking webRequest listener, InnerTube API fetcher, cache
├── picker/
│   ├── picker.html            # Profile selection UI (Who's watching?)
│   ├── picker.css             # Dark theme, hover lift, focus rings, badges
│   └── picker.js              # Keyboard shortcuts, same-tab redirection, index-shift guard
├── popup/
│   ├── popup.html             # Toolbar quick switcher
│   ├── popup.css              # Compact dark theme layout
│   └── popup.js               # New-tab launcher and settings link
├── options/
│   ├── options.html           # Settings & Diagnostics interface
│   ├── options.css            # Settings styling and JSON pre viewer
│   └── options.js             # Mode settings, cache clearing, raw JSON inspector
├── icons/
│   ├── icon-16.png            # 16x16 icon
│   ├── icon-32.png            # 32x32 icon
│   ├── icon-48.png            # 48x48 icon
│   └── icon-128.png           # 128x128 icon
└── README.md                  # Documentation and testing guide
```

---

## Troubleshooting

### "No signed-in YouTube accounts detected"

- Make sure you are signed into YouTube at `https://www.youtube.com`.
- If you just logged in, click the toolbar icon and click **Refresh Accounts**, or go to Settings and click **Clear & Refresh Accounts**.
- Check the **Debug & Diagnostics** section in Settings and click **Inspect Raw JSON** to view the response from YouTube.

### YouTube returned 401 or 403

- YouTube occasionally requires SAPISID hash authentication for the InnerTube endpoint.
- The extension automatically retrieves the `SAPISID` cookie and computes the required `SAPISIDHASH` header using WebCrypto SHA-1. Ensure third-party cookie blockers are not stripping YouTube session cookies.

### Account index shifted or account signed out

- If an account was signed out or Google shifted indices, the extension verifies index freshness before redirecting. If the account is no longer valid, it falls back to loading the target untouched and logs a warning in the console.

### Private / Incognito Browsing

- The extension explicitly skips interception in incognito windows (`details.incognito === true`), preserving privacy and default browser behavior.
