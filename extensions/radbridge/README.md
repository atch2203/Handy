# RadBridge

A Chrome/Edge extension (Manifest V3) that inserts text dictated in [Handy](../../README.md) into a field of a web page, such as the report field of a browser-based RIS, **without moving keyboard focus** away from the window you are working in.

Handy runs a WebSocket server on `127.0.0.1` when its paste method is **Send to Browser Extension**. RadBridge's service worker connects to it, authenticates with a shared token, and inserts each dictation into the target tab. It then tells Handy whether the insert worked. If it didn't, Handy puts the text on the clipboard and shows a notice.

End-user setup is in [`docs/radbridge-setup.md`](../../docs/radbridge-setup.md).

## Files

| File              | What it does                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`   | MV3 manifest. No host permissions up front: access to the configured pages is requested when the options are saved.                            |
| `background.js`   | Service worker: the WebSocket client (hello, 20 s pings, reconnect with 1 s to 30 s backoff), target tab tracking, routing inserts, the badge. |
| `content.js`      | Runs in every frame of the configured pages: remembers the last focused field, inserts text, runs the field picker.                            |
| `options.html/js` | All configuration, stored in `chrome.storage.local`.                                                                                           |
| `popup.html/js`   | Connection status, the target tab, **Target this tab**, **Pick field**.                                                                        |
| `shared.js`       | Defaults and helpers shared by the worker and the pages.                                                                                       |
| `test/`           | A local test page with every kind of field, and an automated content script test.                                                              |

No build step: the files load as they are.

## Protocol

JSON text frames over `ws://127.0.0.1:<port>` (default port 47813).

| Direction         | Message                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| extension → Handy | `{"type":"hello","token":"…","version":1}`. Must be the first message, or Handy closes the connection.                   |
| Handy → extension | `{"type":"hello_ok","version":1}`                                                                                        |
| extension → Handy | `{"type":"ping"}` every 20 s; Handy answers `{"type":"pong"}`. Message traffic keeps the MV3 worker alive (Chrome 116+). |
| Handy → extension | `{"type":"insert","id":"<uuid>","text":"…"}`                                                                             |
| extension → Handy | `{"type":"ack","id":"<uuid>","ok":true}` or `{"type":"ack","id":"…","ok":false,"error":"…"}`                             |

Handy refuses the handshake unless `Origin` starts with `chrome-extension://` or `extension://`. Web pages can't connect, even though any page can open a WebSocket to localhost. Handy keeps one authenticated client; a newer one replaces it. Regenerating the token in Handy disconnects the extension.

## How it picks the tab and field

**Bound field.** Right-click a text field in a matching page and choose **Bind RadBridge to this field**. Dictation then goes to that exact field, whichever window is focused, until you choose **Unbind RadBridge** (right-click menu or popup). The menu works in popup app windows, which have no toolbar button. A binding overrides everything below. The menu doesn't appear in `about:blank` or `srcdoc` iframes, whose address doesn't match the URL pattern; use a selector for a field in one of those. It ends when its window closes or reloads, and then the **When the bound field's window closes or reloads** option decides:

- **Stop until I bind a field again** (default): dictation fails, so Handy puts it on the clipboard, until you bind a field again.
- **Find the same field in any open RadOS window:** binding also saved a selector for the field. RadBridge looks for it in every matching window, as in selector mode below.

**Without a binding**, RadBridge asks every frame of every matching tab whether it has the field, and skips tabs that don't. A same-site viewer popup without text fields never becomes the target. With **Target this tab**, only the pinned tab is asked. A tab unloaded by Memory Saver is reported as an error and is never reloaded. Which field, set in the options:

- **Last focused field** (default): the `textarea`, text `input` or `contenteditable` focused most recently in any matching tab or frame, open shadow roots included. Click into the report field once after opening it. A text box in another window of the same site, once typed into, becomes the most recent one, so prefer a binding or a selector.
- **CSS selector:** `>>>` steps into a same-origin iframe or an open shadow root, for example `iframe#editor >>> .ql-editor` or `report-editor >>> textarea`. **Pick field** in the popup writes one for you. It prefers `id`, then `name`, `aria-label`, `role`, `placeholder` or `data-*`, then a short structural path. The most recently used tab where it finds a field wins.

**Insert:** with the default **Automatic** method, RadBridge tries these in order. It moves to the next one only if the field's text didn't change, so text is never inserted twice.

