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
      (status.pinned ? "📌 " : "") + (status.target.title || status.target.url);
  } else {
    $("target").textContent = status.targetError || "None";
  }
  if (status.bound) {
    $("field").textContent =
      status.via === "bound"
        ? `Bound to ${status.config.boundSelector || "a field"}`
        : status.config.whenBindingLost === "auto"
          ? `Bound field's window closed; looking for ${status.config.boundSelector}`
          : "Bound field's window closed. Right-click the field and bind again.";
  } else {
    $("field").textContent =
      status.config.fieldMode === "selector"
        ? status.config.selector || "(no selector set)"
        : "Last focused field";
  }
  $("unpin").hidden = !status.pinned;
  $("unbind").hidden = !status.bound;

  const ready = status.connected && status.target;
  $("dot").className =
    `dot ${!status.connected ? "err" : ready ? "ok" : "warn"}`;
}

$("unbind").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "unbind" });
  showMessage("Unbound.", true);
  refresh();
});

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
