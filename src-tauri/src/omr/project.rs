//! Check source-page coverage using Audiveris's book, since an XML export can
//! look valid even when an entire source page was rejected by recognition.
use quick_xml::{events::Event, Reader};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};

/// Audiveris 5.11 serializes zero-width/height glyph tables without any runs,
/// then dereferences the missing array when reading them. Keep them empty, but
/// provide one empty sequence and a matching extent. No ink is added or removed.
fn normalize_empty_tables(bytes: &[u8]) -> Result<(Vec<u8>, usize), String> {
    // Most pages need no repair. Avoid parsing their millions of run entries.
    if !bytes.windows(9).any(|w| w == b"width=\"0\"")
        && !bytes.windows(10).any(|w| w == b"height=\"0\"")
    {
        return Ok((bytes.to_vec(), 0));
    }
    let mut reader = Reader::from_reader(bytes);
    let mut output = Vec::new();
    let mut copied = 0;
    let mut count = 0;
    loop {
        let start = reader.buffer_position() as usize;
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Empty(e) if e.local_name().as_ref() == b"run-table" => {
                let axis = match attr(&e, b"orientation").as_str() {
                    "VERTICAL" => b"width".as_slice(),
                    "HORIZONTAL" => b"height".as_slice(),
                    _ => continue,
                };
                if attr(&e, axis) != "0" {
                    continue;
                }
                output.extend_from_slice(&bytes[copied..start]);
                let mut table = quick_xml::events::BytesStart::new("run-table");
                for attribute in e.attributes() {
                    let a = attribute.map_err(|e| e.to_string())?;
                    table.push_attribute((
                        a.key.as_ref(),
                        if a.key.as_ref() == axis {
                            b"1".as_slice()
                        } else {
                            a.value.as_ref()
                        },
                    ));
                }
                let mut writer = quick_xml::Writer::new(&mut output);
                writer
                    .write_event(Event::Start(table))
                    .map_err(|e| e.to_string())?;
                writer
                    .write_event(Event::Empty(quick_xml::events::BytesStart::new("runs")))
                    .map_err(|e| e.to_string())?;
                writer
                    .write_event(Event::End(quick_xml::events::BytesEnd::new("run-table")))
                    .map_err(|e| e.to_string())?;
                copied = reader.buffer_position() as usize;
                count += 1;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    output.extend_from_slice(&bytes[copied..]);
    Ok((output, count))
}

pub fn copy_compatible(source: &Path, destination: &Path) -> Result<usize, String> {
    let mut archive = zip::ZipArchive::new(File::open(source).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut output = zip::ZipWriter::new(File::create(destination).map_err(|e| e.to_string())?);
    let mut count = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.name().starts_with("sheet#") && entry.name().ends_with(".xml") {
            if entry.size() > 64 * 1024 * 1024 {
                return Err("Saved page metadata exceeds the recovery limit".into());
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            let (bytes, repaired) = normalize_empty_tables(&bytes)?;
            count += repaired;
            if repaired == 0 {
                drop(entry);
                output
                    .raw_copy_file(archive.by_index(i).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                continue;
            }
            output
                .start_file(
                    entry.name(),
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Deflated)
                        .compression_level(Some(1)),
                )
                .map_err(|e| e.to_string())?;
            output.write_all(&bytes).map_err(|e| e.to_string())?;
        } else {
            output.raw_copy_file(entry).map_err(|e| e.to_string())?;
        }
    }
    output
        .finish()
        .map_err(|e| e.to_string())?
        .sync_all()
        .map_err(|e| e.to_string())?;
    Ok(count)
}

pub fn make_compatible(path: &Path) -> Result<usize, String> {
    let temporary = path.with_extension("normalized.omr");
    let count = copy_compatible(path, &temporary)?;
    fs::rename(temporary, path).map_err(|e| e.to_string())?;
    Ok(count)
}

pub fn pages(path: &Path) -> Result<(u32, Vec<u32>), String> {
    let mut archive = zip::ZipArchive::new(File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut book = archive.by_name("book.xml").map_err(|e| e.to_string())?;
    if book.size() > 16 * 1024 * 1024 {
        return Err("Book metadata is oversized".into());
    }
    let mut bytes = Vec::new();
    book.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let mut reader = Reader::from_reader(bytes.as_slice());
    reader.config_mut().expand_empty_elements = true;
    let mut page = 0;
    let mut total = 0;
    let mut valid = false;
    let mut in_steps = false;
    let mut complete = Vec::new();
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) if e.name().as_ref() == b"sheet" => {
                page = attr(&e, b"number").parse().unwrap_or(0);
                total = total.max(page);
                valid = attr(&e, b"invalid") != "true";
            }
            Event::Start(e) if e.name().as_ref() == b"steps" => in_steps = true,
            Event::End(e) if e.name().as_ref() == b"steps" => in_steps = false,
            Event::Text(e) if in_steps && valid => {
                if e.decode()
                    .map_err(|e| e.to_string())?
                    .split_whitespace()
                    .any(|s| s == "PAGE")
                {
                    complete.push(page);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok((total, complete))
}

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
    fn compatibility_keeps_empty_glyphs_empty_and_other_bytes_unchanged() {
        let original = br#"<?xml version="1.0"?><sheet><run-table orientation="VERTICAL" width="0" height="43"/><run-table orientation="HORIZONTAL" width="12" height="0"/><run-table orientation="VERTICAL" width="2" height="3"><runs>0 1</runs></run-table><text>Allegro &amp; dolce</text></sheet>"#;
        let (fixed, count) = normalize_empty_tables(original).unwrap();
        assert_eq!(count, 2);
        let expected = String::from_utf8_lossy(original)
            .replace(
                "width=\"0\" height=\"43\"/>",
                "width=\"1\" height=\"43\"><runs/></run-table>",
            )
            .replace(
                "width=\"12\" height=\"0\"/>",
                "width=\"12\" height=\"1\"><runs/></run-table>",
            );
        assert_eq!(fixed, expected.as_bytes());
        assert_eq!(normalize_empty_tables(&fixed).unwrap(), (fixed, 0));
    }

    #[test]
    fn project_copy_preserves_images_source_and_page_inventory() {
        let dir = std::env::temp_dir().join(format!(
            "sonora-project-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.omr");
        let destination = dir.join("copy.omr");
        let book = br#"<book><sheet number="1"><steps>LOAD PAGE</steps></sheet><sheet number="2"><steps>LOAD TEXTS</steps></sheet><sheet number="3" invalid="true"><steps>PAGE</steps></sheet></book>"#;
        let image = b"binary image bytes \0\xff";
        let mut zip = zip::ZipWriter::new(File::create(&source).unwrap());
        for (name, bytes) in [
            ("book.xml", book.as_slice()),
            ("sheet#1/BINARY.png", image.as_slice()),
            (
                "sheet#2/sheet#2.xml",
                b"<sheet><run-table width=\"3\" height=\"2\"/></sheet>".as_slice(),
            ),
            (
                "sheet#1/sheet#1.xml",
                br#"<sheet><run-table orientation="VERTICAL" width="0" height="43"/></sheet>"#
                    .as_slice(),
            ),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        let original = fs::read(&source).unwrap();
        assert_eq!(copy_compatible(&source, &destination).unwrap(), 1);
        assert_eq!(fs::read(&source).unwrap(), original);
        let mut archive = zip::ZipArchive::new(File::open(&destination).unwrap()).unwrap();
        let mut saved_image = Vec::new();
        archive
            .by_name("sheet#1/BINARY.png")
            .unwrap()
            .read_to_end(&mut saved_image)
            .unwrap();
        assert_eq!(saved_image, image);
        let mut unchanged = Vec::new();
        archive
            .by_name("sheet#2/sheet#2.xml")
            .unwrap()
            .read_to_end(&mut unchanged)
            .unwrap();
        assert_eq!(
            unchanged,
            b"<sheet><run-table width=\"3\" height=\"2\"/></sheet>"
        );
        assert_eq!(pages(&destination).unwrap(), (3, vec![1]));
        fs::remove_dir_all(dir).unwrap();
    }

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
