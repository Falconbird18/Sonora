use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

<<<<<<< HEAD
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
    thumb_url: Option<String>,
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

#[tauri::command]
async fn imslp_search(query: String, limit: Option<u32>) -> Result<Vec<ImslpSearchHit>, String> {
    let limit = limit.unwrap_or(20).clamp(1, 50);
    let client = imslp_client()?;
    let q = query.trim().to_string();
    let resp = client
        .get("https://imslp.org/api.php")
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
                snippet: clean_search_snippet(&snippet),
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
    out
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("<br>", " ")
        .replace("<br/>", " ")
        .replace("<br />", " ")
        .replace("&amp;", "&")
}

fn clean_search_snippet(s: &str) -> String {
    let decoded = decode_html_entities(s);
    let no_tags = strip_html_tags(&decoded);
    let cleaned = clean_wiki_text(&no_tags);
    let mut out = cleaned
        .replace('|', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    while out.starts_with('.') {
        out = out[1..].trim_start().to_string();
    }
    out
}

fn parse_wikitext_field(value: &serde_json::Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }
    value.get("*").and_then(|v| v.as_str()).map(|s| s.to_string())
}

#[tauri::command]
async fn imslp_work_scores(work_title: String) -> Result<Vec<ImslpScoreFile>, String> {
    let client = imslp_client()?;
    let resp = client
        .get("https://imslp.org/api.php")
        .query(&[
            ("action", "parse"),
            ("page", &work_title),
            ("prop", "wikitext"),
            ("format", "json"),
            ("formatversion", "2"),
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
    let mut files = extract_score_files(&wikitext);
    enrich_thumbnails(&client, &mut files).await;
    Ok(files)
}

async fn enrich_thumbnails(client: &reqwest::Client, files: &mut [ImslpScoreFile]) {
    if files.is_empty() {
        return;
    }
    for chunk in files.chunks_mut(40) {
        let titles: Vec<String> = chunk
            .iter()
            .map(|f| format!("File:{}", f.filename.replace(' ', "_")))
            .collect();
        let joined = titles.join("|");
        let resp = client
            .get("https://imslp.org/api.php")
            .query(&[
                ("action", "query"),
                ("titles", &joined),
                ("prop", "imageinfo"),
                ("iiprop", "url"),
                ("iiurlwidth", "160"),
                ("format", "json"),
            ])
            .send()
            .await;
        let Ok(resp) = resp else { continue };
        let Ok(body) = resp.json::<serde_json::Value>().await else { continue };
        let Some(pages) = body["query"]["pages"].as_object() else { continue };
        let mut thumbs: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for (_id, page) in pages {
            let title = page["title"].as_str().unwrap_or("").to_string();
            let fname = title.strip_prefix("File:").unwrap_or(&title).replace('_', " ");
            if let Some(info) = page["imageinfo"].as_array().and_then(|a| a.first()) {
                if let Some(tu) = info.get("thumburl").and_then(|v| v.as_str()) {
                    let mut u = tu.to_string();
                    if u.starts_with("//") {
                        u = format!("https:{u}");
                    }
                    thumbs.insert(fname.to_lowercase(), u.clone());
                    thumbs.insert(
                        title.strip_prefix("File:").unwrap_or(&title).to_lowercase(),
                        u,
                    );
                }
            }
        }
        for f in chunk.iter_mut() {
            let k1 = f.filename.to_lowercase();
            let k2 = f.filename.replace(' ', "_").to_lowercase();
            f.thumb_url = thumbs.get(&k1).cloned().or_else(|| thumbs.get(&k2).cloned());
        }
    }
}

fn extract_score_files(wikitext: &str) -> Vec<ImslpScoreFile> {
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut rest = wikitext;

    while let Some(start) = rest.find("{{#fte:imslpfile") {
        rest = &rest[start..];
        let Some(block) = extract_template_block(rest) else { break };
        rest = &rest[block.len()..];

        let mut names = std::collections::BTreeMap::<u32, String>::new();
        let mut descriptions = std::collections::BTreeMap::<u32, String>::new();
        let mut editor = String::new();
        let mut publisher = String::new();
        let mut image_type = String::new();

        for line in block.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with('|') {
                continue;
            }
            if let Some(r) = strip_param(trimmed, "File Name")
                .or_else(|| strip_param(trimmed, "Filename"))
                .or_else(|| strip_param(trimmed, "FileName"))
            {
                let (idx, value) = split_indexed_param(r);
                let value = value.trim().to_string();
                if value.to_lowercase().ends_with(".pdf") {
                    names.insert(idx, value);
                }
            } else if let Some(r) = strip_param(trimmed, "File Description") {
                let (idx, value) = split_indexed_param(r);
                if !value.is_empty() {
                    descriptions.insert(idx, value);
                }
            } else if let Some(r) = strip_param(trimmed, "Editor") {
                let (_, value) = split_indexed_param(r);
                if !value.is_empty() {
                    editor = value;
                }
            } else if let Some(r) = strip_param(trimmed, "Publisher Information") {
                let (_, value) = split_indexed_param(r);
                if !value.is_empty() {
                    publisher = value;
                }
            } else if let Some(r) = strip_param(trimmed, "Image Type") {
                let (_, value) = split_indexed_param(r);
                if !value.is_empty() {
                    image_type = value;
                }
            }
        }
        flush_block(
            &names, &descriptions, &editor, &publisher, &image_type, &mut seen, &mut results,
        );
    }
    results
}

fn extract_template_block(s: &str) -> Option<&str> {
    if !s.starts_with("{{") {
        return None;
    }
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            depth += 1;
            i += 2;
            continue;
        }
        if bytes[i] == b'}' && bytes[i + 1] == b'}' {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return Some(&s[..i]);
            }
            continue;
        }
        i += 1;
    }
    None
}

