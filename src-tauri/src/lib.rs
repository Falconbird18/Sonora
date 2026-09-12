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
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Sonora/1.1",
        )
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())
}

async fn api_get_json(
    client: &reqwest::Client,
    params: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    let mut last_err = String::new();
    for attempt in 0..4u32 {
        if attempt > 0 {
            let delay_ms = 400u64 * 2u64.pow(attempt - 1);
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms.min(3000))).await;
        }
        let resp = match client
            .get("https://imslp.org/api.php")
            .query(params)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        let status = resp.status();
        if status.as_u16() == 502 || status.as_u16() == 503 || status.as_u16() == 504 {
            last_err = format!("HTTP status server error ({status}) from IMSLP API");
            continue;
        }
        if !status.is_success() {
            return Err(format!(
                "HTTP status server error ({status}) for url (https://imslp.org/api.php)"
            ));
        }
        match resp.json::<serde_json::Value>().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        }
    }
    Err(format!(
        "IMSLP is temporarily unavailable (after retries). Last error: {last_err}. Try again in a minute."
    ))
}


#[tauri::command]
async fn imslp_search(query: String, limit: Option<u32>) -> Result<Vec<ImslpSearchHit>, String> {
    let limit = limit.unwrap_or(20).clamp(1, 50);
    let client = imslp_client()?;
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }

    // Run a few complementary MediaWiki searches and merge/rank.
    // 1) plain text  2) intitle:  3) quoted phrase when multi-word
    let mut queries = vec![q.clone(), format!("intitle:{}", q)];
    if q.contains(' ') {
        queries.push(format!("\"{}\"", q));
    }


    let mut merged: Vec<ImslpSearchHit> = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    let mut last_err = String::new();

    for srsearch in queries {
        let limit_s = limit.to_string();
        let body = match api_get_json(
            &client,
            &[
                ("action", "query"),
                ("list", "search"),
                ("srsearch", &srsearch),
                ("srnamespace", "0"),
                ("srlimit", &limit_s),
                ("srprop", "snippet|size|wordcount|timestamp"),
                ("srwhat", "text"),
                ("format", "json"),
                ("formatversion", "2"),
            ],
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        let Some(arr) = body["query"]["search"].as_array() else {
            continue;
        };
        for item in arr {
            let title = match item["title"].as_str() {
                Some(t) => t.to_string(),
                None => continue,
            };
            if title.starts_with("Category:")
                || title.starts_with("Help:")
                || title.starts_with("IMSLP:")
                || title.starts_with("File:")
                || title.starts_with("Template:")
                || title.starts_with("User:")
            {
                continue;
            }
            let snippet = item["snippet"].as_str().unwrap_or("").to_string();
            let snippet_plain = strip_html_tags(&decode_html_entities(&snippet));
            if snippet_plain.trim_start().to_uppercase().starts_with("#REDIRECT") {
                continue;
            }
            let key = title.to_lowercase();
            if !seen.insert(key) {
                continue;
            }
            merged.push(ImslpSearchHit {
                title,
                snippet: clean_search_snippet(&snippet),
                pageid: item["pageid"].as_u64(),
            });
        }
    }

    // Rank: work pages "Title (Composer)" first, then title match quality
    let q_lower = q.to_lowercase();
    let q_tokens: Vec<&str> = q_lower.split_whitespace().collect();
    merged.sort_by(|a, b| {
        search_rank(&b.title, &q_lower, &q_tokens)
            .cmp(&search_rank(&a.title, &q_lower, &q_tokens))
            .then_with(|| a.title.cmp(&b.title))
    });
    merged.truncate(limit as usize);
    if merged.is_empty() && !last_err.is_empty() {
        return Err(last_err);
    }
    Ok(merged)
}

