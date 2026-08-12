fn main() {
    // Listing the app's own commands makes tauri-build generate their
    // allow-*/deny-* permissions, so capabilities/default.json can grant them
    // to the main window explicitly (Tauri v2 ACL).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "launch_proxied_browser",
                "app_version",
                "start_backend",
                "stop_backend",
                "backend_status",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
