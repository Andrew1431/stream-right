mod admin;
mod capture;
mod icons;
// Native Go live. Public only so the dev probes in examples/ can drive the stages.
#[doc(hidden)]
pub mod live;
mod windows_list;

use tauri::Manager;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running stream");
}