fn search_rank(title: &str, q: &str, tokens: &[&str]) -> i32 {
    let t = title.to_lowercase();
    let mut score = 0i32;
    // Prefer real work pages: "Something (Composer, Name)"
    if t.contains('(') && t.contains(')') {
        score += 50;
    }
    if t == *q {
        score += 100;
    } else if t.starts_with(q) {
        score += 40;
    } else if t.contains(q) {
        score += 25;
    }
    for tok in tokens {
        if t.contains(tok) {
            score += 8;
        }
    }
    // Penalize arrangements / extracts that often clutter results
    if t.contains("theme from") || t.contains("arranged") || t.contains("simplified") {
        score -= 15;
    }
    score
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

/// Resolve MediaWiki redirects so short titles like "Moonlight sonata" work.
async fn resolve_page_title(client: &reqwest::Client, title: &str) -> Result<String, String> {
    let body = api_get_json(
        client,
        &[
            ("action", "query"),
            ("titles", title),
            ("redirects", "1"),
            ("format", "json"),
            ("formatversion", "2"),
        ],
    )
    .await?;
    if let Some(redirects) = body["query"]["redirects"].as_array() {
        if let Some(last) = redirects.last() {
            if let Some(to) = last["to"].as_str() {
                return Ok(to.to_string());
            }
        }
    }
    if let Some(pages) = body["query"]["pages"].as_array() {
        if let Some(page) = pages.first() {
            if page.get("missing").is_some() {
                return Err(format!("IMSLP page not found: {title}"));
            }
            if let Some(t) = page["title"].as_str() {
                return Ok(t.to_string());
            }
        }
    }
    Ok(title.to_string())
}

#[tauri::command]
async fn imslp_work_scores(work_title: String) -> Result<Vec<ImslpScoreFile>, String> {
    let client = imslp_client()?;
    let mut page = resolve_page_title(&client, work_title.trim()).await?;
    let mut wikitext = String::new();
    for _ in 0..3 {
        let body = api_get_json(
            &client,
            &[
                ("action", "parse"),
                ("page", &page),
                ("prop", "wikitext"),
                ("format", "json"),
                ("formatversion", "2"),
            ],
        )
        .await?;
        if body.get("error").is_some() {
            return Err(body["error"]["info"]
                .as_str()
                .unwrap_or("IMSLP work page not found")
                .to_string());
        }
        wikitext = parse_wikitext_field(&body["parse"]["wikitext"])
            .ok_or_else(|| "No wikitext returned for this work".to_string())?;
        // Follow remaining #REDIRECT wikitext if the query API did not
        if wikitext.trim_start().to_uppercase().starts_with("#REDIRECT") {
            if let Some(target) = extract_redirect_target(&wikitext) {
                page = target;
                continue;
            }
        }
        break;
    }

    let mut files = extract_score_files(&wikitext);
    // Fallback: scrape bare PDF filenames if template parser found nothing
    if files.is_empty() {
        let mut seen = std::collections::HashSet::new();
        for name in simple_pdf_filenames(&wikitext) {
            if seen.insert(name.clone()) {
                files.push(make_score_file(&name, "", ""));
            }
        }
    }
    enrich_thumbnails(&client, &mut files).await;
    Ok(files)
}

fn extract_redirect_target(wikitext: &str) -> Option<String> {
    let upper = wikitext.trim_start();
    if !upper.to_uppercase().starts_with("#REDIRECT") {
        return None;
    }
    let start = upper.find("[[")?;
    let end = upper[start..].find("]]")?;
    let inner = &upper[start + 2..start + end];
    let target = inner.split('|').next()?.trim();
    if target.is_empty() {
        None
    } else {
        Some(target.to_string())
    }
}

async fn enrich_thumbnails(client: &reqwest::Client, files: &mut [ImslpScoreFile]) {
    if files.is_empty() {
        return;
    }
    for chunk in files.chunks_mut(40) {
        // Query both space and underscore forms — MediaWiki normalizes unpredictably
        let mut titles: Vec<String> = Vec::new();
        for f in chunk.iter() {
            titles.push(format!("File:{}", f.filename.replace(' ', "_")));
            if f.filename.contains(' ') {
                titles.push(format!("File:{}", f.filename));
            }
        }
        let joined = titles.join("|");
        let resp = client
            .get("https://imslp.org/api.php")
            .query(&[
                ("action", "query"),
                ("titles", &joined),
                ("prop", "imageinfo"),
                ("iiprop", "url|thumburl|size"),
                ("iiurlwidth", "240"),
                ("format", "json"),
                ("formatversion", "2"),
            ])
            .send()
            .await;
        let Ok(resp) = resp else { continue };
        let Ok(body) = resp.json::<serde_json::Value>().await else { continue };
        let pages = body["query"]["pages"].as_array().cloned().unwrap_or_default();
        let mut thumbs: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for page in pages {
            if page.get("missing").is_some() {
                continue;
            }
            let title = page["title"].as_str().unwrap_or("").to_string();
            let fname = title.strip_prefix("File:").unwrap_or(&title);
            let info = match page["imageinfo"].as_array().and_then(|a| a.first()) {
                Some(i) => i,
                None => continue,
            };
            // Prefer rendered thumb; fall back to full file URL (browser may not show PDF)
            let mut chosen = info
                .get("thumburl")
                .and_then(|v| v.as_str())
                .or_else(|| info.get("url").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            if let Some(ref mut u) = chosen {
                if u.starts_with("//") {
                    *u = format!("https:{u}");
                } else if u.starts_with("http://") {
                    *u = format!("https://{}", &u[7..]);
                }
            }
            if let Some(u) = chosen {
                let lower = u.to_lowercase();
                // Skip raw PDF URLs — browsers cannot render them in <img>
                if !lower.ends_with(".pdf") {
                    let keys = [
                        fname.to_lowercase(),
                        fname.replace('_', " ").to_lowercase(),
                        fname.replace(' ', "_").to_lowercase(),
                    ];
                    for k in keys {
                        thumbs.insert(k, u.clone());
                    }
                }
            }
        }
        for f in chunk.iter_mut() {
            let k1 = f.filename.to_lowercase();
            let k2 = f.filename.replace(' ', "_").to_lowercase();
            let k3 = f.filename.replace('_', " ").to_lowercase();
            f.thumb_url = thumbs
                .get(&k1)
                .cloned()
                .or_else(|| thumbs.get(&k2).cloned())
                .or_else(|| thumbs.get(&k3).cloned());
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
    sort_score_files(&mut results);
    results
}

fn sort_score_files(files: &mut [ImslpScoreFile]) {
    fn rank(desc: &str) -> i32 {
        let d = desc.to_lowercase();
        if d.contains("complete score") || d == "score" {
            0
        } else if d.contains("complete") {
            1
        } else if d.contains("score") && !d.contains("part") {
            2
        } else if d.contains("piano") || d.contains("vocal") {
            3
        } else if d.contains("part") {
            5
        } else if d.contains("manuscript") {
            4
        } else {
            6
        }
    }
    files.sort_by(|a, b| {
        rank(&a.description)
            .cmp(&rank(&b.description))
            .then_with(|| a.description.cmp(&b.description))
            .then_with(|| a.filename.cmp(&b.filename))
    });
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
        let filename = filename.trim();
        if !filename.to_lowercase().ends_with(".pdf") {
            continue;
        }
        let key = filename.replace(' ', "_").to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        let mut parts: Vec<String> = Vec::new();
        let desc = descriptions
            .get(n)
            .map(|s| clean_wiki_text(s))
            .unwrap_or_default();
        if !desc.is_empty() {
            parts.push(desc);
        }
        let itype = clean_wiki_text(image_type);
        if !itype.is_empty() {
            let label = match itype.to_lowercase().as_str() {
                "normal scan" => "Scan".to_string(),
                "manuscript scan" => "Manuscript".to_string(),
                "typeset" => "Typeset".to_string(),
                other => itype.clone(),
            };
            if !parts
                .iter()
                .any(|p| p.to_lowercase().contains(&label.to_lowercase()))
            {
                parts.push(label);
            }
        }
        let pub_clean = clean_wiki_text(publisher);
        if !pub_clean.is_empty() && pub_clean.len() > 2 {
            let short = if pub_clean.len() > 80 {
                format!("{}…", &pub_clean[..77])
            } else {
                pub_clean
            };
            parts.push(short);
        }
        let desc = parts.join(" · ");
        let ed = clean_editor(editor);
        results.push(make_score_file(filename, &desc, &ed));
    }
}

fn clean_editor(raw: &str) -> String {
    let s = clean_wiki_text(raw);
    let s = s.trim().to_string();
    if s.len() <= 1 {
        String::new()
    } else {
        s
    }
}

fn strip_param<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let line = line.strip_prefix('|')?.trim_start();
    let line_lower = line.to_ascii_lowercase();
    let key_lower = key.to_ascii_lowercase();
    if !line_lower.starts_with(&key_lower) {
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
    for (pat, repl) in [
        ("{{FE}}", "First edition"),
        ("{{UE}}", "Urtext"),
        ("{{Normal}}", ""),
        ("{{Typeset}}", "Typeset"),
    ] {
        out = out.replace(pat, repl);
    }
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
            out.replace_range(start..end + 2, " ");
        } else {
            break;
        }
    }
    out = out.replace("'''", "").replace("''", "");
    out = out
        .replace('|', " ")
        .split_whitespace()
        .filter(|t| !t.contains('=') && *t != "*" && *t != "#")
        .collect::<Vec<_>>()
        .join(" ");
    out
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

/// Download via IMSLP disclaimer → wait-page data-id → mirror URL flow.
/// Also tries ImageHandler, MediaWiki imageinfo URL, and alternate mirror hosts.
#[tauri::command]
async fn imslp_download_score(
    filename: String,
    library_root: Option<String>,
    composer: Option<String>,
    work_title: Option<String>,
) -> Result<ImslpDownloadResult, String> {
    let client = imslp_client()?;
    let encoded = urlencoding_encode(&filename);
    let accept_url = format!("https://imslp.org/wiki/Special:IMSLPDisclaimerAccept/{encoded}");
    let handler_url = format!("https://imslp.org/wiki/Special:IMSLPImageHandler/{encoded}");

    let mut candidates: Vec<String> = Vec::new();

    // 1) Disclaimer / wait page
    let accept_bytes = fetch_bytes(&client, &accept_url).await?;
    if accept_bytes.starts_with(b"%PDF") {
        return finish_download(filename, library_root, composer.clone(), work_title.clone(), accept_bytes);
    }
    let accept_html = String::from_utf8_lossy(&accept_bytes).into_owned();
    push_unique(&mut candidates, extract_all_mirror_urls(&accept_html));

    // 2) Image handler page
    if let Ok(handler_bytes) = fetch_bytes(&client, &handler_url).await {
        if handler_bytes.starts_with(b"%PDF") {
            return finish_download(filename, library_root, composer.clone(), work_title.clone(), handler_bytes);
        }
        let handler_html = String::from_utf8_lossy(&handler_bytes).into_owned();
        push_unique(&mut candidates, extract_all_mirror_urls(&handler_html));
    }

    // 3) MediaWiki imageinfo (direct file URL on imslp.org)
    if let Some(api_url) = imageinfo_url(&client, &filename).await {
        push_unique(&mut candidates, vec![api_url]);
    }

    // 4) Expand each candidate with host alternates (s9 / vmirror / etc.)
    let mut expanded = Vec::new();
    for c in &candidates {
        push_unique(&mut expanded, mirror_alternates(c));
    }
    candidates = expanded;

    if candidates.is_empty() {
        if accept_html.to_lowercase().contains("subscribe") {
            return Err(
                "Could not get a free download link (membership wait page changed, or a subscription is required)."
                    .into(),
            );
        }
        return Err("Could not find a download link on IMSLP for this file.".into());
    }

    let mut last_err = String::new();
    for url in candidates {
        match fetch_bytes(&client, &url).await {
            Ok(bytes) if bytes.starts_with(b"%PDF") => {
                return finish_download(filename, library_root, composer, work_title, bytes);
            }
            Ok(_) => {
                last_err = format!("Mirror returned non-PDF content ({url})");
            }
            Err(e) => {
                last_err = e;
            }
        }
    }

    Err(format!(
        "All mirror attempts failed for “{filename}”. Last error: {last_err}"
    ))
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .header(
            "Accept",
            "application/pdf,text/html,application/xhtml+xml,*/*;q=0.8",
        )
        .header("Referer", "https://imslp.org/")
        .header("Cookie", "redirectPassed=1; imslpdisclaimeraccepted=yes")
        .timeout(std::time::Duration::from_secs(45))
        .send()
        .await
        .map_err(|e| format!("error sending request for url ({url}): {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {url}", resp.status()));
    }
    let b = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed reading body from {url}: {e}"))?;
    Ok(b.to_vec())
}

fn finish_download(
    filename: String,
    library_root: Option<String>,
    composer: Option<String>,
    work_title: Option<String>,
    bytes: Vec<u8>,
) -> Result<ImslpDownloadResult, String> {
    let size = bytes.len() as u64;
    if size < 100 {
        return Err("Downloaded file is too small to be a valid PDF.".into());
    }

    if let Some(root) = library_root.filter(|s| !s.trim().is_empty()) {
        // Prefer composer folder so library sync tags the score with that composer
        // (folderSync uses the parent directory name as composer).
        let composer_folder = sanitize_path_segment(
            composer
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty() && *s != "Unknown Composer")
                .unwrap_or("Unknown Composer"),
        );
        let dir = PathBuf::from(&root).join(&composer_folder);
        fs::create_dir_all(&dir).map_err(|e| format!("Could not create composer folder: {e}"))?;

        // Prefer a readable work-based filename when available
        let safe = preferred_filename(&filename, work_title.as_deref());
        let dest = unique_dest(&dir, &safe)?;
        fs::write(&dest, &bytes).map_err(|e| format!("Could not write PDF: {e}"))?;
        let saved_name = dest
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or(safe);
        let relative = format!("{composer_folder}/{saved_name}");
        return Ok(ImslpDownloadResult {
            filename: saved_name,
            size,
            saved_path: Some(dest.to_string_lossy().to_string()),
            relative_path: Some(relative),
            bytes_base64: None,
        });
    }

    Ok(ImslpDownloadResult {
        filename,
        size,
        saved_path: None,
        relative_path: None,
        bytes_base64: Some(data_encoding_base64(&bytes)),
    })
}