1. `textarea`/`input`: the native `value` setter, then `input` and `change` events. React-controlled fields see the change.
2. `contenteditable`: focus the field inside the page (this doesn't move OS focus), put the caret at the end or keep it, and `execCommand('insertText')`. Editors that watch the page, like ProseMirror, pick the change up, and undo works.
3. A synthetic `paste` event carrying `text/plain`.
4. A synthetic `beforeinput` with `inputType: 'insertText'` and target ranges saying where to insert.

**Slate editors** (`[data-slate-editor]`, as in RadOS) get only 4, then 3. Slate keeps its own model and redraws from it, and Chrome fires no `beforeinput` for `execCommand`. So text inserted with `execCommand` shows on the page, but Slate never sees it, and it vanishes the next time the user types. Chosen methods are also checked against the page only, so "the text changed" can't tell these apart; that's why Slate is detected up front. Separators ignore Slate's zero-width characters and `contenteditable="false"` parts such as placeholders.

RadBridge never presses Enter, submits a form or clicks anything. In append mode it restores the field's selection and the page's focused element afterwards. It never logs or stores dictated text; the only stored data is the configuration.

## Automated tests

Both run in headless Chrome and need Node 22+. Set `CHROME=/path/to/chrome` if it isn't `google-chrome`.

```bash
node extensions/radbridge/test/content-test.mjs
node extensions/radbridge/test/e2e-test.mjs
```

- `content-test.mjs` checks `content.js` against the test page: each field type including a real Slate editor (text must reach its model and survive the user typing), append and caret modes, separators, selection restore, last-focused tracking and picked selectors.
- `e2e-test.mjs` loads the extension with a mock of Handy's WebSocket server. It checks the token handshake, dictation while a same-site viewer popup is focused, binding a field, and both "binding lost" options after a reload.

Neither covers real OS focus, Memory Saver, or the right-click menu itself (the test calls the same code the menu does). The manual checklist below covers those.

## Manual test checklist

Serve the test page, from the repository root:

```bash
npx serve extensions/radbridge/test     # or: python3 -m http.server -d extensions/radbridge/test 3000
```

In the RadBridge options set the URL pattern to `http://localhost/*` (match patterns ignore the port) and save. Set Handy's paste method to **Send to Browser Extension** and paste its token into the options. Then check each item, dictating with Handy's shortcut:

**Every field type**, with **Last focused field** and again with a **picked** selector:

- [ ] 1 plain textarea
- [ ] 2 React-style controlled textarea: the "Model" line matches the field
- [ ] 3 plain contenteditable
- [ ] 4 model-based editor: the "Model" line matches the field
- [ ] 5 editor in a same-origin iframe
- [ ] 6 textarea in a srcdoc iframe
- [ ] 7 textarea in an open shadow root
- [ ] 8 Slate editor: the "Model" line matches the field, and the text stays when you type in the field afterwards

**Focus.** For each field type above:

- [ ] The test page is a background tab, and another tab in the same window is active. The text arrives.
- [ ] Another application's window is focused, such as a text editor standing in for the image viewer. The text arrives, and the keyboard focus stays in that other application: type right after dictating to check.

**Windows and binding:**

- [ ] Open the viewer popup with the button on the test page and click into it, after clicking a field on the test page. Dictation reaches the test page.
- [ ] In the viewer popup, right-click: there's no Bind item, since it has no text field. On the test page, right-click a field and choose **Bind RadBridge to this field**. The field flashes, and dictation goes there even after you click into another field.
- [ ] Reload the test page. With **Stop until I bind a field again**, dictation fails with "Copied to Clipboard Instead" and a message to bind again. With **Find the same field…**, it reaches the same field.
- [ ] **Unbind RadBridge** from the right-click menu and from the popup.

**Position:**

- [ ] **Append to the end:** the text goes after the existing text, with a space when needed. The caret and selection you had in the field come back.
- [ ] **At the caret:** the text goes where the caret was.
- [ ] Separator **A new line** and **Nothing**.

**Connection:**

- [ ] Quit and restart Handy. The badge turns red, then green within 30 s without touching the browser, and dictation works again.
- [ ] Leave the browser idle for 5+ minutes, then dictate. It works on the first try, because the service worker stayed alive or reconnected.
- [ ] Put a wrong token in the options. The badge stays red, and the popup says Handy refused the token. Dictation falls back to the clipboard, with a "Copied to Clipboard Instead" notice in Handy.
- [ ] Regenerate the token in Handy. The extension disconnects until it gets the new token.
- [ ] Close the target tab and dictate. Handy shows "Copied to Clipboard Instead" with "No open tab matches…", and the text is on the clipboard.
- [ ] Discard the tab (`chrome://discards`, **Urgent discard**) and dictate. The error mentions Memory Saver.
- [ ] **Test insert** on the options page inserts `[RadBridge test]`.
- [ ] The badge is green when connected with a target, amber when connected without one, and red when Handy isn't reachable.

**Security:**

- [ ] From the browser console of an ordinary web page, `new WebSocket("ws://127.0.0.1:47813")` fails, because Handy refuses its origin.

Repeat the checklist in Edge.
