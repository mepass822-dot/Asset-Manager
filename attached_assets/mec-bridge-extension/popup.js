const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("exportBtn");
const debugEl = document.getElementById("debugInfo");

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status " + type;
}

function showDebug(lines) {
  debugEl.textContent = lines.join("\n");
  debugEl.style.display = "block";
}

function getSavedUrl() {
  const saved = localStorage.getItem("mec_agent_url");
  if (saved) document.getElementById("dashboardUrl").value = saved;
}
getSavedUrl();

// Try to extract valid wallets from any data blob, regardless of key name or structure
function extractWallets(data) {
  if (!data) return [];
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (e) { return []; }
  }

  // Top-level array of wallet objects with a mnemonic
  if (Array.isArray(data)) {
    const withMnemonic = data.filter(w => w && (w.mnemonic || w.seed || w.phrase));
    if (withMnemonic.length > 0) return withMnemonic;

    // Flat array of accounts
    const withAddress = data.filter(w => w && w.address && (w.mnemonic || w.seed || w.phrase));
    if (withAddress.length > 0) return withAddress.map(a => ({
      walletName: a.name || a.accountName || a.label || "Imported",
      mnemonic: a.mnemonic || a.seed || a.phrase,
      accounts: [{ address: a.address, accountName: a.name || a.accountName }],
    }));
  }

  // Object: check known array fields
  const arrayFields = ["accountList", "wallets", "accounts", "keyring", "keyrings", "items", "data", "list", "vault"];
  for (const field of arrayFields) {
    if (data[field]) {
      const result = extractWallets(data[field]);
      if (result.length > 0) return result;
    }
  }

  // Object where values are wallet objects
  const values = Object.values(data);
  const withMnemonic = values.filter(v => v && typeof v === "object" && (v.mnemonic || v.seed || v.phrase));
  if (withMnemonic.length > 0) {
    return withMnemonic.map(v => ({
      walletName: v.walletName || v.name || v.label || "Imported",
      mnemonic: v.mnemonic || v.seed || v.phrase,
      accounts: Array.isArray(v.accounts) ? v.accounts : (v.address ? [{ address: v.address }] : []),
    }));
  }

  return [];
}

function findWalletsInStorage(storageObj) {
  for (const [key, value] of Object.entries(storageObj)) {
    const wallets = extractWallets(value);
    if (wallets.length > 0) return wallets;
  }
  return [];
}

exportBtn.addEventListener("click", async () => {
  const dashboardUrl = document.getElementById("dashboardUrl").value.trim().replace(/\/$/, "");
  const password = document.getElementById("password").value.trim();
  const network = document.getElementById("network").value.trim() || "mainnet";

  if (!dashboardUrl) { showStatus("Please enter your dashboard URL.", "error"); return; }
  if (!password) { showStatus("Please enter an encryption password.", "error"); return; }

  localStorage.setItem("mec_agent_url", dashboardUrl);
  exportBtn.disabled = true;
  debugEl.style.display = "none";
  showStatus("Scanning extension storage...", "info");

  // Step 1: scan ALL of this extension's chrome.storage.local
  chrome.storage.local.get(null, (allStorage) => {
    const extKeys = Object.keys(allStorage || {});
    const wallets = findWalletsInStorage(allStorage || {});

    if (wallets.length > 0) {
      sendToAgent(wallets, dashboardUrl, password, network);
      return;
    }

    // Step 2: scan ALL localStorage keys on the active tab
    showStatus("Scanning active tab storage...", "info");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        showStatus("No active tab found. Open the Meta Earth wallet tab first.", "error");
        showDebug([
          "Bridge extension storage keys: " + (extKeys.length ? extKeys.join(", ") : "(empty)"),
          "No active tab available.",
        ]);
        exportBtn.disabled = false;
        return;
      }

      const tabUrl = tabs[0].url || "(unknown)";

      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          const result = {};
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            keys.push(key);
            try {
              const val = localStorage.getItem(key);
              result[key] = val ? JSON.parse(val) : val;
            } catch (e) {
              result[key] = localStorage.getItem(key);
            }
          }
          return { data: result, keys };
        }
      }, (results) => {
        const tabResult = results && results[0] && results[0].result;
        const tabData = tabResult ? tabResult.data : null;
        const tabKeys = tabResult ? tabResult.keys : [];

        if (tabData && typeof tabData === "object") {
          const tabWallets = findWalletsInStorage(tabData);
          if (tabWallets.length > 0) {
            sendToAgent(tabWallets, dashboardUrl, password, network);
            return;
          }
        }

        // Show diagnostic so the user can report what was found
        showStatus("No wallet data found in this tab's storage.", "error");
        showDebug([
          "Active tab: " + tabUrl,
          "Tab localStorage keys (" + tabKeys.length + "): " + (tabKeys.length ? tabKeys.join(", ") : "(empty)"),
          "Bridge extension storage keys: " + (extKeys.length ? extKeys.join(", ") : "(empty)"),
          "",
          "Tip: Make sure the Meta Earth wallet website tab is active, not the extension popup.",
          "Or use the manual import option in the dashboard.",
        ]);
        exportBtn.disabled = false;
      });
    });
  });
});

async function sendToAgent(accountList, dashboardUrl, password, network) {
  const wallets = [];

  accountList.forEach((w, wi) => {
    const mnemonic = w.mnemonic || w.seed || w.phrase;
    if (!mnemonic) return;

    const baseOffset = typeof w.accountOffset === "number" ? w.accountOffset : 0;
    const accounts = Array.isArray(w.accounts) ? w.accounts.filter(a => a && a.address) : [];

    if (accounts.length === 0) {
      wallets.push({
        label: w.walletName || w.name || w.label || `Wallet ${wi + 1}`,
        mnemonic,
        hdIndex: 0,
        password,
        network,
      });
    } else {
      accounts.forEach((a, ai) => {
        const name = a.accountName || a.name || a.label;
        wallets.push({
          label: name
            ? `${w.walletName || w.name || `Wallet ${wi + 1}`} / ${name}`
            : `${w.walletName || w.name || `Wallet ${wi + 1}`} / Account ${baseOffset + ai}`,
          mnemonic,
          address: a.address || "",
          hdIndex: baseOffset + ai,
          password,
          network,
        });
      });
    }
  });

  if (wallets.length === 0) {
    showStatus("Wallets found but none had a recoverable mnemonic. Use manual import in the dashboard.", "error");
    exportBtn.disabled = false;
    return;
  }

  showStatus(`Found ${wallets.length} account(s). Sending to dashboard...`, "info");

  try {
    const resp = await fetch(`${dashboardUrl}/api/wallets/import-extension`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Unknown error" }));
      showStatus(`Server error: ${err.error || resp.status}`, "error");
      exportBtn.disabled = false;
      return;
    }

    const result = await resp.json();
    showStatus(
      `Done! ${result.imported} account(s) imported, ${result.skipped} already existed.`,
      "success"
    );
  } catch (err) {
    showStatus("Could not reach dashboard: " + err.message, "error");
  }

  exportBtn.disabled = false;
}
