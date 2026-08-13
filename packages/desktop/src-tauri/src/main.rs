// Glass desktop shell (plan §2, §7). Wraps the shared @glass/viewer frontend
// in a native window and exposes the capabilities the desktop uniquely needs:
//   - launching the local browser through a SOCKS proxy with an isolated
//     profile (you render and interact locally, egress happens from the chosen
//     device), and
//   - running the local Glass backend (deploy/glass-backend.mjs) for the role
//     the user picked — standalone / hub / spoke — with its lifetime tied to
//     the app so no node processes leak.
// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use std::os::unix::fs::PermissionsExt;

// ---------------------------------------------------------------------------
// Backend process manager
// ---------------------------------------------------------------------------

/// The one supervised backend child (deploy/glass-backend.mjs) plus what it
/// reported at readiness, for backend_status.
#[derive(Default)]
struct BackendInner {
    child: Option<Child>,
    role: Option<String>,
    hub_url: Option<String>,
}

/// Managed state. The Arc lets blocking work (spawn + ready-wait, termination)
/// run off the command thread without borrowing tauri::State across await.
#[derive(Default)]
struct Backend(Arc<Mutex<BackendInner>>);

const READY_MARKER: &str = "GLASS_BACKEND_READY ";
const ERROR_MARKER: &str = "GLASS_BACKEND_ERROR ";
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Stop a backend child. SIGTERM first — glass-backend.mjs traps SIGTERM and
/// reaps its own children (hub/sessiond/agent); a straight SIGKILL would leak
/// those grandchildren. Escalates to kill() only if it ignores SIGTERM for 5s.
fn terminate(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return; // already exited (try_wait reaped it)
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(child.id().to_string())
            .status();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Take the current backend child (if any) out of state and terminate it.
/// The child is moved out before the blocking wait so the mutex is never held
/// across process teardown.
fn kill_backend(shared: &Arc<Mutex<BackendInner>>) {
    let child = {
        let mut inner = shared.lock().unwrap();
        inner.role = None;
        inner.hub_url = None;
        inner.child.take()
    };
    if let Some(mut child) = child {
        terminate(&mut child);
    }
}

/// Forward every line of a child stream into the channel; keep draining after
/// the receiver is gone so the pipe never backs up the child.
fn pump_lines<R: Read + Send + 'static>(stream: R, tx: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            match line {
                Ok(line) => {
                    let _ = tx.send(line);
                }
                Err(_) => break,
            }
        }
    });
}

/// Candidate node binaries. GUI-launched macOS apps get a minimal PATH
/// (/usr/bin:/bin:...) that usually lacks node, so fall back to the common
/// Homebrew locations when plain "node" isn't found.
const NODE_CANDIDATES: &[&str] = &["node", "/opt/homebrew/bin/node", "/usr/local/bin/node"];

