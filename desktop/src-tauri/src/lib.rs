mod admin;
mod windows_list;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            windows_list::list_windows,
            admin::server_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running stream");
}
