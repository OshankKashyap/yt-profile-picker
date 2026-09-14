/**
 * YT Profile Picker - Background Script (Manifest V2)
 *
 * Anti-Bot Compliant Architecture:
 * - NEVER sends raw youtubei requests from background/curl (avoids Google anti-bot HTML blocks).
 * - Relies entirely on in-page content.js enumeration and maintains a 10-minute cache.
 * - Handles cold-start path via temporary background tab with a 10s timeout and race-free about:blank creation.
 * - Blocking webRequest listener with one-shot releasedTabs tracking to prevent redirect loops.
 */

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache validity

const DEFAULT_SETTINGS = {
  mode: "ask_open", // "ask_open" (default) | "default_account" | "ask_every_time"
  defaultAccountIndex: 0,
  enableMusic: true,
  lastUsedAccount: null,
};

// In-memory cache for fast, synchronous webRequest checks
let accountCache = {
  accounts: null,
  rawJson: null,
  timestamp: 0,
};

// Cached settings in memory for zero-overhead synchronous evaluation
let cachedSettings = { ...DEFAULT_SETTINGS };

// Track last prompted target per tab to avoid duplicate consecutive prompts
const lastPromptedPerTab = new Map();

// URLs explicitly bypassed by user action (e.g. Esc/Cancel)
const bypassedTargets = new Set();

// IDs of tabs released by picker (one-shot release to prevent redirect loops)
const releasedTabs = new Set();

// IDs of background warmup tabs to prevent interception loops
const warmupTabIds = new Set();

// Callbacks waiting for account enumeration (cold-start path)
const accountWaiters = [];

function notifyAccountWaiters(accounts) {
  while (accountWaiters.length > 0) {
    const cb = accountWaiters.shift();
    try {
      cb(accounts);
    } catch {}
  }
}

/* =========================================================================
   SETTINGS MANAGEMENT
   ========================================================================= */

async function loadSettings() {
  try {
    const data = await browser.storage.local.get("settings");
    if (data && data.settings) {
      cachedSettings = { ...DEFAULT_SETTINGS, ...data.settings };
    }
  } catch (err) {
    console.error("[YT Profile Picker] Failed to load settings:", err);
  }
}

async function saveSettings(newSettings) {
  cachedSettings = { ...cachedSettings, ...newSettings };
  await browser.storage.local.set({ settings: cachedSettings });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    cachedSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  }
});

/* =========================================================================
   COLD-START ENUMERATION VIA BACKGROUND TAB (RACE-FREE & 10S WAIT)
   ========================================================================= */

async function warmCacheViaBackgroundTab() {
  // If an existing YouTube tab is already open, ask it to enumerate
  try {
    const existingTabs = await browser.tabs.query({
      url: "*://*.youtube.com/*",
    });
    const realTab = existingTabs.find((t) => !warmupTabIds.has(t.id));
    if (realTab && realTab.id) {
      browser.tabs
        .sendMessage(realTab.id, { type: "FORCE_ENUMERATE" })
        .catch(() => {});
    }
  } catch {}

  // If a warmup tab is already active, wait on existing waiters queue (up to 10s)
  if (warmupTabIds.size > 0) {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve(accountCache.accounts || []),
        10000,
      );
      accountWaiters.push((accounts) => {
        clearTimeout(timer);
        resolve(accounts);
      });
    });
  }

  // Work Item 3: Race-free warmup tab creation
  // Create tab with about:blank, add ID to warmupTabIds BEFORE navigating to youtube
  let warmupTab = null;
  try {
    warmupTab = await browser.tabs.create({
      url: "about:blank",
      active: false,
    });
    warmupTabIds.add(warmupTab.id);
    await browser.tabs.update(warmupTab.id, {
      url: "https://www.youtube.com/",
    });
  } catch (err) {
    console.warn("[YT Profile Picker] Could not create warmup tab:", err);
    if (warmupTab && warmupTab.id) {
      warmupTabIds.delete(warmupTab.id);
      browser.tabs.remove(warmupTab.id).catch(() => {});
    }
    return accountCache.accounts || [];
  }

  // Work Item 4: Wait up to 10s for content.js to report accounts
  return new Promise((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        console.log(
          "[BG] [YT Profile Picker] Warmup tab timed out after 10s; returning uncached.",
        );
        resolve(accountCache.accounts || []);
      }
    }, 10000);

    function onDone(accounts) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        cleanup();
        resolve(accounts);
      }
    }

    accountWaiters.push(onDone);

    function cleanup() {
      const idx = accountWaiters.indexOf(onDone);
      if (idx !== -1) accountWaiters.splice(idx, 1);
      if (warmupTab && warmupTab.id) {
        warmupTabIds.delete(warmupTab.id);
        browser.tabs.remove(warmupTab.id).catch(() => {});
      }
    }
  });
}