fn sanitize_path_segment(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if r#"<>:"/\|?*"#.contains(c) || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let s = s.trim().trim_matches('.').trim().to_string();
    if s.is_empty() {
        "Unknown Composer".into()
    } else {
        s
    }
}

fn preferred_filename(raw_filename: &str, work_title: Option<&str>) -> String {
    if let Some(title) = work_title.map(str::trim).filter(|s| !s.is_empty()) {
        // Use work title without the trailing "(Composer)" for a cleaner file name
        let base = title
            .rsplit_once('(')
            .map(|(left, _)| left.trim())
            .unwrap_or(title);
        let safe = sanitize_path_segment(base);
        if !safe.is_empty() && safe != "Unknown Composer" {
            return format!("{safe}.pdf");
        }
    }
    let stem = raw_filename
        .strip_suffix(".pdf")
        .or_else(|| raw_filename.strip_suffix(".PDF"))
        .unwrap_or(raw_filename);
    format!("{}.pdf", sanitize_path_segment(stem))
}

fn unique_dest(dir: &Path, filename: &str) -> Result<PathBuf, String> {
    let dest = dir.join(filename);
    if !dest.exists() {
        return Ok(dest);
    }
    let stem = dest.file_stem().and_then(|s| s.to_str()).unwrap_or("score");
    let ext = dest
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for n in 2..100 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Ok(dir.join(format!(
        "{stem}-{}.pdf",
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    )))
}

