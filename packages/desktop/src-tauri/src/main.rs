// Glass desktop shell (plan §2, §7). Wraps the shared @glass/viewer frontend
// in a native window and exposes the capabilities the desktop uniquely needs:
//   - launching the local browser through a SOCKS proxy with an isolated
//     profile (you render and interact locally, egress happens from the chosen
//     device), and
//   - attaching to the persistent local Glass service for the role the user
//     picked. deploy/glass-backend.mjs is a short-lived control client; glassd,
//     the supervisor, and sessiond deliberately outlive this viewer process.
// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

// ---------------------------------------------------------------------------
// Backend process manager
// ---------------------------------------------------------------------------

/// What the durable service most recently reported at readiness.  There is no
/// long-lived child here: the app owns only a short-lived glassd control client.
#[derive(Default)]
struct BackendInner {
    running: bool,
    role: Option<String>,
    hub_url: Option<String>,
    details: serde_json::Value,
}

/// Managed state. The Arc lets blocking work (spawn + ready-wait, termination)
/// run off the command thread without borrowing tauri::State across await.
#[derive(Default)]
struct Backend(Arc<Mutex<BackendInner>>);

const READY_MARKER: &str = "GLASS_BACKEND_READY ";
const ERROR_MARKER: &str = "GLASS_BACKEND_ERROR ";
// First activation may atomically stage the bundled runtime outside the .app.
const READY_TIMEOUT: Duration = Duration::from_secs(120);

/// Stop a stuck short-lived control client. The persistent backend is not its
/// child, so this cannot signal glassd/sessiond. Escalates if SIGTERM is ignored.
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

/// Spawn `node <script> <args...>` with the given env, trying each node
/// candidate until one exists. The client exits after one control response.
fn spawn_backend(
    script: &Path,
    args: &[String],
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
            .args(args)
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

/// Blocking body of start_backend: invoke the persistent service client and
/// scan stdout+stderr line-by-line until GLASS_BACKEND_READY
/// (parse + return its json), GLASS_BACKEND_ERROR (Err), process exit (Err),
/// or the readiness deadline (Err). Both streams are scanned because the launcher
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
    runtime_version: String,
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

    // The launcher derives its own home from its location (SELF_DIR), so no
    // GLASS_HOME is needed for either the dev repo or the bundled layout.
    let mut envs: Vec<(&str, String)> = Vec::new();
    envs.push(("GLASS_RUNTIME_VERSION", runtime_version));
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

    let args = vec!["--role".to_string(), role.clone()];
    let mut child = spawn_backend(&script, &args, &envs, node_override.as_deref())?;
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
                            inner.running = true;
                            inner.details = value.clone();
                            // The client has handed ownership to glassd and
                            // exits immediately. Reap it; never retain a handle
                            // whose teardown could reach the persistent stack.
                            drop(inner);
                            let _ = child.wait();
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
                return Err(format!("backend ({role}) exited before reporting ready"));
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
    let runtime_version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        start_backend_blocking(
            shared,
            role,
            device_id,
            device_pub,
            hub_url,
            hub_pin,
            script,
            node_override,
            runtime_version,
        )
    })
    .await
    .map_err(|e| format!("backend launcher task failed: {e}"))?
}

/// Explicitly stop the durable backend for role reconfiguration. This is the
/// destructive path: glassd stops the supervisor and therefore live sessions.
#[tauri::command]
async fn stop_backend(
    app: tauri::AppHandle,
    state: tauri::State<'_, Backend>,
) -> Result<(), String> {
    let (script, node_override) = resolve_backend(&app)
        .ok_or_else(|| "could not locate the Glass backend control client".to_string())?;
    let shared = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let args = vec!["--stop".to_string()];
        let mut child = spawn_backend(&script, &args, &[], node_override.as_deref())?;
        let status = child
            .wait()
            .map_err(|e| format!("backend stop wait failed: {e}"))?;
        if !status.success() {
            return Err(format!("backend stop client exited with {status}"));
        }
        let mut inner = shared.lock().unwrap();
        inner.running = false;
        inner.role = None;
        inner.hub_url = None;
        inner.details = serde_json::Value::Null;
        Ok(())
    })
    .await
    .map_err(|e| format!("backend stop task failed: {e}"))?
}