/* =========================================================================
   INITIALIZATION & CACHE INVALIDATION
   ========================================================================= */

async function init() {
  await loadSettings();
  try {
    const data = await browser.storage.local.get([
      "cachedAccounts",
      "cacheTimestamp",
      "lastRawJson",
    ]);
    if (
      data.cachedAccounts &&
      data.cachedAccounts.length > 0 &&
      data.cacheTimestamp
    ) {
      accountCache.accounts = data.cachedAccounts;
      accountCache.timestamp = data.cacheTimestamp;
      accountCache.rawJson = data.lastRawJson || null;
    }
  } catch (err) {
    console.warn("[YT Profile Picker] Init error:", err);
  }
}

init();

// Invalidate cache when Google/YouTube auth cookies change
browser.cookies.onChanged.addListener((changeInfo) => {
  const domain = changeInfo.cookie.domain || "";
  if (domain.includes("youtube.com") || domain.includes("google.com")) {
    const sensitive = [
      "SAPISID",
      "LOGIN_INFO",
      "SID",
      "SSID",
      "APISID",
      "__Secure-3PAPISID",
      "__Secure-1PAPISID",
    ];
    if (sensitive.includes(changeInfo.cookie.name)) {
      accountCache.timestamp = 0;
    }
  }
});

// Clean up tab tracking when tabs close
browser.tabs.onRemoved.addListener((tabId) => {
  lastPromptedPerTab.delete(tabId);
  warmupTabIds.delete(tabId);
  releasedTabs.delete(tabId);
});

/* =========================================================================
   BLOCKING WEBREQUEST LISTENER
   ========================================================================= */

function handleBeforeRequest(details) {
  // Never intercept warmup tabs created by the extension
  if (warmupTabIds.has(details.tabId)) return {};

  // Work Item 2: One-shot release for tabs released by picker (prevents redirect loops)
  if (details.tabId !== undefined && releasedTabs.has(details.tabId)) {
    releasedTabs.delete(details.tabId);
    return {};
  }

  // Skip non-main_frame requests
  if (details.type !== "main_frame") return {};

  // Skip incognito windows completely
  if (details.incognito) return {};

  // Parse target URL
  let targetUrl;
  try {
    targetUrl = new URL(details.url);
  } catch {
    return {};
  }

  const hostname = targetUrl.hostname.toLowerCase();

  // Target host validation
  if (hostname === "accounts.google.com") return {};
  if (!hostname.endsWith("youtube.com")) return {};

  // Music toggle check
  if (hostname === "music.youtube.com" && !cachedSettings.enableMusic) {
    return {};
  }

  // Skip sensitive/action paths
  const path = targetUrl.pathname.toLowerCase();
  if (
    path.startsWith("/signin") ||
    path.startsWith("/logout") ||
    path.startsWith("/upload")
  ) {
    return {};
  }

  // Skip if already has authuser parameter
  if (targetUrl.searchParams.has("authuser")) {
    return {};
  }

  // Loop & duplicate guard
  if (details.url.includes("picker/picker.html")) {
    return {};
  }

  if (bypassedTargets.has(details.url)) {
    bypassedTargets.delete(details.url);
    return {};
  }

  if (lastPromptedPerTab.get(details.tabId) === details.url) {
    return {};
  }

  // Mode checks
  if (cachedSettings.mode === "default_account") {
    // Mode 2: Never prompt
    return {};
  }

  if (cachedSettings.mode === "ask_open" && details.originUrl) {
    // Mode 1 (DEFAULT): prompt only for navigations where origin is NOT youtube.com
    try {
      const origin = new URL(details.originUrl);
      if (origin.hostname.toLowerCase().endsWith("youtube.com")) {
        // In-site navigation: pass through silently
        return {};
      }
    } catch {}
  }
  // Mode "ask_every_time" falls through here to prompt

  // Account count checks
  const isCacheFresh =
    accountCache.accounts && Date.now() - accountCache.timestamp < CACHE_TTL_MS;

  if (isCacheFresh) {
    if (accountCache.accounts.length <= 1) {
      // 0 or 1 account: pass through silently
      return {};
    }

    lastPromptedPerTab.set(details.tabId, details.url);
    const pickerUrl = browser.runtime.getURL(
      `picker/picker.html?target=${encodeURIComponent(details.url)}`,
    );
    return { redirectUrl: pickerUrl };
  }

  // Cold start or stale cache: open picker in same tab (picker executes cold-start path with 10s timeout)
  lastPromptedPerTab.set(details.tabId, details.url);
  const pickerUrl = browser.runtime.getURL(
    `picker/picker.html?target=${encodeURIComponent(details.url)}`,
  );
  return { redirectUrl: pickerUrl };
}

