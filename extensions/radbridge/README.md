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

**Tab:** the tab pinned with **Target this tab**, if it's still open. Otherwise the matching tab focused most recently, then the matching tab used most recently. A tab unloaded by Memory Saver is reported as an error and is never reloaded.

**Field**, set in the options:

- **Last focused field** (default): the last `textarea`, text `input` or `contenteditable` focused in any frame of the tab, open shadow roots included. Click into the report field once after opening it.
- **CSS selector:** `>>>` steps into a same-origin iframe or an open shadow root, for example `iframe#editor >>> .ql-editor` or `report-editor >>> textarea`. **Pick field** in the popup writes one for you. It prefers `id`, then `name`, `aria-label`, `role`, `placeholder` or `data-*`, then a short structural path.

**Insert:** with the default **Automatic** method, RadBridge tries these in order. It moves to the next one only if the field's text didn't change, so text is never inserted twice.

1. `textarea`/`input`: the native `value` setter, then `input` and `change` events. React-controlled fields see the change.
2. `contenteditable`: focus the field inside the page (this doesn't move OS focus), put the caret at the end or keep it, and `execCommand('insertText')`. Rich text editors get real `beforeinput`/`input` events, and undo works.
3. A synthetic `paste` event carrying `text/plain`.
4. A synthetic `beforeinput` with `inputType: 'insertText'`.

RadBridge never presses Enter, submits a form or clicks anything. In append mode it restores the field's selection and the page's focused element afterwards. It never logs or stores dictated text; the only stored data is the configuration.

## Automated test

Checks `content.js` against the test page in headless Chrome. It covers each field type, append and caret modes, separators, selection restore, last-focused tracking and picked selectors.

```bash
node extensions/radbridge/test/content-test.mjs   # Node 22+; CHROME=/path/to/chrome if needed
```

It doesn't cover the service worker, the connection to Handy, background tabs or real focus. The manual checklist below covers those.

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

**Focus.** For each field type above:

- [ ] The test page is a background tab, and another tab in the same window is active. The text arrives.
- [ ] Another application's window is focused, such as a text editor standing in for the image viewer. The text arrives, and the keyboard focus stays in that other application: type right after dictating to check.

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
