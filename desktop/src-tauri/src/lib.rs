mod admin;
mod capture;
mod icons;
// Native Go live. Public only so the dev probes in examples/ can drive the stages.
#[doc(hidden)]
pub mod live;
mod windows_list;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(live::session::LiveState::default())
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
