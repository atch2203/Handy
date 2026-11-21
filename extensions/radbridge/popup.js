const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showMessage(text, ok = false) {
  $("message").textContent = text;
  $("message").className = `message ${ok ? "ok" : "err"}`;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "status" });
  $("connection").textContent = status.connected
    ? "Connected to Handy"
    : status.error || "Not connected to Handy";

  if (status.target) {
    $("target").textContent =
      (status.pinned ? "📌 " : "") +
      (status.target.title || status.target.url) +
      (status.target.discarded ? " (unloaded by Memory Saver)" : "");
  } else {
    $("target").textContent = status.config.urlPattern
      ? "No open tab matches the URL pattern"
      : "Set the URL pattern in Options";
  }
  $("field").textContent =
    status.config.fieldMode === "selector"
      ? status.config.selector || "(no selector set)"
      : "Last focused field";
  $("unpin").hidden = !status.pinned;

  const ready = status.connected && status.target && !status.target.discarded;
  $("dot").className =
    `dot ${!status.connected ? "err" : ready ? "ok" : "warn"}`;
}

$("pin").addEventListener("click", async () => {
  const tab = await activeTab();
  const result = await chrome.runtime.sendMessage({
    type: "pin-tab",
    tabId: tab.id,
  });
  if (result.ok) showMessage("This tab is now the target.", true);
  else showMessage(result.error);
  refresh();
});

$("unpin").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "unpin-tab" });
  showMessage("Pin cleared.", true);
  refresh();
});

$("pick").addEventListener("click", async () => {
  const tab = await activeTab();
  const result = await chrome.runtime.sendMessage({
    type: "pick-field",
    tabId: tab.id,
  });
  if (!result.ok) {
    showMessage(result.error);
    return;
  }
  // The popup closes when the page is clicked; the pick is saved by then.
  showMessage("Click the report field in the page. Esc cancels.", true);
});

$("options").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 1500);
