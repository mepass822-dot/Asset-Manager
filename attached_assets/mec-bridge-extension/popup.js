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

  if (!dashboardUrl) {
    showStatus("Please enter your dashboard URL.", "error");
    return;
  }
  if (!password) {
    showStatus("Please enter an encryption password.", "error");
    return;
  }

  localStorage.setItem("mec_agent_url", dashboardUrl);

  exportBtn.disabled = true;
  showStatus("Reading wallets from Meta Earth extension...", "info");

  try {
    // Read accountList from chrome.storage.local (shared with Meta Earth extension via storage permission)
    // The Meta Earth extension ID is: ifedpjnndppciiodbhmaohidoocmiomp
    const MEW_EXTENSION_ID = "ifedpjnndppciiodbhmaohidoocmiomp";

    // Try reading via chrome.storage.local (works if same storage area is accessible)
    // In Manifest V3, extensions can only read their own storage.
    // So we read from OUR storage which mirrors MEC data if user has exported.
    // Best approach: read from localStorage of the active tab (which has MEC extension injected)
    // OR ask user to copy the export JSON.

    // Primary method: get from storage.local directly
    chrome.storage.local.get(["accountList", "currentAccount", "pw"], async (result) => {
      let accountList = result.accountList;

      // Try to decode: the extension stores values as JSON-stringified with possible encoding
      if (typeof accountList === "string") {
        try { accountList = JSON.parse(accountList); } catch (e) {}
      }

      // Filter valid wallets (must have mnemonic or priv and at least one account with address)
      const validWallets = Array.isArray(accountList)
        ? accountList.filter(w => (w.mnemonic || w.priv) && w.accounts && w.accounts.some(a => a.address))
        : [];

      if (validWallets.length === 0) {
        // Try reading via content script from active tab
        showStatus("No wallets found in bridge storage. Trying active tab...", "info");

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (!tabs[0]) {
            showStatus("Could not access active tab. See instructions below.", "error");
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
              showStatus(
                "Could not auto-read wallets. Please open the Meta Earth extension, go to Settings > Export, copy the data, and use the manual import in the dashboard instead.",
                "error"
              );
              exportBtn.disabled = false;
            }
          });
        });
        return;
      }

      sendToAgent(validWallets, dashboardUrl, password, network);
    });

  } catch (err) {
    showStatus("Error: " + err.message, "error");
    exportBtn.disabled = false;
  }
});

async function sendToAgent(accountList, dashboardUrl, password, network) {
  showStatus(`Found ${accountList.length} wallet(s). Sending to agent...`, "info");

  // Build the payload: extract mnemonic and first address per wallet
  const wallets = accountList
    .filter(w => (w.mnemonic || w.priv) && w.accounts && w.accounts.length > 0)
    .map((w, i) => ({
      label: w.walletName || w.accounts[0]?.accountName || `Wallet ${i + 1}`,
      mnemonic: w.mnemonic || "",
      priv: w.priv || "",
      address: w.accounts[0]?.address || "",
      password: password,
      network: network
    }));

  try {
    const resp = await fetch(`${dashboardUrl}/api/wallets/import-extension`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Unknown error" }));
      showStatus(`Server error: ${err.error || resp.status}`, "error");
      exportBtn.disabled = false;
      return;
    }

    const result = await resp.json();
    showStatus(
      `Done! ${result.imported} wallet(s) imported, ${result.skipped} already existed.`,
      "success"
    );
  } catch (err) {
    showStatus("Could not reach dashboard: " + err.message, "error");
  }

  exportBtn.disabled = false;
}
