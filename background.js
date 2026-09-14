/**
 * YT Profile Picker - Background Script (Manifest V2)
 * Handles account enumeration via YouTube InnerTube, blocking webRequest interception,
 * account caching, and communication with picker/popup/options pages.
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
  error: null,
};

// Cached settings in memory for zero-overhead synchronous evaluation
let cachedSettings = { ...DEFAULT_SETTINGS };

// Track last prompted target per tab to avoid duplicate consecutive prompts
const lastPromptedPerTab = new Map();

// URLs explicitly bypassed by user action (e.g. Esc/Cancel/bypass)
const bypassedTargets = new Set();

// Active in-flight promise to avoid duplicate concurrent fetches
let pendingFetch = null;

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
   ACCOUNTS_LIST PARSER (ADJUST IF YOUTUBE CHANGES SHAPE)
   =========================================================================
   InnerTube endpoint: POST https://www.youtube.com/youtubei/v1/account/accounts_list
   Extracts: { name, email, avatarUrl, authuser, isActive }
   Prefers an index found inside signin/switch URLs in the response;
   falls back to array order (0, 1, 2...).
   ========================================================================= */

function extractText(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj.trim();
  if (obj.simpleText) return String(obj.simpleText).trim();
  if (Array.isArray(obj.runs) && obj.runs.length > 0) {
    return obj.runs
      .map((r) => r.text || "")
      .join("")
      .trim();
  }
  return "";
}

function extractThumbnail(obj) {
  if (!obj) return null;
  if (typeof obj === "string" && obj.startsWith("http")) return obj;
  const thumbs =
    obj.thumbnails ||
    (obj.accountPhoto && obj.accountPhoto.thumbnails) ||
    (obj.avatar && obj.avatar.thumbnails);
  if (Array.isArray(thumbs) && thumbs.length > 0) {
    // Pick largest thumbnail (last)
    const best = thumbs[thumbs.length - 1];
    return best && best.url ? best.url : null;
  }
  return null;
}

