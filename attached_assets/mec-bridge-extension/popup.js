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

exportBtn.addEventListener("click", async () => {
  const dashboardUrl = document.getElementById("dashboardUrl").value.trim().replace(/\/$/, "");
  const password = document.getElementById("password").value.trim();
  const network = document.getElementById("network").value.trim() || "mainnet";

  if (!dashboardUrl) { showStatus("Please enter your dashboard URL.", "error"); return; }
  if (!password) { showStatus("Please enter an encryption password.", "error"); return; }

  localStorage.setItem("mec_agent_url", dashboardUrl);
  exportBtn.disabled = true;
  showStatus("Reading all accounts from Meta Earth extension...", "info");

  chrome.storage.local.get(["accountList"], (result) => {
    let accountList = result.accountList;

    if (typeof accountList === "string") {
      try { accountList = JSON.parse(accountList); } catch (e) {}
    }

    // Filter wallets that have a mnemonic and at least one account with an address
    const validWallets = Array.isArray(accountList)
      ? accountList.filter(w => w.mnemonic && Array.isArray(w.accounts) && w.accounts.some(a => a.address))
      : [];

    if (validWallets.length === 0) {
      // Try from active tab localStorage
      showStatus("Trying active tab...", "info");
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) {
          showStatus("No accounts found. Try the manual import method in the dashboard.", "error");
          exportBtn.disabled = false;
          return;
        }
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => {
            try {
              const raw = localStorage.getItem("accountList");
              return raw ? JSON.parse(raw) : null;
            } catch (e) { return null; }
          }
        }, (results) => {
          const tabData = results && results[0] && results[0].result;
          if (tabData && Array.isArray(tabData) && tabData.length > 0) {
            sendToAgent(tabData, dashboardUrl, password, network);
          } else {
            showStatus("No accounts found. Use manual import in the dashboard.", "error");
            exportBtn.disabled = false;
          }
        });
      });
      return;
    }

    sendToAgent(validWallets, dashboardUrl, password, network);
  });
});

async function sendToAgent(accountList, dashboardUrl, password, network) {
  // Expand ALL accounts within each wallet — each at its correct HD index
  const wallets = [];
  accountList.forEach((w, wi) => {
    if (!w.mnemonic) return;
    const baseOffset = typeof w.accountOffset === "number" ? w.accountOffset : 0;
    const accounts = Array.isArray(w.accounts) ? w.accounts.filter(a => a.address) : [];

    if (accounts.length === 0) {
      wallets.push({
        label: w.walletName || `Wallet ${wi + 1}`,
        mnemonic: w.mnemonic,
        hdIndex: 0,
        password,
        network,
      });
    } else {
      accounts.forEach((a, ai) => {
        wallets.push({
          label: a.accountName
            ? `${w.walletName || `Wallet ${wi + 1}`} / ${a.accountName}`
            : `${w.walletName || `Wallet ${wi + 1}`} / Account ${baseOffset + ai}`,
          mnemonic: w.mnemonic,
          address: a.address || "",
          hdIndex: baseOffset + ai,
          password,
          network,
        });
      });
    }
  });

  const totalAccounts = wallets.length;
  showStatus(`Found ${totalAccounts} account(s) across ${accountList.length} wallet(s). Sending...`, "info");

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
