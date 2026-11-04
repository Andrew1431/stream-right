mod admin;
mod capture;
mod icons;
// Native Go live; the stages are being built, nothing calls them yet.
#[allow(dead_code)]
mod live;
mod windows_list;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            windows_list::list_windows,
            windows_list::list_monitors,
            capture::capture_thumbnail,
            capture::capture_monitor_thumbnail,
            admin::server_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running stream");
}
