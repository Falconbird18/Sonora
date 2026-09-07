use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Debug, Serialize)]
struct NativeScoreFile {
    path: String,
    relative_path: String,
    name: String,
    size: u64,
    modified_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ImslpSearchHit {
    title: String,
    snippet: String,
    pageid: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ImslpScoreFile {
    filename: String,
    description: String,
    editor: String,
    download_url: String,
}

fn collect_pdfs(root: &Path, current: &Path, files: &mut Vec<NativeScoreFile>) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|error| error.to_string())?;
    for entry in entries {
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

fn imslp_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Sonora/1.0 (sheet music library; +https://github.com/Falconbird18/Sonora)")
        .cookie_store(true)
        .build()
        .map_err(|e| e.to_string())
}

/// Search IMSLP works via the public MediaWiki API (no HTML scraping).
#[tauri::command]
async fn imslp_search(query: String, limit: Option<u32>) -> Result<Vec<ImslpSearchHit>, String> {
    let limit = limit.unwrap_or(20).clamp(1, 50);
    let client = imslp_client()?;
    let url = "https://imslp.org/api.php";
    let q = query.trim().to_string();

    let resp = client
        .get(url)
        .query(&[
            ("action", "query"),
            ("list", "search"),
            ("srsearch", &q),
            ("srnamespace", "0"),
            ("srlimit", &limit.to_string()),
            ("srprop", "snippet|size|wordcount|timestamp"),
            ("format", "json"),
            ("formatversion", "2"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let hits = body["query"]["search"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let title = item["title"].as_str()?.to_string();
            if title.starts_with("Category:")
                || title.starts_with("Help:")
                || title.starts_with("IMSLP:")
                || title.starts_with("File:")
            {
                return None;
            }
            let snippet = item["snippet"].as_str().unwrap_or("").to_string();
            if snippet.contains("#REDIRECT") {
                return None;
            }
            Some(ImslpSearchHit {
                title,
                snippet: strip_html_tags(&snippet),
                pageid: item["pageid"].as_u64(),
            })
        })
        .collect();
    Ok(hits)
}

fn strip_html_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace(""", "\"")
        .replace("&#39;", "'")
        .replace("<", "<")
        .replace(">", ">")
        .replace("&nbsp;", " ")
        .replace("&", "&")
}

/// Extract wikitext whether MediaWiki returns a bare string or {"*": "..."}.
fn parse_wikitext_field(value: &serde_json::Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }
    value
        .get("*")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Parse work-page wikitext (via MediaWiki action=parse) for PDF score files.
/// This uses the public API only — no HTML scraping of rendered pages.
#[tauri::command]
async fn imslp_work_scores(work_title: String) -> Result<Vec<ImslpScoreFile>, String> {
    let client = imslp_client()?;
    let url = "https://imslp.org/api.php";
    let resp = client
        .get(url)
        .query(&[
            ("action", "parse"),
            ("page", &work_title),
            ("prop", "wikitext"),
            ("format", "json"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if body.get("error").is_some() {
        return Err(body["error"]["info"]
            .as_str()
            .unwrap_or("IMSLP work page not found")
            .to_string());
    }
    let wikitext = parse_wikitext_field(&body["parse"]["wikitext"])
        .ok_or_else(|| "No wikitext returned for this work".to_string())?;

    Ok(extract_score_files(&wikitext))
}

/// Parse only `{{#fte:imslpfile ... }}` blocks (score PDFs, not audio).
fn extract_score_files(wikitext: &str) -> Vec<ImslpScoreFile> {
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut in_file_block = false;
    let mut names: std::collections::BTreeMap<u32, String> = std::collections::BTreeMap::new();
    let mut descriptions: std::collections::BTreeMap<u32, String> = std::collections::BTreeMap::new();
    let mut editor = String::new();
    let mut publisher = String::new();
    let mut image_type = String::new();

    for line in wikitext.lines() {
        let trimmed = line.trim();

        if trimmed.contains("{{#fte:imslpfile") {
            if in_file_block {
                flush_block(
                    &names,
                    &descriptions,
                    &editor,
                    &publisher,
                    &image_type,
                    &mut seen,
                    &mut results,
                );
            }
            in_file_block = true;
            names.clear();
            descriptions.clear();
            editor.clear();
            publisher.clear();
            image_type.clear();
            continue;
        }

        if in_file_block {
            if trimmed == "}}" || trimmed.starts_with("}}") {
                flush_block(
                    &names,
                    &descriptions,
                    &editor,
                    &publisher,
                    &image_type,
                    &mut seen,
                    &mut results,
                );
                in_file_block = false;
                names.clear();
                descriptions.clear();
                editor.clear();
                publisher.clear();
                image_type.clear();
                continue;
            }

            if let Some(rest) = strip_param(trimmed, "File Name")
                .or_else(|| strip_param(trimmed, "Filename"))
            {
                let (idx, value) = split_indexed_param(rest);
                if value.to_lowercase().ends_with(".pdf") {
                    names.insert(idx, value);
                }
            } else if let Some(rest) = strip_param(trimmed, "File Description") {
                let (idx, value) = split_indexed_param(rest);
                if !value.is_empty() {
                    descriptions.insert(idx, value);
                }
            } else if let Some(rest) = strip_param(trimmed, "Editor") {
                let (_, value) = split_indexed_param(rest);
                if !value.is_empty() {
                    editor = value;
                }
            } else if let Some(rest) = strip_param(trimmed, "Publisher Information") {
                let (_, value) = split_indexed_param(rest);
                if !value.is_empty() {
                    publisher = value;
                }
            } else if let Some(rest) = strip_param(trimmed, "Image Type") {
                let (_, value) = split_indexed_param(rest);
                if !value.is_empty() {
                    image_type = value;
                }
            }
        }
    }

    if in_file_block {
        flush_block(
            &names,
            &descriptions,
            &editor,
            &publisher,
            &image_type,
            &mut seen,
            &mut results,
        );
    }

    results
}

fn flush_block(
    names: &std::collections::BTreeMap<u32, String>,
    descriptions: &std::collections::BTreeMap<u32, String>,
    editor: &str,
    publisher: &str,
    image_type: &str,
    seen: &mut std::collections::HashSet<String>,
    results: &mut Vec<ImslpScoreFile>,
) {
    for (n, filename) in names {
        if !filename.to_lowercase().ends_with(".pdf") {
            continue;
        }
        if !seen.insert(filename.clone()) {
            continue;
        }
        let mut desc = descriptions.get(n).cloned().unwrap_or_default();
        if desc.is_empty() && !image_type.is_empty() {
            desc = image_type.to_string();
        }
        desc = clean_wiki_text(&desc);
        let ed = clean_wiki_text(editor);
        let pub_clean = clean_wiki_text(publisher);
        // Skip pure template residue / empty publisher noise
        if !pub_clean.is_empty() && pub_clean.len() > 1 {
            if !desc.is_empty() {
                desc = format!("{desc} · {pub_clean}");
            } else {
                desc = pub_clean;
            }
        }
        results.push(make_score_file(filename, &desc, &ed));
    }
}

fn strip_param<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let line = line.strip_prefix('|')?;
    // Must not slice into a multi-byte UTF-8 character (e.g. CJK in unrelated fields).
    if !line.is_char_boundary(key.len()) {
        return None;
    }
    let prefix = line.get(..key.len())?;
    if !prefix.eq_ignore_ascii_case(key) {
        return None;
    }
    Some(&line[key.len()..])
}

fn split_indexed_param(rest: &str) -> (u32, String) {
    let rest = rest.trim_start();
    if let Some(eq) = rest.find('=') {
        let head = rest[..eq].trim();
        let value = rest[eq + 1..].trim().to_string();
        let idx = head.parse::<u32>().unwrap_or(1);
        (idx, value)
    } else {
        (1, rest.trim().to_string())
    }
}

/// Strip common MediaWiki markup for human-readable display.
fn clean_wiki_text(s: &str) -> String {
    let mut out = s.to_string();

    // [[link|display]] or [[link]] -> display / link
    while let Some(start) = out.find("[[") {
        if let Some(rel_end) = out[start..].find("]]") {
            let end = start + rel_end;
            let inner = &out[start + 2..end];
            let display = inner.split('|').next_back().unwrap_or(inner).to_string();
            out.replace_range(start..end + 2, &display);
        } else {
            break;
        }
    }

    // {{template|args}} — drop entirely (publisher codes, scanners, etc.)
    while let Some(start) = out.find("{{") {
        if let Some(rel_end) = out[start..].find("}}") {
            let end = start + rel_end;
            out.replace_range(start..end + 2, "");
        } else {
            break;
        }
    }

    // [http://... label] -> label
    while let Some(start) = out.find('[') {
        let after = start + 1;
        if after < out.len() {
            let rest = &out[after..];
            if rest.starts_with("http://") || rest.starts_with("https://") {
                if let Some(rel_end) = rest.find(']') {
                    let inner = &rest[..rel_end];
                    let display = inner
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("")
                        .to_string();
                    out.replace_range(start..after + rel_end + 1, &display);
                    continue;
                }
            }
        }
        break;
    }

    // Bold/italic wiki markers
    out = out.replace("'''", "").replace("''", "");

    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn make_score_file(filename: &str, description: &str, editor: &str) -> ImslpScoreFile {
    let encoded = urlencoding_encode(filename);
    ImslpScoreFile {
        filename: filename.to_string(),
        description: description.to_string(),
        editor: editor.to_string(),
        download_url: format!("https://imslp.org/wiki/Special:ImagefromIndex/{encoded}"),
    }
}

/// Minimal percent-encoding for path segments.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Download a score PDF through the public ImagefromIndex redirect.
/// Accepts the IMSLP disclaimer cookie so the real PDF is returned.
/// Optionally writes into the user's library folder (IMSLP/ subdir).
#[tauri::command]
async fn imslp_download_score(
    filename: String,
    library_root: Option<String>,
) -> Result<ImslpDownloadResult, String> {
    let client = imslp_client()?;

    let _ = client
        .get("https://imslp.org/wiki/Special:ImagefromIndex/")
        .header("Cookie", "imslpdisclaimeraccepted=yes")
        .send()
        .await;

    let encoded = urlencoding_encode(&filename);
    let url = format!("https://imslp.org/wiki/Special:ImagefromIndex/{encoded}");
    let resp = client
        .get(&url)
        .header("Cookie", "imslpdisclaimeraccepted=yes")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    if bytes.len() < 100
        || content_type.contains("text/html")
        || !bytes.starts_with(b"%PDF")
    {
        return Err(
            "IMSLP returned a non-PDF response (disclaimer or blocked). Try again, or open the work on IMSLP in a browser."
                .into(),
        );
    }

    let mut saved_path: Option<String> = None;
    let mut relative_path: Option<String> = None;

    if let Some(root) = library_root {
        let root_path = PathBuf::from(&root);
        if root_path.is_dir() {
            let imslp_dir = root_path.join("IMSLP");
            fs::create_dir_all(&imslp_dir).map_err(|e| e.to_string())?;
            let safe_name = filename
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect::<String>();
            let dest = imslp_dir.join(&safe_name);
            fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
            saved_path = Some(dest.to_string_lossy().to_string());
            relative_path = Some(format!("IMSLP/{safe_name}"));
        }
    }

    let include_bytes = saved_path.is_none();
    Ok(ImslpDownloadResult {
        filename,
        size: bytes.len() as u64,
        saved_path,
        relative_path,
        bytes_base64: if include_bytes {
            Some(data_encoding_base64(&bytes))
        } else {
            None
        },
    })
}

#[derive(Debug, Serialize)]
struct ImslpDownloadResult {
    filename: String,
    size: u64,
    saved_path: Option<String>,
    relative_path: Option<String>,
    bytes_base64: Option<String>,
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
    fs::read(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_score_file_base64(path: String) -> Result<String, String> {
    let buf = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(data_encoding_base64(&buf))
}

fn data_encoding_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 63) as usize] as char);
        out.push(TABLE[((triple >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
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
        .invoke_handler(tauri::generate_handler![
            pick_score_folder,
            list_score_files,
            read_score_file,
            read_score_file_base64,
            read_text_file,
            imslp_search,
            imslp_work_scores,
            imslp_download_score
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sonora");
}
