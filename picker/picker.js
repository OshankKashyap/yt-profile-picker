/**
 * YT Profile Picker - Picker Logic
 * Handles profile selection, keyboard shortcuts, cold-start path,
 * and seamless same-tab navigation.
 */

(function () {
  "use strict";

  const PALETTE = [
    "#d93025",
    "#1a73e8",
    "#188038",
    "#f29900",
    "#a142f4",
    "#e37400",
    "#0097a7",
    "#b31412",
  ];

  const urlParams = new URLSearchParams(window.location.search);
  const targetUrl = urlParams.get("target") || "https://www.youtube.com/";

  let accountsList = [];
  let focusedIndex = 0;
  let settings = {};
  let isRefreshing = false;

  const loadingStateEl = document.getElementById("loading-state");
  const profileListEl = document.getElementById("profile-list");
  const errorContainerEl = document.getElementById("error-container");
  const errorTextEl = document.getElementById("error-text");
  const btnFallbackEl = document.getElementById("btn-fallback");
  const btnCancelEl = document.getElementById("btn-cancel");
  const btnRefreshEl = document.getElementById("btn-refresh");
  const refreshStatusEl = document.getElementById("refresh-status");
  const linkOptionsEl = document.getElementById("link-options");

  function getColorForString(str) {
    if (!str) return PALETTE[0];
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
  }

  function appendAuthuser(originalUrl, authuser) {
    try {
      const u = new URL(originalUrl);
      u.searchParams.set("authuser", String(authuser));
      return u.toString();
    } catch {
      const sep = originalUrl.includes("?") ? "&" : "?";
      return `${originalUrl}${sep}authuser=${authuser}`;
    }
  }

  async function getCurrentTabId() {
    try {
      const tab = await browser.tabs.getCurrent();
      return tab ? tab.id : null;
    } catch {
      return null;
    }
  }

  async function continueUntouched() {
    const tabId = await getCurrentTabId();
    try {
      await browser.runtime.sendMessage({
        type: "RELEASE_TAB",
        url: targetUrl,
        tabId,
      });
    } catch {}

    if (tabId) {
      browser.tabs.update(tabId, { url: targetUrl });
    } else {
      window.location.replace(targetUrl);
    }
  }

  async function selectAccount(account) {
    if (!account || isRefreshing) return;

    const tabId = await getCurrentTabId();

    try {
      // Index shift verification against cached accounts
      const verification = await browser.runtime.sendMessage({
        type: "VERIFY_ACCOUNT_INDEX",
        account,
      });

      if (!verification || !verification.valid) {
        console.warn(
          "[YT Profile Picker] Index shift detected: account no longer in cache. Falling back to target untouched.",
        );
        await continueUntouched();
        return;
      }

      const activeAuthuser =
        verification.authuser !== undefined
          ? verification.authuser
          : account.authuser;

      console.log(
        "[YT Profile Picker] Verified account:",
        verification.name || account.name,
        "authuser:",
        activeAuthuser,
      );

      // Save last used account identifier using unique Gaia ID
      const accountId = account.id;
      await browser.runtime.sendMessage({
        type: "SET_LAST_USED",
        accountId,
      });

      const finalUrl = appendAuthuser(targetUrl, activeAuthuser);

      try {
        await browser.runtime.sendMessage({
          type: "RELEASE_TAB",
          url: finalUrl,
          tabId,
        });
      } catch {}

      if (tabId) {
        browser.tabs.update(tabId, { url: finalUrl });
      } else {
        window.location.replace(finalUrl);
      }
    } catch (err) {
      console.warn("[YT Profile Picker] Error during account selection:", err);
      await continueUntouched();
    }
  }

  function renderAccounts(accounts, lastUsedId) {
    loadingStateEl.classList.add("hidden");
    errorContainerEl.classList.add("hidden");
    profileListEl.classList.remove("hidden");
    profileListEl.innerHTML = "";

    let initialFocusIndex = 0;

    accounts.forEach((acc, index) => {
      const item = document.createElement("div");
      item.className = "profile-item";
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("data-index", String(index));
      item.setAttribute("data-id", String(acc.id));
      item.setAttribute(
        "aria-label",
        `${acc.name} (${acc.byline || "Profile"})`,
      );

      // Avatar container
      const avatarContainer = document.createElement("div");
      avatarContainer.className = "profile-avatar-container";

      if (acc.avatarUrl) {
        const img = document.createElement("img");
        img.className = "profile-avatar";
        img.src = acc.avatarUrl;
        img.alt = acc.name;
        img.onerror = () => {
          img.replaceWith(createFallbackAvatar(acc));
        };
        avatarContainer.appendChild(img);
      } else {
        avatarContainer.appendChild(createFallbackAvatar(acc));
      }

      // Profile details
      const details = document.createElement("div");
      details.className = "profile-details";

      const nameEl = document.createElement("div");
      nameEl.className = "profile-name";
      nameEl.textContent = acc.name;
      details.appendChild(nameEl);

      const subtitleText = acc.byline || acc.email || acc.handle;
      if (subtitleText) {
        const subtitleEl = document.createElement("div");
        subtitleEl.className = "profile-email";
        subtitleEl.textContent = subtitleText;
        details.appendChild(subtitleEl);
      }

      // Meta (badges & shortcut indicator)
      const meta = document.createElement("div");
      meta.className = "profile-meta";

      const isLastUsed = lastUsedId && acc.id === lastUsedId;
      if (isLastUsed) {
        const badge = document.createElement("span");
        badge.className = "badge badge-last-used";
        badge.textContent = "Last used";
        meta.appendChild(badge);
        initialFocusIndex = index;
      } else if (acc.isActive) {
        const badge = document.createElement("span");
        badge.className = "badge badge-active";
        badge.textContent = "Current";
        meta.appendChild(badge);
      }

      // Number shortcut badge (1-9)
      if (index < 9) {
        const shortcut = document.createElement("span");
        shortcut.className = "shortcut-indicator";
        shortcut.textContent = String(index + 1);
        shortcut.title = `Press ${index + 1} to select`;
        meta.appendChild(shortcut);
      }

      item.appendChild(avatarContainer);
      item.appendChild(details);
      item.appendChild(meta);

      item.addEventListener("click", () => selectAccount(acc));

      profileListEl.appendChild(item);
    });

    focusedIndex = initialFocusIndex;
    updateFocusedItem();
  }

  function createFallbackAvatar(acc) {
    const fallback = document.createElement("div");
    fallback.className = "profile-avatar-fallback";
    fallback.style.backgroundColor = getColorForString(
      acc.name || acc.email || "Account",
    );
    const initial = (acc.name || "A").trim().charAt(0).toUpperCase();
    fallback.textContent = initial;
    return fallback;
  }

  function showErrorState(message) {
    loadingStateEl.classList.add("hidden");
    profileListEl.classList.add("hidden");
    errorContainerEl.classList.remove("hidden");
    if (message) {
      errorTextEl.textContent = message;
    }
    btnFallbackEl.focus();
  }

  function updateFocusedItem() {
    const items = profileListEl.querySelectorAll(".profile-item");
    items.forEach((it, idx) => {
      if (idx === focusedIndex) {
        it.classList.add("is-focused");
        it.focus();
      } else {
        it.classList.remove("is-focused");
      }
    });
  }

  async function refreshProfiles() {
    if (isRefreshing) return;
    isRefreshing = true;
    btnRefreshEl.disabled = true;
    refreshStatusEl.textContent = "Checking profiles...";

    try {
      const response = await browser.runtime.sendMessage({
        type: "FORCE_REFRESH_ACCOUNTS",
      });
      if (!response || !response.refreshed) {
        refreshStatusEl.textContent =
          "Could not refresh profiles. Your current list is unchanged.";
        return;
      }

      const nextAccounts = response.accounts || [];
      const oldIds = new Set(accountsList.map((account) => account.id));
      const newIds = new Set(nextAccounts.map((account) => account.id));
      const added = nextAccounts.filter((account) => !oldIds.has(account.id));
      const removed = accountsList.filter((account) => !newIds.has(account.id));

      accountsList = nextAccounts;
      if (accountsList.length > 1) {
        renderAccounts(accountsList, settings.lastUsedAccount);
      } else if (accountsList.length === 1) {
        showErrorState("Only one signed-in profile remains.");
      } else {
        showErrorState("No signed-in profiles found.");
      }

      refreshStatusEl.textContent = added.length || removed.length
        ? `${added.length} added, ${removed.length} removed.`
        : "Profiles are up to date.";
    } catch (err) {
      console.warn("[YT Profile Picker] Manual refresh failed:", err);
      refreshStatusEl.textContent =
        "Could not refresh profiles. Your current list is unchanged.";
    } finally {
      isRefreshing = false;
      btnRefreshEl.disabled = false;
    }
  }

  // Keyboard navigation & shortcuts
  document.addEventListener("keydown", (e) => {
    // Escape cancels and continues untouched
    if (e.key === "Escape") {
      e.preventDefault();
      continueUntouched();
      return;
    }

    // Digits 1-9 direct selection
    if (e.key >= "1" && e.key <= "9") {
      const idx = parseInt(e.key, 10) - 1;
      if (idx < accountsList.length) {
        e.preventDefault();
        selectAccount(accountsList[idx]);
        return;
      }
    }

    // Arrow navigation
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      if (accountsList.length > 0) {
        focusedIndex = (focusedIndex + 1) % accountsList.length;
        updateFocusedItem();
      }
      return;
    }

    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (accountsList.length > 0) {
        focusedIndex =
          (focusedIndex - 1 + accountsList.length) % accountsList.length;
        updateFocusedItem();
      }
      return;
    }

    // Enter / Space activates focused account
    if (e.key === "Enter" || e.key === " ") {
      if (
        document.activeElement &&
        document.activeElement.classList.contains("profile-item")
      ) {
        e.preventDefault();
        const id = document.activeElement.getAttribute("data-id");
        const idx = parseInt(
          document.activeElement.getAttribute("data-index"),
          10,
        );
        const targetAcc =
          accountsList.find((a) => a.id === id) ||
          (!isNaN(idx) ? accountsList[idx] : null);
        if (targetAcc) {
          selectAccount(targetAcc);
        }
      }
    }
  });

  // Event Listeners
  btnFallbackEl.addEventListener("click", continueUntouched);
  btnCancelEl.addEventListener("click", continueUntouched);
  btnRefreshEl.addEventListener("click", refreshProfiles);

  linkOptionsEl.addEventListener("click", (e) => {
    e.preventDefault();
    if (browser.runtime.openOptionsPage) {
      browser.runtime.openOptionsPage();
    } else {
      window.open(browser.runtime.getURL("options/options.html"));
    }
  });

  // Initialization: fetch accounts (triggers cold-start path if cache is cold)
  async function initPicker() {
    try {
      const [accountsRes, settingsRes] = await Promise.all([
        browser.runtime.sendMessage({ type: "GET_ACCOUNTS" }),
        browser.runtime.sendMessage({ type: "GET_SETTINGS" }),
      ]);

      settings = (settingsRes && settingsRes.settings) || {};
      accountsList = (accountsRes && accountsRes.accounts) || [];

      // If 0 or 1 account, rule says: pass through silently
      if (accountsList.length <= 1) {
        if (
          accountsList.length === 0 &&
          accountsRes &&
          accountsRes.timestamp === 0
        ) {
          // Timeout or error during cold-start: show fallback button
          showErrorState("Could not detect multiple accounts.");
          return;
        }
        // Exactly 1 or 0 verified accounts: proceed to YouTube untouched
        continueUntouched();
        return;
      }

      renderAccounts(accountsList, settings.lastUsedAccount);
    } catch (err) {
      console.warn("[YT Profile Picker] Error during picker init:", err);
      showErrorState("Could not communicate with background service.");
    } finally {
      btnRefreshEl.disabled = false;
    }
  }

  initPicker();
})();