async fn imageinfo_url(client: &reqwest::Client, filename: &str) -> Option<String> {
    let title = format!("File:{}", filename.replace(' ', "_"));
    let resp = client
        .get("https://imslp.org/api.php")
        .query(&[
            ("action", "query"),
            ("titles", &title),
            ("prop", "imageinfo"),
            ("iiprop", "url"),
            ("format", "json"),
            ("formatversion", "2"),
        ])
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = resp.json().await.ok()?;
    let pages = body["query"]["pages"].as_array()?;
    let info = pages.first()?["imageinfo"].as_array()?.first()?;
    let mut url = info.get("url")?.as_str()?.to_string();
    if url.starts_with("//") {
        url = format!("https:{url}");
    }
    if url.starts_with("http://") {
        url = format!("https://{}", &url[7..]);
    }
    Some(url)
}

fn push_unique(out: &mut Vec<String>, items: Vec<String>) {
    for item in items {
        if !out.iter().any(|x| x == &item) {
            out.push(item);
        }
    }
}

/// Collect every plausible mirror URL from a wait / handler HTML page.
fn extract_all_mirror_urls(html: &str) -> Vec<String> {
    let mut found = Vec::new();

    // data-id="https&#58;//s9.imslp.org/..."
    for (prefix, quote) in [("data-id=\"", '"'), ("data-id='", '\'')] {
        let mut search = html;
        while let Some(idx) = search.find(prefix) {
            let start = idx + prefix.len();
            if let Some(rel) = search[start..].find(quote) {
                let raw = &search[start..start + rel];
                let decoded = decode_basic_html_entities(raw);
                if let Some(url) = normalize_mirror_candidate(&decoded) {
                    if !found.contains(&url) {
                        found.push(url);
                    }
                }
            }
            search = &search[start..];
        }
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
                .user_agent(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Sonora/1.1",
                )
                .cookie_store(true)
                .timeout(std::time::Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()
                .map_err(|e| e.to_string())
        }

        async fn api_get_json(
            client: &reqwest::Client,
            params: &[(&str, &str)],
        ) -> Result<serde_json::Value, String> {
            let mut last_err = String::new();
            for attempt in 0..4u32 {
                if attempt > 0 {
                    let delay_ms = 400u64 * 2u64.pow(attempt - 1);
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms.min(3000))).await;
                }
                let resp = match client
                    .get("https://imslp.org/api.php")
                    .query(params)
                    .send()
                    .await
                {
                    Ok(r) => r,
                    Err(e) => {
                        last_err = e.to_string();
                        continue;
                    }
                };
                let status = resp.status();
                if status.as_u16() == 502 || status.as_u16() == 503 || status.as_u16() == 504 {
                    last_err = format!("HTTP status server error ({status}) from IMSLP API");
                    continue;
                }
                if !status.is_success() {
                    return Err(format!(
                        "HTTP status server error ({status}) for url (https://imslp.org/api.php)"
                    ));
                }
                match resp.json::<serde_json::Value>().await {
                    Ok(v) => return Ok(v),
                    Err(e) => {
                        last_err = e.to_string();
                        continue;
                    }
                }
            }
            Err(format!(
                "IMSLP is temporarily unavailable (after retries). Last error: {last_err}. Try again in a minute."
            ))
        }


        #[tauri::command]
        async fn imslp_search(query: String, limit: Option<u32>) -> Result<Vec<ImslpSearchHit>, String> {
            let limit = limit.unwrap_or(20).clamp(1, 50);
            let client = imslp_client()?;
            let q = query.trim().to_string();
            if q.is_empty() {
                return Ok(vec![]);
            }

            // Run a few complementary MediaWiki searches and merge/rank.
            // 1) plain text  2) intitle:  3) quoted phrase when multi-word
            let mut queries = vec![q.clone(), format!("intitle:{}", q)];
            if q.contains(' ') {
                queries.push(format!("\"{}\"", q));
            }


            let mut merged: Vec<ImslpSearchHit> = Vec::new();
            let mut seen = std::collections::HashSet::<String>::new();
            let mut last_err = String::new();

            for srsearch in queries {
                let limit_s = limit.to_string();
                let body = match api_get_json(
                    &client,
                    &[
                        ("action", "query"),
                        ("list", "search"),
                        ("srsearch", &srsearch),
                        ("srnamespace", "0"),
                        ("srlimit", &limit_s),
                        ("srprop", "snippet|size|wordcount|timestamp"),
                        ("srwhat", "text"),
                        ("format", "json"),
                        ("formatversion", "2"),
                    ],
                )
                .await
                {
                    Ok(v) => v,
                    Err(e) => {
                        last_err = e;
                        continue;
                    }
                };
                let Some(arr) = body["query"]["search"].as_array() else {
                    continue;
                };
                for item in arr {
                    let title = match item["title"].as_str() {
                        Some(t) => t.to_string(),
                        None => continue,
                    };
                    if title.starts_with("Category:")
                        || title.starts_with("Help:")
                        || title.starts_with("IMSLP:")
                        || title.starts_with("File:")
                        || title.starts_with("Template:")
                        || title.starts_with("User:")
                    {
                        continue;
                    }
                    let snippet = item["snippet"].as_str().unwrap_or("").to_string();
                    let snippet_plain = strip_html_tags(&decode_html_entities(&snippet));
                    if snippet_plain.trim_start().to_uppercase().starts_with("#REDIRECT") {
                        continue;
                    }
                    let key = title.to_lowercase();
                    if !seen.insert(key) {
                        continue;
                    }
                    merged.push(ImslpSearchHit {
                        title,
                        snippet: clean_search_snippet(&snippet),
                        pageid: item["pageid"].as_u64(),
                    });
                }
            }

            // Rank: work pages "Title (Composer)" first, then title match quality
            let q_lower = q.to_lowercase();
            let q_tokens: Vec<&str> = q_lower.split_whitespace().collect();
            merged.sort_by(|a, b| {
                search_rank(&b.title, &q_lower, &q_tokens)
                    .cmp(&search_rank(&a.title, &q_lower, &q_tokens))
                    .then_with(|| a.title.cmp(&b.title))
            });
            merged.truncate(limit as usize);
            if merged.is_empty() && !last_err.is_empty() {
                return Err(last_err);
            }
            Ok(merged)
        }

        fn search_rank(title: &str, q: &str, tokens: &[&str]) -> i32 {
            let t = title.to_lowercase();
            let mut score = 0i32;
            // Prefer real work pages: "Something (Composer, Name)"
            if t.contains('(') && t.contains(')') {
                score += 50;
            }
            if t == *q {
                score += 100;
            } else if t.starts_with(q) {
                score += 40;
            } else if t.contains(q) {
                score += 25;
            }
            for tok in tokens {
                if t.contains(tok) {
                    score += 8;
                }
            }
            // Penalize arrangements / extracts that often clutter results
            if t.contains("theme from") || t.contains("arranged") || t.contains("simplified") {
                score -= 15;
            }
            score
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

        /// Resolve MediaWiki redirects so short titles like "Moonlight sonata" work.
        async fn resolve_page_title(client: &reqwest::Client, title: &str) -> Result<String, String> {
            let body = api_get_json(
                client,
                &[
                    ("action", "query"),
                    ("titles", title),
                    ("redirects", "1"),
                    ("format", "json"),
                    ("formatversion", "2"),
                ],
            )
            .await?;
            if let Some(redirects) = body["query"]["redirects"].as_array() {
                if let Some(last) = redirects.last() {
                    if let Some(to) = last["to"].as_str() {
                        return Ok(to.to_string());
                    }
                }
            }
            if let Some(pages) = body["query"]["pages"].as_array() {
                if let Some(page) = pages.first() {
                    if page.get("missing").is_some() {
                        return Err(format!("IMSLP page not found: {title}"));
                    }
                    if let Some(t) = page["title"].as_str() {
                        return Ok(t.to_string());
                    }
                }
            }
            Ok(title.to_string())
        }

        #[tauri::command]
        async fn imslp_work_scores(work_title: String) -> Result<Vec<ImslpScoreFile>, String> {
            let client = imslp_client()?;
            let mut page = resolve_page_title(&client, work_title.trim()).await?;
            let mut wikitext = String::new();
            for _ in 0..3 {
                let body = api_get_json(
                    &client,
                    &[
                        ("action", "parse"),
                        ("page", &page),
                        ("prop", "wikitext"),
                        ("format", "json"),
                        ("formatversion", "2"),
                    ],
                )
                .await?;
                if body.get("error").is_some() {
                    return Err(body["error"]["info"]
                        .as_str()
                        .unwrap_or("IMSLP work page not found")
                        .to_string());
                }
                wikitext = parse_wikitext_field(&body["parse"]["wikitext"])
                    .ok_or_else(|| "No wikitext returned for this work".to_string())?;
                // Follow remaining #REDIRECT wikitext if the query API did not
                if wikitext.trim_start().to_uppercase().starts_with("#REDIRECT") {
                    if let Some(target) = extract_redirect_target(&wikitext) {
                        page = target;
                        continue;
                    }
                }
                break;
            }

            let mut files = extract_score_files(&wikitext);
            // Fallback: scrape bare PDF filenames if template parser found nothing
            if files.is_empty() {
                let mut seen = std::collections::HashSet::new();
                for name in simple_pdf_filenames(&wikitext) {
                    if seen.insert(name.clone()) {
                        files.push(make_score_file(&name, "", ""));
                    }
                }
            }
            enrich_thumbnails(&client, &mut files).await;
            Ok(files)
        }

        fn extract_redirect_target(wikitext: &str) -> Option<String> {
            let upper = wikitext.trim_start();
            if !upper.to_uppercase().starts_with("#REDIRECT") {
                return None;
            }
            let start = upper.find("[[")?;
            let end = upper[start..].find("]]")?;
            let inner = &upper[start + 2..start + end];
            let target = inner.split('|').next()?.trim();
            if target.is_empty() {
                None
            } else {
                Some(target.to_string())
            }
        }

        async fn enrich_thumbnails(client: &reqwest::Client, files: &mut [ImslpScoreFile]) {
            if files.is_empty() {
                return;
            }
            for chunk in files.chunks_mut(40) {
                // Query both space and underscore forms — MediaWiki normalizes unpredictably
                let mut titles: Vec<String> = Vec::new();
                for f in chunk.iter() {
                    titles.push(format!("File:{}", f.filename.replace(' ', "_")));
                    if f.filename.contains(' ') {
                        titles.push(format!("File:{}", f.filename));
                    }
                }
                let joined = titles.join("|");
                let resp = client
                    .get("https://imslp.org/api.php")
                    .query(&[
                        ("action", "query"),
                        ("titles", &joined),
                        ("prop", "imageinfo"),
                        ("iiprop", "url|thumburl|size"),
                        ("iiurlwidth", "240"),
                        ("format", "json"),
                        ("formatversion", "2"),
                    ])
                    .send()
                    .await;
                let Ok(resp) = resp else { continue };
                let Ok(body) = resp.json::<serde_json::Value>().await else { continue };
                let pages = body["query"]["pages"].as_array().cloned().unwrap_or_default();
                let mut thumbs: std::collections::HashMap<String, String> =
                    std::collections::HashMap::new();
                for page in pages {
                    if page.get("missing").is_some() {
                        continue;
                    }
                    let title = page["title"].as_str().unwrap_or("").to_string();
                    let fname = title.strip_prefix("File:").unwrap_or(&title);
                    let info = match page["imageinfo"].as_array().and_then(|a| a.first()) {
                        Some(i) => i,
                        None => continue,
                    };
                    // Prefer rendered thumb; fall back to full file URL (browser may not show PDF)
                    let mut chosen = info
                        .get("thumburl")
                        .and_then(|v| v.as_str())
                        .or_else(|| info.get("url").and_then(|v| v.as_str()))
                        .map(|s| s.to_string());
                    if let Some(ref mut u) = chosen {
                        if u.starts_with("//") {
                            *u = format!("https:{u}");
                        } else if u.starts_with("http://") {
                            *u = format!("https://{}", &u[7..]);
                        }
                    }
                    if let Some(u) = chosen {
                        let lower = u.to_lowercase();
                        // Skip raw PDF URLs — browsers cannot render them in <img>
                        if !lower.ends_with(".pdf") {
                            let keys = [
                                fname.to_lowercase(),
                                fname.replace('_', " ").to_lowercase(),
                                fname.replace(' ', "_").to_lowercase(),
                            ];
                            for k in keys {
                                thumbs.insert(k, u.clone());
                            }
                        }
                    }
                }
                for f in chunk.iter_mut() {
                    let k1 = f.filename.to_lowercase();
                    let k2 = f.filename.replace(' ', "_").to_lowercase();
                    let k3 = f.filename.replace('_', " ").to_lowercase();
                    f.thumb_url = thumbs
                        .get(&k1)
                        .cloned()
                        .or_else(|| thumbs.get(&k2).cloned())
                        .or_else(|| thumbs.get(&k3).cloned());
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
            sort_score_files(&mut results);
            results
        }

        fn sort_score_files(files: &mut [ImslpScoreFile]) {
            fn rank(desc: &str) -> i32 {
                let d = desc.to_lowercase();
                if d.contains("complete score") || d == "score" {
                    0
                } else if d.contains("complete") {
                    1
                } else if d.contains("score") && !d.contains("part") {
                    2
                } else if d.contains("piano") || d.contains("vocal") {
                    3
                } else if d.contains("part") {
                    5
                } else if d.contains("manuscript") {
                    4
                } else {
                    6
                }
            }
            files.sort_by(|a, b| {
                rank(&a.description)
                    .cmp(&rank(&b.description))
                    .then_with(|| a.description.cmp(&b.description))
                    .then_with(|| a.filename.cmp(&b.filename))
            });
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
                let filename = filename.trim();
                if !filename.to_lowercase().ends_with(".pdf") {
                    continue;
                }
                let key = filename.replace(' ', "_").to_lowercase();
                if !seen.insert(key) {
                    continue;
                }
                let mut parts: Vec<String> = Vec::new();
                let desc = descriptions
                    .get(n)
                    .map(|s| clean_wiki_text(s))
                    .unwrap_or_default();
                if !desc.is_empty() {
                    parts.push(desc);
                }
                let itype = clean_wiki_text(image_type);
                if !itype.is_empty() {
                    let label = match itype.to_lowercase().as_str() {
                        "normal scan" => "Scan".to_string(),
                        "manuscript scan" => "Manuscript".to_string(),
                        "typeset" => "Typeset".to_string(),
                        other => itype.clone(),
                    };
                    if !parts
                        .iter()
                        .any(|p| p.to_lowercase().contains(&label.to_lowercase()))
                    {
                        parts.push(label);
                    }
                }
                let pub_clean = clean_wiki_text(publisher);
                if !pub_clean.is_empty() && pub_clean.len() > 2 {
                    let short = if pub_clean.len() > 80 {
                        format!("{}…", &pub_clean[..77])
                    } else {
                        pub_clean
                    };
                    parts.push(short);
                }
                let desc = parts.join(" · ");
                let ed = clean_editor(editor);
                results.push(make_score_file(filename, &desc, &ed));
            }
        }

        fn clean_editor(raw: &str) -> String {
            let s = clean_wiki_text(raw);
            let s = s.trim().to_string();
            if s.len() <= 1 {
                String::new()
            } else {
                s
            }
        }

        fn strip_param<'a>(line: &'a str, key: &str) -> Option<&'a str> {
            let line = line.strip_prefix('|')?.trim_start();
            let line_lower = line.to_ascii_lowercase();
            let key_lower = key.to_ascii_lowercase();
            if !line_lower.starts_with(&key_lower) {
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
            for (pat, repl) in [
                ("{{FE}}", "First edition"),
                ("{{UE}}", "Urtext"),
                ("{{Normal}}", ""),
                ("{{Typeset}}", "Typeset"),
            ] {
                out = out.replace(pat, repl);
            }
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
                    out.replace_range(start..end + 2, " ");
                } else {
                    break;
                }
            }
            out = out.replace("'''", "").replace("''", "");
            out = out
                .replace('|', " ")
                .split_whitespace()
                .filter(|t| !t.contains('=') && *t != "*" && *t != "#")
                .collect::<Vec<_>>()
                .join(" ");
            out
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

        /// Download via IMSLP disclaimer → wait-page data-id → mirror URL flow.
        /// Also tries ImageHandler, MediaWiki imageinfo URL, and alternate mirror hosts.
        #[tauri::command]
        async fn imslp_download_score(
            filename: String,
            library_root: Option<String>,
            composer: Option<String>,
            work_title: Option<String>,
        ) -> Result<ImslpDownloadResult, String> {
            let client = imslp_client()?;
            let encoded = urlencoding_encode(&filename);
            let accept_url = format!("https://imslp.org/wiki/Special:IMSLPDisclaimerAccept/{encoded}");
            let handler_url = format!("https://imslp.org/wiki/Special:IMSLPImageHandler/{encoded}");

            let mut candidates: Vec<String> = Vec::new();

            // 1) Disclaimer / wait page
            let accept_bytes = fetch_bytes(&client, &accept_url).await?;
            if accept_bytes.starts_with(b"%PDF") {
                return finish_download(filename, library_root, composer.clone(), work_title.clone(), accept_bytes);
            }
            let accept_html = String::from_utf8_lossy(&accept_bytes).into_owned();
            push_unique(&mut candidates, extract_all_mirror_urls(&accept_html));

            // 2) Image handler page
            if let Ok(handler_bytes) = fetch_bytes(&client, &handler_url).await {
                if handler_bytes.starts_with(b"%PDF") {
                    return finish_download(filename, library_root, composer.clone(), work_title.clone(), handler_bytes);
                }
                let handler_html = String::from_utf8_lossy(&handler_bytes).into_owned();
                push_unique(&mut candidates, extract_all_mirror_urls(&handler_html));
            }

            // 3) MediaWiki imageinfo (direct file URL on imslp.org)
            if let Some(api_url) = imageinfo_url(&client, &filename).await {
                push_unique(&mut candidates, vec![api_url]);
            }

            // 4) Expand each candidate with host alternates (s9 / vmirror / etc.)
            let mut expanded = Vec::new();
            for c in &candidates {
                push_unique(&mut expanded, mirror_alternates(c));
            }
            candidates = expanded;

            if candidates.is_empty() {
                if accept_html.to_lowercase().contains("subscribe") {
                    return Err(
                        "Could not get a free download link (membership wait page changed, or a subscription is required)."
                            .into(),
                    );
                }
                return Err("Could not find a download link on IMSLP for this file.".into());
            }

            let mut last_err = String::new();
            for url in candidates {
                match fetch_bytes(&client, &url).await {
                    Ok(bytes) if bytes.starts_with(b"%PDF") => {
                        return finish_download(filename, library_root, composer, work_title, bytes);
                    }
                    Ok(_) => {
                        last_err = format!("Mirror returned non-PDF content ({url})");
                    }
                    Err(e) => {
                        last_err = e;
                    }
                }
            }

            Err(format!(
                "All mirror attempts failed for “{filename}”. Last error: {last_err}"
            ))
        }

        async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
            let resp = client
                .get(url)
                .header(
                    "Accept",
                    "application/pdf,text/html,application/xhtml+xml,*/*;q=0.8",
                )
                .header("Referer", "https://imslp.org/")
                .header("Cookie", "redirectPassed=1; imslpdisclaimeraccepted=yes")
                .timeout(std::time::Duration::from_secs(45))
                .send()
                .await
                .map_err(|e| format!("error sending request for url ({url}): {e}"))?;

            if !resp.status().is_success() {
                return Err(format!("HTTP {} from {url}", resp.status()));
            }
            let b = resp
                .bytes()
                .await
                .map_err(|e| format!("Failed reading body from {url}: {e}"))?;
            Ok(b.to_vec())
        }

        fn finish_download(
            filename: String,
            library_root: Option<String>,
            composer: Option<String>,
            work_title: Option<String>,
            bytes: Vec<u8>,
        ) -> Result<ImslpDownloadResult, String> {
            let size = bytes.len() as u64;
            if size < 100 {
                return Err("Downloaded file is too small to be a valid PDF.".into());
            }

            if let Some(root) = library_root.filter(|s| !s.trim().is_empty()) {
                // Prefer composer folder so library sync tags the score with that composer
                // (folderSync uses the parent directory name as composer).
                let composer_folder = sanitize_path_segment(
                    composer
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && *s != "Unknown Composer")
                        .unwrap_or("Unknown Composer"),
                );
                let dir = PathBuf::from(&root).join(&composer_folder);
                fs::create_dir_all(&dir).map_err(|e| format!("Could not create composer folder: {e}"))?;

                // Prefer a readable work-based filename when available
                let safe = preferred_filename(&filename, work_title.as_deref());
                let dest = unique_dest(&dir, &safe)?;
                fs::write(&dest, &bytes).map_err(|e| format!("Could not write PDF: {e}"))?;
                let saved_name = dest
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or(safe);
                let relative = format!("{composer_folder}/{saved_name}");
                return Ok(ImslpDownloadResult {
                    filename: saved_name,
                    size,
                    saved_path: Some(dest.to_string_lossy().to_string()),
                    relative_path: Some(relative),
                    bytes_base64: None,
                });
            }

            Ok(ImslpDownloadResult {
                filename,
                size,
                saved_path: None,
                relative_path: None,
                bytes_base64: Some(data_encoding_base64(&bytes)),
            })
        }

        fn sanitize_path_segment(name: &str) -> String {
            let s: String = name
                .chars()
                .map(|c| {
                    if r#"<>:"/\|?*"#.contains(c) || c.is_control() {
                        '-'
                    } else {
                        c
                    }
                })
                .collect();
            let s = s.trim().trim_matches('.').trim().to_string();
            if s.is_empty() {
                "Unknown Composer".into()
            } else {
                s
            }
        }

        fn preferred_filename(raw_filename: &str, work_title: Option<&str>) -> String {
            if let Some(title) = work_title.map(str::trim).filter(|s| !s.is_empty()) {
                // Use work title without the trailing "(Composer)" for a cleaner file name
                let base = title
                    .rsplit_once('(')
                    .map(|(left, _)| left.trim())
                    .unwrap_or(title);
                let safe = sanitize_path_segment(base);
                if !safe.is_empty() && safe != "Unknown Composer" {
                    return format!("{safe}.pdf");
                }
            }
            let stem = raw_filename
                .strip_suffix(".pdf")
                .or_else(|| raw_filename.strip_suffix(".PDF"))
                .unwrap_or(raw_filename);
            format!("{}.pdf", sanitize_path_segment(stem))
        }

        fn unique_dest(dir: &Path, filename: &str) -> Result<PathBuf, String> {
            let dest = dir.join(filename);
            if !dest.exists() {
                return Ok(dest);
            }
            let stem = dest.file_stem().and_then(|s| s.to_str()).unwrap_or("score");
            let ext = dest
                .extension()
                .and_then(|s| s.to_str())
                .map(|e| format!(".{e}"))
                .unwrap_or_default();
            for n in 2..100 {
                let candidate = dir.join(format!("{stem} ({n}){ext}"));
                if !candidate.exists() {
                    return Ok(candidate);
                }
            }
            Ok(dir.join(format!(
                "{stem}-{}.pdf",
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0)
            )))
        }

        async fn imageinfo_url(client: &reqwest::Client, filename: &str) -> Option<String> {
            let title = format!("File:{}", filename.replace(' ', "_"));
            let resp = client
                .get("https://imslp.org/api.php")
                .query(&[
                    ("action", "query"),
                    ("titles", &title),
                    ("prop", "imageinfo"),
                    ("iiprop", "url"),
                    ("format", "json"),
                    ("formatversion", "2"),
                ])
                .send()
                .await
                .ok()?;
            let body: serde_json::Value = resp.json().await.ok()?;
            let pages = body["query"]["pages"].as_array()?;
            let info = pages.first()?["imageinfo"].as_array()?.first()?;
            let mut url = info.get("url")?.as_str()?.to_string();
            if url.starts_with("//") {
                url = format!("https:{url}");
            }
            if url.starts_with("http://") {
                url = format!("https://{}", &url[7..]);
            }
            Some(url)
        }

        fn push_unique(out: &mut Vec<String>, items: Vec<String>) {
            for item in items {
                if !out.iter().any(|x| x == &item) {
                    out.push(item);
                }
            }
        }

        /// Collect every plausible mirror URL from a wait / handler HTML page.
        fn extract_all_mirror_urls(html: &str) -> Vec<String> {
            let mut found = Vec::new();

            // data-id="https&#58;//s9.imslp.org/..."
            for (prefix, quote) in [("data-id=\"", '"'), ("data-id='", '\'')] {
                let mut search = html;
                while let Some(idx) = search.find(prefix) {
                    let start = idx + prefix.len();
                    if let Some(rel) = search[start..].find(quote) {
                        let raw = &search[start..start + rel];
                        let decoded = decode_basic_html_entities(raw);
                        if let Some(url) = normalize_mirror_candidate(&decoded) {
                            if !found.contains(&url) {
                                found.push(url);
                            }
                        }
                    }
                    search = &search[start..];
                }
            }

            // Bare URLs in the page
            for marker in [
                "https://s9.imslp.org/",
                "https://s10.imslp.org/",
                "https://s6.imslp.org/",
                "https://s7.imslp.org/",
                "https://s8.imslp.org/",
                "https://vmirror.imslp.org/",
                "http://vmirror.imslp.org/",
                "//vmirror.imslp.org/",
                "//s9.imslp.org/",
                "https://ks.imslp.net/",
                "https://imslp.org/images/",
                "http://imslp.org/images/",
            ] {
                let mut from = 0;
                while let Some(idx) = html[from..].find(marker) {
                    let abs = from + idx;
                    let slice = &html[abs..];
                    let end = slice
                        .find(|c: char| c == '"' || c == '\'' || c == ' ' || c == '<' || c == '>' || c == ')' || c == '\n' || c == '\r')
                        .unwrap_or(slice.len().min(240));
                    let mut url = decode_basic_html_entities(&slice[..end]);
                    while url.ends_with(['.', ',', ')', ';']) {
                        url.pop();
                    }
                    if let Some(u) = normalize_mirror_candidate(&url) {
                        if !found.contains(&u) {
                            found.push(u);
                        }
                    }
                    from = abs + marker.len();
                }
            }
            found
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
            if u.starts_with("http://") {
                u = format!("https://{}", &u[7..]);
            }
            let lower = u.to_lowercase();
            if lower.contains(".pdf")
                || lower.contains("/files/")
                || lower.contains("imglnks")
                || lower.contains("/images/")
                || lower.contains("vmirror.imslp.org")
                || lower.contains(".imslp.org/files")
            {
                Some(u)
            } else {
                None
            }
        }

        /// Build alternate host variants for a known mirror path.
        fn mirror_alternates(url: &str) -> Vec<String> {
            let mut out = vec![url.to_string()];
            // Rewrite between common IMSLP file hosts
            let hosts = [
                "https://vmirror.imslp.org/",
                "https://s6.imslp.org/",
                "https://s7.imslp.org/",
                "https://s8.imslp.org/",
                "https://s9.imslp.org/",
                "https://s10.imslp.org/",
            ];
            for from in hosts {
                if let Some(rest) = url.strip_prefix(from) {
                    for to in hosts {
                        if to != from {
                            out.push(format!("{to}{rest}"));
                        }
                    }
                    break;
                }
            }
            // /files/imglnks/ ↔ sometimes also served under /images/
            if url.contains("/files/imglnks/") {
                if let Some(idx) = url.find("/files/imglnks/") {
                    let host_end = idx;
                    let host = &url[..host_end];
                    let rest = &url[idx + "/files/imglnks/".len()..];
                    // usimg/x/yy/FILE.pdf → often also at imslp.org/images/x/yy/FILE
                    if rest.contains("usimg/") {
                        let after = rest.replacen("usimg/", "", 1);
                        out.push(format!("https://imslp.org/images/{after}"));
                    }
                    let _ = host;
                }
            }
            out
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
                .replace("&lt;", "<")
                .replace("&gt;", ">")
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
        }}

    // Bare URLs in the page
    for marker in [
        "https://s9.imslp.org/",
        "https://s10.imslp.org/",
        "https://s6.imslp.org/",
        "https://s7.imslp.org/",
        "https://s8.imslp.org/",
        "https://vmirror.imslp.org/",
        "http://vmirror.imslp.org/",
        "//vmirror.imslp.org/",
        "//s9.imslp.org/",
        "https://ks.imslp.net/",
        "https://imslp.org/images/",
        "http://imslp.org/images/",
    ] {
        let mut from = 0;
        while let Some(idx) = html[from..].find(marker) {
            let abs = from + idx;
            let slice = &html[abs..];
            let end = slice
                .find(|c: char| c == '"' || c == '\'' || c == ' ' || c == '<' || c == '>' || c == ')' || c == '\n' || c == '\r')
                .unwrap_or(slice.len().min(240));
            let mut url = decode_basic_html_entities(&slice[..end]);
            while url.ends_with(['.', ',', ')', ';']) {
                url.pop();
            }
            if let Some(u) = normalize_mirror_candidate(&url) {
                if !found.contains(&u) {
                    found.push(u);
                }
            }
            from = abs + marker.len();
        }
    }
    found
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
    if u.starts_with("http://") {
        u = format!("https://{}", &u[7..]);
    }
    let lower = u.to_lowercase();
    if lower.contains(".pdf")
        || lower.contains("/files/")
        || lower.contains("imglnks")
        || lower.contains("/images/")
        || lower.contains("vmirror.imslp.org")
        || lower.contains(".imslp.org/files")
    {
        Some(u)
    } else {
        None
    }
}

