// Settings shared by the service worker, options page and popup. Everything
// RadBridge stores is here; it never stores or logs dictated text.

export const DEFAULTS = {
  port: 47813,
  token: "",
  // Chrome match pattern for the pages to insert into, e.g.
  // "https://rados.example.org/*". Empty until the user sets it.
  urlPattern: "",
  // "focused": the last text field the user focused in the page.
  // "selector": `selector` below (">>>" crosses into an iframe or shadow root).
  fieldMode: "focused",
  selector: "",
  // "end": append to the end of the field. "caret": insert at the caret.
  position: "end",
  // Put before the text when the field doesn't already end in whitespace:
  // "space", "newline" or "none".
  separator: "space",
  // "auto" tries each method until the field's text changes. Or force one:
  // "value", "execCommand", "paste", "beforeinput".
  strategy: "auto",
  // Briefly outline the field after inserting.
  flash: true,
};

export const TEST_TEXT = "[RadBridge test]";

export async function loadConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

// The fields of `config` that the content script needs to insert.
export function insertOptions(config) {
  const { fieldMode, selector, position, separator, strategy, flash } = config;
  return { fieldMode, selector, position, separator, strategy, flash };
}

// Checks a Chrome match pattern: scheme://host/path with "*" wildcards.
// Returns an error message, or null when it's usable.
export function validatePattern(pattern) {
  const match = /^(https?|\*):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(pattern);
  if (!match) {
    return 'Use a pattern like "https://rados.example.org/*".';
  }
  return null;
}
