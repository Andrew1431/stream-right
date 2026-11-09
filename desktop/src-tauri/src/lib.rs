mod admin;
mod capture;
mod icons;
// Native Go live. Public only so the dev probes in examples/ can drive the stages.
#[doc(hidden)]
pub mod live;
mod windows_list;

use tauri::Manager;

// Tauri empties the app's resource table on every way out: closing the window, relaunch, and the
// updater (which calls process::exit without an Exit event). Dropping this then ends the stream
// properly, so viewers don't sit on a frozen picture until the server notices.
struct StopOnExit(tauri::AppHandle);

impl tauri::Resource for StopOnExit {}

impl Drop for StopOnExit {
    fn drop(&mut self) {
        live::session::shutdown(&self.0, std::time::Duration::from_secs(5));
    }
}

pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin. A stream-desktop:// link opens a second process; this hands
        // its URL to the running app (the deep-link feature re-emits it to onOpenUrl) and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(live::session::LiveState::default())
        .setup(|_app| {
            _app.resources_table().add(StopOnExit(_app.handle().clone()));
            // Installed builds get the scheme from the NSIS installer; dev builds register the
            // running exe so links work without installing.
            #[cfg(debug_assertions)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = _app.deep_link().register_all() {
                    eprintln!("deep link registration failed: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            windows_list::list_windows,
            windows_list::list_monitors,
            capture::capture_thumbnail,
            capture::capture_monitor_thumbnail,
            admin::server_request,
            live::session::go_live,
            live::session::stop_live,
            live::session::live_status,
            live::session::set_live_mic,
            live::session::modify_live,
            windows_list::list_audio_apps,
        ])
        .run(tauri::generate_context!())
        .expect("error while running stream");
}