browser.webRequest.onBeforeRequest.addListener(
  handleBeforeRequest,
  {
    urls: ["*://*.youtube.com/*"],
    types: ["main_frame"],
  },
  ["blocking"],
);

/* =========================================================================
   RUNTIME MESSAGES (CONTENT / PICKER / POPUP / OPTIONS)
   ========================================================================= */

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  switch (message.type) {
    // Work Item 1: Stage logging forwarded from content.js
    case "CONTENT_LOG": {
      console.log(
        `[BG] [YT Profile Picker] ${message.stage}:`,
        message.detail || "",
      );
      break;
    }

    // Received from content.js after in-page enumeration
    case "ACCOUNTS_UPDATED": {
      const accounts = message.accounts || [];

      // Work Item 5: Never cache empty or failed enumeration
      if (accounts.length === 0) {
        console.log(
          "[BG] [YT Profile Picker] Ignoring empty accounts update; not caching.",
        );
        notifyAccountWaiters([]);
        sendResponse({ success: false, reason: "Empty accounts list" });
        break;
      }

      accountCache = {
        accounts: accounts,
        rawJson: message.rawJson || null,
        timestamp: Date.now(),
      };

      browser.storage.local.set({
        cachedAccounts: accountCache.accounts,
        cacheTimestamp: accountCache.timestamp,
        lastRawJson: accountCache.rawJson,
      });

      notifyAccountWaiters(accountCache.accounts);
      sendResponse({ success: true });
      break;
    }

    // Called by picker, popup, options
    case "GET_ACCOUNTS": {
      const isFresh =
        accountCache.accounts !== null &&
        accountCache.accounts.length > 0 &&
        Date.now() - accountCache.timestamp < CACHE_TTL_MS;

      if (isFresh) {
        sendResponse({
          accounts: accountCache.accounts,
          rawJson: accountCache.rawJson,
          timestamp: accountCache.timestamp,
        });
        return;
      }

      // Cold-start path: warm cache via background tab (up to 10s wait)
      warmCacheViaBackgroundTab()
        .then((accounts) => {
          sendResponse({
            accounts: accounts || [],
            rawJson: accountCache.rawJson,
            timestamp: accountCache.timestamp,
          });
        })
        .catch(() => {
          sendResponse({
            accounts: accountCache.accounts || [],
            rawJson: accountCache.rawJson,
            timestamp: accountCache.timestamp,
          });
        });
      return true; // Async sendResponse
    }

    case "FORCE_REFRESH_ACCOUNTS": {
      accountCache.timestamp = 0;
      warmCacheViaBackgroundTab()
        .then((accounts) => {
          sendResponse({
            accounts: accounts || [],
            rawJson: accountCache.rawJson,
            timestamp: accountCache.timestamp,
          });
        })
        .catch(() => {
          sendResponse({
            accounts: [],
            rawJson: null,
            timestamp: Date.now(),
          });
        });
      return true;
    }

    case "CLEAR_CACHE": {
      accountCache = {
        accounts: null,
        rawJson: null,
        timestamp: 0,
      };
      browser.storage.local
        .remove(["cachedAccounts", "cacheTimestamp", "lastRawJson"])
        .then(() => {
          sendResponse({ success: true });
        });
      return true;
    }

    // Work Item 2: Release tab from webRequest interception for same-tab navigation
    case "RELEASE_TAB":
    case "BYPASS_TARGET": {
      if (message.tabId !== undefined && message.tabId !== null) {
        releasedTabs.add(message.tabId);
      }
      if (message.url) {
        bypassedTargets.add(message.url);
      }
      sendResponse({ success: true });
      break;
    }

    case "GET_SETTINGS": {
      sendResponse({ settings: cachedSettings });
      break;
    }

    case "SAVE_SETTINGS": {
      saveSettings(message.settings || {}).then(() => {
        sendResponse({ success: true, settings: cachedSettings });
      });
      return true;
    }

    case "SET_LAST_USED": {
      cachedSettings.lastUsedAccount = message.accountId;
      browser.storage.local.set({ settings: cachedSettings }).then(() => {
        sendResponse({ success: true });
      });
      return true;
    }

    case "VERIFY_ACCOUNT_INDEX": {
      const chosen = message.account;
      if (!chosen) {
        sendResponse({ valid: false, reason: "No account specified" });
        break;
      }

      // Check against cached accounts — match strictly by unique Gaia ID
      const currentAccounts = accountCache.accounts || [];
      const match = currentAccounts.find((a) => a.id === chosen.id);

      if (!match) {
        sendResponse({ valid: false, reason: "Account not found in cache" });
      } else {
        sendResponse({ valid: true, authuser: match.authuser, name: match.name });
      }
      break;
    }
  }
});
