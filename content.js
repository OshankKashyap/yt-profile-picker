/**
 * YT Profile Picker - Content Script (Page World Enumeration)
 * Runs on *.youtube.com in document_idle.
 * Executes same-origin GET /getAccountSwitcherEndpoint calls to discover all identities.
 */

(function () {
  "use strict";

  const YT_ORIGIN = "https://www.youtube.com";
  const ENUM_KEY = "__yt_profile_picker_last_enum";
  const ENUM_INTERVAL_MS = 10 * 60 * 1000; // At most once per tab per 10 min

  function stageLog(stage, detail = "") {
    console.log(`[YT Profile Picker] ${stage}:`, detail);
    try {
      browser.runtime
        .sendMessage({
          type: "CONTENT_LOG",
          stage,
          detail:
            typeof detail === "object"
              ? JSON.stringify(detail)
              : String(detail),
        })
        .catch(() => {});
    } catch {}
  }

  stageLog("injected", location.href);

  function getCookie(name) {
    try {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return parts.pop().split(";").shift();
    } catch {}
    return null;
  }


  /* =========================================================================
     ACCOUNTS_LIST PARSER (DEEP SCAN FOR accountItem NODES)
     ========================================================================= */

  function extractText(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj.trim();
    if (obj.simpleText) return String(obj.simpleText).trim();
    if (Array.isArray(obj.runs)) {
      return obj.runs
        .map((r) => r?.text || "")
        .join("")
        .trim();
    }
    return "";
  }

  function extractLargestPhoto(item) {
    const thumbs = item?.accountPhoto?.thumbnails;
    if (!Array.isArray(thumbs) || thumbs.length === 0) return null;
    let best = thumbs[0];
    let maxW = best?.width || 0;
    for (let i = 1; i < thumbs.length; i++) {
      const w = thumbs[i]?.width || 0;
      if (w > maxW) {
        maxW = w;
        best = thumbs[i];
      }
    }
    return best?.url || null;
  }

  function extractTokens(item) {
    let gaiaId = null;
    let datasyncId = null;
    let authuser = undefined;

    const tokens =
      item?.serviceEndpoint?.selectActiveIdentityEndpoint?.supportedTokens;
    if (Array.isArray(tokens)) {
      for (const t of tokens) {
        if (!t || typeof t !== "object") continue;

        if (t.accountStateToken?.obfuscatedGaiaId) {
          gaiaId = t.accountStateToken.obfuscatedGaiaId;
        }

        if (t.datasyncIdToken) {
          if (typeof t.datasyncIdToken === "string") {
            datasyncId = t.datasyncIdToken;
          } else if (t.datasyncIdToken.datasyncIdToken) {
            datasyncId = t.datasyncIdToken.datasyncIdToken;
          }
        }

        if (t.accountSigninToken?.signinUrl) {
          const m = t.accountSigninToken.signinUrl.match(/authuser=(\d+)/);
          if (m) {
            authuser = parseInt(m[1], 10);
          }
        }
      }
    }

    return {
      id: gaiaId || datasyncId || null,
      authuser,
    };
  }

  function parseAccountsList(data) {
    if (!data || typeof data !== "object") return [];

    const rawItems = [];

    function walk(node) {
      if (!node || typeof node !== "object") return;

      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }

      for (const key of Object.keys(node)) {
        if (
          key === "accountItem" &&
          node[key] &&
          typeof node[key] === "object"
        ) {
          rawItems.push(node[key]);
        } else {
          walk(node[key]);
        }
      }
    }

    walk(data);

    const accounts = [];
    const seenIds = new Set();

    for (const item of rawItems) {
      if (item.isDisabled === true) continue;

      const { id, authuser } = extractTokens(item);
      if (!id) continue;

      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const name = extractText(item.accountName);
      const byline = extractText(item.accountByline);
      const email =
        (item.email ? extractText(item.email) : null) ||
        (item.accountEmail ? extractText(item.accountEmail) : null) ||
        null;
      const handle =
        item.channelHandle?.simpleText ||
        (item.channelHandle ? extractText(item.channelHandle) : undefined);
      const photo = extractLargestPhoto(item);
      const isSelected = Boolean(item.isSelected);
      const serviceEndpoint = item.serviceEndpoint;

      accounts.push({
        id,
        name,
        byline,
        email,
        handle,
        photo,
        avatarUrl: photo, // UI compatibility
        isSelected,
        isActive: isSelected, // UI compatibility
        authuser,
        serviceEndpoint,
      });
    }

    return accounts;
  }

  /* =========================================================================
     IN-PAGE ENUMERATION VIA YTCFG & SAME-ORIGIN FETCH
     ========================================================================= */

  async function enumerateAccounts(force = false) {
    let allowed = true;
    let remainingMs = 0;

    if (!force) {
      try {
        const last = sessionStorage.getItem(ENUM_KEY);
        if (last) {
          const elapsed = Date.now() - Number(last);
          if (elapsed < ENUM_INTERVAL_MS) {
            allowed = false;
            remainingMs = ENUM_INTERVAL_MS - elapsed;
          }
        }
      } catch {}
    }

    stageLog(
      "rate-limit decision",
      allowed
        ? "allowed (0ms remaining)"
        : `blocked (${remainingMs}ms remaining)`,
    );
    if (!allowed) return;

    const sapisid =
      getCookie("SAPISID") ||
      getCookie("__Secure-3PAPISID") ||
      getCookie("__Secure-1PAPISID");
    const sapisidPresent = Boolean(sapisid);
    stageLog("SAPISID present", sapisidPresent);

    if (!sapisid) {
      // A missing auth cookie confirms there are no signed-in profiles.
      browser.runtime
        .sendMessage({
          type: "ACCOUNTS_UPDATED",
          accounts: [],
          verifiedEmpty: true,
        })
        .catch(() => {});
      return;
    }

    const fetchUrl = `${YT_ORIGIN}/getAccountSwitcherEndpoint`;
    stageLog("fetch URL", fetchUrl);

    try {
      const res = await fetch(fetchUrl, {
        method: "GET",
        credentials: "include",
      });

      stageLog("response status", res.status);

      const rawText = await res.text();

      // Rule 5: Treat an HTML response (title contains "Sorry") as FAILURE => fallback, never crash
      if (
        rawText.includes("<title>Sorry") ||
        rawText.includes("automated queries") ||
        rawText.trim().startsWith("<")
      ) {
        stageLog(
          "account enumeration anti-bot HTML detected",
          "treating as failure; not caching",
        );
        return;
      }

      const json = JSON.parse(rawText.slice(rawText.indexOf("{"))); // strips `)]}'`
      stageLog("response envelope code", json.code);

      const accounts = parseAccountsList(json);
      stageLog("parsed account count", accounts.length);

      if (!accounts || accounts.length === 0) {
        stageLog("enumeration returned 0 accounts", "not caching");
        return;
      }

      // Record successful enumeration in this tab
      try {
        sessionStorage.setItem(ENUM_KEY, String(Date.now()));
      } catch {}

      // Report discovered accounts to background script cache
      browser.runtime.sendMessage({
        type: "ACCOUNTS_UPDATED",
        accounts,
        rawJson: json,
      });
    } catch (err) {
      stageLog(
        "account enumeration fetch failed",
        err.message || String(err),
      );
    }
  }

  // Listen for forced enumeration requests from background
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "FORCE_ENUMERATE") {
      enumerateAccounts(true);
    }
  });

  // Run automatically on page load (at document_idle) with small delay to let ytcfg initialize
  setTimeout(() => {
    enumerateAccounts(false);
  }, 400);
})();
