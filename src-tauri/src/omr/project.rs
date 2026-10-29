//! Check source-page coverage using Audiveris's book, since an XML export can
//! look valid even when an entire source page was rejected by recognition.
use quick_xml::{events::Event, Reader};
use std::{fs::File, io::Read, path::Path};

fn attr(e: &quick_xml::events::BytesStart<'_>, key: &[u8]) -> String {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        .map(|a| String::from_utf8_lossy(&a.value).into_owned())
        .unwrap_or_default()
}

pub fn inspect(path: &Path, first: u32, last: Option<u32>) -> Result<Vec<String>, String> {
    let mut archive = zip::ZipArchive::new(File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut book = archive.by_name("book.xml").map_err(|e| e.to_string())?;
    if book.size() > 16 * 1024 * 1024 {
        return Err("Book metadata is too large to review".into());
    }
    let mut bytes = Vec::new();
    book.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    inspect_book(&bytes, first, last)
}

fn inspect_book(bytes: &[u8], first: u32, last: Option<u32>) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    reader.config_mut().expand_empty_elements = true;
    let mut stack = Vec::<Vec<u8>>::new();
    let mut page = 0;
    let mut max_page = 0;
    let mut invalid = false;
    let mut complete = false;
    let mut has_music = false;
    let mut warnings = Vec::new();
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) => {
                if e.name().as_ref() == b"sheet" && stack.last().is_some_and(|n| n == b"book") {
                    page = attr(&e, b"number").parse().unwrap_or(0);
                    max_page = max_page.max(page);
                    invalid = attr(&e, b"invalid") == "true";
                    complete = false;
                    has_music = false;
                }
                if e.name().as_ref() == b"page" && stack.last().is_some_and(|n| n == b"sheet") {
                    has_music = true;
                }
                stack.push(e.name().as_ref().to_vec());
                if stack.len() > 256 {
                    return Err("Book metadata nesting exceeds limit".into());
                }
            }
            Event::Text(e) if stack.last().is_some_and(|n| n == b"steps") => {
                complete = e
                    .decode()
                    .map_err(|e| e.to_string())?
                    .split_whitespace()
                    .any(|s| s == "PAGE");
            }
            Event::End(e) => {
                stack.pop();
                if e.name().as_ref() == b"sheet"
                    && page >= first
                    && last.is_none_or(|end| page <= end)
                {
                    if invalid {
                        warnings.push(format!("Source page {page} was rejected by Audiveris and may be absent from MusicXML"));
                    } else if !complete || !has_music {
                        warnings.push(format!("Source page {page} did not finish music recognition and may be absent from MusicXML"));
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if max_page == 0 || !stack.is_empty() {
        return Err("Book metadata has no complete source-page inventory".into());
    }
    if first > max_page || last.is_some_and(|end| end > max_page) {
        warnings.push(format!(
            "Requested page range exceeds the document's {max_page} source pages"
        ));
    }
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catches_rejected_and_unprocessed_pages_without_flagging_exclusions() {
        let book = br#"<book><sheet number="1"><steps>LOAD PAGE</steps><page id="1"></page></sheet><sheet number="2" invalid="true"><steps>LOAD</steps></sheet><sheet number="3"><steps/></sheet></book>"#;
        assert!(inspect_book(book, 1, Some(1)).unwrap().is_empty());
        let warnings = inspect_book(book, 1, None).unwrap();
        assert_eq!(warnings.len(), 2);
        assert!(warnings[0].contains("page 2"));
        assert!(warnings[1].contains("page 3"));
        assert_eq!(inspect_book(book, 4, Some(5)).unwrap().len(), 1);
    }
}
