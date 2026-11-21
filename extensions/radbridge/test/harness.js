// Test fields for RadBridge. No libraries: each imitates how a real editor
// tracks its own state, so an insert that only changes the DOM is caught.

// 2. React-style controlled textarea. React remembers the last value it saw
// through an instance-level `value` setter and ignores an `input` event whose
// value matches it; then it re-renders the old state. Only the prototype's
// native setter gets past that tracking.
(function controlledTextarea() {
  const el = document.getElementById("controlled-textarea");
  const modelView = document.getElementById("controlled-model");
  const native = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  );
  let tracked = "";
  let state = "";
  Object.defineProperty(el, "value", {
    configurable: true,
    get() {
      return native.get.call(this);
    },
    set(v) {
      tracked = String(v);
      native.set.call(this, v);
    },
  });
  function render() {
    if (native.get.call(el) !== state) native.set.call(el, state);
    tracked = state;
    modelView.textContent = JSON.stringify(state);
  }
  el.addEventListener("input", () => {
    const value = native.get.call(el);
    if (value !== tracked) state = value; // React's "did the value change?"
    // React re-renders after every event, reverting ignored changes.
    queueMicrotask(render);
  });
  render();
})();

// 4. Model-based editor: cancels beforeinput, applies it to its model, and
// re-renders. Anything that changes the DOM without beforeinput is reverted.
function modelEditor(el, modelView) {
  let text = "";
  let caret = 0;

  function render() {
    el.textContent = text;
    if (modelView) modelView.textContent = JSON.stringify(text);
    if (
      document.activeElement === el ||
      el.getRootNode().activeElement === el
    ) {
      const selection =
        el.getRootNode().getSelection?.() ?? document.getSelection();
      const range = document.createRange();
      const node = el.firstChild ?? el;
      range.setStart(node, Math.min(caret, node.textContent.length));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function caretOffset() {
    const selection =
      el.getRootNode().getSelection?.() ?? document.getSelection();
    if (!selection.rangeCount || !el.contains(selection.anchorNode))
      return text.length;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return range.toString().length;
  }

  el.addEventListener("beforeinput", (event) => {
    event.preventDefault();
    const at = caretOffset();
    switch (event.inputType) {
      case "insertText":
      case "insertFromPaste":
      case "insertReplacementText": {
        const data =
          event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
        text = text.slice(0, at) + data + text.slice(at);
        caret = at + data.length;
        break;
      }
      case "insertParagraph":
      case "insertLineBreak":
        text = text.slice(0, at) + "\n" + text.slice(at);
        caret = at + 1;
        break;
      case "deleteContentBackward":
        if (at > 0) {
          text = text.slice(0, at - 1) + text.slice(at);
          caret = at - 1;
        }
        break;
      default:
        break;
    }
    render();
  });
  // Changes that skip beforeinput are thrown away, as real editors do.
  el.addEventListener("input", () => queueMicrotask(render));
  render();
}

modelEditor(
  document.getElementById("model-editor"),
  document.getElementById("model-editor-model"),
);

// 7. An editor inside an open shadow root.
customElements.define(
  "report-editor",
  class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = `
        <style>
          textarea { box-sizing: border-box; width: 100%; font: inherit; }
        </style>
        <textarea id="shadow-textarea" rows="3" aria-label="Shadow report"></textarea>`;
    }
  },
);
