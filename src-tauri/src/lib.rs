mod library_archive;
mod score_folders;
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
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct MovedScore {
    native_path: String,
    relative_path: String,
    filename: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ImslpSearchHit {
    title: String,
    snippet: String,
    pageid: Option<u64>,
    thumb_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ImslpScoreFile {
    filename: String,
    #[serde(skip)]
    raw_metadata: [String; 3],
    description: String,
    editor: String,
    publisher: String,
    arranger: String,
    copyright: String,
    section: String,
    thumbnail_file: Option<String>,
    download_url: String,
    thumb_url: Option<String>,
}

fn collect_pdfs(
    root: &Path,
    current: &Path,
    files: &mut Vec<NativeScoreFile>,
) -> Result<(), String> {
    collect_score_tree(root, current, files, &mut Vec::new())
}

fn collect_score_tree(root: &Path, current: &Path, files: &mut Vec<NativeScoreFile>, directories: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if entry.file_type().map_err(|e| e.to_string())?.is_symlink() { continue; }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            directories.push(path.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"));
            collect_score_tree(root, &path, files, directories)?;
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
                metadata: fs::read(path.with_extension("sonora.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok()),
            });
        }
    }
    Ok(())
}

fn imslp_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT.get_or_init(||reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Sonora/1.1",
        )
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())).clone()
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
    let title_query = q
        .split_whitespace()
        .map(|word| format!("intitle:{word}"))
        .collect::<Vec<_>>()
        .join(" ");
    let mut queries = vec![title_query, q.clone()];
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
                Some(t) => decode_html_entities(t),
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
            if snippet_plain
                .trim_start()
                .to_uppercase()
                .starts_with("#REDIRECT")
            {
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
                thumb_url: None,
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
    enrich_search_thumbs(&client, &mut merged).await;
    Ok(merged)
}

fn api_pages(body: &serde_json::Value) -> Vec<serde_json::Value> {
    match &body["query"]["pages"] {
        serde_json::Value::Array(pages) => pages.clone(),
        serde_json::Value::Object(pages) => pages.values().cloned().collect(),
        _ => Vec::new(),
    }
}

