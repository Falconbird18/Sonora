//! First-run provisioning into Sonora's own data directory. The official engine
//! is downloaded on demand, verified, and unpacked without system installation.
use sha2::{Digest, Sha256};
#[cfg(any(target_os = "macos", target_os = "windows", test))]
use std::process::Command;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

const VERSION: &str = "5.11.0";

fn asset() -> Result<(&'static str, &'static str), String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok((
            "Audiveris-5.11.0-ubuntu22.04-x86_64.deb",
            "ae714594f40e54b1a4951fc3f914f08ae38fe5d07b7f2283b1a904fdb6e0a318",
        )),
        ("macos", "aarch64") => Ok((
            "Audiveris-5.11.0-macosx-arm64.dmg",
            "17491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6",
        )),
        ("macos", "x86_64") => Ok((
            "Audiveris-5.11.0-macosx-x86_64.dmg",
            "11794424c6f1698617836a77d2c5818c46405a3fe7388281c623c4e383fa33cb",
        )),
        ("windows", "x86_64") => Ok((
            "Audiveris-5.11.0-windows-x86_64.msi",
            "ac221b0d39a90e32b7f43dbf9f5d5a45ff8b5424076af21b65278955688dac71",
        )),
        (os, arch) => Err(format!(
            "Automatic local recognition is not available for {os}/{arch} yet."
        )),
    }
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    expected_hash: Option<&str>,
) -> Result<(), String> {
    let mut response = client.get(url).send().await.map_err(|e| format!("Could not prepare local recognition. Check your connection and try Convert again: {e}"))?
        .error_for_status().map_err(|e| e.to_string())?;
    let mut file = File::create(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut size = 0usize;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        size += chunk.len();
        if size > 200 * 1024 * 1024 {
            return Err("Recognition download exceeded its expected size".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    file.sync_all().map_err(|e| e.to_string())?;
    if expected_hash.is_some_and(|expected| format!("{:x}", hash.finalize()) != expected) {
        return Err(
            "The recognition download did not pass integrity verification. Try Convert again."
                .into(),
        );
    }
    Ok(())
}

pub async fn languages(folder: &Path, specification: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(240))
        .user_agent("Sonora local music recognition setup")
        .build()
        .map_err(|e| e.to_string())?;
    for code in specification.split('+') {
        if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_lowercase()) {
            return Err("Invalid automatic OCR language".into());
        }
        let path = folder.join(format!("{code}.traineddata"));
        if super::legacy_ocr_data(&path) {
            continue;
        }
        let temporary = folder.join(format!("{code}.download"));
        let result = download(
            &client,
            &format!(
                "https://raw.githubusercontent.com/tesseract-ocr/tessdata/4.1.0/{code}.traineddata"
            ),
            &temporary,
            None,
        )
        .await;
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        if !super::legacy_ocr_data(&temporary) {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "The {code} OCR dictionary could not be verified. Try Convert again."
            ));
        }
        fs::rename(temporary, path).map_err(|e| e.to_string())?;
    }
    Ok(folder.to_path_buf())
}

fn ready(folder: &Path) -> Option<PathBuf> {
    let relative = fs::read_to_string(folder.join("ready.txt")).ok()?;
    if !Path::new(&relative)
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let engine = folder.join(relative);
    engine.is_file().then_some(engine)
}

pub async fn prepare(base: &Path, specification: &str) -> Result<(PathBuf, PathBuf), String> {
    let runtime = base.join(format!("runtime-{VERSION}"));
    let engine = if let Some(engine) = ready(&runtime) {
        engine
    } else {
        fs::create_dir_all(base).map_err(|e| e.to_string())?;
        let (name, hash) = asset()?;
        let package = base.join(name);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .user_agent("Sonora local music recognition setup")
            .build()
            .map_err(|e| e.to_string())?;
        if let Err(error) = download(
            &client,
            &format!("https://github.com/Audiveris/audiveris/releases/download/{VERSION}/{name}"),
            &package,
            Some(hash),
        )
        .await
        {
            let _ = fs::remove_file(&package);
            return Err(error);
        }
        let stage = base.join(format!("runtime-{VERSION}-staging"));
        let output = stage.clone();
        let input = package.clone();
        let relative = tokio::task::spawn_blocking(move || {
            if output.exists() {
                fs::remove_dir_all(&output).map_err(|e| e.to_string())?;
            }
            fs::create_dir_all(&output).map_err(|e| e.to_string())?;
            unpack(&input, &output)?;
            let engine = find_engine(&output, 0)
                .ok_or("The local recognition package contains no launcher")?;
            let relative = engine
                .strip_prefix(&output)
                .map_err(|e| e.to_string())?
                .to_path_buf();
            fs::write(
                output.join("ready.txt"),
                relative.to_string_lossy().as_bytes(),
            )
            .map_err(|e| e.to_string())?;
            Ok::<_, String>(relative)
        })
        .await
        .map_err(|e| e.to_string())??;
        if runtime.exists() {
            fs::remove_dir_all(&runtime).map_err(|e| e.to_string())?;
        }
        fs::rename(&stage, &runtime).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(package);
        runtime.join(relative)
    };
    let data = languages(&base.join("tessdata"), specification).await?;
    Ok((engine, data))
}