/// Build alternate host variants for a known mirror path.
fn mirror_alternates(url: &str) -> Vec<String> {
    let mut out = vec![url.to_string()];
    // Rewrite between common IMSLP file hosts
    let hosts = [
        "https://vmirror.imslp.org/",
        "https://s6.imslp.org/",
        "https://s7.imslp.org/",
        "https://s8.imslp.org/",
        "https://s9.imslp.org/",
        "https://s10.imslp.org/",
    ];
    for from in hosts {
        if let Some(rest) = url.strip_prefix(from) {
            for to in hosts {
                if to != from {
                    out.push(format!("{to}{rest}"));
                }
            }
            break;
        }
    }
    // /files/imglnks/ ↔ sometimes also served under /images/
    if url.contains("/files/imglnks/") {
        if let Some(idx) = url.find("/files/imglnks/") {
            let host_end = idx;
            let host = &url[..host_end];
            let rest = &url[idx + "/files/imglnks/".len()..];
            // usimg/x/yy/FILE.pdf → often also at imslp.org/images/x/yy/FILE
            if rest.contains("usimg/") {
                let after = rest.replacen("usimg/", "", 1);
                out.push(format!("https://imslp.org/images/{after}"));
            }
            let _ = host;
        }
    }
    out
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
        .replace("&lt;", "<")
        .replace("&gt;", ">")
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
