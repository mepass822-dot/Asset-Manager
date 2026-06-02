const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("exportBtn");

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status " + type;
}

function getSavedUrl() {
  const saved = localStorage.getItem("mec_agent_url");
  if (saved) document.getElementById("dashboardUrl").value = saved;
}
getSavedUrl();

// Try to extract valid wallets from any data blob, regardless of key name or structure
function extractWallets(data) {
  if (!data) return [];

  // Parse string if needed
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (e) { return []; }
  }

  // Case 1: top-level array of wallets e.g. [{mnemonic, accounts}, ...]
  if (Array.isArray(data)) {
    const withMnemonic = data.filter(w => w && w.mnemonic);
    if (withMnemonic.length > 0) return withMnemonic;

    // Case 2: flat array of accounts e.g. [{address, mnemonic}, ...]
    const withAddress = data.filter(w => w && (w.address || w.mnemonic));
    if (withAddress.length > 0) return withAddress.map(a => ({
      walletName: a.name || a.accountName || a.label || "Imported",
      mnemonic: a.mnemonic || a.seed || a.phrase,
      accounts: a.address ? [{ address: a.address, accountName: a.name || a.accountName }] : [],
    })).filter(w => w.mnemonic);
  }

  // Case 3: object with a known array field
  const arrayFields = ["accountList", "wallets", "accounts", "keyring", "keyrings", "items", "data"];
  for (const field of arrayFields) {
    if (data[field]) {
      const result = extractWallets(data[field]);
      if (result.length > 0) return result;
    }
  }

  // Case 4: object where values are wallet objects {mnemonic, ...}
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

// Scan ALL keys in a storage object for wallet data
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
  showStatus("Scanning extension storage for wallets...", "info");

  // Step 1: scan ALL of chrome.storage.local (not just one key)
  chrome.storage.local.get(null, (allStorage) => {
    const wallets = findWalletsInStorage(allStorage || {});

    if (wallets.length > 0) {
      sendToAgent(wallets, dashboardUrl, password, network);
      return;
    }

    // Step 2: scan ALL localStorage keys on the active tab
    showStatus("Scanning active tab storage...", "info");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        showStatus("No wallet accounts found. Make sure the Meta Earth wallet tab is open and active, then try again.", "error");
        exportBtn.disabled = false;
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          const result = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            try {
              const val = localStorage.getItem(key);
              result[key] = val ? JSON.parse(val) : val;
            } catch (e) {
              result[key] = localStorage.getItem(key);
            }
          }
          return result;
        }
      }, (results) => {
        const tabData = results && results[0] && results[0].result;
        if (tabData && typeof tabData === "object") {
          const tabWallets = findWalletsInStorage(tabData);
          if (tabWallets.length > 0) {
            sendToAgent(tabWallets, dashboardUrl, password, network);
            return;
          }
        }

        showStatus(
          "No wallet data found. Open the Meta Earth wallet website as your active tab, then click Export again. " +
          "Or use the manual import option in the dashboard.",
          "error"
        );
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
