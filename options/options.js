/**
 * YT Profile Picker - Options & Diagnostics Logic
 */

(function () {
  "use strict";

  const modeRadios = document.querySelectorAll('input[name="picker-mode"]');
  const refreshModeRadios = document.querySelectorAll(
    'input[name="refresh-mode"]',
  );
  const selectRefreshInterval = document.getElementById(
    "select-refresh-interval",
  );
  const selectDefaultAccount = document.getElementById(
    "select-default-account",
  );
  const toggleMusic = document.getElementById("toggle-music");
  const cacheStatusText = document.getElementById("cache-status-text");
  const btnClearCache = document.getElementById("btn-clear-cache");
  const btnInspectJson = document.getElementById("btn-inspect-json");
  const btnCopyJson = document.getElementById("btn-copy-json");
  const debugContainer = document.getElementById("debug-json-container");
  const debugRawJson = document.getElementById("debug-raw-json");
  const toastEl = document.getElementById("toast");

  let currentSettings = {};
  let currentRawJson = null;
  let toastTimer = null;

  function showToast(msg) {
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    toastTimer = setTimeout(() => {
      toastEl.classList.add("hidden");
    }, 2000);
  }

  function updateCacheDisplay(accounts, timestamp) {
    if (!accounts || accounts.length === 0) {
      cacheStatusText.textContent = "0 accounts cached.";
      return;
    }

    const count = accounts.length;
    let timeStr = "just now";
    if (timestamp) {
      const elapsedSec = Math.floor((Date.now() - timestamp) / 1000);
      if (elapsedSec < 60) {
        timeStr = `${elapsedSec}s ago`;
      } else {
        timeStr = `${Math.floor(elapsedSec / 60)}m ago`;
      }
    }
    cacheStatusText.textContent = `${count} account${count > 1 ? "s" : ""} cached (${timeStr}).`;
  }

  function populateAccountsDropdown(accounts, selectedIndex) {
    selectDefaultAccount.innerHTML = "";

    if (!accounts || accounts.length === 0) {
      const opt = document.createElement("option");
      opt.value = "0";
      opt.textContent = "Account 1 (Default: authuser=0)";
      selectDefaultAccount.appendChild(opt);
      return;
    }

    accounts.forEach((acc) => {
      const opt = document.createElement("option");
      opt.value = String(acc.authuser);
      const emailPart = acc.email ? ` (${acc.email})` : "";
      opt.textContent = `${acc.name}${emailPart} [authuser=${acc.authuser}]`;
      if (acc.authuser === selectedIndex) {
        opt.selected = true;
      }
      selectDefaultAccount.appendChild(opt);
    });
  }

  function selectedRefreshMode() {
    return (
      document.querySelector('input[name="refresh-mode"]:checked')?.value ||
      "automatic"
    );
  }

  function updateRefreshControls() {
    selectRefreshInterval.disabled = selectedRefreshMode() === "manual";
  }

  async function saveCurrentSettings() {
    let selectedMode = "ask_open";
    modeRadios.forEach((r) => {
      if (r.checked) selectedMode = r.value;
    });

    const defaultIdx = parseInt(selectDefaultAccount.value, 10) || 0;
    const enableMusic = toggleMusic.checked;

    currentSettings.mode = selectedMode;
    currentSettings.defaultAccountIndex = defaultIdx;
    currentSettings.enableMusic = enableMusic;
    currentSettings.refreshMode = selectedRefreshMode();
    currentSettings.refreshIntervalMinutes = Number(selectRefreshInterval.value);

    updateRefreshControls();

    await browser.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      settings: currentSettings,
    });

    showToast("Settings saved");
  }

  async function loadOptions() {
    try {
      const [settingsRes, accountsRes] = await Promise.all([
        browser.runtime.sendMessage({ type: "GET_SETTINGS" }),
        browser.runtime.sendMessage({ type: "GET_ACCOUNTS" }),
      ]);

      currentSettings = (settingsRes && settingsRes.settings) || {
        mode: "ask_open",
        defaultAccountIndex: 0,
        enableMusic: true,
      };

      // Set Mode Radio
      modeRadios.forEach((r) => {
        r.checked = r.value === currentSettings.mode;
      });

      refreshModeRadios.forEach((r) => {
        r.checked = r.value === (currentSettings.refreshMode || "automatic");
      });
      const interval = Number(currentSettings.refreshIntervalMinutes);
      selectRefreshInterval.value = [10, 15, 20, 30, 45, 60].includes(interval)
        ? String(interval)
        : "10";
      updateRefreshControls();

      // Set Music Toggle
      toggleMusic.checked = Boolean(currentSettings.enableMusic !== false);

      const accounts = (accountsRes && accountsRes.accounts) || [];
      populateAccountsDropdown(accounts, currentSettings.defaultAccountIndex);
      updateCacheDisplay(accounts, accountsRes && accountsRes.timestamp);

      currentRawJson = (accountsRes && accountsRes.rawJson) || null;
      if (currentRawJson) {
        debugRawJson.textContent = JSON.stringify(currentRawJson, null, 2);
      }
    } catch (err) {
      console.warn("[YT Profile Picker] Failed to load options data:", err);
      showToast("Error loading options");
    }
  }

  // Event Listeners for auto-save
  modeRadios.forEach((r) => {
    r.addEventListener("change", saveCurrentSettings);
  });

  selectDefaultAccount.addEventListener("change", saveCurrentSettings);
  toggleMusic.addEventListener("change", saveCurrentSettings);
  refreshModeRadios.forEach((r) => {
    r.addEventListener("change", saveCurrentSettings);
  });
  selectRefreshInterval.addEventListener("change", saveCurrentSettings);

  // Refresh accounts
  btnClearCache.addEventListener("click", async () => {
    cacheStatusText.textContent =
      "Refreshing accounts from YouTube InnerTube...";
    try {
      const res = await browser.runtime.sendMessage({
        type: "FORCE_REFRESH_ACCOUNTS",
      });
      const accounts = (res && res.accounts) || [];
      if (!res || !res.refreshed) {
        updateCacheDisplay(accounts, res && res.timestamp);
        showToast("Refresh failed; showing cached accounts");
        return;
      }
      populateAccountsDropdown(accounts, currentSettings.defaultAccountIndex);
      updateCacheDisplay(accounts, res && res.timestamp);
      currentRawJson = (res && res.rawJson) || null;
      debugRawJson.textContent = currentRawJson
        ? JSON.stringify(currentRawJson, null, 2)
        : "No raw account data available.";
      showToast(`Refreshed (${accounts.length} found)`);
    } catch (err) {
      cacheStatusText.textContent = "Refresh failed.";
      showToast("Refresh failed");
    }
  });

  // Inspect Raw JSON
  btnInspectJson.addEventListener("click", async () => {
    if (debugContainer.classList.contains("hidden")) {
      debugContainer.classList.remove("hidden");
      btnInspectJson.textContent = "Hide Raw JSON";

      if (!currentRawJson) {
        debugRawJson.textContent = "Fetching raw accounts_list response...";
        const res = await browser.runtime.sendMessage({ type: "GET_ACCOUNTS" });
        currentRawJson = (res && res.rawJson) || null;
        if (currentRawJson) {
          debugRawJson.textContent = JSON.stringify(currentRawJson, null, 2);
        } else {
          debugRawJson.textContent =
            "No accounts_list response data found. Sign into YouTube and retry.";
        }
      }
    } else {
      debugContainer.classList.add("hidden");
      btnInspectJson.textContent = "Inspect Raw JSON";
    }
  });

  // Copy JSON
  btnCopyJson.addEventListener("click", async () => {
    const textToCopy = debugRawJson.textContent;
    if (
      !textToCopy ||
      textToCopy.startsWith("No raw") ||
      textToCopy.startsWith("Fetching")
    ) {
      showToast("No JSON to copy yet");
      return;
    }
    try {
      await navigator.clipboard.writeText(textToCopy);
      showToast("JSON copied to clipboard");
    } catch {
      showToast("Copy failed");
    }
  });

  loadOptions();
})();
