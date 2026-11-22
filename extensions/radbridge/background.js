// RadBridge service worker.
//
// Connects to Handy's localhost WebSocket, authenticates with the token, and
// routes each dictated `insert` to the target tab's content script, then
// returns the result to Handy as an `ack`. Never logs or stores dictated text.

import { DEFAULTS, TEST_TEXT, insertOptions, loadConfig } from "./shared.js";

const PROTOCOL_VERSION = 1;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SCRIPT_ID = "radbridge-content";
// Wakes the worker so it reconnects after Chrome suspends it.
const KEEPALIVE_ALARM = "radbridge-keepalive";

const MEMORY_SAVER_HINT =
  'Chrome unloaded the tab to save memory. Reload it, and add the site to "Always keep these sites active" in chrome://settings/performance.';

let config = { ...DEFAULTS };
let socket = null;
let authenticated = false;
let pingTimer = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
// Why the last connection closed, for the popup.
let lastError = "";

// ---------------------------------------------------------------------------
// Where dictation goes, in order:
//
// 1. A field bound with the right-click menu. If its window closed or
//    reloaded, either fail until a field is bound again, or look for the
//    same field (its saved selector) in every matching window, as set in
//    `whenBindingLost`.
// 2. Otherwise the field from `fieldMode`, in the tab pinned with "Target
//    this tab", or else in any matching tab.
//
// Window focus doesn't decide it: a site can open several windows, such as a
// report window and a viewer popup, and only some of them have the field.
// Tabs without the field are skipped. The binding and the pin are kept in
// session storage so they survive the worker being suspended.

const BIND_MENU = "radbridge-bind";
const UNBIND_MENU = "radbridge-unbind";

const REBIND_HINT =
  'Right-click the report field and choose "Bind RadBridge to this field".';

async function getSession() {
  const { pinnedTabId = null, binding = null } =
    await chrome.storage.session.get(["pinnedTabId", "binding"]);
  return { pinnedTabId, binding };
}

async function matchingTabs() {
  if (!config.urlPattern) return [];
  try {
    return await chrome.tabs.query({ url: config.urlPattern });
  } catch {
    // An invalid pattern, or no permission for it yet.
    return [];
  }
}

async function tabMatches(tabId) {
  return (await matchingTabs()).some((tab) => tab.id === tabId);
}

chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url || change.status === "complete" || "discarded" in change) {
    updateBadge();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { pinnedTabId } = await getSession();
  if (pinnedTabId === tabId) {
    await chrome.storage.session.remove("pinnedTabId");
  }
  // A binding to this tab stays, so the next dictation reports it lost.
  updateBadge();
});

// ---------------------------------------------------------------------------
// Content script registration, for the pages the user configured.

async function registerContentScript() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch {
    // Wasn't registered.
  }
  if (!config.urlPattern) return;
  const granted = await chrome.permissions.contains({
    origins: [config.urlPattern],
  });
  if (!granted) return;

  const script = {
    id: SCRIPT_ID,
    matches: [config.urlPattern],
    js: ["content.js"],
    allFrames: true,
    runAt: "document_idle",
    persistAcrossSessions: true,
  };
  try {
    // Also into about:blank and srcdoc iframes, which have no URL of their own.
    await chrome.scripting.registerContentScripts([
      { ...script, matchOriginAsFallback: true },
    ]);
  } catch {
    // Older Chrome, or a pattern with a path, which that option doesn't allow.
    await chrome.scripting.registerContentScripts([script]);
  }
}

// Injects the content script into a tab that loaded before it was registered.
async function injectInto(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"],
  });
}

// ---------------------------------------------------------------------------
// Talking to the content scripts in a tab's frames.

async function sendToFrame(tabId, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch {
    return null;
  }
}

// Asks every frame of `tab` whether it has the field. Resolves to the frames
// that do, and whether any frame answered (none do before the content script
// is injected).
async function probeTab(tab, options) {
  let frames =
    (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) ?? [];
  if (frames.length === 0) frames = [{ frameId: 0 }];
  const replies = await Promise.all(
    frames.map(({ frameId }) =>
      sendToFrame(tab.id, frameId, { type: "probe", options }),
    ),
  );
  const found = [];
  replies.forEach((reply, order) => {
    if (reply?.found) {
      found.push({
        tab,
        frameId: frames[order].frameId,
        focusedAt: reply.focusedAt,
        order,
      });
    }
  });
  return { found, reachable: replies.some(Boolean) };
}

