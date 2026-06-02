const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("exportBtn");
const snippetSection = document.getElementById("snippetSection");
const snippetCode = document.getElementById("snippetCode");
const copyBtn = document.getElementById("copyBtn");

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status " + type;
}

function getSavedUrl() {
  const saved = localStorage.getItem("mec_agent_url");
  if (saved) document.getElementById("dashboardUrl").value = saved;
}
getSavedUrl();

function buildSnippet(dashboardUrl, password, network) {
  return `chrome.storage.local.get(["accountList"], function(r) {
  const list = r.accountList || [];
  const wallets = [];
  list.forEach((w, wi) => {
    if (!w.mnemonic) return;
    const base = w.accountOffset || 0;
    const accs = (w.accounts || []).filter(a => a.address);
    if (accs.length === 0) {
      wallets.push({ label: w.walletName || "Wallet " + (wi+1), mnemonic: w.mnemonic, hdIndex: 0, password: ${JSON.stringify(password)}, network: ${JSON.stringify(network)} });
    } else {
      accs.forEach((a, ai) => {
        wallets.push({ label: (w.walletName || "Wallet "+(wi+1)) + " / " + (a.accountName || "Account "+(base+ai)), mnemonic: w.mnemonic, address: a.address, hdIndex: base+ai, password: ${JSON.stringify(password)}, network: ${JSON.stringify(network)} });
      });
    }
  });
  if (!wallets.length) { console.log("No wallets with mnemonic found in storage."); return; }
  fetch(${JSON.stringify(dashboardUrl + "/api/wallets/import-extension")}, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({wallets}) }).then(r=>r.json()).then(r=>console.log("Done:", r)).catch(console.error);
});`;
}

copyBtn && copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(snippetCode.textContent).then(() => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  });
});

exportBtn.addEventListener("click", async () => {
  const dashboardUrl = document.getElementById("dashboardUrl").value.trim().replace(/\/$/, "");
  const password = document.getElementById("password").value.trim();
  const network = document.getElementById("network").value.trim() || "mainnet";

  if (!dashboardUrl) { showStatus("Please enter your dashboard URL.", "error"); return; }
  if (!password) { showStatus("Please enter an encryption password.", "error"); return; }

  localStorage.setItem("mec_agent_url", dashboardUrl);
  exportBtn.disabled = true;
  snippetSection.style.display = "none";
  showStatus("Scanning storage...", "info");

  // Try our own extension's storage first (in case data was synced here)
  chrome.storage.local.get(null, (allStorage) => {
    for (const [, value] of Object.entries(allStorage || {})) {
      const wallets = tryExtractWallets(value);
      if (wallets.length > 0) { sendToAgent(wallets, dashboardUrl, password, network); return; }
    }

    // Try active tab localStorage
    showStatus("Scanning active tab...", "info");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) { showFallback(dashboardUrl, password, network); return; }

      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          const out = {};
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            try { out[k] = JSON.parse(localStorage.getItem(k)); } catch { out[k] = localStorage.getItem(k); }
          }
          return out;
        }
      }, (results) => {
        const tabData = results && results[0] && results[0].result;
        if (tabData) {
          for (const [, value] of Object.entries(tabData)) {
            const wallets = tryExtractWallets(value);
            if (wallets.length > 0) { sendToAgent(wallets, dashboardUrl, password, network); return; }
          }
        }
        showFallback(dashboardUrl, password, network);
      });
    });
  });
});

function showFallback(dashboardUrl, password, network) {
  showStatus("Automatic import unavailable — use the console snippet below.", "error");
  snippetCode.textContent = buildSnippet(dashboardUrl, password, network);
  snippetSection.style.display = "block";
  exportBtn.disabled = false;
}

function tryExtractWallets(data) {
  if (!data) return [];
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { return []; } }

  if (Array.isArray(data)) {
    const withMnemonic = data.filter(w => w && w.mnemonic);
    if (withMnemonic.length) return withMnemonic;
  }

  const arrayFields = ["accountList", "wallets", "accounts", "keyring", "keyrings", "items", "data"];
  for (const f of arrayFields) {
    if (data[f]) { const r = tryExtractWallets(data[f]); if (r.length) return r; }
  }

  const withMnemonic = Object.values(data).filter(v => v && typeof v === "object" && v.mnemonic);
  return withMnemonic.map(v => ({
    walletName: v.walletName || v.name || v.label || "Imported",
    mnemonic: v.mnemonic,
    accounts: Array.isArray(v.accounts) ? v.accounts : (v.address ? [{ address: v.address }] : []),
    accountOffset: v.accountOffset || 0,
  }));
}

async function sendToAgent(accountList, dashboardUrl, password, network) {
  const wallets = [];
  accountList.forEach((w, wi) => {
    if (!w.mnemonic) return;
    const base = w.accountOffset || 0;
    const accs = Array.isArray(w.accounts) ? w.accounts.filter(a => a && a.address) : [];
    if (accs.length === 0) {
      wallets.push({ label: w.walletName || `Wallet ${wi + 1}`, mnemonic: w.mnemonic, hdIndex: 0, password, network });
    } else {
      accs.forEach((a, ai) => {
        wallets.push({
          label: `${w.walletName || `Wallet ${wi + 1}`} / ${a.accountName || `Account ${base + ai}`}`,
          mnemonic: w.mnemonic, address: a.address, hdIndex: base + ai, password, network,
        });
      });
    }
  });

  if (!wallets.length) { showFallback(dashboardUrl, password, network); return; }

  showStatus(`Found ${wallets.length} account(s). Sending...`, "info");
  try {
    const resp = await fetch(`${dashboardUrl}/api/wallets/import-extension`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallets }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Unknown error" }));
      showStatus(`Server error: ${err.error || resp.status}`, "error");
      exportBtn.disabled = false;
      return;
    }
    const result = await resp.json();
    showStatus(`Done! ${result.imported} imported, ${result.skipped} already existed.`, "success");
  } catch (err) {
    showStatus("Could not reach dashboard: " + err.message, "error");
  }
  exportBtn.disabled = false;
}
