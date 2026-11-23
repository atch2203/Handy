// Source of ../vendor/slate-editor.js: a real Slate editor for the test page,
// since RadOS's report field is one. Slate keeps its own model of the text
// and redraws from it, so text that only changes the page is lost on the next
// edit. "Model" under the editor shows what Slate holds.
//
// Rebuild (needs Bun; React matches RadOS's 18.3.1):
//   cd extensions/radbridge/test/slate
//   bun add react@18.3.1 react-dom@18.3.1 slate slate-react slate-history
//   bun build slate-editor.jsx --minify \
//     --define process.env.NODE_ENV='"production"' --outfile ../vendor/slate-editor.js
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createEditor, Node } from "slate";
import { Slate, Editable, withReact } from "slate-react";
import { withHistory } from "slate-history";

const initial = [{ type: "paragraph", children: [{ text: "" }] }];
const modelText = (value) => value.map((n) => Node.string(n)).join("\n");

function SlateField() {
  const editor = useMemo(() => withHistory(withReact(createEditor())), []);
  const [model, setModel] = useState("");
  window.slateHarness = { editor, modelText: () => modelText(editor.children) };
  return (
    <>
      <Slate
        editor={editor}
        initialValue={initial}
        onChange={(value) => setModel(modelText(value))}
      >
        <Editable
          id="slate-editor"
          className="editable"
          aria-label="Slate report"
          placeholder="Slate editor"
        />
      </Slate>
      <div className="model">
        Model: <span id="slate-model">{JSON.stringify(model)}</span>
      </div>
    </>
  );
}

createRoot(document.getElementById("slate-host")).render(<SlateField />);
