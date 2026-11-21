// RadBridge content script. Runs in every frame of the configured pages.
//
// - Remembers the last text field focused in this frame (open shadow roots
//   included), for the "last focused field" mode.
// - Answers the service worker's `probe` (is the field in this frame?) and
//   `insert` (put text in it) messages.
// - Runs the "Pick field" picker.
//
// Never presses Enter, submits or clicks anything, and never logs or stores
// dictated text.

(() => {
  if (globalThis.__radbridgeLoaded) return;
  globalThis.__radbridgeLoaded = true;

  const TEXT_INPUT_TYPES = new Set([
    "text",
    "search",
    "url",
    "tel",
    "email",
    "",
  ]);
  // How long an editor gets to update after an insert before it's checked.
  const SETTLE_MS = 30;

  // ---------------------------------------------------------------------------
  // Finding fields

  // Checks use tag names, not instanceof: an element in a same-origin iframe
  // comes from that iframe's window, so instanceof would fail.
  const isElement = (el) => el?.nodeType === Node.ELEMENT_NODE;
  const isValueField = (el) =>
    el.localName === "textarea" || el.localName === "input";
  const isShadowRoot = (node) =>
    node?.nodeType === Node.DOCUMENT_FRAGMENT_NODE && !!node.host;

  function isTextField(el) {
    if (!isElement(el)) return false;
    if (el.localName === "textarea") return !el.readOnly && !el.disabled;
    if (el.localName === "input") {
      return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
    }
    return el.isContentEditable;
  }

  // The field `el` belongs to: itself for inputs, or the outermost element of
  // a contenteditable region (a click often lands on a <p> inside it).
  function fieldFor(el) {
    if (!isElement(el)) return null;
    if (isValueField(el)) return isTextField(el) ? el : null;
    if (!el.isContentEditable) return null;
    let root = el;
    while (root.parentElement?.isContentEditable) root = root.parentElement;
    return root;
  }

  // Resolves a selector whose ">>>" segments step into an iframe's document or
  // an element's open shadow root. Only reaches same-origin iframes.
  function resolveSelector(selector) {
    const segments = selector
      .split(">>>")
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) return null;
    let root = document;
    for (let i = 0; i < segments.length; i++) {
      let el;
      try {
        el = root.querySelector(segments[i]);
      } catch {
        return null; // Invalid selector.
      }
      if (!el) return null;
      if (i === segments.length - 1)
        return fieldFor(el) ?? (isTextField(el) ? el : null);
      if (el.localName === "iframe" || el.localName === "frame") {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {
          // Cross-origin.
        }
        if (!doc) return null;
        root = doc;
      } else if (el.shadowRoot) {
        root = el.shadowRoot;
      } else {
        root = el;
      }
    }
    return null;
  }

  // Last focused field in this frame.
  let lastField = null;
  let lastFocusedAt = 0;
  // Caret/selection in a contenteditable field when it lost focus.
  let lastRange = null;

  document.addEventListener(
    "focusin",
    (event) => {
      // The real target, even inside an open shadow root.
      const field = fieldFor(event.composedPath()[0]);
      if (field) {
        lastField = field;
        lastFocusedAt = Date.now();
      }
    },
    true,
  );

  document.addEventListener(
    "focusout",
    (event) => {
      const field = fieldFor(event.composedPath()[0]);
      if (field && field.isContentEditable) {
        const selection = selectionFor(field);
        if (
          selection?.rangeCount &&
          field.contains(selection.getRangeAt(0).startContainer)
        ) {
          lastRange = selection.getRangeAt(0).cloneRange();
        }
      }
    },
    true,
  );

  function findField(options) {
    if (options.fieldMode === "selector") {
      return options.selector ? resolveSelector(options.selector) : null;
    }
    return lastField?.isConnected && isTextField(lastField) ? lastField : null;
  }

  // ---------------------------------------------------------------------------
  // Inserting

  function selectionFor(el) {
    const root = el.getRootNode();
    // Chrome gives shadow roots their own getSelection().
    if (isShadowRoot(root) && typeof root.getSelection === "function") {
      return root.getSelection();
    }
    return el.ownerDocument.getSelection();
  }

  function textOf(el) {
    return el.isContentEditable ? el.innerText : el.value;
  }

  // The deepest focused element, through shadow roots.
  function deepActiveElement(doc) {
    let el = doc.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function separatorFor(before, options) {
    if (!before || /\s$/.test(before) || options.separator === "none")
      return "";
    return options.separator === "newline" ? "\n" : " ";
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 1. <textarea>/<input>: the native value setter, so React-controlled
  //    inputs see the change, then input/change events.
  function insertByValue(el, text, options) {
    if (el.isContentEditable) return false;
    const win = el.ownerDocument.defaultView;
    const proto =
      el.localName === "textarea"
        ? win.HTMLTextAreaElement.prototype
        : win.HTMLInputElement.prototype;
    const setValue = Object.getOwnPropertyDescriptor(proto, "value").set;
    const value = el.value;
    const atCaret = options.position === "caret" && el.selectionStart != null;
    const start = atCaret ? el.selectionStart : value.length;
    const end = atCaret ? el.selectionEnd : value.length;
    const insert = separatorFor(value.slice(0, start), options) + text;
    setValue.call(el, value.slice(0, start) + insert + value.slice(end));
    if (atCaret) {
      const caret = start + insert.length;
      el.setSelectionRange(caret, caret);
    }
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: insert,
      }),
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Puts the selection where the text should go in a contenteditable field.
  // Returns the text to insert, separator included.
  function placeCaret(el, text, options) {
    const selection = selectionFor(el);
    let range = null;
    if (options.position === "caret") {
      if (
        selection.rangeCount &&
        el.contains(selection.getRangeAt(0).startContainer)
      ) {
        range = selection.getRangeAt(0);
      } else if (lastRange && el.contains(lastRange.startContainer)) {
        range = lastRange;
      }
    }
    if (!range) {
      range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    // Text before the caret, to decide the separator.
    const beforeRange = el.ownerDocument.createRange();
    beforeRange.selectNodeContents(el);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    return separatorFor(beforeRange.toString(), options) + text;
  }

  // 2. contenteditable: execCommand fires native beforeinput/input, so rich
  //    text editors update their own state and undo works.
  function insertByExecCommand(el, text, options) {
    if (!el.isContentEditable) return false;
    el.focus({ preventScroll: true });
    const insert = placeCaret(el, text, options);
    // Its return value isn't trusted: an editor that cancels beforeinput and
    // applies the text itself makes it return false. The caller checks the
    // field's text instead.
    el.ownerDocument.execCommand("insertText", false, insert);
    return true;
  }

  // 3. A synthetic paste, which many editors handle.
  function insertByPaste(el, text, options) {
    el.focus({ preventScroll: true });
    const insert = el.isContentEditable ? placeCaret(el, text, options) : text;
    const data = new DataTransfer();
    data.setData("text/plain", insert);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    return true;
  }

  // 4. beforeinput insertText, for editors that build their model from it.
  function insertByBeforeInput(el, text, options) {
    el.focus({ preventScroll: true });
    const insert = el.isContentEditable ? placeCaret(el, text, options) : text;
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: insert,
        bubbles: true,
        cancelable: true,
      }),
    );
    return true;
  }

  const STRATEGIES = {
    value: insertByValue,
    execCommand: insertByExecCommand,
    paste: insertByPaste,
    beforeinput: insertByBeforeInput,
  };

  function saveState(el) {
    const doc = el.ownerDocument;
    const state = { active: deepActiveElement(doc), scrollTop: el.scrollTop };
    if (!el.isContentEditable) {
      state.start = el.selectionStart;
      state.end = el.selectionEnd;
    } else {
      const selection = selectionFor(el);
      state.ranges = [];
      for (let i = 0; i < selection.rangeCount; i++) {
        state.ranges.push(selection.getRangeAt(i).cloneRange());
      }
    }
    return state;
  }

  // Puts back the caret, selection and focus the user had ("end" mode).
  function restoreState(el, state) {
    try {
      if (!el.isContentEditable) {
        if (state.start != null) el.setSelectionRange(state.start, state.end);
      } else {
        const selection = selectionFor(el);
        selection.removeAllRanges();
        state.ranges.forEach((range) => selection.addRange(range));
      }
      const body = el.ownerDocument.body;
      if (state.active === el) {
        // The user was already in the field: leave them there.
      } else if (state.active && state.active !== body) {
        state.active.focus({ preventScroll: true });
      } else {
        el.blur();
      }
      el.scrollTop = state.scrollTop;
    } catch {
      // Best effort: the editor may have replaced its nodes.
    }
  }

  function flash(el) {
    const { outline, outlineOffset } = el.style;
    el.style.outline = "3px solid #1a73e8";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = outline;
      el.style.outlineOffset = outlineOffset;
    }, 700);
  }

  async function insert(text, options) {
    const el = findField(options);
    if (!el) return { ok: false, error: "The field wasn't found." };

    const order =
      options.strategy === "auto"
        ? el.isContentEditable
          ? ["execCommand", "paste", "beforeinput"]
          : ["value", "paste", "beforeinput"]
        : [options.strategy];
    const state = saveState(el);
    const before = textOf(el);

    let ok = false;
    for (const name of order) {
      const strategy = STRATEGIES[name];
      if (!strategy) continue;
      let applicable = true;
      try {
        // false: the method doesn't apply to this kind of field.
        applicable = strategy(el, text, options);
      } catch {
        // It may still have changed the field; checked below.
      }
      if (!applicable) continue;
      await sleep(SETTLE_MS);
      // Only move on when nothing changed, so text is never inserted twice.
      if (textOf(el) !== before) {
        ok = true;
        break;
      }
    }

    if (options.position !== "caret") restoreState(el, state);
    if (!ok) return { ok: false, error: "The field didn't accept the text." };
    if (options.flash) flash(el);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Field picker

  let picking = false;
  let highlight = null;

  function cssPath(el) {
    // Stops at the document or shadow root the element is in.
    const root = el.getRootNode();
    const unique = (selector) => {
      try {
        return root.querySelectorAll(selector).length === 1;
      } catch {
        return false;
      }
    };
    const tag = el.localName;
    if (el.id && unique(`#${CSS.escape(el.id)}`))
      return `#${CSS.escape(el.id)}`;
    const attributes = ["name", "aria-label", "role", "placeholder"];
    for (const attr of el.getAttributeNames()) {
      if (attr.startsWith("data-") && !attributes.includes(attr))
        attributes.push(attr);
    }
    for (const attr of attributes) {
      const value = el.getAttribute(attr);
      if (!value || value.length > 80) continue;
      const selector = `${tag}[${attr}="${CSS.escape(value)}"]`;
      if (unique(selector)) return selector;
    }
    // A short structural path, anchored at the nearest ancestor with an id.
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      if (node !== el && node.id && unique(`#${CSS.escape(node.id)}`)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const parent = node.parentElement;
      let part = node.localName;
      if (parent) {
        const sameTag = [...parent.children].filter(
          (c) => c.localName === node.localName,
        );
        if (sameTag.length > 1)
          part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (unique(parts.join(" > "))) break;
      node = parent;
    }
    return parts.join(" > ");
  }

  // The selector for `el` from the top-most document this frame can reach,
  // with ">>>" steps through shadow roots and same-origin iframes.
  function selectorFor(el) {
    const steps = [];
    let node = el;
    for (;;) {
      steps.unshift(cssPath(node));
      const root = node.getRootNode();
      if (isShadowRoot(root)) {
        node = root.host;
        continue;
      }
      let frame = null;
      try {
        frame = root.defaultView?.frameElement ?? null;
      } catch {
        // Cross-origin parent: the selector starts at this frame.
      }
      if (!frame) break;
      node = frame;
    }
    return steps.join(" >>> ");
  }

  function showHighlight(el) {
    if (!highlight) {
      highlight = document.createElement("div");
      Object.assign(highlight.style, {
        position: "fixed",
        zIndex: "2147483647",
        pointerEvents: "none",
        border: "2px solid #1a73e8",
        background: "rgba(26, 115, 232, 0.12)",
        borderRadius: "3px",
      });
      document.documentElement.appendChild(highlight);
    }
    const rect = el.getBoundingClientRect();
    Object.assign(highlight.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function onPickMove(event) {
    const field = fieldFor(event.composedPath()[0]);
    if (field) showHighlight(field);
    else if (highlight) highlight.style.display = "none";
  }

  function onPickClick(event) {
    const field = fieldFor(event.composedPath()[0]);
    if (!field) return;
    event.preventDefault();
    event.stopPropagation();
    chrome.runtime.sendMessage({
      type: "picked",
      selector: selectorFor(field),
    });
    stopPicking();
  }

  function onPickKey(event) {
    if (event.key === "Escape") stopPicking();
  }

  function startPicking() {
    if (picking) return;
    picking = true;
    document.addEventListener("mousemove", onPickMove, true);
    document.addEventListener("click", onPickClick, true);
    document.addEventListener("keydown", onPickKey, true);
  }

  function stopPicking() {
    if (!picking) return;
    picking = false;
    document.removeEventListener("mousemove", onPickMove, true);
    document.removeEventListener("click", onPickClick, true);
    document.removeEventListener("keydown", onPickKey, true);
    highlight?.remove();
    highlight = null;
  }

  // ---------------------------------------------------------------------------
  // Messages from the service worker

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case "probe":
        sendResponse({
          found: findField(message.options) != null,
          focusedAt: lastFocusedAt,
        });
        return false;
      case "insert":
        insert(message.text, message.options).then(sendResponse, (e) =>
          sendResponse({ ok: false, error: String(e?.message ?? e) }),
        );
        return true;
      case "pick-start":
        startPicking();
        sendResponse(true);
        return false;
      case "pick-stop":
        stopPicking();
        sendResponse(true);
        return false;
      default:
        return false;
    }
  });
})();