fn simple_pdf_filenames(wikitext: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = wikitext;
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find(".pdf") {
        let abs_end = search_from + rel + 4;
        // walk back for filename start
        let start_area = &lower[search_from..abs_end];
        let name_start = start_area
            .rfind(|c: char| c == '|' || c == '=' || c == '[' || c == '/' || c == ' ' || c == '\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        let candidate = start_area[name_start..].trim();
        if candidate.to_lowercase().ends_with(".pdf")
            && candidate.len() > 5
            && !candidate.contains("{{")
            && !candidate.contains("}}")
        {
            let clean = candidate.trim_matches(|c: char| c == '[' || c == ']').to_string();
            if clean.to_lowercase().ends_with(".pdf") {
                out.push(clean);
            }
        }
        search_from = abs_end;
    }
    out
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
        if !filename.to_lowercase().ends_with(".pdf") || !seen.insert(filename.clone()) {
            continue;
        }
        let mut desc = descriptions.get(n).cloned().unwrap_or_default();
        if desc.is_empty() && !image_type.is_empty() {
            desc = image_type.to_string();
        }
        desc = clean_wiki_text(&desc);
        let ed = clean_wiki_text(editor);
        let pub_clean = clean_wiki_text(publisher);
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
    let line = line.strip_prefix('|')?.trim_start();
    if line.len() < key.len() || !line.is_char_boundary(key.len()) {
        return None;
    }
    let prefix = line.get(..key.len())?;
    if !prefix.eq_ignore_ascii_case(key) {
        return None;
    }
    let after = &line[key.len()..];
    if after.is_empty()
        || after.starts_with('=')
        || after.starts_with(|c: char| c.is_ascii_whitespace() || c.is_ascii_digit())
    {
        Some(after)
    } else {
        None
    }
}

fn split_indexed_param(rest: &str) -> (u32, String) {
    let rest = rest.trim_start();
    if let Some(eq) = rest.find('=') {
        let head = rest[..eq].trim();
        let value = rest[eq + 1..].trim().to_string();
        (head.parse::<u32>().unwrap_or(1), value)
    } else {
        (1, rest.trim().to_string())
    }
}

fn clean_wiki_text(s: &str) -> String {
    let mut out = s.to_string();
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
    while let Some(start) = out.find("{{") {
        if let Some(rel_end) = out[start..].find("}}") {
            let end = start + rel_end;
            out.replace_range(start..end + 2, "");
        } else {
            break;
        }
    }
    out = out.replace("'''", "").replace("''", "");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn make_score_file(filename: &str, description: &str, editor: &str) -> ImslpScoreFile {
    let encoded = urlencoding_encode(filename);
    ImslpScoreFile {
        filename: filename.to_string(),
        description: description.to_string(),
        editor: editor.to_string(),
        download_url: format!("https://imslp.org/wiki/Special:IMSLPDisclaimerAccept/{encoded}"),
        thumb_url: None,
    }
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Download via IMSLP disclaimer → image-handler → mirror URL flow.
/// Non-members often get an HTML wait/subscribe page that still embeds the
/// real mirror in a `data-id` attribute; we parse that and fetch the PDF.
#[tauri::command]
async fn imslp_download_score(
    filename: String,
    library_root: Option<String>,
) -> Result<ImslpDownloadResult, String> {
    let client = imslp_client()?;
    let encoded = urlencoding_encode(&filename);
    let accept_url = format!("https://imslp.org/wiki/Special:IMSLPDisclaimerAccept/{encoded}");
    let handler_url = format!("https://imslp.org/wiki/Special:IMSLPImageHandler/{encoded}");

    let headers = |req: reqwest::RequestBuilder| {
        req.header("Cookie", "redirectPassed=1; imslpdisclaimeraccepted=yes")
            .header(
                "Accept",
                "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
            )
            .header("Referer", "https://imslp.org/")
    };

    let resp = headers(client.get(&accept_url))
        .send()
        .await
        .map_err(|e| format!("IMSLP request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("IMSLP disclaimer error: {e}"))?;

    let mut bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read IMSLP response: {e}"))?;

    if !bytes.starts_with(b"%PDF") {
        let html = String::from_utf8_lossy(&bytes).into_owned();
        let mut mirror = extract_mirror_url(&html);

        if mirror.is_none() {
            if let Ok(resp2) = headers(client.get(&handler_url)).send().await {
                if resp2.status().is_success() {
                    if let Ok(b2) = resp2.bytes().await {
                        if b2.starts_with(b"%PDF") {
                            bytes = b2;
                        } else {
                            mirror = extract_mirror_url(&String::from_utf8_lossy(&b2));
                        }
                    }
                }
            }
        }

        if !bytes.starts_with(b"%PDF") {
            let mirror = mirror.ok_or_else(|| {
                if html.to_lowercase().contains("subscribe") {
                    "Could not get a free download link (membership may be required, or page format changed)."
                        .to_string()
                } else {
                    "Could not find a download link on IMSLP.".to_string()
                }
            })?;

            let resp3 = headers(client.get(&mirror))
                .send()
                .await
                .map_err(|e| format!("Mirror download failed: {e}"))?
                .error_for_status()
                .map_err(|e| format!("Mirror returned error: {e}"))?;

            let content_type = resp3
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            bytes = resp3
                .bytes()
                .await
                .map_err(|e| format!("Failed to read PDF bytes: {e}"))?;

            if bytes.len() < 100 || content_type.contains("text/html") || !bytes.starts_with(b"%PDF")
            {
                return Err(
                    "IMSLP returned a non-PDF response. The file may require membership.".into(),
                );
            }
        }
    }

    if bytes.len() < 100 || !bytes.starts_with(b"%PDF") {
        return Err("IMSLP returned a non-PDF response.".into());
    }

    let mut saved_path = None;
    let mut relative_path = None;
    if let Some(root) = library_root {
        let root_path = PathBuf::from(&root);
        if !root_path.is_dir() {
            return Err(format!("Library folder does not exist: {root}"));
        }
        let imslp_dir = root_path.join("IMSLP");
        fs::create_dir_all(&imslp_dir).map_err(|e| format!("Could not create IMSLP folder: {e}"))?;
        let safe_name: String = filename
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let dest = imslp_dir.join(&safe_name);
        fs::write(&dest, &bytes).map_err(|e| format!("Could not write PDF: {e}"))?;
        saved_path = Some(dest.to_string_lossy().to_string());
        relative_path = Some(format!("IMSLP/{safe_name}"));
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

fn extract_mirror_url(html: &str) -> Option<String> {
    for (prefix, quote) in [("data-id=\"", '"'), ("data-id='", '\'')] {
        let mut search = html;
        while let Some(idx) = search.find(prefix) {
            let start = idx + prefix.len();
            if let Some(rel) = search[start..].find(quote) {
                let raw = &search[start..start + rel];
                let decoded = decode_basic_html_entities(raw);
                if let Some(url) = normalize_mirror_candidate(&decoded) {
                    return Some(url);
                }
            }
            search = &search[start..];
        }
    }

    for marker in [
        "https://vmirror.imslp.org/",
        "http://vmirror.imslp.org/",
        "//vmirror.imslp.org/",
        "https://ks",
        "http://ks",
        "//ks",
        "https://s",
        "http://s",
    ] {
        let mut from = 0;
        while let Some(rel) = html[from..].find(marker) {
            let idx = from + rel;
            let slice = &html[idx..];
            let end = slice
                .find(|c: char| matches!(c, '"' | '\'' | ' ' | '<' | '>' | '\n' | '\r'))
                .unwrap_or(slice.len());
            let mut url = decode_basic_html_entities(&slice[..end]);
            while url.ends_with(['.', ',', ')']) {
                url.pop();
            }
            if let Some(u) = normalize_mirror_candidate(&url) {
                return Some(u);
            }
            from = idx + marker.len();
        }
    }
    None
}

fn normalize_mirror_candidate(raw: &str) -> Option<String> {
    let mut u = raw.trim().to_string();
    if u.is_empty() {
        return None;
    }
    if u.starts_with("//") {
        u = format!("https:{u}");
    }
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return None;
    }
    if u.starts_with("http://") && (u.contains("imslp.org") || u.contains("vmirror")) {
        u = format!("https://{}", &u[7..]);
    }
    let lower = u.to_lowercase();
    if lower.contains(".pdf")
        || lower.contains("/files/")
        || lower.contains("imglnks")
        || lower.contains("vmirror.imslp.org")
    {
        Some(u)
    } else {
        None
    }
}

fn decode_basic_html_entities(s: &str) -> String {
    s.replace("&#58;", ":")
        .replace("&#x3a;", ":")
        .replace("&#x3A;", ":")
        .replace("&#47;", "/")
        .replace("&#x2f;", "/")
        .replace("&#x2F;", "/")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
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

=======
// Temporarily restored stub — full file will be restored next.
>>>>>>> 2da327d743e46421c78af94dbc9063058fcd8829
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Sonora");
}