// The field from `options.fieldMode` in `tabs`: {tab, frameId} or {error}.
// "focused": the field focused most recently. "selector": the most recently
// used tab where the selector finds a field, top frame first.
async function searchTabs(tabs, options, { inject, where }) {
  const live = tabs.filter((tab) => !tab.discarded);
  if (live.length === 0) return { error: MEMORY_SAVER_HINT };

  let probes = await Promise.all(live.map((tab) => probeTab(tab, options)));
  if (inject) {
    // Tabs that loaded before the content script was registered.
    const unreachable = live.filter((_, i) => !probes[i].reachable);
    if (unreachable.length > 0) {
      await Promise.all(
        unreachable.map((tab) => injectInto(tab.id).catch(() => {})),
      );
      probes = await Promise.all(live.map((tab) => probeTab(tab, options)));
    }
  }

  const found = probes.flatMap((p) => p.found);
  if (found.length === 0) {
    return {
      error:
        options.fieldMode === "focused"
          ? `No text field was focused in ${where}. Click into the report field once.`
          : `The field wasn't found in ${where}.`,
    };
  }
  if (options.fieldMode === "focused") {
    found.sort((a, b) => b.focusedAt - a.focusedAt);
  } else {
    // `lastAccessed` is Chrome 121+.
    found.sort(
      (a, b) =>
        (b.tab.lastAccessed ?? 0) - (a.tab.lastAccessed ?? 0) ||
        a.order - b.order,
    );
  }
  return { tab: found[0].tab, frameId: found[0].frameId };
}

// Whether the bound field is still there.
async function bindingAlive(binding) {
  const reply = await sendToFrame(binding.tabId, binding.frameId, {
    type: "probe",
    options: { fieldMode: "bound", bindId: binding.bindId },
  });
  return !!reply?.found;
}

// The field to insert into: {tab, frameId, via} or {error, via}. `via` says
// how it was chosen: "bound", "bound-lost", "pinned" or "search".
async function findTarget(options, { inject = false } = {}) {
  const tabs = await matchingTabs();
  const { pinnedTabId, binding } = await getSession();

  if (binding) {
    const tab = tabs.find((t) => t.id === binding.tabId);
    if (tab && !tab.discarded && (await bindingAlive(binding))) {
      return { tab, frameId: binding.frameId, via: "bound", binding };
    }
    if (tab?.discarded) {
      return { error: MEMORY_SAVER_HINT, via: "bound-lost", binding };
    }
    if (config.whenBindingLost !== "auto" || !config.boundSelector) {
      return {
        error: `The bound field's window was closed or reloaded. ${REBIND_HINT}`,
        via: "bound-lost",
        binding,
      };
    }
    if (tabs.length === 0) {
      return {
        error: "No open tab matches the RadBridge URL pattern.",
        via: "bound-lost",
        binding,
      };
    }
    const found = await searchTabs(
      tabs,
      { ...options, fieldMode: "selector", selector: config.boundSelector },
      { inject, where: "any open RadOS window" },
    );
    return { ...found, via: "bound-lost", binding };
  }

  if (tabs.length === 0) {
    return {
      error: config.urlPattern
        ? "No open tab matches the RadBridge URL pattern."
        : "Set the URL pattern in the RadBridge options.",
      via: "search",
    };
  }
  const pinned = tabs.find((tab) => tab.id === pinnedTabId);
  const found = await searchTabs(pinned ? [pinned] : tabs, options, {
    inject,
    where: pinned ? "the pinned tab" : "any open RadOS window",
  });
  return { ...found, via: pinned ? "pinned" : "search" };
}

