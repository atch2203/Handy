# Setting up Handy with RadBridge (Windows)

With this setup, you dictate with Handy and the text goes straight into the report field of your browser-based reporting system, such as Sirona RadOS. The keyboard stays wherever you were working, for example in the image viewer.

Before you start: **hospital-managed computers often block unsigned apps, PowerShell scripts and unpacked browser extensions through group policy.** If a step below is blocked, ask your IT department. Don't try to work around the block.

## 1. Install Handy

Install the Handy build that includes RadBridge support. To build it yourself, follow [BUILD.md](../BUILD.md) on Windows, then run `bun run tauri build`. The installer is under `src-tauri\target\release\bundle\`.

Start Handy, finish its first-run setup, and dictate a test sentence into Notepad to check that it works.

## 2. Set up the punctuation rules

Your speech model writes spoken punctuation as tokens, such as `{period}` when you say "period", and adds punctuation of its own. Handy's **Text Rules** clean that up before the text is pasted.

1. In Handy, open **Settings → Advanced → Text Rules**.
2. Turn on **Apply Text Rules**.
3. Check the rules. Handy starts with these:
   - `.` → **Delete**: removes the periods the model adds on its own.
   - `{period}` → `.`
   - `{comma}` → `,`
   - `{newline}` → **New line**
4. Add a rule for each spoken token you use, with **Add Rule**. Type what the model writes on the left, and choose what to write instead on the right: some **Text**, a **New line**, or **Delete**. To also remove commas the model adds on its own, add `,` → **Delete**.
5. Paste a sentence as History shows it into **Try It** to check the result.

Good to know:

- **History** shows what the model wrote before the rules. Use it to find out what to type on the left.
- Rules don't affect each other: `,` → Delete never deletes the comma that `{comma}` writes, whatever their order.
- A period or comma with a digit on both sides is never changed, so `2.5 cm` and `1,200 mL` are safe.
- Word rules match whole words only: a rule for `period` leaves "periodic" alone.
- **Capitalize After a Period or New Line** capitalises the next word after a period or new line that a rule wrote.

Advanced users can still run their own script on the text with a [transcription hook](../README.md#transcription-hook); it runs after the rules.

## 3. Load the extension

1. Copy the `extensions\radbridge` folder somewhere permanent, such as `C:\RadBridge`. The browser loads it from there each time it starts.
2. Chrome: open `chrome://extensions`. Edge: open `edge://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the `radbridge` folder.
5. Pin RadBridge to the toolbar (the puzzle icon, then the pin) so you can see its badge.

## 4. Connect the extension to Handy

1. In Handy, open **Settings → Advanced → Paste Method** and choose **Send to Browser Extension**.
2. Click **Copy** next to the token.
3. Right-click the RadBridge icon, then choose **Options**.
4. Paste the token into **Token**. Keep the port at 47813 unless you changed it in Handy.

## 5. Set the URL pattern

In the RadBridge options, set **URL pattern** to match your reporting system's address, for example `https://rados.example-hospital.org/*`. Click **Save**, then **Allow** when the browser asks for access to those pages.

Reload any reporting tabs that were already open.

## 6. Choose the field

**Recommended: bind the field.** Open a report, right-click the report field, and choose **Bind RadBridge to this field**. The field flashes briefly. Dictation then goes to that field, even while the image viewer or another RadOS window is focused. This works in RadOS's popup windows too.

The binding ends when the report window closes or reloads, for example when the next study opens. In the RadBridge options, **When the bound field's window closes or reloads** decides what happens next:

- **Stop until I bind a field again** (default): dictation is copied to the clipboard until you right-click the field and bind it again. Most predictable.
- **Find the same field in any open RadOS window:** RadBridge finds the report field in the new window by itself. This works if the report field looks the same to the browser in every study; test it with a few studies.

To stop, right-click in a RadOS window and choose **Unbind RadBridge**.

**Without binding**, RadBridge uses **Last focused field**: the text field you clicked most recently in any RadOS window. Windows without one, like the viewer, are skipped. A text box in the viewer that you type into would count as the most recent field, so binding is safer.

## 7. Test it

1. In the RadBridge options, click **Test insert**. `[RadBridge test]` should appear in the report field. Delete it afterwards.
2. Click into another application, such as the image viewer, and dictate a sentence with Handy. The text should appear in the report field, and your keyboard should still type into the image viewer.

The RadBridge badge shows the status:

- **on** (green): connected to Handy, with a reporting tab to insert into.
- **tab** (amber): connected, but no tab matches the URL pattern.
- **off** (red): Handy isn't running, isn't set to **Send to Browser Extension**, or the token is wrong.

If an insert fails, Handy copies the text to the clipboard and shows **Copied to Clipboard Instead** with the reason. Paste it with Ctrl+V. Every dictation is also in Handy's History.

## 8. Keep the reporting tab loaded

Chrome's Memory Saver unloads tabs you haven't used for a while, and RadBridge can't insert into an unloaded tab.

- **Chrome:** open `chrome://settings/performance`. Under **Always keep these sites active**, click **Add** and enter the reporting system's address.
- **Edge:** open `edge://settings/system`. Under **Never put these sites to sleep**, click **Add** and enter the address.

## Privacy

- Handy and the extension talk only over `127.0.0.1`, and nothing leaves the computer.
- Handy accepts connections only from browser extensions that know the token. Web pages can't connect.
- Neither Handy nor RadBridge logs dictated text. RadBridge stores only its settings. Handy keeps its usual History, which you can limit or turn off in Handy's settings.