/// Cached content-free lifecycle diagnostics from the latest glassd response.
#[tauri::command]
fn backend_status(state: tauri::State<'_, Backend>) -> serde_json::Value {
    let inner = state.0.lock().unwrap();
    if inner.running {
        let mut details = inner.details.clone();
        if let Some(object) = details.as_object_mut() {
            object.insert("running".into(), json!(true));
            object.insert("role".into(), json!(inner.role));
            object.insert("hubUrl".into(), json!(inner.hub_url));
        }
        details
    } else {
        json!({ "running": false })
    }
}

/// Apply a staged glassd/Node replacement at the user-confirmed destructive
/// maintenance boundary. The control client performs health validation and
/// restores the previous controller automatically if the replacement fails.
#[tauri::command]
async fn apply_backend_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, Backend>,
) -> Result<serde_json::Value, String> {
    let (script, node_override) = resolve_backend(&app)
        .ok_or_else(|| "could not locate the Glass backend control client".to_string())?;
    let shared = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let args = vec!["--apply-service-update".to_string()];
        let mut child = spawn_backend(&script, &args, &[], node_override.as_deref())?;
        let (tx, rx) = mpsc::channel::<String>();
        pump_lines(child.stdout.take().expect("stdout piped"), tx.clone());
        pump_lines(child.stderr.take().expect("stderr piped"), tx);
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                terminate(&mut child);
                return Err("backend maintenance update timed out".into());
            }
            match rx.recv_timeout(remaining) {
                Ok(line) => {
                    if let Some(payload) = line.strip_prefix("GLASS_BACKEND_UPDATED ") {
                        let value: serde_json::Value = serde_json::from_str(payload)
                            .map_err(|e| format!("backend update returned invalid json: {e}"))?;
                        let mut status = value
                            .get("status")
                            .cloned()
                            .unwrap_or_else(|| json!({ "running": true }));
                        if let (Some(object), Some(service_update)) =
                            (status.as_object_mut(), value.get("serviceUpdate"))
                        {
                            object.insert("serviceUpdate".into(), service_update.clone());
                        }
                        let mut inner = shared.lock().unwrap();
                        inner.running = status
                            .get("running")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true);
                        inner.role = status
                            .get("role")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        inner.hub_url = status
                            .get("hubUrl")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        inner.details = status;
                        drop(inner);
                        let _ = child.wait();
                        return Ok(value);
                    }
                    if let Some(message) = line.strip_prefix(ERROR_MARKER) {
                        terminate(&mut child);
                        return Err(message.to_string());
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    terminate(&mut child);
                    return Err("backend maintenance update timed out".into());
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = child.wait();
                    return Err("backend maintenance client exited without a result".into());
                }
            }
        }
    })
    .await
    .map_err(|e| format!("backend update task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Proxied browser launch
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
    profile_dir: Option<String>,
    profile_name: Option<String>,
    url: Option<String>,
) -> Result<(), String> {
    // u16 already bounds the port at 65535; only zero is invalid.
    if socks_port == 0 {
        return Err(format!("invalid socksPort {socks_port}"));
    }
    if socks_host.trim().is_empty() {
        return Err("socksHost is required".into());
    }
    // Either an explicit absolute dir, or a NAME the shell resolves under
    // ~/.glass/desktop/browser-profiles/ — the webview has no $HOME. The name
    // is sanitized to a conservative charset so a device id can never traverse
    // out of the profiles root.
    let profile_dir = match (profile_dir, profile_name) {
        (Some(dir), _) if !dir.trim().is_empty() => dir,
        (_, Some(name)) => {
            let safe: String = name
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let safe = safe.trim_matches('.').to_string(); // no "." / ".." segments
            if safe.is_empty() {
                return Err("profileName has no usable characters".into());
            }
            let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
            let dir = std::path::Path::new(&home)
                .join(".glass")
                .join("desktop")
                .join("browser-profiles")
                .join(safe);
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("could not create profile dir: {e}"))?;
            dir.to_string_lossy().into_owned()
        }
        _ => return Err("profileDir or profileName is required for profile isolation".into()),
    };

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
            return Some((
                Path::new(&home).join("deploy").join("glass-backend.mjs"),
                None,
            ));
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
            let reconfigure = MenuItemBuilder::with_id("reconfigure", "Reconfigure…").build(app)?;
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
        .invoke_handler(tauri::generate_handler![
            launch_proxied_browser,
            app_version,
            start_backend,
            stop_backend,
            backend_status,
            apply_backend_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Glass desktop shell");

    // App/window exit disconnects only the Viewer. glassd, the supervisor, and
    // sessiond keep running so an update/relaunch reattaches to the same shells.
    app.run(|_, _| {});
}
