use std::{
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(serde::Serialize)]
pub struct ScoreTree {
    files: Vec<super::NativeScoreFile>,
    directories: Vec<String>,
}

#[tauri::command]
pub async fn list_score_tree(path: String) -> Result<ScoreTree, String> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(path);
        if !root.is_dir() {
            return Err("The score folder no longer exists.".into());
        }
        let mut tree = ScoreTree {
            files: Vec::new(),
            directories: Vec::new(),
        };
        super::collect_score_tree(&root, &root, &mut tree.files, &mut tree.directories)?;
        tree.directories.sort();
        tree.files
            .sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        Ok(tree)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn checked_path(root: &Path, relative: &str, must_exist: bool) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.contains('\\')
        || relative
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        || Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid relative library path.".into());
    }
    let target = root.join(relative);
    let check = if must_exist {
        target.as_path()
    } else {
        target.parent().ok_or("Invalid destination")?
    };
    if !check
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(root)
    {
        return Err("The path is outside the score library.".into());
    }
    if target.is_symlink() {
        return Err("Symbolic links cannot be reorganized.".into());
    }
    Ok(target)
}

#[tauri::command]
pub fn create_score_directory(library_root: String, relative_path: String) -> Result<(), String> {
    let root = Path::new(&library_root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = checked_path(&root, &relative_path, false)?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid folder name")?;
    if name.starts_with('.')
        || name
            .chars()
            .any(|c| "<>:\"|?*".contains(c) || c.is_control())
        || name.ends_with(['.', ' '])
    {
        return Err("Invalid folder name.".into());
    }
    fs::create_dir(target).map_err(|e| format!("Could not create folder: {e}"))
}

#[tauri::command]
pub fn move_score_entry(
    library_root: String,
    source_relative: String,
    destination_relative: String,
) -> Result<(), String> {
    let root = Path::new(&library_root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let source = checked_path(&root, &source_relative, true)?;
    let destination = checked_path(&root, &destination_relative, false)?;
    if source == destination {
        return Ok(());
    }
    let canonical_source = source.canonicalize().map_err(|e| e.to_string())?;
    let destination_parent = destination
        .parent()
        .unwrap()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if source.is_dir() && destination_parent.starts_with(&canonical_source) {
        return Err("A folder cannot be moved inside itself.".into());
    }
    if destination.exists() {
        return Err("A file or folder with that name already exists.".into());
    }
    let sidecar = source.with_extension("sonora.json");
    let destination_sidecar = destination.with_extension("sonora.json");
    let move_sidecar = source.is_file() && sidecar.exists();
    if move_sidecar && destination_sidecar.exists() {
        return Err("Score metadata already exists at the destination.".into());
    }
    fs::rename(&source, &destination).map_err(|e| format!("Could not move item: {e}"))?;
    if move_sidecar {
        if let Err(error) = fs::rename(&sidecar, &destination_sidecar) {
            fs::rename(&destination, &source).map_err(|rollback| format!("Metadata move failed ({error}); rollback failed ({rollback}). Refresh the library."))?;
            return Err(format!("Could not move metadata: {error}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_score_directory(
    library_root: String,
    relative_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || delete_directory_on_disk(library_root, relative_path))
        .await
        .map_err(|e| e.to_string())?
}

fn delete_directory_on_disk(library_root: String, relative_path: String) -> Result<(), String> {
    let root = Path::new(&library_root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = checked_path(&root, &relative_path, true)?;
    if !target.is_dir() {
        return Err("Select a folder to delete.".into());
    }
    fs::remove_dir_all(target).map_err(|e| format!("Could not delete folder: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deletion_removes_subtree_and_protects_root() {
        let root = std::env::temp_dir().join(format!(
            "sonora-delete-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("Delete/Parts")).unwrap();
        fs::create_dir(root.join("Keep")).unwrap();
        fs::write(root.join("Delete/Parts/score.pdf"), b"pdf").unwrap();
        fs::write(root.join("Delete/Parts/score.sonora.json"), b"metadata").unwrap();
        let path = root.to_string_lossy().to_string();
        assert!(delete_directory_on_disk(path.clone(), "".into()).is_err());
        assert!(delete_directory_on_disk(path.clone(), "../escape".into()).is_err());
        delete_directory_on_disk(path, "Delete".into()).unwrap();
        assert!(!root.join("Delete").exists());
        assert!(root.join("Keep").is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folders_follow_filesystem_and_preserve_sidecars() {
        let root = std::env::temp_dir().join(format!(
            "sonora-folders-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.to_string_lossy().to_string();
        create_score_directory(path.clone(), "Practice".into()).unwrap();
        create_score_directory(path.clone(), "Practice/Parts".into()).unwrap();
        fs::write(root.join("score.pdf"), b"pdf").unwrap();
        fs::write(root.join("score.sonora.json"), b"metadata").unwrap();
        move_score_entry(
            path.clone(),
            "score.pdf".into(),
            "Practice/score.pdf".into(),
        )
        .unwrap();
        assert!(root.join("Practice/score.sonora.json").exists());
        move_score_entry(path.clone(), "Practice".into(), "Rehearsal".into()).unwrap();
        assert!(root.join("Rehearsal/Parts").is_dir());
        assert!(root.join("Rehearsal/score.pdf").exists());
        assert!(move_score_entry(
            path.clone(),
            "Rehearsal".into(),
            "Rehearsal/Parts/Cycle".into()
        )
        .is_err());
        assert!(create_score_directory(path.clone(), "../Escape".into()).is_err());
        assert!(create_score_directory(path.clone(), "/Escape".into()).is_err());
        fs::write(root.join("collision.pdf"), b"keep").unwrap();
        assert!(
            move_score_entry(path, "Rehearsal/score.pdf".into(), "collision.pdf".into()).is_err()
        );
        assert_eq!(fs::read(root.join("collision.pdf")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }
}
