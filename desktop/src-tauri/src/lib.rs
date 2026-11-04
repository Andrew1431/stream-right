mod capture;
// Native Go live; the stages are being built, nothing calls them yet. Public for the dev probes in examples/.
#[allow(dead_code)]
pub mod live;
mod windows_list;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![windows_list::list_windows, capture::capture_thumbnail])
        .run(tauri::generate_context!())
        .expect("error while running stream");
}
