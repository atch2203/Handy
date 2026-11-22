// End-to-end test of the RadBridge extension in headless Chrome, with a mock
// of Handy's WebSocket server. Covers the service worker: connecting with the
// token, choosing the tab when a same-site viewer popup is focused, and the
// right-click binding (bound field, then rebind-or-auto when it's lost).
//
//   node extensions/radbridge/test/e2e-test.mjs
//
// Set CHROME to the browser binary if it isn't google-chrome. Needs Node 22+.
// It loads a copy of the extension whose manifest grants http://127.0.0.1/*
// up front, since a script can't click Chrome's permission prompt.
import { createServer } from "http";
import { createHash, randomUUID } from "crypto";
import { spawn } from "child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, extname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = "e2e-token";
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

// --- Test page server -------------------------------------------------------
const pages = createServer((req, res) => {
  const path =
    new URL(req.url, "http://x").pathname.replace(/^\/+/, "") || "index.html";
  try {
    const body = readFileSync(join(here, path));
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => pages.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${pages.address().port}`;

// --- Mock Handy: a minimal WebSocket server ----------------------------------
const handy = {
  socket: null,
  authenticated: false,
  acks: new Map(),
  origin: null,
};
const wsServer = createServer();
wsServer.on("upgrade", (req, socket) => {
  handy.origin = req.headers.origin;
  const accept = createHash("sha1")
    .update(
      req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
    )
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = buffer[1] & 0x80;
      const total = offset + (masked ? 4 : 0) + len;
      if (buffer.length < total) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.subarray(total - len, total));
      if (mask)
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(total);
      if (opcode === 8) return socket.end();
      if (opcode !== 1) continue;
      const message = JSON.parse(payload.toString());
      if (message.type === "hello") {
        if (message.token !== TOKEN) return socket.end();
        handy.socket = socket;
        handy.authenticated = true;
        send({ type: "hello_ok", version: 1 });
      } else if (message.type === "ping") {
        send({ type: "pong" });
      } else if (message.type === "ack") {
        handy.acks.get(message.id)?.(message);
      }
    }
  });
});
function send(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  handy.socket.write(Buffer.concat([header, payload]));
}
function insert(text) {
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: "no ack in 2 s" }),
      2000,
    );
    handy.acks.set(id, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
    send({ type: "insert", id, text });
  });
}
await new Promise((r) => wsServer.listen(0, "127.0.0.1", r));
const handyPort = wsServer.address().port;

// --- Extension copy with the test page's host permission granted ------------
const work = mkdtempSync(join(tmpdir(), "radbridge-e2e-"));
const extDir = join(work, "extension");
cpSync(join(here, ".."), extDir, {
  recursive: true,
  filter: (src) => !src.includes(`${here}/`),
});
const manifest = JSON.parse(
  readFileSync(join(extDir, "manifest.json"), "utf8"),
);
manifest.host_permissions = ["http://127.0.0.1/*"];
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest));

// --- Chrome over a CDP pipe (needed to load an unpacked extension) ----------
const chrome = spawn(
  process.env.CHROME ?? "google-chrome",
  [
    "--headless=new",
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${join(work, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
);
const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];
let nextId = 1;
const pending = new Map();
let incoming = "";
fromChrome.on("data", (chunk) => {
  incoming += chunk;
  let end;
  while ((end = incoming.indexOf("\0")) >= 0) {
    const message = JSON.parse(incoming.slice(0, end));
    incoming = incoming.slice(end + 1);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) =>
      m.error
        ? reject(new Error(`${method}: ${m.error.message}`))
        : resolve(m.result),
    );
    toChrome.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}
async function evaluate(sessionId, expression) {
  const r = await cdp(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails)
    throw new Error(
      r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
    );
  return r.result.value;
}
async function attach(targetId) {
  const { sessionId } = await cdp("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  return sessionId;
}
async function waitFor(fn, what, ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

function cleanup() {
  chrome.kill();
  pages.close();
  wsServer.close();
  handy.socket?.destroy();
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

try {
  const { id: extensionId } = await cdp("Extensions.loadUnpacked", {
    path: extDir,
  });
  const worker = await waitFor(async () => {
    const { targetInfos } = await cdp("Target.getTargets");
    return targetInfos.find(
      (t) => t.type === "service_worker" && t.url.includes(extensionId),
    );
  }, "the service worker");
  const sw = await attach(worker.targetId);

  await evaluate(
    sw,
    `chrome.storage.local.set(${JSON.stringify({ token: TOKEN, port: handyPort, urlPattern: "http://127.0.0.1/*" })})`,
  );
  await waitFor(() => handy.authenticated, "the extension to connect");
  check("connects and authenticates", true);
  check(
    "sends an extension origin",
    handy.origin?.startsWith("chrome-extension://"),
    handy.origin,
  );

  // Report window, then a same-site viewer popup that takes focus.
  const { targetId: reportId } = await cdp("Target.createTarget", {
    url: `${base}/index.html`,
  });
  const report = await attach(reportId);
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }, report);
  await waitFor(
    () => evaluate(report, "document.readyState === 'complete'"),
    "the report page",
  );
  await sleep(500); // content script at document_idle
  const field = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const textOf = (sel) =>
    evaluate(
      report,
      `(() => { const el = ${field(sel)}; return el.isContentEditable ? el.innerText : el.value; })()`,
    );

  await evaluate(report, `${field("#plain-textarea")}.focus()`);
  const { targetId: viewerId } = await cdp("Target.createTarget", {
    url: `${base}/viewer.html`,
    newWindow: true,
  });
  await cdp("Target.activateTarget", { targetId: viewerId });
  await sleep(500);

  let ack = await insert("one");
  check(
    "viewer focused: inserts into the report's last focused field",
    ack.ok && (await textOf("#plain-textarea")) === "one",
    JSON.stringify(ack),
  );

  // Bind the model editor, as the right-click menu does.
  const { tabId: reportTabId } = await evaluate(
    sw,
    `chrome.tabs.query({ url: "${base}/index.html" }).then(([t]) => ({ tabId: t.id }))`,
  );
  await evaluate(
    report,
    `${field("#model-editor")}.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true }))`,
  );
  await evaluate(sw, `radbridgeDebug.bind(${reportTabId}, 0)`);
  const bound = await evaluate(sw, `chrome.storage.local.get("boundSelector")`);
  check(
    "binding saves the field's selector",
    bound.boundSelector === "#model-editor",
    bound.boundSelector,
  );

  ack = await insert("two");
  check(
    "bound: inserts into the bound field, not the last focused one",
    ack.ok &&
      (await textOf("#model-editor")) === "two" &&
      (await textOf("#plain-textarea")) === "one",
    JSON.stringify(ack),
  );

  // Reload the report window: the binding is lost.
  await cdp("Page.reload", {}, report);
  await sleep(300);
  await waitFor(
    () => evaluate(report, "document.readyState === 'complete'"),
    "the reload",
  );
  await sleep(500);
  ack = await insert("three");
  check(
    "binding lost, rebind mode: fails and asks to bind again",
    !ack.ok && /Bind RadBridge/.test(ack.error ?? ""),
    JSON.stringify(ack),
  );
  check(
    "rebind mode: nothing was inserted",
    (await textOf("#model-editor")) === "",
  );

  await evaluate(sw, `chrome.storage.local.set({ whenBindingLost: "auto" })`);
  await sleep(200);
  ack = await insert("four");
  check(
    "binding lost, auto mode: finds the same field again",
    ack.ok && (await textOf("#model-editor")) === "four",
    JSON.stringify(ack),
  );

  await evaluate(sw, `radbridgeDebug.unbind()`);
  await evaluate(
    sw,
    `chrome.storage.local.set({ fieldMode: "selector", selector: "#plain-textarea" })`,
  );
  await sleep(200);
  ack = await insert("five");
  check(
    "unbound selector mode skips the viewer",
    ack.ok && (await textOf("#plain-textarea")) === "five",
    JSON.stringify(ack),
  );
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}`);
} finally {
  cleanup();
}

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
