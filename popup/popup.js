/**
 * YT Profile Picker - Toolbar Popup Logic
 * Quick switcher: click opens YouTube under selected account in a new tab.
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

  const accountsContainerEl = document.getElementById("accounts-container");
  const emptyStateEl = document.getElementById("empty-state");
  const btnSettingsEl = document.getElementById("btn-settings");
  const btnRefreshEl = document.getElementById("btn-refresh");

  function getColorForString(str) {
    if (!str) return PALETTE[0];
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
  }

  function createFallbackAvatar(acc) {
    const fallback = document.createElement("div");
    fallback.className = "account-avatar-fallback";
    fallback.style.backgroundColor = getColorForString(
      acc.name || acc.email || "Account",
    );
    const initial = (acc.name || "A").trim().charAt(0).toUpperCase();
    fallback.textContent = initial;
    return fallback;
  }

  async function openAccountInNewTab(account) {
    const targetUrl = `https://www.youtube.com/?authuser=${account.authuser}`;
    const accountId = account.email || account.name;

    try {
      await browser.runtime.sendMessage({
        type: "SET_LAST_USED",
        accountId,
      });
    } catch {}

    browser.tabs.create({ url: targetUrl });
    window.close();
  }

  function renderAccounts(accounts, lastUsedId) {
    accountsContainerEl.innerHTML = "";

    if (!accounts || accounts.length === 0) {
      accountsContainerEl.classList.add("hidden");
      emptyStateEl.classList.remove("hidden");
      return;
    }

    accountsContainerEl.classList.remove("hidden");
    emptyStateEl.classList.add("hidden");

    accounts.forEach((acc) => {
      const card = document.createElement("div");
      card.className = "account-card";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Open YouTube as ${acc.name}`);

      // Avatar
      const avatarWrap = document.createElement("div");
      avatarWrap.className = "account-avatar-wrap";

      if (acc.avatarUrl) {
        const img = document.createElement("img");
        img.className = "account-avatar";
        img.src = acc.avatarUrl;
        img.alt = acc.name;
        img.onerror = () => {
          img.replaceWith(createFallbackAvatar(acc));
        };
        avatarWrap.appendChild(img);
      } else {
        avatarWrap.appendChild(createFallbackAvatar(acc));
      }

      // Info
      const info = document.createElement("div");
      info.className = "account-info";

      const nameEl = document.createElement("div");
      nameEl.className = "account-name";
      nameEl.textContent = acc.name;
      info.appendChild(nameEl);

      if (acc.email) {
        const emailEl = document.createElement("div");
        emailEl.className = "account-email";
        emailEl.textContent = acc.email;
        info.appendChild(emailEl);
      }

      // Badges
      const badges = document.createElement("div");
      badges.className = "account-badges";

      const isLastUsed =
        lastUsedId && (acc.email === lastUsedId || acc.name === lastUsedId);
      if (isLastUsed) {
        const b = document.createElement("span");
        b.className = "badge badge-last-used";
        b.textContent = "Last";
        badges.appendChild(b);
      } else if (acc.isActive) {
        const b = document.createElement("span");
        b.className = "badge badge-active";
        b.textContent = "Current";
        badges.appendChild(b);
      }

      card.appendChild(avatarWrap);
      card.appendChild(info);
      card.appendChild(badges);

      card.addEventListener("click", () => openAccountInNewTab(acc));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openAccountInNewTab(acc);
        }
      });

      accountsContainerEl.appendChild(card);
    });
  }

  async function loadData(force = false) {
    try {
      const msgType = force ? "FORCE_REFRESH_ACCOUNTS" : "GET_ACCOUNTS";
      const [accountsRes, settingsRes] = await Promise.all([
        browser.runtime.sendMessage({ type: msgType }),
        browser.runtime.sendMessage({ type: "GET_SETTINGS" }),
      ]);

      const accounts = (accountsRes && accountsRes.accounts) || [];
      const settings = (settingsRes && settingsRes.settings) || {};

      renderAccounts(accounts, settings.lastUsedAccount);
    } catch (err) {
      console.warn("[YT Profile Picker] Popup loadData error:", err);
      renderAccounts([], null);
    }
  }

  btnSettingsEl.addEventListener("click", () => {
    if (browser.runtime.openOptionsPage) {
      browser.runtime.openOptionsPage();
    } else {
      window.open(browser.runtime.getURL("options/options.html"));
    }
    window.close();
  });

  btnRefreshEl.addEventListener("click", () => {
    loadData(true);
  });

  loadData();
})();