function extractAuthuserFromNode(node) {
  try {
    const str = JSON.stringify(node);
    // Matches authuser=1, authuser/1, "authuser": 1, "authuser": "1"
    const m =
      str.match(/authuser[=/](\d+)/i) ||
      str.match(/["']authuser["']\s*:\s*"?(\d+)"?/i);
    if (m && m[1] !== undefined) {
      return parseInt(m[1], 10);
    }
  } catch {}
  return null;
}

function parseAccountsList(data) {
  if (!data || typeof data !== "object") return [];

  const rawItems = [];

  // Recursive walk to find account renderers defensively
  function walk(node) {
    if (!node || typeof node !== "object") return;

    if (node.accountItem && typeof node.accountItem === "object") {
      rawItems.push(node.accountItem);
      return;
    }
    if (
      node.accountItemRenderer &&
      typeof node.accountItemRenderer === "object"
    ) {
      rawItems.push(node.accountItemRenderer);
      return;
    }
    if (
      node.accountName ||
      (node.accountPhoto && (node.accountByline || node.email || node.title))
    ) {
      rawItems.push(node);
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else {
      for (const key of Object.keys(node)) {
        walk(node[key]);
      }
    }
  }

  walk(data);

  const accounts = [];
  const seen = new Set();

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    const name =
      extractText(item.accountName) ||
      extractText(item.title) ||
      extractText(item.name) ||
      `Account ${i + 1}`;
    const email =
      extractText(item.accountByline) ||
      extractText(item.email) ||
      extractText(item.byline) ||
      "";
    const avatarUrl =
      extractThumbnail(item.accountPhoto) ||
      extractThumbnail(item.avatar) ||
      extractThumbnail(item);
    const parsedAuthuser = extractAuthuserFromNode(item);
    const authuser = parsedAuthuser !== null ? parsedAuthuser : i;
    const isActive = Boolean(item.isSelected || item.hasCheckmark);

    const dedupKey = `${name}|${email}|${authuser}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    accounts.push({
      name,
      email: email || null,
      avatarUrl,
      authuser,
      isActive,
    });
  }

  // Active-account fallback: if no item was flagged isSelected, mark first account (authuser 0) as active
  if (accounts.length > 0 && !accounts.some((a) => a.isActive)) {
    accounts[0].isActive = true;
  }

  return accounts;
}

/* =========================================================================
   SAPISIDHASH & INNERTUBE FETCHER
   ========================================================================= */

async function computeSapisidHash(sapisid) {
  const ts = Math.floor(Date.now() / 1000);
  const origin = "https://www.youtube.com";
  const str = `${ts} ${origin} ${sapisid}`;
  const buffer = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-1", buffer);
  const hashArray = Array.from(new Uint8Array(digest));
  const sha1 = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `SAPISIDHASH ${ts}_${sha1}`;
}

async function fetchRawAccountsList() {
  const endpoint = "https://www.youtube.com/youtubei/v1/account/accounts_list";
  const payload = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20240101.00.00",
        hl: "en",
      },
    },
  };

  const headers = {
    "Content-Type": "application/json",
  };

  let res = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(payload),
  });

  // If 401 or 403, retry with SAPISIDHASH authorization header
  if (res.status === 401 || res.status === 403) {
    try {
      const cookie =
        (await browser.cookies.get({
          url: "https://www.youtube.com",
          name: "SAPISID",
        })) ||
        (await browser.cookies.get({
          url: "https://www.google.com",
          name: "SAPISID",
        }));

      if (cookie && cookie.value) {
        const authHeader = await computeSapisidHash(cookie.value);
        headers["Authorization"] = authHeader;
        headers["X-Origin"] = "https://www.youtube.com";

        res = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify(payload),
        });
      }
    } catch (authErr) {
      console.warn(
        "[YT Profile Picker] SAPISIDHASH calculation failed:",
        authErr,
      );
    }
  }

  if (!res.ok) {
    throw new Error(`InnerTube accounts_list HTTP ${res.status}`);
  }

  return await res.json();
}

async function resolveAccounts(force = false) {
  const isFresh =
    accountCache.accounts && Date.now() - accountCache.timestamp < CACHE_TTL_MS;
  if (!force && isFresh) {
    return accountCache.accounts;
  }

  if (pendingFetch) {
    return pendingFetch;
  }

  pendingFetch = (async () => {
    try {
      const rawData = await fetchRawAccountsList();
      const parsed = parseAccountsList(rawData);
      accountCache = {
        accounts: parsed,
        rawJson: rawData,
        timestamp: Date.now(),
        error: null,
      };

      await browser.storage.local.set({
        cachedAccounts: parsed,
        cacheTimestamp: accountCache.timestamp,
        lastRawJson: rawData,
      });

      return parsed;
    } catch (err) {
      console.warn("[YT Profile Picker] resolveAccounts error:", err);
      accountCache.error = err.message || "Failed to resolve accounts";
      return accountCache.accounts || [];
    } finally {
      pendingFetch = null;
    }
  })();

  return pendingFetch;
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
    if (data.cachedAccounts && data.cacheTimestamp) {
      accountCache.accounts = data.cachedAccounts;
      accountCache.timestamp = data.cacheTimestamp;
      accountCache.rawJson = data.lastRawJson || null;
    }
    // Eagerly resolve if missing or stale
    if (
      !accountCache.accounts ||
      Date.now() - accountCache.timestamp > CACHE_TTL_MS
    ) {
      resolveAccounts().catch(() => {});
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
    const sensitiveCookies = [
      "SAPISID",
      "LOGIN_INFO",
      "SID",
      "SSID",
      "APISID",
      "__Secure-3PSID",
    ];
    if (sensitiveCookies.includes(changeInfo.cookie.name)) {
      accountCache.timestamp = 0;
      resolveAccounts(true).catch(() => {});
    }
  }
});

// Clean up tab tracking when tabs close
browser.tabs.onRemoved.addListener((tabId) => {
  lastPromptedPerTab.delete(tabId);
});

/* =========================================================================
   BLOCKING WEBREQUEST LISTENER
   ========================================================================= */

function handleBeforeRequest(details) {
  // 1. Skip non-main_frame requests
  if (details.type !== "main_frame") return {};

  // 2. Skip incognito windows completely
  if (details.incognito) return {};

  // 3. Parse target URL
  let targetUrl;
  try {
    targetUrl = new URL(details.url);
  } catch {
    return {};
  }

  const hostname = targetUrl.hostname.toLowerCase();

  // 4. Target host validation
  if (hostname === "accounts.google.com") return {};
  if (!hostname.endsWith("youtube.com")) return {};

  // Music toggle check
  if (hostname === "music.youtube.com" && !cachedSettings.enableMusic) {
    return {};
  }

  // 5. Skip sensitive/action paths
  const path = targetUrl.pathname.toLowerCase();
  if (
    path.startsWith("/signin") ||
    path.startsWith("/logout") ||
    path.startsWith("/upload")
  ) {
    return {};
  }

  // 6. Skip if already has authuser parameter
  if (targetUrl.searchParams.has("authuser")) {
    return {};
  }

  // 7. Loop / duplicate guard
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

  // 8. Mode checks
  if (cachedSettings.mode === "default_account") {
    // Never prompt mode
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

  // 9. Account availability check
  const isCacheFresh =
    accountCache.accounts && Date.now() - accountCache.timestamp < CACHE_TTL_MS;

  if (isCacheFresh) {
    // Synchronous path
    if (accountCache.accounts.length <= 1) {
      // 0 or 1 account signed in: pass through silently
      return {};
    }

    lastPromptedPerTab.set(details.tabId, details.url);
    const pickerUrl = browser.runtime.getURL(
      `picker/picker.html?target=${encodeURIComponent(details.url)}`,
    );
    return { redirectUrl: pickerUrl };
  }

  // Cache is stale or uninitialized: resolve with max 300ms timeout
  return new Promise((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({}); // Fall through untouched after 300ms max
      }
    }, 300);

    resolveAccounts()
      .then((accounts) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);

        if (!accounts || accounts.length <= 1) {
          resolve({});
          return;
        }

        lastPromptedPerTab.set(details.tabId, details.url);
        const pickerUrl = browser.runtime.getURL(
          `picker/picker.html?target=${encodeURIComponent(details.url)}`,
        );
        resolve({ redirectUrl: pickerUrl });
      })
      .catch(() => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({});
      });
  });
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
   RUNTIME MESSAGES (PICKER / POPUP / OPTIONS)
   ========================================================================= */

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  switch (message.type) {
    case "GET_ACCOUNTS": {
      resolveAccounts()
        .then((accounts) => {
          sendResponse({
            accounts,
            rawJson: accountCache.rawJson,
            error: accountCache.error,
            timestamp: accountCache.timestamp,
          });
        })
        .catch((err) => {
          sendResponse({
            accounts: accountCache.accounts || [],
            rawJson: accountCache.rawJson,
            error: err.message,
            timestamp: accountCache.timestamp,
          });
        });
      return true; // Async sendResponse
    }

    case "FORCE_REFRESH_ACCOUNTS": {
      resolveAccounts(true)
        .then((accounts) => {
          sendResponse({
            accounts,
            rawJson: accountCache.rawJson,
            error: accountCache.error,
            timestamp: accountCache.timestamp,
          });
        })
        .catch((err) => {
          sendResponse({
            accounts: [],
            rawJson: null,
            error: err.message,
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
        error: null,
      };
      browser.storage.local
        .remove(["cachedAccounts", "cacheTimestamp", "lastRawJson"])
        .then(() => {
          sendResponse({ success: true });
        });
      return true;
    }

    case "BYPASS_TARGET": {
      if (message.url) {
        bypassedTargets.add(message.url);
      }
      if (message.tabId !== undefined && message.url) {
        lastPromptedPerTab.set(message.tabId, message.url);
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
      // Re-resolve to detect index shift
      resolveAccounts(true)
        .then((freshAccounts) => {
          if (!freshAccounts || freshAccounts.length === 0) {
            sendResponse({ valid: false, reason: "No accounts returned" });
            return;
          }

          const match = freshAccounts.find((a) => {
            if (
              chosen.email &&
              a.email &&
              chosen.email.toLowerCase() === a.email.toLowerCase()
            ) {
              return true;
            }
            if (chosen.name && a.name && chosen.name === a.name) {
              return true;
            }
            return false;
          });

          if (!match) {
            sendResponse({ valid: false, reason: "Account signed out" });
          } else {
            sendResponse({ valid: true, authuser: match.authuser });
          }
        })
        .catch((err) => {
          sendResponse({ valid: false, reason: err.message });
        });
      return true;
    }
  }
});
