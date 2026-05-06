//! Cross-platform helper to spawn child processes WITHOUT flashing a console
//! window on Windows. Without `CREATE_NO_WINDOW` (0x08000000), every
//! `python.exe`, `node.exe`, `ffmpeg.exe`, `nvidia-smi.exe` etc. invoked from
//! the GUI shell pops a black terminal that briefly appears and disappears,
//! making the app look broken.
//!
//! Usage:
//!
//! ```ignore
//! use crate::process_ext::HideConsole;
//! Command::new("python").arg("--version").hide_console().output()?;
//! ```
//!
//! On non-Windows targets the trait is a no-op so callers can use the same
//! API everywhere.
//!
//! `CREATE_NO_WINDOW` (0x08000000) is documented at:
//! <https://learn.microsoft.com/windows/win32/procthread/process-creation-flags>

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

pub trait HideConsole {
    fn hide_console(&mut self) -> &mut Self;
}

#[cfg(target_os = "windows")]
impl HideConsole for std::process::Command {
    fn hide_console(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(target_os = "windows"))]
impl HideConsole for std::process::Command {
    fn hide_console(&mut self) -> &mut Self { self }
}

#[cfg(target_os = "windows")]
impl HideConsole for tokio::process::Command {
    fn hide_console(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(target_os = "windows"))]
impl HideConsole for tokio::process::Command {
    fn hide_console(&mut self) -> &mut Self { self }
}
