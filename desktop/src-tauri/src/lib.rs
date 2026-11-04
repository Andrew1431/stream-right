mod capture;
// Native Go live; the stages are being built, nothing calls them yet.
#[allow(dead_code)]
// Public only so dev harnesses in examples/ can drive the stages.
#[doc(hidden)]
pub mod live;
mod windows_list;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![windows_list::list_windows, capture::capture_thumbnail])
        .run(tauri::generate_context!())
        .expect("error while running stream");
}