async fn enrich_search_thumbs(client: &reqwest::Client, hits: &mut [ImslpSearchHit]) {
    // `images` continuation is shared across all pages; one large work can starve
    // the rest of a search result. Read each work's first score from its revision.
    for chunk in hits.chunks_mut(15) {
        let titles = chunk
            .iter()
            .map(|hit| hit.title.as_str())
            .collect::<Vec<_>>()
            .join("|");
        let Ok(body) = api_get_json(
            client,
            &[
                ("action", "query"),
                ("titles", &titles),
                ("prop", "revisions|pageimages"),
                ("rvprop", "content"),
                ("rvslots", "main"),
                ("redirects", "1"),
                ("pithumbsize", "240"),
                ("format", "json"),
                ("formatversion", "2"),
            ],
        )
        .await
        else {
            continue;
        };
        let mut candidates = Vec::new();
        let mut map = std::collections::HashMap::new();
        for page in api_pages(&body) {
            let title = page["title"].as_str().unwrap_or("").to_lowercase();
            let revision = page["revisions"].as_array().and_then(|rows| rows.first());
            let wikitext = revision.and_then(|revision| {
                revision["slots"]["main"]["content"]
                    .as_str()
                    .or_else(|| revision["slots"]["main"]["*"].as_str())
                    .or_else(|| revision["content"].as_str())
                    .or_else(|| revision["*"].as_str())
            });
            if let Some(text) = wikitext {
                if let Some(file) = extract_score_files(text).into_iter().next() {
                    candidates.push((title, file));
                    continue;
                }
            }
            if let Some(url) = page["thumbnail"]["source"].as_str() {
                map.insert(title, normalize_image_url(url));
            }
        }
        let mut files = candidates
            .iter()
            .map(|(_, file)| file.clone())
            .collect::<Vec<_>>();
        enrich_thumbnails(client, &mut files).await;
        for ((title, _), file) in candidates.into_iter().zip(files) {
            if let Some(url) = file.thumb_url {
                map.insert(title, url);
            }
        }
        if let Some(redirects) = body["query"]["redirects"].as_array() {
            for redirect in redirects {
                if let (Some(from), Some(to)) = (redirect["from"].as_str(), redirect["to"].as_str())
                {
                    if let Some(url) = map.get(&to.to_lowercase()).cloned() {
                        map.insert(from.to_lowercase(), url);
                    }
                }
            }
        }
        for hit in chunk {
            hit.thumb_url = map.get(&hit.title.to_lowercase()).cloned();
        }
    }
}
fn normalize_image_url(url: &str) -> String {
    if url.starts_with("//") {
        format!("https:{url}")
    } else if let Some(path) = url.strip_prefix("http://") {
        format!("https://{path}")
    } else {
        url.into()
    }
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
        if tok.chars().all(|c| c.is_ascii_digit()) {
            if t.split(|c: char| !c.is_ascii_digit())
                .any(|part| part == *tok)
            {
                score += 40;
            } else {
                score -= 35;
            }
        } else if t.contains(tok) {
            score += 12;
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
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn decode_html_entities(s: &str) -> String {
    let mut result = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('&') {
        result.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(end) = rest.find(';').filter(|end| *end < 40) else {
            result.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = if let Some(hex) = entity
            .strip_prefix("#x")
            .or_else(|| entity.strip_prefix("#X"))
        {
            u32::from_str_radix(hex, 16)
                .ok()
                .and_then(char::from_u32)
                .map(|c| c.to_string())
        } else if let Some(decimal) = entity.strip_prefix('#') {
            decimal
                .parse::<u32>()
                .ok()
                .and_then(char::from_u32)
                .map(|c| c.to_string())
        } else {
            markup5ever::data::NAMED_ENTITIES
                .get(&rest[1..=end])
                .and_then(|&(first, second)| {
                    let mut value = String::new();
                    value.push(char::from_u32(first)?);
                    if second != 0 {
                        value.push(char::from_u32(second)?);
                    }
                    Some(value)
                })
        };
        if let Some(value) = decoded {
            result.push_str(&value);
            rest = &rest[end + 1..];
        } else {
            result.push('&');
            rest = &rest[1..];
        }
    }
    result.push_str(rest);
    result
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
    value
        .get("*")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
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
    {
        let pages = api_pages(&body);
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
async fn imslp_work_scores(work_title: String) -> Result<serde_json::Value, String> {
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
        if wikitext
            .trim_start()
            .to_uppercase()
            .starts_with("#REDIRECT")
        {
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
    enrich_edition_metadata(&client, &mut files).await;
    enrich_thumbnails(&client, &mut files).await;
    let metadata = extract_work_metadata(&wikitext);
    Ok(serde_json::json!({"files":files,"metadata":metadata,"pageTitle":page}))
}
fn extract_work_metadata(wikitext: &str) -> serde_json::Map<String, serde_json::Value> {
    let parameters = template_parameters(wikitext);
    let mut metadata = serde_json::Map::new();
    for (key, field) in [
        ("Work Title", "title"),
        ("Opus/Catalogue Number", "catalogue"),
        ("Key", "key"),
        ("Instrumentation", "instruments"),
        ("Year/Date of Composition", "compositionDate"),
        ("Number of Movements/Sections", "movements"),
        ("Piece Style", "period"),
    ] {
        if let Some(value) = parameters
            .iter()
            .find_map(|p| strip_param(p, key).map(|v| split_indexed_param(v).1))
        {
            metadata.insert(
                field.into(),
                serde_json::Value::String(if field == "movements" {
                    value
                        .lines()
                        .map(|line| {
                            clean_wiki_text(
                                line.trim_start().trim_start_matches(['#', ':', '*']).trim(),
                            )
                        })
                        .filter(|line| !line.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n")
                } else {
                    clean_wiki_text(&value)
                }),
            );
        }
    }
    metadata
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

/// Ask MediaWiki to expand publisher/editor templates we cannot maintain locally.
/// Expansion is batched; a temporary API failure retains the locally cleaned metadata.
async fn enrich_edition_metadata(client: &reqwest::Client, files: &mut [ImslpScoreFile]) {
    let mut seen = std::collections::HashSet::new();
    let raw: Vec<String> = files
        .iter()
        .flat_map(|file| file.raw_metadata.iter())
        .filter(|value| value.contains("{{") && seen.insert((*value).clone()))
        .cloned()
        .collect();
    let mut expanded = std::collections::HashMap::new();
    const SEPARATOR: &str = "\nSONORA_METADATA_BOUNDARY_64F9\n";
    for chunk in raw.chunks(30) {
        let text = chunk.join(SEPARATOR);
        let Ok(response) = client
            .post("https://imslp.org/api.php")
            .timeout(std::time::Duration::from_secs(12))
            .form(&[
                ("action", "expandtemplates"),
                ("text", text.as_str()),
                ("prop", "wikitext"),
                ("format", "json"),
            ])
            .send()
            .await
        else {
            continue;
        };
        let Ok(body) = response.json::<serde_json::Value>().await else {
            continue;
        };
        let output = body["expandtemplates"]["wikitext"]
            .as_str()
            .or_else(|| body["expandtemplates"]["*"].as_str());
        let Some(output) = output else {
            continue;
        };
        let values: Vec<_> = output.split(SEPARATOR).collect();
        if values.len() != chunk.len() {
            continue;
        }
        for (raw, value) in chunk.iter().zip(values) {
            let cleaned = clean_wiki_text(value);
            if !cleaned.is_empty() {
                expanded.insert(raw.clone(), cleaned);
            }
        }
    }
    for file in files {
        for (index, target) in [&mut file.publisher, &mut file.editor, &mut file.arranger]
            .into_iter()
            .enumerate()
        {
            if let Some(value) = expanded.get(&file.raw_metadata[index]) {
                *target = value.clone();
            }
        }
    }
}

async fn enrich_thumbnails(client: &reqwest::Client, files: &mut [ImslpScoreFile]) {
    if files.is_empty() {
        return;
    }
    for chunk in files.chunks_mut(20) {
        // Query both space and underscore forms — MediaWiki normalizes unpredictably
        let titles: Vec<String> = chunk
            .iter()
            .flat_map(|file| {
                file.thumbnail_file
                    .iter()
                    .map(|name| format!("File:{name}"))
                    .chain(std::iter::once(format!("File:{}", file.filename)))
            })
            .collect();
        let joined = titles.join("|");
        let resp = client
            .get("https://imslp.org/api.php")
            .query(&[
                ("action", "query"),
                ("titles", &joined),
                ("prop", "imageinfo"),
                ("iiprop", "url|size"),
                ("iiurlwidth", "240"),
                ("format", "json"),
                ("formatversion", "2"),
            ])
            .send()
            .await;
        let Ok(resp) = resp else { continue };
        let Ok(body) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        let pages = api_pages(&body);
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
            let filename = f.thumbnail_file.as_deref().unwrap_or(&f.filename);
            let k1 = filename.to_lowercase();
            let k2 = filename.replace(' ', "_").to_lowercase();
            let k3 = filename.replace('_', " ").to_lowercase();
            f.thumb_url = thumbs
                .get(&k1)
                .cloned()
                .or_else(|| thumbs.get(&k2).cloned())
                .or_else(|| thumbs.get(&k3).cloned())
                .or_else(|| thumbs.get(&f.filename.to_lowercase()).cloned())
                .or_else(|| {
                    thumbs
                        .get(&f.filename.replace('_', " ").to_lowercase())
                        .cloned()
                });
        }
    }
}

fn template_parameters(block: &str) -> Vec<String> {
    let bytes = block.as_bytes();
    let mut depth = 0i32;
    let mut links = 0i32;
    let mut starts = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes.get(i..i + 2) == Some(b"{{") {
            depth += 1;
            i += 2;
            continue;
        }
        if bytes.get(i..i + 2) == Some(b"}}") {
            depth -= 1;
            i += 2;
            continue;
        }
        if bytes.get(i..i + 2) == Some(b"[[") {
            links += 1;
            i += 2;
            continue;
        }
        if bytes.get(i..i + 2) == Some(b"]]") {
            links -= 1;
            i += 2;
            continue;
        }
        if bytes[i] == b'|' && depth == 1 && links == 0 {
            starts.push(i);
        }
        i += 1;
    }
    starts
        .iter()
        .enumerate()
        .map(|(n, start)| {
            block[*start..starts.get(n + 1).copied().unwrap_or(block.len() - 2)]
                .trim()
                .to_string()
        })
        .collect()
}

#[tauri::command]
async fn imslp_thumbnail(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    let host = parsed.host_str().unwrap_or("");
    if parsed.scheme() != "https" || !(host == "imslp.org" || host.ends_with(".imslp.org")) {
        return Err("Unsupported thumbnail host".into());
    }
    let client = imslp_client()?;
    let mut candidates = vec![parsed.clone()];
    if host == "cdn.imslp.org" {
        let mut alternate = parsed.clone();
        alternate
            .set_host(Some("imslp.org"))
            .map_err(|e| e.to_string())?;
        candidates.push(alternate);
    }
    let mut last_error = "Preview unavailable".to_string();
    for candidate in candidates {
        for attempt in 0..2 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(350)).await;
            }
            let response = match client
                .get(candidate.clone())
                .header("Referer", "https://imslp.org/")
                .header(
                    "Accept",
                    "image/png,image/jpeg,image/webp,image/gif,*/*;q=0.5",
                )
                .timeout(std::time::Duration::from_secs(12))
                .send()
                .await
                .and_then(|response| response.error_for_status())
            {
                Ok(response) => response,
                Err(error) => {
                    last_error = format!("Preview request failed: {error:#}");
                    continue;
                }
            };
            if response.content_length().unwrap_or(0) > 8_000_000 {
                return Err("Thumbnail too large".into());
            }
            let bytes = match response.bytes().await {
                Ok(bytes) if bytes.len() <= 8_000_000 => bytes,
                Ok(_) => return Err("Thumbnail too large".into()),
                Err(error) => {
                    last_error = error.to_string();
                    continue;
                }
            };
            let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                "image/png"
            } else if bytes.starts_with(b"\xff\xd8\xff") {
                "image/jpeg"
            } else if bytes.starts_with(b"GIF8") {
                "image/gif"
            } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
                "image/webp"
            } else {
                last_error = "The preview server did not return an image".into();
                continue;
            };
            return Ok(format!(
                "data:{mime};base64,{}",
                data_encoding_base64(&bytes)
            ));
        }
    }
    Err(last_error)
}

fn extract_score_files(wikitext: &str) -> Vec<ImslpScoreFile> {
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut rest = wikitext;

    while let Some(start) = rest.find("{{#fte:imslpfile") {
        rest = &rest[start..];
        let Some(block) = extract_template_block(rest) else {
            break;
        };
        rest = &rest[block.len()..];

        let mut names = std::collections::BTreeMap::<u32, String>::new();
        let mut descriptions = std::collections::BTreeMap::<u32, String>::new();
        let mut editor = String::new();
        let mut publisher = String::new();
        let mut image_type = String::new();

        for line in template_parameters(block) {
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
        let previous_len = results.len();
        flush_block(
            &names,
            &descriptions,
            &editor,
            &publisher,
            &image_type,
            &mut seen,
            &mut results,
        );
        let params = template_parameters(block);
        let value = |key: &str| -> String {
            params
                .iter()
                .find_map(|line| {
                    let (name, value) = line.trim().strip_prefix('|')?.split_once('=')?;
                    if name.trim().eq_ignore_ascii_case(key) {
                        Some(value.trim().to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default()
        };
        let prefix = &wikitext[..wikitext.len() - rest.len() - block.len()];
        let section = prefix
            .lines()
            .rev()
            .find(|line| line.trim().starts_with("==="))
            .unwrap_or("")
            .trim_matches('=')
            .trim();
        for file in &mut results[previous_len..] {
            let index = names
                .iter()
                .find(|(_, name)| name.trim() == file.filename)
                .map(|(index, _)| *index)
                .unwrap_or(1);
            let indexed = |key: &str| -> String {
                let explicit = format!("{key} {index}");
                params
                    .iter()
                    .find_map(|line| {
                        let (name, value) = line.trim().strip_prefix('|')?.split_once('=')?;
                        if name.trim().eq_ignore_ascii_case(&explicit) {
                            Some(value.trim().to_string())
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| value(key))
            };
            file.editor = clean_wiki_text(&indexed("Editor"));
            file.raw_metadata = [
                indexed("Publisher Information"),
                indexed("Editor"),
                indexed("Arranger"),
            ];
            file.publisher = clean_wiki_text(&indexed("Publisher Information"));
            file.arranger = clean_wiki_text(&indexed("Arranger"));
            file.copyright = clean_wiki_text(&indexed("Copyright"));
            file.section = clean_wiki_text(section);
            let thumb = indexed("Thumb Filename");
            file.thumbnail_file = if thumb.is_empty() { None } else { Some(thumb) };
        }
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
    let category = |file: &ImslpScoreFile| {
        let section = file.section.to_ascii_lowercase();
        if !file.raw_metadata[2].trim().is_empty()
            || !file.arranger.trim().is_empty()
            || section.starts_with("for ")
            || section.contains("arrangements")
        {
            2
        } else if section.contains("parts") {
            1
        } else {
            0
        }
    };
    files.sort_by(|a, b| {
        category(a)
            .cmp(&category(b))
            .then_with(|| rank(&a.description).cmp(&rank(&b.description)))
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
            let clean = candidate
                .trim_matches(|c: char| c == '[' || c == ']')
                .to_string();
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
                _other => itype.clone(),
            };
            if !parts
                .iter()
                .any(|p| p.to_lowercase().contains(&label.to_lowercase()))
            {
                parts.push(label);
            }
        }
        let _ = publisher;
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
    let matched_len = key_lower.len();
    let after = line.get(matched_len..)?.trim_start();
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

fn wiki_arguments(s: &str) -> Vec<&str> {
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut links = 0i32;
    let mut starts = vec![0];
    let mut i = 0;
    while i < bytes.len() {
        if bytes.get(i..i + 2) == Some(b"{{") {
            depth += 1;
            i += 2;
            continue;
        }
        if bytes.get(i..i + 2) == Some(b"}}") {
            depth -= 1;
            i += 2;
            continue;
        }
        if bytes.get(i..i + 2) == Some(b"[[") {
            links += 1;
            i += 2;
            continue;
        }
        if bytes.get(i..i + 2) == Some(b"]]") {
            links -= 1;
            i += 2;
            continue;
        }
        if bytes[i] == b'|' && depth == 0 && links == 0 {
            starts.push(i + 1);
        }
        i += 1;
    }
    starts
        .iter()
        .enumerate()
        .map(|(n, start)| s[*start..starts.get(n + 1).map(|end| end - 1).unwrap_or(s.len())].trim())
        .collect()
}
fn clean_wiki_text(s: &str) -> String {
    clean_wiki_text_depth(s, 0)
}
fn clean_wiki_text_depth(s: &str, depth: u8) -> String {
    if depth > 10 {
        return String::new();
    }
    let mut out = s.to_string();
    for (start_tag, end_tag) in [("<!--", "-->"), ("<ref", "</ref>"), ("<score", "</score>")] {
        while let Some(start) = out.find(start_tag) {
            if let Some(end) = out[start..].find(end_tag) {
                out.replace_range(start..start + end + end_tag.len(), " ");
            } else {
                break;
            }
        }
    }
    while let Some(start) = out.find("{{") {
        let Some(block) = extract_template_block(&out[start..]) else {
            out.replace_range(start..start + 2, " ");
            continue;
        };
        let length = block.len();
        let args = wiki_arguments(&block[2..length - 2]);
        let arg = |index: usize| {
            args.get(index)
                .map(|value| clean_wiki_text_depth(value, depth + 1))
                .unwrap_or_default()
        };
        let replacement = match args[0].to_ascii_lowercase().as_str() {
            "linked" | "linkarr" | "linkcomp" | "linktr" => [arg(1), arg(2)]
                .into_iter()
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
            "p" => {
                let publisher = if !arg(2).is_empty() { arg(2) } else { arg(1) };
                let date = if !arg(4).is_empty() { arg(4) } else { arg(5) };
                [
                    publisher,
                    arg(3),
                    date,
                    if !arg(7).is_empty() {
                        format!("Plate {}", arg(7))
                    } else {
                        String::new()
                    },
                ]
                .into_iter()
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
            }
            "wc" | "date" => args
                .iter()
                .skip(1)
                .rev()
                .find(|v| !v.is_empty())
                .map(|v| clean_wiki_text_depth(v, depth + 1))
                .unwrap_or_default(),
            "key" | "k" => {
                let key = arg(1);
                let minor = key
                    .chars()
                    .next()
                    .map(|c| c.is_lowercase())
                    .unwrap_or(false);
                let key = if key.len() == 2 && key.ends_with('b') {
                    format!("{}♭", key[..1].to_uppercase())
                } else {
                    key
                };
                format!(
                    "{} {}",
                    key.to_uppercase()
                        .replace("SHARP", "♯")
                        .replace("FLAT", "♭")
                        .replace("-", "♭")
                        .replace("#", "♯"),
                    if minor { "minor" } else { "major" }
                )
            }
            "fe" => "First edition".into(),
            "ue" | "urtext" => "Urtext".into(),
            "typeset" => "Typeset".into(),
            "normal" => String::new(),
            "linkwork" => arg(1),
            "lang" | "plain" | "nowrap" | "small" | "abbr" => args
                .last()
                .map(|v| clean_wiki_text_depth(v, depth + 1))
                .unwrap_or_default(),
            name if name.starts_with("#subitem:") || name == "#subitem" => args
                .iter()
                .skip(1)
                .find_map(|value| {
                    value
                        .strip_prefix("title=")
                        .map(|title| clean_wiki_text_depth(title, depth + 1))
                })
                .unwrap_or_default(),
            "ca" | "circa" => format!("ca. {}", arg(1)),
            "m" | "mvt" | "movement" | "title" | "italic" => arg(1),
            "flat" => "♭".into(),
            "sharp" => "♯".into(),
            "natural" => "♮".into(),
            _ => String::new(),
        };
        out.replace_range(start..start + length, &replacement);
    }
    while let Some(start) = out.find("[[") {
        let Some(end) = out[start + 2..].find("]]").map(|end| start + 2 + end) else {
            break;
        };
        let inner = &out[start + 2..end];
        let display = if inner.to_ascii_lowercase().starts_with("category:") {
            String::new()
        } else {
            inner.split('|').next_back().unwrap_or(inner).to_string()
        };
        out.replace_range(start..end + 2, &display);
    }
    let mut from = 0;
    while let Some(start) = out[from..].find('[').map(|start| from + start) {
        let Some(end) = out[start..].find(']').map(|end| start + end) else {
            break;
        };
        if out[start + 1..].starts_with("http") {
            let content = &out[start + 1..end];
            let display = content
                .split_once(char::is_whitespace)
                .map(|(_, text)| text.to_string())
                .unwrap_or_default();
            out.replace_range(start..end + 1, &display);
            from = start + display.len();
        } else {
            from = start + 1;
        }
    }
    let decoded = decode_html_entities(&out).replace("''", "");
    strip_html_tags(&decoded)
        .split_whitespace()
        .filter(|word| *word != "#" && *word != "*")
        .collect::<Vec<_>>()
        .join(" ")
}

fn make_score_file(filename: &str, description: &str, editor: &str) -> ImslpScoreFile {
    let encoded = urlencoding_encode(filename);
    ImslpScoreFile {
        filename: filename.to_string(),
        raw_metadata: Default::default(),
        publisher: String::new(),
        arranger: String::new(),
        copyright: String::new(),
        section: String::new(),
        thumbnail_file: None,
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
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
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
    organization: Option<String>,
    metadata: Option<serde_json::Value>,
) -> Result<ImslpDownloadResult, String> {
    let client = imslp_client()?;
    let encoded = urlencoding_encode(&filename);
    let accept_url = format!("https://imslp.org/wiki/Special:IMSLPDisclaimerAccept/{encoded}");
    let handler_url = format!("https://imslp.org/wiki/Special:IMSLPImageHandler/{encoded}");

    let mut candidates: Vec<String> = Vec::new();

    // 1) Disclaimer / wait page
    let accept_result = fetch_bytes(&client, &accept_url).await;
    let accept_error = accept_result.as_ref().err().cloned().unwrap_or_default();
    let accept_bytes = accept_result.unwrap_or_default();
    if accept_bytes.starts_with(b"%PDF") {
        return finish_download(
            filename,
            library_root,
            composer.clone(),
            work_title.clone(),
            organization.clone(),
            metadata.clone(),
            accept_bytes,
        );
    }
    let accept_html = String::from_utf8_lossy(&accept_bytes).into_owned();
    push_unique(&mut candidates, extract_all_mirror_urls(&accept_html));

    // 2) Image handler page
    if let Ok(handler_bytes) = fetch_bytes(&client, &handler_url).await {
        if handler_bytes.starts_with(b"%PDF") {
            return finish_download(
                filename,
                library_root,
                composer.clone(),
                work_title.clone(),
                organization.clone(),
                metadata.clone(),
                handler_bytes,
            );
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
        return Err(format!(
            "Could not find a download link on IMSLP for this file. {accept_error}"
        ));
    }

    let mut last_err = String::new();
    for url in candidates {
        match fetch_bytes(&client, &url).await {
            Ok(bytes) if bytes.starts_with(b"%PDF") => {
                return finish_download(
                    filename,
                    library_root,
                    composer,
                    work_title,
                    organization,
                    metadata,
                    bytes,
                );
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
        .map_err(|e| format!("error sending request for url ({url}): {e:#}"))?;

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
    organization: Option<String>,
    metadata: Option<serde_json::Value>,
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
        let mut dir = PathBuf::from(&root);
        if organization.as_deref() != Some("flat") {
            dir = dir.join(&composer_folder);
        }
        if organization.as_deref() == Some("composer-work") {
            dir = dir.join(sanitize_path_segment(
                work_title.as_deref().unwrap_or("Untitled work"),
            ));
        }
        fs::create_dir_all(&dir).map_err(|e| format!("Could not create composer folder: {e}"))?;

        // Prefer a readable work-based filename when available
        let work_filename = preferred_filename(&filename, work_title.as_deref());
        let edition = metadata
            .as_ref()
            .and_then(|m| m["edition"].as_str())
            .unwrap_or("Score");
        let publisher = metadata
            .as_ref()
            .and_then(|m| m["publisher"].as_str())
            .unwrap_or("");
        let edition_name: String = format!(
            "{}{}{}",
            edition,
            if publisher.is_empty() { "" } else { " — " },
            publisher
        )
        .chars()
        .take(90)
        .collect();
        let safe = if organization.as_deref() == Some("composer-work") {
            format!("{}.pdf", sanitize_path_segment(&edition_name))
        } else {
            format!(
                "{} — {}.pdf",
                work_filename.trim_end_matches(".pdf"),
                sanitize_path_segment(&edition_name)
            )
        };
        let dest = unique_dest(&dir, &safe)?;
        fs::write(&dest, &bytes).map_err(|e| format!("Could not write PDF: {e}"))?;
        let saved_name = dest
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or(safe);
        if let Some(metadata) = metadata {
            let sidecar = dest.with_extension("sonora.json");
            if let Err(error) = fs::write(
                &sidecar,
                serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?,
            ) {
                let _ = fs::remove_file(&dest);
                return Err(format!("Could not save score metadata: {error}"));
            }
        }
        let relative = dest
            .strip_prefix(&root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
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
    let mut length = 0;
    let s: String = s
        .trim()
        .trim_matches('.')
        .trim()
        .chars()
        .take_while(|c| {
            length += c.len_utf8();
            length <= 160
        })
        .collect();
    if s.is_empty() {
        "Unknown Composer".into()
    } else {
        s
    }
}

fn sanitize_folder_segment(name: &str) -> String {
    sanitize_path_segment(name)
}

fn preferred_filename(raw_filename: &str, work_title: Option<&str>) -> String {
    if let Some(title) = work_title.map(str::trim).filter(|s| !s.is_empty()) {
        // Use work title without the trailing "(Composer)" for a cleaner file name
        let base = if title.ends_with(')')
            && title
                .rsplit_once('(')
                .map(|(_, last)| last.contains(','))
                .unwrap_or(false)
        {
            title
                .rsplit_once('(')
                .map(|(left, _)| left.trim())
                .unwrap_or(title)
        } else {
            title
        };
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

#[tauri::command]
fn save_score_sidecar(
    source_path: String,
    library_root: String,
    metadata: serde_json::Value,
) -> Result<(), String> {
    let source = PathBuf::from(source_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let root = PathBuf::from(library_root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !source.starts_with(root)
        || source
            .extension()
            .and_then(|v| v.to_str())
            .map(|v| !v.eq_ignore_ascii_case("pdf"))
            .unwrap_or(true)
    {
        return Err("Score is outside the library".into());
    }
    let destination = source.with_extension("sonora.json");
    let temporary = source.with_extension("sonora.json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, destination).map_err(|e| e.to_string())
}

/// Move a score PDF into `{library_root}/{composer_folder}/`, creating the folder if needed.
#[tauri::command]
fn move_score_into_composer_folder(
    source_path: String,
    library_root: String,
    composer_folder: String,
    work_folder: Option<String>,
    flat: Option<bool>,
) -> Result<MovedScore, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("Source file not found: {source_path}"));
    }

    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("Library folder no longer exists.".into());
    }

    // Refuse to move files outside the library root
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical_source = source.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_source.starts_with(&canonical_root) {
        return Err("Score file is outside the library folder.".into());
    }

    let folder_name = sanitize_folder_segment(&composer_folder);
    let mut dest_dir = if flat.unwrap_or(false) {
        root.clone()
    } else {
        root.join(&folder_name)
    };
    if let Some(work) = work_folder.filter(|w| !w.is_empty()) {
        dest_dir = dest_dir.join(sanitize_path_segment(&work));
    }
    fs::create_dir_all(&dest_dir).map_err(|e| format!("Could not create composer folder: {e}"))?;

    let filename = source
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid source filename".to_string())?;

    // Already in the right folder
    if source
        .parent()
        .map(|p| p == dest_dir.as_path())
        .unwrap_or(false)
    {
        let relative = source
            .strip_prefix(&root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        return Ok(MovedScore {
            native_path: source.to_string_lossy().to_string(),
            relative_path: relative,
            filename,
        });
    }

    let dest = unique_dest(&dest_dir, &filename)?;
    fs::rename(&source, &dest).map_err(|e| format!("Could not move score file: {e}"))?;
    let sidecar = source.with_extension("sonora.json");
    if sidecar.exists() {
        if let Err(error) = fs::rename(&sidecar, dest.with_extension("sonora.json")) {
            let _ = fs::rename(&dest, &source);
            return Err(format!("Could not move score metadata: {error}"));
        }
    }

    let saved_name = dest
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(filename);
    let relative = dest
        .strip_prefix(&root)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(MovedScore {
        native_path: dest.to_string_lossy().to_string(),
        relative_path: relative,
        filename: saved_name,
    })
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
    let pages = api_pages(&body);
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
                .find(|c: char| {
                    c == '"'
                        || c == '\''
                        || c == ' '
                        || c == '<'
                        || c == '>'
                        || c == ')'
                        || c == '\n'
                        || c == '\r'
                })
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
async fn list_score_files(path: String) -> Result<Vec<NativeScoreFile>, String> {
    tokio::task::spawn_blocking(move || scan_score_files(path)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn score_folder_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

fn scan_score_files(path: String) -> Result<Vec<NativeScoreFile>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("The saved score folder no longer exists.".into());
    }
    let mut files = Vec::new();
    collect_pdfs(&root, &root, &mut files)?;
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

/// Recognize a rendered score page locally. No PDF bytes or images leave the device.
#[tauri::command]
async fn ocr_score_page(image: Vec<u8>) -> Result<String, String> {
    if image.len() > 16 * 1024 * 1024 || !image.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("OCR requires a PNG page smaller than 16 MB.".into());
    }
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let languages = Command::new("tesseract").arg("--list-langs").output()
            .map_err(|_| "Local OCR requires Tesseract installed on this computer.".to_string())?;
        if !String::from_utf8_lossy(&languages.stdout).lines().any(|line|line.trim()=="eng") {
            return Err("Local OCR requires Tesseract English language data (eng.traineddata). Filename suggestions are still available.".into());
        }
        let mut child = Command::new("tesseract")
            .args(["stdin", "stdout", "--psm", "11"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|_| "Local OCR requires Tesseract installed on this computer.".to_string())?;
        let mut stdin = child.stdin.take().ok_or("Could not open OCR input")?;
        let writer = std::thread::spawn(move || stdin.write_all(&image));
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if start.elapsed().as_secs() < 30 => std::thread::sleep(std::time::Duration::from_millis(50)),
                _ => { let _ = child.kill(); let _ = child.wait(); let _ = writer.join(); return Err("Local OCR timed out.".into()); }
            }
        }
        let _ = writer.join();
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err("Local OCR could not read this page.".into()); }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
fn read_score_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|error| error.to_string())
}

#[tauri::command]
async fn read_score_file_binary(path: String) -> Result<tauri::ipc::Response, String> {
    tokio::task::spawn_blocking(move || fs::read(path).map(tauri::ipc::Response::new).map_err(|error| error.to_string()))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn read_score_file_base64(path: String) -> Result<String, String> {
    let buf = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(data_encoding_base64(&buf))
}

fn data_encoding_base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
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
            library_archive::export_library_archive,
            library_archive::import_library_archive,
            pick_score_folder,
            list_score_files,
            score_folders::list_score_tree,
            score_folders::create_score_directory,
            score_folders::move_score_entry,
            score_folders::delete_score_directory,
            score_folder_exists,
            read_score_file,
            read_score_file_binary,
            ocr_score_page,
            read_score_file_base64,
            read_text_file,
            move_score_into_composer_folder,
            save_score_sidecar,
            imslp_thumbnail,
            imslp_search,
            imslp_work_scores,
            imslp_download_score
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sonora");
}

#[cfg(test)]
mod imslp_tests {
    use super::*;

    #[test]
    fn parses_real_editions_without_filename_gibberish() {
        let files = extract_score_files(include_str!("../tests/fixtures/beethoven-op49-1.wiki"));
        assert!(files.len() >= 30);
        let first = files
            .iter()
            .find(|f| f.filename == "PMLP01471-Op.49-1.pdf")
            .unwrap();
        assert_eq!(
            first.thumbnail_file.as_deref(),
            Some("Beethoven_deux_sonates_faciles_op.49.jpg")
        );
        assert_eq!(first.editor, "First edition");
        assert!(first.publisher.contains("Vienna"));
        assert!(files.iter().any(|f| f.editor.contains("Moscheles")));
        assert!(files
            .iter()
            .any(|f| f.arranger.contains("Joshua Choe") && f.description.contains("Violins I")));
        assert!(files
            .iter()
            .all(|f| !f.description.contains("{{") && !f.editor.contains("<br")));
    }

    #[test]
    fn nested_inline_and_multiline_parameters_are_not_split() {
        let files = extract_score_files("{{#fte:imslpfile|File Name 1=Test.pdf|File Description 1=Complete Score|Editor={{LinkEd|Émile|Sauret}}|Publisher Information=[[Publisher|Éditions]]<br>Paris\n1900|Thumb Filename=TN-Test.jpg}}");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].editor, "Émile Sauret");
        assert_eq!(files[0].publisher, "Éditions Paris 1900");
    }

    #[test]
    fn accepts_both_mediawiki_page_formats() {
        assert_eq!(
            api_pages(&serde_json::json!({"query":{"pages":{"123":{"title":"Test"}}}})).len(),
            1
        );
        assert_eq!(
            api_pages(&serde_json::json!({"query":{"pages":[{"title":"Test"}]}})).len(),
            1
        );
    }

    #[test]
    fn ninth_symphony_outranks_nineteenth_sonata() {
        assert!(
            search_rank(
                "Symphony No.9, Op.125 (Beethoven, Ludwig van)",
                "beethoven 9",
                &["beethoven", "9"]
            ) > search_rank(
                "Piano Sonata No.19, Op.49 No.1 (Beethoven, Ludwig van)",
                "beethoven 9",
                &["beethoven", "9"]
            )
        );
    }

    #[tokio::test]
    #[ignore = "Requires live IMSLP network access"]
    async fn live_search_editions_and_thumbnail() {
        let hits = imslp_search("beethoven 9".into(), Some(10)).await.unwrap();
        assert!(hits.iter().any(|h| h.title.contains("Symphony No.9")));
        assert!(hits.iter().any(|h| h.thumb_url.is_some()));
        let result =
            imslp_work_scores("Piano Sonata No.19, Op.49 No.1 (Beethoven, Ludwig van)".into())
                .await
                .unwrap();
        assert!(result["files"].as_array().unwrap().len() >= 30);
        let collected_edition = result["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| {
                file["filename"]
                    .as_str()
                    .unwrap_or("")
                    .contains("Beethoven_Werke_Breitkopf")
            })
            .unwrap();
        assert!(
            collected_edition["publisher"]
                .as_str()
                .unwrap_or("")
                .contains("Breitkopf"),
            "Publisher template should be expanded: {}",
            collected_edition["publisher"]
        );
        let url = result["files"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|f| f["thumb_url"].as_str())
            .expect("real thumbnail");
        assert!(imslp_thumbnail(url.into())
            .await
            .unwrap()
            .starts_with("data:image/"));
    }
}

#[cfg(test)]
mod organization_tests {
    use super::*;
    #[test]
    fn organization_moves_sidecars_without_overwriting_editions() {
        let root = std::env::temp_dir().join(format!(
            "sonora-organization-{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("Score.pdf");
        fs::write(&source, b"%PDF test").unwrap();
        save_score_sidecar(
            source.to_string_lossy().into(),
            root.to_string_lossy().into(),
            serde_json::json!({"workTitle":"Symphony No.9","editor":"Test editor"}),
        )
        .unwrap();
        let moved = move_score_into_composer_folder(
            source.to_string_lossy().into(),
            root.to_string_lossy().into(),
            "Beethoven".into(),
            Some("Symphony No.9".into()),
            Some(false),
        )
        .unwrap();
        assert_eq!(moved.relative_path, "Beethoven/Symphony No.9/Score.pdf");
        assert!(PathBuf::from(&moved.native_path)
            .with_extension("sonora.json")
            .exists());
        let flat = move_score_into_composer_folder(
            moved.native_path,
            root.to_string_lossy().into(),
            "Beethoven".into(),
            None,
            Some(true),
        )
        .unwrap();
        assert_eq!(flat.relative_path, "Score.pdf");
        let mut files = Vec::new();
        collect_pdfs(&root, &root, &mut files).unwrap();
        assert_eq!(files[0].metadata.as_ref().unwrap()["editor"], "Test editor");
        assert!(sanitize_path_segment(&"É".repeat(200)).len() <= 160);
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod live_import_test {
    use super::*;
    #[tokio::test]
    #[ignore = "Downloads a public-domain PDF from IMSLP"]
    async fn live_import_preserves_work_metadata() {
        let root = std::env::temp_dir().join(format!("sonora-live-import-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let result = imslp_download_score(
            "PMLP01471-Op.49-1.pdf".into(), Some(root.to_string_lossy().into()),
            Some("Ludwig van Beethoven".into()), Some("Piano Sonata No.19, Op.49 No.1".into()),
            Some("composer-work".into()), Some(serde_json::json!({"title":"Piano Sonata No.19, Op.49 No.1", "composer":"Ludwig van Beethoven", "workTitle":"Piano Sonata No.19, Op.49 No.1", "edition":"Complete Score", "publisher":"Bureau des Arts et d'Industrie, Vienna, 1805"}))
        ).await.unwrap();
        let destination = PathBuf::from(result.saved_path.unwrap());
        assert!(fs::read(&destination).unwrap().starts_with(b"%PDF"));
        assert!(destination.with_extension("sonora.json").exists());
        let mut files = Vec::new();
        collect_pdfs(&root, &root, &mut files).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].metadata.as_ref().unwrap()["workTitle"],
            "Piano Sonata No.19, Op.49 No.1"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod data_integrity_tests {
    use super::*;
    use base64::Engine;
    #[test]
    fn base64_round_trips_every_tail_length_and_real_thumbnail() {
        for length in 0..512 {
            let bytes: Vec<u8> = (0..length).map(|i| ((i * 97 + 3) % 256) as u8).collect();
            let encoded = data_encoding_base64(&bytes);
            assert_eq!(encoded.len() % 4, 0);
            assert_eq!(
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .unwrap(),
                bytes
            );
        }
        let png = include_bytes!("../../tests/ui/score-preview.png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(data_encoding_base64(png))
                .unwrap(),
            png
        );
    }
    #[test]
    fn nested_templates_entities_and_indexed_edition_fields() {
        assert_eq!(
            decode_html_entities("B&#228;renreiter &amp; H&#xE4;rtel &ndash; &eacute;"),
            "Bärenreiter & Härtel – é"
        );
        assert_eq!(
            clean_wiki_text("{{P|Universal Edition||Vienna|{{WC|1391429356|1922}}|||U.E. 4028}}"),
            "Universal Edition, Vienna, 1922, Plate U.E. 4028"
        );
        assert_eq!(
            clean_wiki_text(
                "[[Publisher|Éditions]]<br>Paris [https://example.org source] {{Key|eflat}}"
            ),
            "Éditions Paris source E♭ minor"
        );
        let files=extract_score_files("{{#fte:imslpfile|File Name 1=One.pdf|File Name 2=Two.pdf|File Description 1=Full score|File Description 2=Violin part|Editor 1={{LinkEd|Ada|One}}|Editor 2={{LinkEd|Émile|Two}}|Thumb Filename 1=One.jpg|Thumb Filename 2=Two.jpg}}");
        let one = files.iter().find(|f| f.filename == "One.pdf").unwrap();
        let two = files.iter().find(|f| f.filename == "Two.pdf").unwrap();
        assert_eq!(one.editor, "Ada One");
        assert_eq!(two.editor, "Émile Two");
        assert_eq!(one.thumbnail_file.as_deref(), Some("One.jpg"));
        assert_eq!(two.thumbnail_file.as_deref(), Some("Two.jpg"));
    }
    #[tokio::test]
    #[ignore = "Requires live IMSLP API and image downloads"]
    async fn live_diverse_works_and_decoded_images() {
        let titles = [
            "Goldberg-Variationen, BWV 988 (Bach, Johann Sebastian)",
            "Symphony No.40 in G minor, K.550 (Mozart, Wolfgang Amadeus)",
            "Suite bergamasque (Debussy, Claude)",
        ];
        let mut proof = Vec::new();
        for title in titles {
            let details = imslp_work_scores(title.into()).await.unwrap();
            let files = details["files"].as_array().unwrap();
            assert!(!files.is_empty(), "No scores for {title}");
            for file in files {
                for field in [
                    "description",
                    "editor",
                    "publisher",
                    "arranger",
                    "copyright",
                    "section",
                ] {
                    let value = file[field].as_str().unwrap();
                    assert!(
                        !value.contains("{{") && !value.contains("}}") && !value.contains("<br"),
                        "Unparsed {field} in {title}: {value}"
                    );
                }
            }
            let url = files
                .iter()
                .find_map(|file| file["thumb_url"].as_str())
                .expect("IMSLP should supply a first-page preview");
            let data = imslp_thumbnail(url.into()).await.unwrap();
            let payload = data.split_once(',').unwrap().1;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(payload)
                .unwrap();
            assert!(
                bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                    || bytes.starts_with(b"\xff\xd8\xff")
                    || bytes.starts_with(b"RIFF")
                    || bytes.starts_with(b"GIF8"),
                "Not an actual image for {title}"
            );
            let raw = api_get_json(
                &imslp_client().unwrap(),
                &[
                    ("action", "parse"),
                    ("page", title),
                    ("prop", "wikitext"),
                    ("format", "json"),
                ],
            )
            .await
            .unwrap();
            let wikitext = parse_wikitext_field(&raw["parse"]["wikitext"]).unwrap_or_default();
            proof.push(serde_json::json!({"title":title,"url":url,"data":data,"details":details,"wikitext":wikitext}));
        }
        if let Ok(path) = std::env::var("SONORA_IMSLP_REVIEW_OUTPUT") {
            fs::write(path, serde_json::to_vec(&proof).unwrap()).unwrap();
        }
    }
}

#[cfg(test)]
mod movement_metadata_tests {
    use super::*;
    #[test]
    fn debussy_movement_names_and_flat_keys_survive() {
        let metadata =
            extract_work_metadata(include_str!("../tests/fixtures/debussy-work-info.wiki"));
        let movements = metadata["movements"].as_str().unwrap();
        for title in [
            "Prélude",
            "Menuet",
            "Clair de lune",
            "Passepied",
            "D♭ major",
        ] {
            assert!(movements.contains(title), "Missing {title}: {movements}");
        }
        assert!(!movements.contains("{{"));
        assert_eq!(metadata["compositionDate"], "1890-1905");
    }
    #[test]
    fn original_score_precedes_arranged_complete_score() {
        let mut original = make_score_file("Original.pdf", "Complete Score · Scan", "");
        original.section = "Scores".into();
        let mut arranged = make_score_file("Accordion.pdf", "Complete Score (C)", "");
        arranged.arranger = "Paul De Bra".into();
        let mut files = vec![arranged, original];
        sort_score_files(&mut files);
        assert_eq!(files[0].filename, "Original.pdf");
    }
}

#[cfg(test)]
mod score_ocr_tests {
    use super::*;
    #[tokio::test]
    async fn rejects_non_image_ocr_input() {
        assert!(ocr_score_page(b"not a PNG".to_vec()).await.unwrap_err().contains("PNG"));
    }
    #[tokio::test]
    #[ignore = "Requires local Tesseract with English language data"]
    async fn local_ocr_reads_title_page() {
        let text = ocr_score_page(include_bytes!("../../tests/ui/score-preview.png").to_vec()).await.unwrap();
        assert!(text.chars().filter(|c|c.is_alphabetic()).count()>8, "No readable title-page text: {text}");
    }
}

#[cfg(test)]
mod performance_tests {
    use super::*;
    use std::time::Instant;

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[tokio::test]
    async fn binary_score_response_preserves_bytes() {
        use tauri::ipc::{IpcResponse, InvokeResponseBody};
        let fixture = Fixture(std::env::temp_dir().join(format!("sonora-binary-test-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())));
        fs::create_dir_all(&fixture.0).unwrap();
        let path = fixture.0.join("score.pdf");
        let bytes: Vec<u8> = (0..=255).cycle().take(65537).collect();
        fs::write(&path, &bytes).unwrap();
        let response = read_score_file_binary(path.to_string_lossy().into_owned()).await.unwrap().body().unwrap();
        match response {
            InvokeResponseBody::Raw(actual) => assert_eq!(actual, bytes),
            _ => panic!("PDF response must be binary"),
        }
        assert!(read_score_file_binary(fixture.0.join("missing.pdf").to_string_lossy().into_owned()).await.is_err());
    }

    /// Run explicitly: cargo test native_library_benchmark -- --ignored --nocapture
    /// Synthetic filesystem + serialization costs, not end-to-end webview latency.
    #[test]
    #[ignore]
    fn native_library_benchmark() {
        let fixture = Fixture(std::env::temp_dir().join(format!("sonora-benchmark-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())));
        fs::create_dir_all(&fixture.0).unwrap();
        let mut rows = Vec::new();
        let mut previous = 0;
        for count in [1000, 10000, 50000] {
            for i in previous..count {
                let dir = fixture.0.join(format!("composer-{}", i % 100));
                fs::create_dir_all(&dir).unwrap();
                fs::write(dir.join(format!("score-{i}.pdf")), b"%PDF-1.4\nbenchmark\n").unwrap();
            }
            previous = count;
            let mut samples = Vec::new();
            for _ in 0..7 {
                let start = Instant::now();
                let files = scan_score_files(fixture.0.to_string_lossy().into_owned()).unwrap();
                assert_eq!(files.len(), count);
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            samples.sort_by(f64::total_cmp);
            rows.push(serde_json::json!({"name":"nativeScan", "size":count, "medianMs":samples[3], "p95Ms":samples[6]}));
        }
        for mb in [1, 10, 50] {
            let bytes = vec![173u8; mb * 1024 * 1024];
            let path = fixture.0.join("transfer.pdf");
            fs::write(&path, &bytes).unwrap();
            for json in [true, false] {
                let mut samples = Vec::new();
                let mut length = 0;
                for _ in 0..7 {
                    let start = Instant::now();
                    let data = fs::read(&path).unwrap();
                    length = if json { serde_json::to_vec(&data).unwrap().len() } else { tauri::ipc::Response::new(data); bytes.len() };
                    samples.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                samples.sort_by(f64::total_cmp);
                rows.push(serde_json::json!({"name": if json {"readAndJsonEncode"} else {"readAndBinaryResponse"}, "sizeMiB":mb, "responseBytes":length, "medianMs":samples[3], "p95Ms":samples[6]}));
            }
        }
        let output = serde_json::to_string_pretty(&serde_json::json!({"profile": if cfg!(debug_assertions) {"debug"} else {"release"}, "samples":7, "rows":rows})).unwrap();
        if let Ok(path) = std::env::var("SONORA_BENCH_OUTPUT") { fs::write(path, &output).unwrap(); }
        println!("{output}");
    }
}
