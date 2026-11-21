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
// Target tab: a pinned tab, else the matching tab focused most recently.
// Kept in session storage so it survives the worker being suspended.

async function getTabState() {
  const { pinnedTabId = null, lastFocusedTabId = null } =
    await chrome.storage.session.get(["pinnedTabId", "lastFocusedTabId"]);
  return { pinnedTabId, lastFocusedTabId };
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

// The tab dictation goes to, or null.
async function resolveTargetTab() {
  const tabs = await matchingTabs();
  if (tabs.length === 0) return null;
  const { pinnedTabId, lastFocusedTabId } = await getTabState();
  const byId = (id) => tabs.find((tab) => tab.id === id);
  return (
    byId(pinnedTabId) ??
    byId(lastFocusedTabId) ??
    // Most recently used first (`lastAccessed` is Chrome 121+).
    [...tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
  );
}

async function noteFocusedTab(tabId) {
  if (tabId == null || tabId < 0) return;
  if (await tabMatches(tabId)) {
    await chrome.storage.session.set({ lastFocusedTabId: tabId });
    updateBadge();
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => noteFocusedTab(tabId));

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) noteFocusedTab(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === "complete" || "discarded" in change) {
    if (tab.active) noteFocusedTab(tabId);
    updateBadge();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { pinnedTabId, lastFocusedTabId } = await getTabState();
  if (pinnedTabId === tabId) {
    await chrome.storage.session.remove("pinnedTabId");
  }
  if (lastFocusedTabId === tabId) {
    await chrome.storage.session.remove("lastFocusedTabId");
  }
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

// Asks every frame whether it has the field, and returns the frame to use.
async function findFieldFrame(tabId, options) {
  let frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  if (frames.length === 0) frames = [{ frameId: 0 }];
  const probes = await Promise.all(
    frames.map(async ({ frameId }) => ({
      frameId,
      reply: await sendToFrame(tabId, frameId, { type: "probe", options }),
    })),
  );
  const reachable = probes.filter((p) => p.reply);
  const found = reachable.filter((p) => p.reply.found);
  if (found.length === 0) {
    return { frameId: null, reachable: reachable.length > 0 };
  }
  if (options.fieldMode === "focused") {
    // The frame whose field was focused most recently.
    found.sort((a, b) => b.reply.focusedAt - a.reply.focusedAt);
  }
  // Otherwise frames stay in the order Chrome lists them, top frame first.
  return { frameId: found[0].frameId, reachable: true };
}

// Inserts `text` into the target field. Resolves to {ok, error?}.
async function insertText(text) {
  const tab = await resolveTargetTab();
  if (!tab) {
    return {
      ok: false,
      error: config.urlPattern
        ? "No open tab matches the RadBridge URL pattern."
        : "Set the URL pattern in the RadBridge options.",
    };
  }
  if (tab.discarded) return { ok: false, error: MEMORY_SAVER_HINT };

  const options = insertOptions(config);
  let { frameId, reachable } = await findFieldFrame(tab.id, options);
  if (frameId === null && !reachable) {
    // The tab loaded before the content script was registered.
    try {
      await injectInto(tab.id);
      ({ frameId } = await findFieldFrame(tab.id, options));
    } catch {
      return {
        ok: false,
        error: "RadBridge can't reach the target tab. Reload it.",
      };
    }
  }
  if (frameId === null) {
    return {
      ok: false,
      error:
        options.fieldMode === "focused"
          ? "Click into the report field once so RadBridge knows where to insert."
          : "The configured field wasn't found in the target tab.",
    };
  }

  const reply = await sendToFrame(tab.id, frameId, {
    type: "insert",
    text,
    options,
  });
  return reply ?? { ok: false, error: "The target tab didn't respond." };
}

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
    const tab = await resolveTargetTab();
    if (tab && !tab.discarded) {
      [color, text, title] = [
        "#188038",
        "on",
        `RadBridge: connected, target "${tab.title}"`,
      ];
    } else {
      [color, text, title] = [
        "#e37400",
        "tab",
        "RadBridge: connected, no target tab",
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
  const tab = await resolveTargetTab();
  const { pinnedTabId } = await getTabState();
  return {
    connected: authenticated,
    error: lastError,
    target: tab
      ? { id: tab.id, title: tab.title, url: tab.url, discarded: tab.discarded }
      : null,
    pinned: tab != null && tab.id === pinnedTabId,
    config: {
      urlPattern: config.urlPattern,
      fieldMode: config.fieldMode,
      selector: config.selector,
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
    await chrome.storage.session.remove(["pinnedTabId", "lastFocusedTabId"]);
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
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  connect();
  updateBadge();
}

chrome.runtime.onInstalled.addListener(async () => {
  config = await loadConfig();
  await registerContentScript();
});

start();