/// Spawn `node <script> --role <role>` with the given env, trying each node
/// candidate until one exists.
fn spawn_backend(
    script: &Path,
    role: &str,
    envs: &[(&str, String)],
    node_override: Option<&Path>,
) -> Result<Child, String> {
    // A bundled (distributed) app carries its own portable node; use only that
    // one (restoring its exec bit, which resource-copying can drop). Dev falls
    // back to the system node candidates.
    let candidates: Vec<String> = match node_override {
        Some(n) => {
            let _ = std::fs::set_permissions(n, std::fs::Permissions::from_mode(0o755));
            vec![n.to_string_lossy().into_owned()]
        }
        None => NODE_CANDIDATES.iter().map(|s| s.to_string()).collect(),
    };
    let mut last_err = None;
    for node in &candidates {
        let mut cmd = Command::new(node);
        cmd.arg(script)
            .arg("--role")
            .arg(role)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in envs {
            cmd.env(key, value);
        }
        // Critical: give the backend (and its own `node`/shell/git children) a
        // usable PATH. A GUI-launched app has a minimal PATH lacking Homebrew,
        // so the launcher's internal `spawn("node", …)` would ENOENT. Prepend
        // the resolved node's directory + the common bins.
        let mut path = String::new();
        if let Some(dir) = Path::new(node).parent() {
            if !dir.as_os_str().is_empty() {
                path.push_str(&dir.to_string_lossy());
                path.push(':');
            }
        }
        path.push_str("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        if let Ok(existing) = std::env::var("PATH") {
            if !existing.is_empty() {
                path.push(':');
                path.push_str(&existing);
            }
        }
        cmd.env("PATH", path);
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                last_err = Some(e);
                continue;
            }
            Err(e) => return Err(format!("failed to spawn {node}: {e}")),
        }
    }
    Err(format!(
        "node not found (tried {}): {}",
        candidates.join(", "),
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

/// Blocking body of start_backend: kill any previous backend, spawn the
/// launcher, and scan stdout+stderr line-by-line until GLASS_BACKEND_READY
/// (parse + return its json), GLASS_BACKEND_ERROR (Err), process exit (Err),
/// or the 20s deadline (Err). Both streams are scanned because the launcher
/// prints READY on stdout but ERROR via console.error (stderr).
fn start_backend_blocking(
    shared: Arc<Mutex<BackendInner>>,
    role: String,
    device_id: Option<String>,
    device_pub: Option<String>,
    hub_url: Option<String>,
    hub_pin: Option<String>,
    script: PathBuf,
    node_override: Option<PathBuf>,
) -> Result<serde_json::Value, String> {
    match role.as_str() {
        "standalone" | "hub" | "spoke" => {}
        other => {
            return Err(format!(
                "unknown backend role '{other}' (expected standalone | hub | spoke)"
            ))
        }
    }
    // Fail fast on missing role inputs instead of waiting for the launcher's
    // own GLASS_BACKEND_ERROR round-trip.
    if role == "hub" && (device_id.is_none() || device_pub.is_none()) {
        return Err("hub role needs deviceId and devicePub (the app's device identity)".into());
    }
    if role == "spoke" && hub_url.is_none() {
        return Err("spoke role needs hubUrl (the remote hub to join)".into());
    }

    // One backend at a time: reconfiguring replaces the previous role cleanly.
    kill_backend(&shared);

    // The launcher derives its own home from its location (SELF_DIR), so no
    // GLASS_HOME is needed for either the dev repo or the bundled layout.
    let mut envs: Vec<(&str, String)> = Vec::new();
    if let Some(v) = device_id {
        envs.push(("VIEWER_ID", v));
    }
    if let Some(v) = device_pub {
        envs.push(("VIEWER_PUB", v));
    }
    if let Some(v) = hub_url {
        envs.push(("HUB_URL", v));
    }
    if let Some(v) = hub_pin {
        envs.push(("HUB_PIN", v));
    }

    let mut child = spawn_backend(&script, &role, &envs, node_override.as_deref())?;
    let (tx, rx) = mpsc::channel::<String>();
    pump_lines(child.stdout.take().expect("stdout piped"), tx.clone());
    pump_lines(child.stderr.take().expect("stderr piped"), tx);

    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            terminate(&mut child);
            return Err(format!(
                "backend ({role}) did not report ready within {}s",
                READY_TIMEOUT.as_secs()
            ));
        }
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                if let Some(i) = line.find(READY_MARKER) {
                    let payload = &line[i + READY_MARKER.len()..];
                    match serde_json::from_str::<serde_json::Value>(payload) {
                        Ok(value) => {
                            let mut inner = shared.lock().unwrap();
                            inner.role = value
                                .get("role")
                                .and_then(|v| v.as_str())
                                .map(String::from)
                                .or(Some(role.clone()));
                            inner.hub_url = value
                                .get("hubUrl")
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            inner.child = Some(child);
                            return Ok(value);
                        }
                        Err(e) => {
                            terminate(&mut child);
                            return Err(format!("backend ready line had invalid json: {e}"));
                        }
                    }
                }
                if let Some(i) = line.find(ERROR_MARKER) {
                    let msg = line[i + ERROR_MARKER.len()..].to_string();
                    terminate(&mut child); // launcher self-exits; this just reaps
                    return Err(format!("backend ({role}) failed to start: {msg}"));
                }
                // any other line: launcher chatter, keep waiting
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                terminate(&mut child);
                return Err(format!(
                    "backend ({role}) did not report ready within {}s",
                    READY_TIMEOUT.as_secs()
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // both stream pumps ended: the launcher exited without READY
                let _ = child.wait();
                return Err(format!(
                    "backend ({role}) exited before reporting ready"
                ));
            }
        }
    }
}

/// Start (or restart) the local backend for a role. camelCase JS args map to
/// these snake_case params per Tauri convention (deviceId -> device_id, ...).
/// Resolves with the parsed GLASS_BACKEND_READY json: { role, hubUrl, hubKey? }.
#[tauri::command]
async fn start_backend(
    app: tauri::AppHandle,
    state: tauri::State<'_, Backend>,
    role: String,
    device_id: Option<String>,
    device_pub: Option<String>,
    hub_url: Option<String>,
    hub_pin: Option<String>,
) -> Result<serde_json::Value, String> {
    let (script, node_override) = resolve_backend(&app).ok_or_else(|| {
        "could not locate the Glass backend — neither the dev repo (set GLASS_HOME) nor a \
         bundled backend in the app's resources was found."
            .to_string()
    })?;
    let shared = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        start_backend_blocking(shared, role, device_id, device_pub, hub_url, hub_pin, script, node_override)
    })
    .await
    .map_err(|e| format!("backend launcher task failed: {e}"))?
}

/// Stop the running backend (SIGTERM so it reaps its own children). No-op if
/// nothing is running.
#[tauri::command]
async fn stop_backend(state: tauri::State<'_, Backend>) -> Result<(), String> {
    let shared = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || kill_backend(&shared))
        .await
        .map_err(|e| format!("backend stop task failed: {e}"))
}

