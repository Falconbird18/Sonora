use serde::Serialize;
use std::{fs, path::{Path, PathBuf}, time::UNIX_EPOCH};

#[derive(Debug, Serialize)]
struct NativeScoreFile {
    path: String,
    relative_path: String,
    name: String,
    size: u64,
    modified_at: u64,
}

fn collect_pdfs(root: &Path, current: &Path, files: &mut Vec<NativeScoreFile>) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }

        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            collect_pdfs(root, &path, files)?;
        } else if metadata.is_file() && name.to_lowercase().ends_with(".pdf") {
            let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            files.push(NativeScoreFile {
                path: path.to_string_lossy().to_string(),
                relative_path: relative.to_string_lossy().replace('\\', "/"),
                name,
                size: metadata.len(),
                modified_at,
            });
        }
    }
    Ok(())
}

#[tauri::command]
async fn pick_score_folder() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Choose Sonora score folder")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().to_string())
}

#[tauri::command]
fn list_score_files(path: String) -> Result<Vec<NativeScoreFile>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("The saved score folder no longer exists.".into());
    }
    let mut files = Vec::new();
    collect_pdfs(&root, &root, &mut files)?;
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

#[tauri::command]
fn read_score_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![pick_score_folder, list_score_files, read_score_file, read_text_file])
        .run(tauri::generate_context!())
        .expect("error while running Sonora");
}