// Inserts `text` into the target field. Resolves to {ok, error?}.
async function insertText(text) {
  const options = insertOptions(config);
  const target = await findTarget(options, { inject: true });
  if (target.error) return { ok: false, error: target.error };
  const insertWith =
    target.via === "bound"
      ? { ...options, fieldMode: "bound", bindId: target.binding.bindId }
      : target.via === "bound-lost"
        ? { ...options, fieldMode: "selector", selector: config.boundSelector }
        : options;
  const reply = await sendToFrame(target.tab.id, target.frameId, {
    type: "insert",
    text,
    options: insertWith,
  });
  return reply ?? { ok: false, error: "The target tab didn't respond." };
}

// ---------------------------------------------------------------------------
// Right-click menu: "Bind RadBridge to this field" on text fields of the
// configured pages, and "Unbind RadBridge" while a field is bound. Unlike the
// toolbar button, it's there in popup app windows too.

async function setupMenus() {
  await chrome.contextMenus.removeAll();
  if (!config.urlPattern) return;
  const { binding } = await getSession();
  chrome.contextMenus.create({
    id: BIND_MENU,
    title: "Bind RadBridge to this field",
    contexts: ["editable"],
    documentUrlPatterns: [config.urlPattern],
  });
  chrome.contextMenus.create({
    id: UNBIND_MENU,
    title: "Unbind RadBridge",
    contexts: ["all"],
    documentUrlPatterns: [config.urlPattern],
    visible: !!binding,
  });
}

async function bind(tabId, frameId) {
  const bindId = crypto.randomUUID();
  let reply = await sendToFrame(tabId, frameId, { type: "bind", bindId });
  if (!reply) {
    // The tab loaded before the content script was registered. The field
    // the user right-clicked is still focused, so bind that.
    await injectInto(tabId).catch(() => {});
    reply = await sendToFrame(tabId, frameId, { type: "bind", bindId });
  }
  if (!reply?.ok) return;
  await chrome.storage.session.set({ binding: { tabId, frameId, bindId } });
  await chrome.storage.local.set({ boundSelector: reply.selector });
  chrome.contextMenus.update(UNBIND_MENU, { visible: true });
  updateBadge();
}

async function unbind() {
  const { binding } = await getSession();
  await chrome.storage.session.remove("binding");
  if (binding) {
    sendToFrame(binding.tabId, binding.frameId, { type: "unbind" });
  }
  chrome.contextMenus.update(UNBIND_MENU, { visible: false });
  updateBadge();
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === BIND_MENU && tab?.id != null) {
    bind(tab.id, info.frameId ?? 0);
  } else if (info.menuItemId === UNBIND_MENU) {
    unbind();
  }
});

// ---------------------------------------------------------------------------
// WebSocket connection to Handy.

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function disconnect() {
  clearInterval(pingTimer);
  pingTimer = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  authenticated = false;
}

function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  if (!config.token) {
    lastError = "Paste Handy's token into the RadBridge options.";
    updateBadge();
    return;
  }

  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  } catch (e) {
    lastError = String(e);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    send({ type: "hello", token: config.token, version: PROTOCOL_VERSION });
    pingTimer = setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS);
  };

  ws.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (message.type) {
      case "hello_ok":
        authenticated = true;
        lastError = "";
        reconnectDelay = RECONNECT_MIN_MS;
        updateBadge();
        break;
      case "insert": {
        let result;
        try {
          result = await insertText(String(message.text ?? ""));
        } catch (e) {
          result = { ok: false, error: `RadBridge error: ${e?.message ?? e}` };
        }
        send({
          type: "ack",
          id: message.id,
          ok: result.ok,
          error: result.error,
        });
        break;
      }
      // "pong" needs nothing: receiving it is what keeps the worker alive.
    }
  };

  ws.onclose = () => {
    if (socket !== ws) return;
    lastError = authenticated
      ? "Handy closed the connection."
      : "Handy isn't reachable, or it refused the token.";
    clearInterval(pingTimer);
    pingTimer = null;
    socket = null;
    authenticated = false;
    updateBadge();
    scheduleReconnect();
  };
}

// ---------------------------------------------------------------------------
// Badge: green = connected and target found; amber = connected, no target;
// red = Handy not reachable.