/// { running, role?, hubUrl? }. Reaps and reports not-running if the child
/// died behind our back.
#[tauri::command]
fn backend_status(state: tauri::State<'_, Backend>) -> serde_json::Value {
    let mut inner = state.0.lock().unwrap();
    let running = match inner.child.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) | Err(_) => {
                inner.child = None;
                inner.role = None;
                inner.hub_url = None;
                false
            }
        },
        None => false,
    };
    if running {
        json!({ "running": true, "role": inner.role, "hubUrl": inner.hub_url })
    } else {
        json!({ "running": false })
    }
}

// ---------------------------------------------------------------------------
// Proxied browser launch (unchanged)
// ---------------------------------------------------------------------------

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

/// The shell's own version, for display in the viewer AND for the updater's
/// anti-rollback bookkeeping. MUST be the same version the updater compares
/// against (tauri.conf.json > version, via generate_context!/PackageInfo) —
/// NOT CARGO_PKG_VERSION, which is pinned at 0.0.0 in Cargo.toml and would make
/// reconcile() think every applied update "didn't advance" and poison it.
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

// ---------------------------------------------------------------------------
// App wiring: menu + lifecycle
// ---------------------------------------------------------------------------

/// Locate the Glass repo root (which holds deploy/glass-backend.mjs). A
/// GUI-launched macOS app inherits almost no environment, so relying on a
/// shell-exported GLASS_HOME fails on double-click. Fall back through: the
/// runtime env, the value baked in at build time (`GLASS_HOME=… tauri build`),
/// then the conventional dev checkout locations under $HOME.
fn resolve_glass_home() -> Option<String> {
    let has_backend = |dir: &Path| dir.join("deploy").join("glass-backend.mjs").is_file();

    if let Ok(h) = std::env::var("GLASS_HOME") {
        if !h.is_empty() && has_backend(Path::new(&h)) {
            return Some(h);
        }
    }
    if let Some(h) = option_env!("GLASS_HOME") {
        if !h.is_empty() && has_backend(Path::new(h)) {
            return Some(h.to_string());
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        for cand in ["projects/glass", "Projects/glass"] {
            let p = Path::new(&home).join(cand);
            if has_backend(&p) {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// Resolve the backend launcher + which node runs it. Dev: the repo + system
/// node (fast iteration; the baked/dev path only resolves on the dev machine).
/// Distributed: the self-contained backend bundled in the app's resources +
/// its own portable node. Returns (launcher_script, Some(bundled_node)|None).
fn resolve_backend(app: &tauri::AppHandle) -> Option<(PathBuf, Option<PathBuf>)> {
    // GLASS_PREFER_BUNDLED forces the distributed path even on a dev machine
    // (so the bundle can be exercised where the repo would otherwise win).
    if std::env::var_os("GLASS_PREFER_BUNDLED").is_none() {
        if let Some(home) = resolve_glass_home() {
            return Some((Path::new(&home).join("deploy").join("glass-backend.mjs"), None));
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        let dir = res.join("backend");
        let script = dir.join("glass-backend.mjs");
        let node = dir.join("node");
        if script.is_file() && node.is_file() {
            return Some((script, Some(node)));
        }
    }
    None
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Backend::default())
        .setup(|app| {
            // Native macOS menu bar: on macOS the FIRST submenu becomes the
            // application menu (its title is replaced by the app name), then
            // File carries "Reconfigure…" which tells the viewer to re-run
            // role setup via the glass://reconfigure event.
            let reconfigure =
                MenuItemBuilder::with_id("reconfigure", "Reconfigure…").build(app)?;
            // Standard macOS Preferences slot (app menu, Cmd+,). Opens the
            // viewer's Terminal Settings panel via the glass://settings event.
            let settings = MenuItemBuilder::with_id("settings", "Terminal Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Glass")
                .about(None)
                .separator()
                .item(&settings)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&reconfigure)
                .separator()
                .close_window()
                .build()?;
            // Edit menu: without it macOS never binds Cmd+C/V/X/A (and undo/redo)
            // to the webview's native edit actions, so copy/paste don't work at
            // all. These predefined items carry the standard accelerators.
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &file_menu])
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app_handle, event| {
                match event.id().as_ref() {
                    "reconfigure" => {
                        // Target the main window; the viewer subscribes via
                        // native.ts onReconfigure().
                        let _ = app_handle.emit_to("main", "glass://reconfigure", ());
                    }
                    "settings" => {
                        // Viewer subscribes via native.ts onSettings() and
                        // opens the Terminal Settings panel.
                        let _ = app_handle.emit_to("main", "glass://settings", ());
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window must not leave a node backend behind.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                kill_backend(&window.state::<Backend>().0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            launch_proxied_browser,
            app_version,
            start_backend,
            stop_backend,
            backend_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Glass desktop shell");

    app.run(|app_handle, event| {
        // Belt-and-braces: whatever path led to exit (Cmd+Q, menu Quit, last
        // window closed), the backend child is terminated before we return.
        if let tauri::RunEvent::Exit = event {
            kill_backend(&app_handle.state::<Backend>().0);
        }
    });
}