fn find_engine(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 12 {
        return None;
    }
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let ty = entry.file_type().ok()?;
        if ty.is_symlink() {
            continue;
        }
        if ty.is_file()
            && ["Audiveris", "Audiveris.exe"].iter().any(|name| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(name)
            })
        {
            return Some(entry.path());
        }
        if ty.is_dir() {
            if let Some(found) = find_engine(&entry.path(), depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn unpack(package: &Path, destination: &Path) -> Result<(), String> {
    let mut file = File::open(package).map_err(|e| e.to_string())?;
    let mut magic = [0; 8];
    file.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if &magic != b"!<arch>\n" {
        return Err("Invalid recognition package".into());
    }
    for _ in 0..100 {
        let mut header = [0; 60];
        file.read_exact(&mut header).map_err(|e| e.to_string())?;
        if &header[58..] != b"`\n" {
            return Err("Invalid recognition archive header".into());
        }
        let name = String::from_utf8_lossy(&header[..16])
            .trim()
            .trim_end_matches('/')
            .to_string();
        let size: u64 = String::from_utf8_lossy(&header[48..58])
            .trim()
            .parse()
            .map_err(|_| "Invalid recognition archive length")?;
        if size > 200 * 1024 * 1024 {
            return Err("Recognition archive is oversized".into());
        }
        if name == "data.tar.zst" {
            let decoder =
                zstd::stream::read::Decoder::new(file.take(size)).map_err(|e| e.to_string())?;
            return tar::Archive::new(decoder)
                .unpack(destination)
                .map_err(|e| e.to_string());
        }
        file.seek(SeekFrom::Current((size + size % 2) as i64))
            .map_err(|e| e.to_string())?;
    }
    Err("Recognition archive contains no application files".into())
}

#[cfg(target_os = "windows")]
fn unpack(package: &Path, destination: &Path) -> Result<(), String> {
    let status = Command::new("msiexec")
        .arg("/a")
        .arg(package)
        .arg("/qn")
        .arg(format!("TARGETDIR={}", destination.display()))
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Could not prepare local recognition ({status}). Try Convert again."
        ))
    }
}

#[cfg(target_os = "macos")]
fn unpack(package: &Path, destination: &Path) -> Result<(), String> {
    let mount = destination.join("mount");
    fs::create_dir_all(&mount).map_err(|e| e.to_string())?;
    let status = Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-mountpoint"])
        .arg(&mount)
        .arg(package)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Could not open the local recognition package".into());
    }
    let result = Command::new("ditto")
        .arg(mount.join("Audiveris.app"))
        .arg(destination.join("Audiveris.app"))
        .status()
        .map_err(|e| e.to_string());
    let _ = Command::new("hdiutil").arg("detach").arg(&mount).status();
    match result {
        Ok(status) if status.success() => Ok(()),
        _ => Err("Could not prepare local recognition".into()),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn unpack(_: &Path, _: &Path) -> Result<(), String> {
    Err("Local recognition is not available for this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "downloads the official runtime and OCR data once; uses only a temporary directory"]
    async fn automatic_runtime_is_usable_and_cached() {
        let folder = std::env::temp_dir().join("sonora-automatic-runtime-test");
        let (engine, data) = prepare(&folder, "eng+deu+ita").await.unwrap();
        assert!(engine.is_file());
        assert!(super::super::legacy_ocr_data(&data.join("eng.traineddata")));
        let path = engine.clone();
        let status = tokio::task::spawn_blocking(move || {
            Command::new(path)
                .arg("-help")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
        })
        .await
        .unwrap()
        .unwrap();
        assert!(status.success());
        assert_eq!(prepare(&folder, "eng+deu+ita").await.unwrap().0, engine);
    }
}
