//! Optional user hook in `<app data dir>/hooks/`, which receives the text
//! about to be pasted on stdin; its stdout is pasted instead.
//!
//! On macOS and Linux the hook is the executable `hooks/transcription`. On
//! Windows it's the first of `transcription.exe`, `.cmd`, `.bat` or `.ps1`
//! that exists.

use anyhow::Context;
use log::error;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Hung hooks are killed so they can't leave the pipeline stuck in "transcribing".
const HOOK_TIMEOUT: Duration = Duration::from_secs(30);

/// File names tried in order inside the hooks folder.
#[cfg(windows)]
const HOOK_NAMES: &[&str] = &[
    "transcription.exe",
    "transcription.cmd",
    "transcription.bat",
    "transcription.ps1",
];
#[cfg(not(windows))]
const HOOK_NAMES: &[&str] = &["transcription"];

/// Returns the hook's output, or `text` unchanged if there's no hook or it
/// fails. Dropping the future kills the hook, so callers can cancel it.
pub async fn apply(app: &AppHandle, text: String) -> String {
    let Ok(dir) = crate::portable::app_data_dir(app) else {
        return text;
    };
    if text.is_empty() {
        return text;
    }
    let Some(hook) = find_hook(&dir.join("hooks"), HOOK_NAMES) else {
        return text;
    };

    run(&hook, &text).await.unwrap_or_else(|e| {
        error!("Transcription hook failed, using original text: {:#}", e);
        text
    })
}

/// The first of `names` that exists as a file in `hooks_dir`.
fn find_hook(hooks_dir: &Path, names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| hooks_dir.join(name))
        .find(|path| path.is_file())
}

/// How a hook file is started: the program and its arguments.
/// Scripts go through their interpreter, since Windows can't run them directly.
fn launcher(hook: &Path) -> (PathBuf, Vec<std::ffi::OsString>) {
    let ext = hook
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("ps1") => (
            PathBuf::from("powershell.exe"),
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]
            .iter()
            .map(Into::into)
            .chain(std::iter::once(hook.as_os_str().to_owned()))
            .collect(),
        ),
        Some("cmd") | Some("bat") => (
            PathBuf::from("cmd.exe"),
            vec!["/C".into(), hook.as_os_str().to_owned()],
        ),
        _ => (hook.to_path_buf(), Vec::new()),
    }
}

async fn run(hook: &Path, text: &str) -> anyhow::Result<String> {
    let (program, args) = launcher(hook);
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // No console window flashing up on every dictation.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()?;

    // Write input while reading output so neither side blocks on a full pipe.
    // Write errors are ignored: a hook may exit without reading its input.
    let mut stdin = child.stdin.take().context("stdin not piped")?;
    let write = async move {
        let _ = stdin.write_all(text.as_bytes()).await;
    };
    let (_, output) = tokio::time::timeout(HOOK_TIMEOUT, async {
        tokio::join!(write, child.wait_with_output())
    })
    .await
    .context("timed out")?;
    let output = output?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow::ensure!(
        output.status.success(),
        "exited with {}: {}",
        output.status,
        stderr.trim()
    );

    // Drop one trailing newline so `echo` output doesn't submit a terminal line.
    // `\r\n` too, which Windows tools write.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout = stdout
        .strip_suffix("\r\n")
        .or_else(|| stdout.strip_suffix('\n'))
        .unwrap_or(&stdout);
    Ok(stdout.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_hook_takes_first_existing_name() {
        let dir = std::env::temp_dir().join(format!("handy-hook-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let names = [
            "transcription.exe",
            "transcription.cmd",
            "transcription.ps1",
        ];
        assert_eq!(find_hook(&dir, &names), None);

        std::fs::write(dir.join("transcription.ps1"), "").unwrap();
        assert_eq!(find_hook(&dir, &names), Some(dir.join("transcription.ps1")));

        std::fs::write(dir.join("transcription.cmd"), "").unwrap();
        assert_eq!(find_hook(&dir, &names), Some(dir.join("transcription.cmd")));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn launcher_wraps_scripts_in_their_interpreter() {
        let (program, args) = launcher(Path::new("hooks/transcription.PS1"));
        assert_eq!(program, PathBuf::from("powershell.exe"));
        assert_eq!(args.first().unwrap(), "-NoProfile");
        assert_eq!(args.last().unwrap(), "hooks/transcription.PS1");

        let (program, args) = launcher(Path::new("hooks/transcription.bat"));
        assert_eq!(program, PathBuf::from("cmd.exe"));
        assert_eq!(args, vec!["/C", "hooks/transcription.bat"]);

        let (program, args) = launcher(Path::new("hooks/transcription"));
        assert_eq!(program, PathBuf::from("hooks/transcription"));
        assert!(args.is_empty());
    }
}