async function updateBadge() {
  let color;
  let text;
  let title;
  if (!authenticated) {
    [color, text, title] = [
      "#d93025",
      "off",
      `RadBridge: ${lastError || "not connected to Handy"}`,
    ];
  } else {
    const target = await findTarget(insertOptions(config));
    if (target.tab) {
      const how = target.via === "bound" ? "bound to a field in" : "target";
      [color, text, title] = [
        "#188038",
        "on",
        `RadBridge: connected, ${how} "${target.tab.title}"`,
      ];
    } else {
      [color, text, title] = [
        "#e37400",
        target.via === "bound-lost" ? "bind" : "tab",
        `RadBridge: connected. ${target.error}`,
      ];
    }
  }
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title });
}

// ---------------------------------------------------------------------------
// Messages from the popup, options page and content scripts.

async function status() {
  const target = await findTarget(insertOptions(config));
  return {
    connected: authenticated,
    error: lastError,
    target: target.tab
      ? { id: target.tab.id, title: target.tab.title, url: target.tab.url }
      : null,
    targetError: target.error ?? "",
    via: target.via,
    bound: !!target.binding,
    pinned: target.via === "pinned",
    config: {
      urlPattern: config.urlPattern,
      fieldMode: config.fieldMode,
      selector: config.selector,
      boundSelector: config.boundSelector,
      whenBindingLost: config.whenBindingLost,
    },
  };
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case "status":
      return status();
    case "pin-tab": {
      if (!(await tabMatches(message.tabId))) {
        return {
          ok: false,
          error: "This tab doesn't match the RadBridge URL pattern.",
        };
      }
      await chrome.storage.session.set({ pinnedTabId: message.tabId });
      updateBadge();
      return { ok: true };
    }
    case "unpin-tab":
      await chrome.storage.session.remove("pinnedTabId");
      updateBadge();
      return { ok: true };
    case "pick-field": {
      if (!(await tabMatches(message.tabId))) {
        return {
          ok: false,
          error: "This tab doesn't match the RadBridge URL pattern.",
        };
      }
      const frames =
        (await chrome.webNavigation.getAllFrames({ tabId: message.tabId })) ??
        [];
      const replies = await Promise.all(
        frames.map(({ frameId }) =>
          sendToFrame(message.tabId, frameId, { type: "pick-start" }),
        ),
      );
      if (!replies.some(Boolean)) {
        await injectInto(message.tabId);
        await Promise.all(
          frames.map(({ frameId }) =>
            sendToFrame(message.tabId, frameId, { type: "pick-start" }),
          ),
        );
      }
      return { ok: true };
    }
    case "picked": {
      // A frame recorded the field the user clicked: stop picking everywhere.
      const tabId = sender.tab?.id;
      if (tabId != null) {
        const frames =
          (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
        frames.forEach(({ frameId }) =>
          sendToFrame(tabId, frameId, { type: "pick-stop" }),
        );
      }
      await chrome.storage.local.set({
        fieldMode: "selector",
        selector: message.selector,
      });
      return { ok: true };
    }
    case "unbind":
      await unbind();
      return { ok: true };
    case "test-insert":
      return insertText(TEST_TEXT);
    case "reconnect":
      disconnect();
      reconnectDelay = RECONNECT_MIN_MS;
      connect();
      return { ok: true };
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content scripts' own probe/insert messages go tab-ward, never here.
  handleMessage(message, sender).then(sendResponse, (e) =>
    sendResponse({ ok: false, error: String(e?.message ?? e) }),
  );
  return true;
});

// ---------------------------------------------------------------------------
// Start-up and settings changes.

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  config = await loadConfig();
  if (changes.urlPattern) {
    await registerContentScript();
    await chrome.storage.session.remove(["pinnedTabId", "binding"]);
    await setupMenus();
  }
  if (changes.port || changes.token) {
    disconnect();
    reconnectDelay = RECONNECT_MIN_MS;
    connect();
  }
  updateBadge();
});

chrome.permissions.onAdded.addListener(() => registerContentScript());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) connect();
});

async function start() {
  config = await loadConfig();
  await setupMenus();
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  connect();
  updateBadge();
}

chrome.runtime.onInstalled.addListener(async () => {
  config = await loadConfig();
  await registerContentScript();
});

// For the end-to-end test and the service worker's DevTools console: the
// right-click menu can't be clicked from a script.
globalThis.radbridgeDebug = { bind, unbind, findTarget };

start();
