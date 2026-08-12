// Glass desktop shell (plan §2, §7). Wraps the shared @glass/viewer frontend
// in a native window and exposes the one capability the desktop uniquely needs
// today: launching the local browser through a SOCKS proxy with an isolated
// profile — you render and interact locally, egress happens from the chosen
// device. Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Command, Stdio};

/// Default macOS binary per browser kind. Mirrors DEFAULT_BIN in
/// packages/agent/src/proxy/browser-profile.ts — keep the two in sync.
fn default_binary(browser: &str) -> Option<&'static str> {
    match browser {
        "chrome" => Some("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        "chromium" => Some("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        "brave" => Some("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
        "edge" => Some("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        _ => None,
    }
}

/// Launch the device's real local browser pinned to a SOCKS5 endpoint with a
/// dedicated profile dir (plan §7, Phase 6). The argument list mirrors
/// buildBrowserLaunch() in packages/agent/src/proxy/browser-profile.ts exactly:
/// --user-data-dir, --proxy-server=socks5://host:port, --no-first-run,
/// --no-default-browser-check, --new-window, then the optional url.
///
/// socks5 (not socks5h) is deliberate: Chromium sends hostnames to the SOCKS
/// proxy for resolution, so DNS also resolves at the exit device — no local
/// DNS leak. The per-profile --user-data-dir keeps proxied browsing fully
/// separate from normal browsing: distinct profile, cookie jar, and window.
#[tauri::command]
fn launch_proxied_browser(
    browser: Option<String>,
    socks_host: String,
    socks_port: u16,
    profile_dir: String,
    url: Option<String>,
) -> Result<(), String> {
    // u16 already bounds the port at 65535; only zero is invalid.
    if socks_port == 0 {
        return Err(format!("invalid socksPort {socks_port}"));
    }
    if socks_host.trim().is_empty() {
        return Err("socksHost is required".into());
    }
    if profile_dir.trim().is_empty() {
        return Err("profileDir is required for profile isolation".into());
    }

    let kind = browser.as_deref().unwrap_or("chrome");
    let binary = default_binary(kind).ok_or_else(|| {
        format!("unknown browser '{kind}' (expected chrome | chromium | brave | edge)")
    })?;

    let mut cmd = Command::new(binary);
    cmd.arg(format!("--user-data-dir={profile_dir}"))
        .arg(format!("--proxy-server=socks5://{socks_host}:{socks_port}"))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--new-window")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(url) = url {
        cmd.arg(url);
    }

    // Detach: give the child its own process group so it never receives the
    // shell's signals and keeps running if the shell quits.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    cmd.spawn()
        .map(|_child| ()) // intentionally not waited on — fully detached
        .map_err(|e| format!("failed to launch {binary}: {e}"))
}

/// The shell's own version (Cargo package version), for display in the viewer.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![launch_proxied_browser, app_version])
        .run(tauri::generate_context!())
        .expect("error while running the Glass desktop shell");
}
