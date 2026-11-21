import { DEFAULTS, loadConfig, validatePattern } from "./shared.js";

const $ = (id) => document.getElementById(id);
const form = $("form");

function showMessage(text, ok = false) {
  $("message").textContent = text;
  $("message").className = `message ${ok ? "ok" : "err"}`;
}

function fill(config) {
  $("port").value = config.port;
  $("token").value = config.token;
  $("urlPattern").value = config.urlPattern;
  $("selector").value = config.selector;
  form.elements.fieldMode.value = config.fieldMode;
  form.elements.position.value = config.position;
  $("separator").value = config.separator;
  $("strategy").value = config.strategy;
  $("flash").checked = config.flash;
}

function read() {
  return {
    port: Number($("port").value) || DEFAULTS.port,
    token: $("token").value.trim(),
    urlPattern: $("urlPattern").value.trim(),
    fieldMode: form.elements.fieldMode.value,
    selector: $("selector").value.trim(),
    position: form.elements.position.value,
    separator: $("separator").value,
    strategy: $("strategy").value,
    flash: $("flash").checked,
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const config = read();
  if (config.urlPattern) {
    const problem = validatePattern(config.urlPattern);
    if (problem) {
      showMessage(problem);
      return;
    }
    // Must run in the click's user gesture, before any other await.
    const granted = await chrome.permissions.request({
      origins: [config.urlPattern],
    });
    if (!granted) {
      showMessage(
        "Chrome didn't grant access to those pages, so nothing was saved.",
      );
      return;
    }
  }
  if (config.fieldMode === "selector" && !config.selector) {
    showMessage("Enter a selector, or use Pick field in the toolbar popup.");
    return;
  }
  await chrome.storage.local.set(config);
  showMessage("Saved.", true);
});

$("test").addEventListener("click", async () => {
  showMessage("");
  const result = await chrome.runtime.sendMessage({ type: "test-insert" });
  if (result?.ok) showMessage("Inserted the test text.", true);
  else showMessage(result?.error || "Test insert failed.");
});

async function refreshStatus() {
  const status = await chrome.runtime.sendMessage({ type: "status" });
  $("connection").textContent = status.connected
    ? `Connected to Handy${status.target ? `, target: ${status.target.title}` : ", no target tab"}`
    : status.error || "Not connected to Handy";
  $("dot").className =
    `dot ${!status.connected ? "err" : status.target ? "ok" : "warn"}`;
}

// A field picked in the popup while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.selector) {
    $("selector").value = changes.selector.newValue ?? "";
    form.elements.fieldMode.value = "selector";
  }
});

fill(await loadConfig());
refreshStatus();
setInterval(refreshStatus, 2000);
