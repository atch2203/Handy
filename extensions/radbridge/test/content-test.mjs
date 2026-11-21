// Automated check of content.js against the test page, in headless Chrome.
// It covers the insert logic only (no service worker, no Handy):
//
//   node extensions/radbridge/test/content-test.mjs
//
// Set CHROME to the browser binary if it isn't google-chrome. Needs Node 22+.
import { createServer } from "http";
import { spawn } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, extname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const content = readFileSync(join(here, "..", "content.js"), "utf8");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

// Serve this folder.
const server = createServer((req, res) => {
  const file = join(
    here,
    new URL(req.url, "http://x").pathname.replace(/^\/+/, "") || "index.html",
  );
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;

// Launch headless Chrome with a throwaway profile.
const profile = mkdtempSync(join(tmpdir(), "radbridge-test-"));
const chrome = spawn(
  process.env.CHROME ?? "google-chrome",
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const cdpPort = await new Promise((resolve, reject) => {
  let log = "";
  chrome.stderr.on("data", (d) => {
    log += d;
    const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(log);
    if (m) resolve(m[1]);
  });
  chrome.on("exit", () => reject(new Error("Chrome exited:\n" + log)));
});
function cleanup() {
  chrome.kill();
  server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}

const targets = await (
  await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 1;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const cmd = (method, params = {}) =>
  new Promise((r) => {
    const id = nextId++;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await cmd("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails)
    throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};

await cmd("Page.enable");
await cmd("Emulation.setFocusEmulationEnabled", { enabled: true });
await cmd("Page.navigate", { url: pageUrl });
await new Promise((r) => setTimeout(r, 1500));

// Fake chrome.runtime: captures the onMessage listener so the test can call it.
await evaluate(`
  globalThis.chrome = { runtime: { onMessage: { addListener(fn) { globalThis.__listener = fn; } }, sendMessage(m) { globalThis.__sent = m; } } };
`);
await evaluate(content);
await evaluate(`globalThis.send = (message) => new Promise((resolve) => {
  globalThis.__listener(message, {}, resolve);
});`);

const base = {
  fieldMode: "selector",
  position: "end",
  separator: "space",
  strategy: "auto",
  flash: false,
};
const deep = (sel) =>
  `(() => { const parts = ${JSON.stringify(sel)}.split(">>>").map(s=>s.trim()); let root = document, el; for (let i=0;i<parts.length;i++){ el = root.querySelector(parts[i]); if (i<parts.length-1) root = el.contentDocument ?? el.shadowRoot; } return el; })()`;
const text = (sel) =>
  evaluate(
    `(() => { const el = ${deep(sel)}; return el.isContentEditable ? el.innerText : el.value; })()`,
  );

let failures = 0;
async function check(name, sel, options, expected, extraCheck) {
  const reply = await evaluate(
    `send({ type: "insert", text: "2.5 cm lesion", options: ${JSON.stringify({ ...base, selector: sel, ...options })} })`,
  );
  const got = await text(sel);
  let ok = reply?.ok && got === expected;
  let extra = "";
  if (ok && extraCheck) {
    extra = await evaluate(extraCheck);
    ok = extra === expected;
  }
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}: reply=${JSON.stringify(reply)} field=${JSON.stringify(got)}${extraCheck ? ` model=${JSON.stringify(extra)}` : ""}`,
  );
}

// Seed some fields with existing text.
await evaluate(`document.getElementById("plain-textarea").value = "Findings:"`);
await check(
  "plain textarea, append + space",
  "#plain-textarea",
  {},
  "Findings: 2.5 cm lesion",
);
await check(
  "controlled textarea (React-style)",
  "#controlled-textarea",
  {},
  "2.5 cm lesion",
  `new Promise(r => setTimeout(() => r(JSON.parse(document.getElementById("controlled-model").textContent)), 50))`,
);
await check(
  "controlled textarea again (separator)",
  "#controlled-textarea",
  {},
  "2.5 cm lesion 2.5 cm lesion",
  `new Promise(r => setTimeout(() => r(JSON.parse(document.getElementById("controlled-model").textContent)), 50))`,
);
await check("plain contenteditable", "#plain-editable", {}, "2.5 cm lesion");
await check(
  "model editor (beforeinput-only)",
  "#model-editor",
  {},
  "2.5 cm lesion",
  `new Promise(r => setTimeout(() => r(JSON.parse(document.getElementById("model-editor-model").textContent)), 50))`,
);
await check(
  "model editor second insert",
  "#model-editor",
  {},
  "2.5 cm lesion 2.5 cm lesion",
  `new Promise(r => setTimeout(() => r(JSON.parse(document.getElementById("model-editor-model").textContent)), 50))`,
);
await check(
  "same-origin iframe editor",
  "#editor-frame >>> #framed-editor",
  {},
  "2.5 cm lesion",
);
await check(
  "srcdoc iframe textarea",
  "#srcdoc-frame >>> #srcdoc-textarea",
  {},
  "2.5 cm lesion",
);
await check(
  "shadow root textarea",
  "#shadow-host >>> #shadow-textarea",
  {},
  "2.5 cm lesion",
);
await check(
  "newline separator",
  "#plain-textarea",
  { separator: "newline" },
  "Findings: 2.5 cm lesion\n2.5 cm lesion",
);

// Caret mode: caret after "AB" in "AB CD".
await evaluate(
  `(() => { const el = document.getElementById("plain-textarea"); el.value = "AB CD"; el.setSelectionRange(2,2); })()`,
);
await check(
  "caret mode textarea",
  "#plain-textarea",
  { position: "caret" },
  "AB 2.5 cm lesion CD",
);

// Append mode restores the user's selection.
await evaluate(
  `(() => { const el = document.getElementById("plain-textarea"); el.value = "XY"; el.focus(); el.setSelectionRange(1,1); })()`,
);
await check(
  "append keeps selection",
  "#plain-textarea",
  {},
  "XY 2.5 cm lesion",
);
const sel = await evaluate(
  `[document.getElementById("plain-textarea").selectionStart, document.getElementById("plain-textarea").selectionEnd].join()`,
);
console.log(`${sel === "1,1" ? "PASS" : "FAIL"} selection restored: ${sel}`);
if (sel !== "1,1") failures++;

// Focus mode: last focused field.
await evaluate(
  `document.getElementById("plain-editable").focus(); document.body.focus();`,
);
const probe = await evaluate(
  `send({ type: "probe", options: { fieldMode: "focused" } })`,
);
console.log(`${probe.found ? "PASS" : "FAIL"} probe finds last focused field`);
if (!probe.found) failures++;
await check(
  "last focused field",
  "#plain-editable",
  { fieldMode: "focused" },
  "2.5 cm lesion 2.5 cm lesion",
);

// Shadow root focus tracking.
await evaluate(
  `document.getElementById("shadow-host").shadowRoot.getElementById("shadow-textarea").focus()`,
);
await check(
  "last focused (shadow)",
  "#shadow-host >>> #shadow-textarea",
  { fieldMode: "focused" },
  "2.5 cm lesion 2.5 cm lesion",
);

// Not found.
const missing = await evaluate(
  `send({ type: "insert", text: "x", options: ${JSON.stringify({ ...base, selector: "#nope" })} })`,
);
console.log(
  `${!missing.ok ? "PASS" : "FAIL"} missing field -> ${JSON.stringify(missing)}`,
);
if (missing.ok) failures++;
const checkbox = await evaluate(
  `send({ type: "insert", text: "x", options: ${JSON.stringify({ ...base, selector: "#not-text" })} })`,
);
console.log(
  `${!checkbox.ok ? "PASS" : "FAIL"} checkbox refused -> ${JSON.stringify(checkbox)}`,
);
if (checkbox.ok) failures++;

// Picker selectors.
const picked = await evaluate(`(() => {
  const out = {};
  const pick = (el) => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true })); return globalThis.__sent?.selector; };
  send({ type: "pick-start" }); out.model = pick(document.getElementById("model-editor"));
  send({ type: "pick-start" }); out.shadow = pick(document.getElementById("shadow-host").shadowRoot.getElementById("shadow-textarea"));
  send({ type: "pick-start" }); out.plain = pick(document.getElementById("plain-textarea"));
  return out;
})()`);
console.log("picked selectors:", JSON.stringify(picked));
const expectPick = {
  model: "#model-editor",
  shadow: "#shadow-host >>> #shadow-textarea",
  plain: "#plain-textarea",
};
for (const k of Object.keys(expectPick)) {
  const ok = picked[k] === expectPick[k];
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} pick ${k}`);
}

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
ws.close();
cleanup();
process.exit(failures ? 1 : 0);
