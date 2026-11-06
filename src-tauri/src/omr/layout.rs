//! Reconcile isolated physical staff splits before Audiveris exports logical parts.
//! The surrounding source layout, not part names or empty MusicXML rests, is the
//! evidence. All graph symbols, images, notation references and times are retained.
use quick_xml::{
    events::{BytesStart, BytesText, Event},
    Reader, Writer,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};

#[derive(Clone)]
struct Node {
    start: BytesStart<'static>,
    children: Vec<Item>,
}
#[derive(Clone)]
enum Item {
    Node(Node),
    Event(Event<'static>),
}
impl Node {
    fn name(&self) -> &[u8] {
        self.start.name().into_inner()
    }
    fn attr(&self, key: &[u8]) -> String {
        self.start
            .attributes()
            .flatten()
            .find(|a| a.key.as_ref() == key)
            .map(|a| String::from_utf8_lossy(&a.value).into_owned())
            .unwrap_or_default()
    }
    fn set(&mut self, key: &str, value: &str) {
        let mut start = BytesStart::new(String::from_utf8_lossy(self.name()).into_owned());
        for a in self.start.attributes().flatten() {
            if a.key.as_ref() != key.as_bytes() {
                start.push_attribute((a.key.as_ref(), a.value.as_ref()));
            }
        }
        start.push_attribute((key, value));
        self.start = start.into_owned();
    }
    fn elements(&self) -> impl Iterator<Item = &Node> {
        self.children
            .iter()
            .filter_map(|c| if let Item::Node(n) = c { Some(n) } else { None })
    }
    fn elements_mut(&mut self) -> impl Iterator<Item = &mut Node> {
        self.children
            .iter_mut()
            .filter_map(|c| if let Item::Node(n) = c { Some(n) } else { None })
    }
    fn named<'a>(&'a self, name: &'a [u8]) -> impl Iterator<Item = &'a Node> {
        self.elements().filter(move |n| n.name() == name)
    }
    fn child_mut(&mut self, name: &[u8]) -> Option<&mut Node> {
        self.children.iter_mut().find_map(|c| match c {
            Item::Node(n) if n.name() == name => Some(n),
            _ => None,
        })
    }
    fn text(&self) -> Result<String, String> {
        let mut value = String::new();
        for item in &self.children {
            match item {
                Item::Event(Event::Text(e)) => {
                    value.push_str(&e.decode().map_err(|e| e.to_string())?)
                }
                _ => return Err("Unsupported mixed reference content".into()),
            }
        }
        Ok(value)
    }
    fn write(&self, w: &mut Writer<Vec<u8>>) -> Result<(), String> {
        if self.children.is_empty() {
            return w
                .write_event(Event::Empty(self.start.clone()))
                .map_err(|e| e.to_string());
        }
        w.write_event(Event::Start(self.start.clone()))
            .map_err(|e| e.to_string())?;
        for item in &self.children {
            match item {
                Item::Node(n) => n.write(w)?,
                Item::Event(e) => w.write_event(e.clone()).map_err(|e| e.to_string())?,
            }
        }
        w.write_event(Event::End(self.start.to_end()))
            .map_err(|e| e.to_string())
    }
    fn bytes(&self) -> Result<Vec<u8>, String> {
        let mut w = Writer::new(Vec::new());
        self.write(&mut w)?;
        Ok(w.into_inner())
    }
}
fn parse(bytes: &[u8]) -> Result<Node, String> {
    let mut reader = Reader::from_reader(bytes);
    let mut stack = Vec::<Node>::new();
    let mut root = None;
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) => {
                if stack.len() >= 128 {
                    return Err("Layout metadata nesting limit".into());
                }
                stack.push(Node {
                    start: e.into_owned(),
                    children: vec![],
                });
            }
            Event::Empty(e) => {
                let n = Node {
                    start: e.into_owned(),
                    children: vec![],
                };
                if let Some(p) = stack.last_mut() {
                    p.children.push(Item::Node(n));
                } else if root.replace(n).is_some() {
                    return Err("Multiple layout roots".into());
                }
            }
            Event::End(_) => {
                let n = stack.pop().ok_or("Unbalanced layout metadata")?;
                if let Some(p) = stack.last_mut() {
                    p.children.push(Item::Node(n));
                } else if root.replace(n).is_some() {
                    return Err("Multiple layout roots".into());
                }
            }
            Event::Eof => break,
            e => {
                if let Some(p) = stack.last_mut() {
                    p.children.push(Item::Event(e.into_owned()));
                }
            }
        }
    }
    if !stack.is_empty() {
        return Err("Incomplete layout metadata".into());
    }
    root.ok_or("Missing layout root".into())
}
fn read_entry(
    archive: &mut zip::ZipArchive<File>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let mut entry = archive.by_name(name).map_err(|e| e.to_string())?;
    if entry.size() > limit {
        return Err("Layout metadata exceeds limit".into());
    }
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
fn grand(n: &Node, canonical: &str) -> bool {
    let parts: Vec<_> = n.named(b"part").collect();
    parts.len() == 1
        && parts[0].attr(b"logical-id") == canonical
        && parts[0].named(b"staff-configuration").count() == 2
}
#[derive(Clone, Debug)]
struct Plan {
    score: usize,
    sheet: String,
    page: String,
    system: usize,
    canonical: String,
    old: BTreeSet<String>,
}
fn plans(book: &Node) -> Vec<Plan> {
    if !book.attr(b"software-version").starts_with("5.11.") {
        return Vec::new();
    }
    let pages: BTreeMap<_, _> = book
        .named(b"sheet")
        .flat_map(|s| {
            s.named(b"page")
                .map(move |p| ((s.attr(b"number"), p.attr(b"id")), p))
        })
        .collect();
    let mut result = Vec::new();
    for (score_index, score) in book.named(b"score").enumerate() {
        let mut systems = Vec::new();
        let mut valid = true;
        let mut grand_ids = BTreeSet::new();
        let mut grand_count = 0;
        for page in score.named(b"page") {
            let key = (page.attr(b"sheet-number"), page.attr(b"sheet-page-id"));
            let Some(p) = pages.get(&key) else {
                valid = false;
                break;
            };
            for (index, s) in p.named(b"system").enumerate() {
                let parts: Vec<_> = s.named(b"part").collect();
                let counts: Vec<_> = parts
                    .iter()
                    .map(|p| p.named(b"staff-configuration").count())
                    .collect();
                if counts != [2] && counts != [1, 1] {
                    valid = false;
                }
                if parts
                    .iter()
                    .flat_map(|p| p.named(b"staff-configuration"))
                    .any(|c| c.attr(b"line-count") != "5")
                {
                    valid = false;
                }
                if counts == [2] {
                    grand_count += 1;
                    grand_ids.insert(parts[0].attr(b"logical-id"));
                }
                systems.push((key.clone(), index, s));
            }
        }
        // Mixed ensembles, whole-page instrumentation changes and ambiguous
        // layouts are deliberately excluded from automatic joining.
        if !valid
            || grand_ids.len() != 1
            || grand_count < 3
            || grand_count * 100 < systems.len() * 85
        {
            continue;
        }
        let canonical = grand_ids.into_iter().next().unwrap();
        if canonical.is_empty() {
            continue;
        }
        let Some(logical) = score
            .named(b"logical-part")
            .find(|p| p.attr(b"id") == canonical)
        else {
            continue;
        };
        if logical.attr(b"staff-count") != "2" {
            continue;
        }
        let mut local = Vec::new();
        let mut uncertain = false;
        for (i, (key, index, s)) in systems.iter().enumerate() {
            if grand(s, &canonical) {
                continue;
            }
            if i == 0
                || i + 1 == systems.len()
                || !grand(systems[i - 1].2, &canonical)
                || !grand(systems[i + 1].2, &canonical)
            {
                uncertain = true;
                break;
            }
            if !systems
                .iter()
                .any(|(other, _, s)| other == key && grand(s, &canonical))
            {
                uncertain = true;
                break;
            }
            let old: BTreeSet<_> = s.named(b"part").map(|p| p.attr(b"logical-id")).collect();
            if old.len() != 2 || old.contains("") || old.contains(&canonical) {
                uncertain = true;
                break;
            }
            if old.iter().any(|id| {
                !score.named(b"logical-part").any(|p| {
                    p.attr(b"id") == *id
                        && p.attr(b"staff-count") == "1"
                        && p.attr(b"name").is_empty()
                })
            }) {
                uncertain = true;
                break;
            }
            local.push(Plan {
                score: score_index,
                sheet: key.0.clone(),
                page: key.1.clone(),
                system: *index,
                canonical: canonical.clone(),
                old,
            });
        }
        if !uncertain {
            result.extend(local);
        }
    }
    result
}
fn refs_join(a: &mut Node, b: &Node) -> Result<(), String> {
    let aa = a.text()?;
    let bb = b.text()?;
    let mut ids = Vec::new();
    let mut seen = BTreeSet::new();
    for id in aa.split_whitespace().chain(bb.split_whitespace()) {
        if id.parse::<u64>().ok().is_none_or(|n| n == 0) {
            return Err("Unsupported notation reference".into());
        }
        if seen.insert(id.to_string()) {
            ids.push(id.to_string());
        }
    }
    a.children = vec![Item::Event(Event::Text(
        BytesText::new(&ids.join(" ")).into_owned(),
    ))];
    Ok(())
}
fn bar_join(a: &mut Node, b: &Node) -> Result<(), String> {
    if a.elements().any(|n| n.name() != b"staff-barlines")
        || b.elements().any(|n| n.name() != b"staff-barlines")
    {
        return Err("Unsupported part barline".into());
    }
    if let Some(other) = b.named(b"staff-barlines").next() {
        if let Some(current) = a.child_mut(b"staff-barlines") {
            refs_join(current, other)?;
        } else {
            a.children.push(Item::Node(other.clone()));
        }
    }
    Ok(())
}
fn merge_part(mut a: Node, b: Node, canonical: &str) -> Result<Node, String> {
    if !a.attr(b"name").is_empty()
        || !b.attr(b"name").is_empty()
        || a.named(b"lyric-lines").next().is_some()
        || b.named(b"lyric-lines").next().is_some()
    {
        return Err("Named or lyric-bearing parts require review".into());
    }
    for p in [&a, &b] {
        if p.start
            .attributes()
            .flatten()
            .any(|attr| attr.key.as_ref() != b"id")
        {
            return Err("Part overrides require review".into());
        }
    }
    let top_staff = a
        .named(b"staff")
        .next()
        .ok_or("Missing upper staff")?
        .attr(b"id")
        .parse::<u32>()
        .map_err(|_| "Invalid upper staff")?;
    let bottom_staff = b
        .named(b"staff")
        .next()
        .ok_or("Missing lower staff")?
        .attr(b"id")
        .parse::<u32>()
        .map_err(|_| "Invalid lower staff")?;
    if top_staff.checked_add(1) != Some(bottom_staff) {
        return Err("Nonadjacent source staves".into());
    }
    for p in [&a, &b] {
        if p.elements().any(|n| {
            ![b"staff".as_slice(), b"left-barline", b"measure", b"slurs"].contains(&n.name())
        }) {
            return Err("Unsupported part structure".into());
        }
    }
    if a.named(b"staff").count() != 1 || b.named(b"staff").count() != 1 {
        return Err("Expected two single staves".into());
    }
    let offset = a
        .named(b"measure")
        .flat_map(|m| m.named(b"voice"))
        .map(|v| v.attr(b"id").parse::<u32>().unwrap_or(0))
        .max()
        .unwrap_or(0)
        .max(4);
    let mut lower = b.named(b"measure");
    for m in a.elements_mut().filter(|n| n.name() == b"measure") {
        let n = lower.next().ok_or("Unaligned measures in split staves")?;
        if m.attr(b"id") != n.attr(b"id") {
            return Err("Unaligned measure IDs in split staves".into());
        }
        for field in m
            .start
            .attributes()
            .flatten()
            .chain(n.start.attributes().flatten())
        {
            let key = field.key.as_ref();
            if key != b"abnormal" && m.attr(key) != n.attr(key) {
                return Err("Split measures have conflicting properties".into());
            }
        }
        let top_chords = m
            .named(b"head-chords")
            .next()
            .map(Node::text)
            .transpose()?
            .unwrap_or_default();
        let bottom_chords = n
            .named(b"head-chords")
            .next()
            .map(Node::text)
            .transpose()?
            .unwrap_or_default();
        if top_chords
            .split_whitespace()
            .any(|id| bottom_chords.split_whitespace().any(|other| id == other))
        {
            return Err("Overlapping chord ownership requires review".into());
        }
        if n.attr(b"abnormal") == "true" {
            m.set("abnormal", "true");
        }
        for field in n.elements() {
            let name = field.name();
            if name == b"voice" {
                let mut voice = field.clone();
                let id = voice
                    .attr(b"id")
                    .parse::<u32>()
                    .map_err(|_| "Invalid voice ID")?;
                voice.set(
                    "id",
                    &id.checked_add(offset)
                        .ok_or("Voice ID overflow")?
                        .to_string(),
                );
                m.children.push(Item::Node(voice));
            } else if [b"left-barline".as_slice(), b"mid-barline", b"right-barline"].contains(&name)
            {
                if let Some(current) = m.child_mut(name) {
                    bar_join(current, field)?;
                } else {
                    m.children.push(Item::Node(field.clone()));
                }
            } else if [
                b"clefs".as_slice(),
                b"keys",
                b"times",
                b"rehearsals",
                b"head-chords",
                b"rest-chords",
                b"flags",
                b"tuplets",
                b"augmentations-dots",
                b"similes",
                b"repeat-signs",
            ]
            .contains(&name)
            {
                if let Some(current) = m.child_mut(name) {
                    refs_join(current, field)?;
                } else {
                    m.children.push(Item::Node(field.clone()));
                }
            } else {
                return Err("Unsupported measure field during layout repair".into());
            }
        }
    }
    if lower.next().is_some() {
        return Err("Unaligned measure count in split staves".into());
    }
    let index = a
        .children
        .iter()
        .rposition(|c| matches!(c,Item::Node(n) if n.name()==b"staff"))
        .unwrap()
        + 1;
    a.children
        .insert(index, Item::Node(b.named(b"staff").next().unwrap().clone()));
    if let Some(other) = b.named(b"left-barline").next() {
        if let Some(current) = a.child_mut(b"left-barline") {
            bar_join(current, other)?;
        } else {
            a.children.insert(index + 1, Item::Node(other.clone()));
        }
    }
    if let Some(other) = b.named(b"slurs").next() {
        if let Some(current) = a.child_mut(b"slurs") {
            refs_join(current, other)?;
        } else {
            a.children.push(Item::Node(other.clone()));
        }
    }
    a.set("id", canonical);
    Ok(a)
}
#[derive(Default, Debug, Serialize)]
pub struct Report {
    pub systems_rejoined: usize,
    pub source_pages: Vec<u32>,
}

pub fn needs_repair(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let Ok(mut zip) = zip::ZipArchive::new(file) else {
        return false;
    };
    read_entry(&mut zip, "book.xml", 16 * 1024 * 1024)
        .and_then(|b| parse(&b))
        .map(|b| !plans(&b).is_empty())
        .unwrap_or(false)
}

fn repair_sheet(bytes: &[u8], plans: &[&Plan]) -> Result<Vec<u8>, String> {
    let mut reader = Reader::from_reader(bytes);
    let mut path = Vec::<Vec<u8>>::new();
    let mut page = String::new();
    let mut system = 0;
    let mut next_system = 0;
    let mut part_start = 0;
    let mut groups = BTreeMap::<(String, usize), Vec<(usize, usize)>>::new();
    loop {
        let start = reader.buffer_position() as usize;
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) => {
                if e.name().as_ref() == b"page" && path.last().is_some_and(|n| n == b"sheet") {
                    page = Node {
                        start: e.clone().into_owned(),
                        children: vec![],
                    }
                    .attr(b"id");
                    next_system = 0;
                }
                if e.name().as_ref() == b"system" && path.last().is_some_and(|n| n == b"page") {
                    system = next_system;
                    next_system += 1;
                }
                if e.name().as_ref() == b"part" && path.last().is_some_and(|n| n == b"system") {
                    part_start = start;
                }
                path.push(e.name().as_ref().to_vec());
            }
            Event::End(e) => {
                path.pop();
                if e.name().as_ref() == b"part"
                    && path.last().is_some_and(|n| n == b"system")
                    && plans.iter().any(|p| p.page == page && p.system == system)
                {
                    groups
                        .entry((page.clone(), system))
                        .or_default()
                        .push((part_start, reader.buffer_position() as usize));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let mut changes = Vec::new();
    for plan in plans {
        let spans = groups
            .get(&(plan.page.clone(), plan.system))
            .ok_or("Missing source system for layout repair")?;
        if spans.len() != 2
            || !bytes[spans[0].1..spans[1].0]
                .iter()
                .all(u8::is_ascii_whitespace)
        {
            return Err("Ambiguous split-part source layout".into());
        }
        let a = parse(&bytes[spans[0].0..spans[0].1])?;
        let b = parse(&bytes[spans[1].0..spans[1].1])?;
        if BTreeSet::from([a.attr(b"id"), b.attr(b"id")]) != plan.old {
            return Err("Source parts and book metadata disagree".into());
        }
        let merged = merge_part(a, b, &plan.canonical)?;
        changes.push((spans[0].0, spans[1].1, merged.bytes()?));
    }
    changes.sort_by_key(|c| c.0);
    let mut output = Vec::new();
    let mut cursor = 0;
    for (start, end, replacement) in changes {
        output.extend_from_slice(&bytes[cursor..start]);
        output.extend(replacement);
        cursor = end;
    }
    output.extend_from_slice(&bytes[cursor..]);
    Ok(output)
}

pub fn reconcile(path: &Path) -> Result<Report, String> {
    let mut zip = zip::ZipArchive::new(File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut book = parse(&read_entry(&mut zip, "book.xml", 16 * 1024 * 1024)?)?;
    let plans = plans(&book);
    if plans.is_empty() {
        return Ok(Report::default());
    }
    let mut edits = BTreeMap::new();
    for sheet in plans
        .iter()
        .map(|p| p.sheet.as_str())
        .collect::<BTreeSet<_>>()
    {
        let name = format!("sheet#{sheet}/sheet#{sheet}.xml");
        let bytes = read_entry(&mut zip, &name, 64 * 1024 * 1024)?;
        edits.insert(
            name,
            repair_sheet(
                &bytes,
                &plans
                    .iter()
                    .filter(|p| p.sheet == sheet)
                    .collect::<Vec<_>>(),
            )?,
        );
    }
    for plan in &plans {
        let sheet = book
            .elements_mut()
            .find(|n| n.name() == b"sheet" && n.attr(b"number") == plan.sheet)
            .ok_or("Missing book sheet")?;
        let page = sheet
            .elements_mut()
            .find(|n| n.name() == b"page" && n.attr(b"id") == plan.page)
            .ok_or("Missing book page")?;
        let system = page
            .elements_mut()
            .filter(|n| n.name() == b"system")
            .nth(plan.system)
            .ok_or("Missing book system")?;
        let mut parts: Vec<_> = system.named(b"part").cloned().collect();
        let lower = parts.pop().ok_or("Missing lower staff")?;
        let mut merged = parts.pop().ok_or("Missing upper staff")?;
        merged.children.extend(lower.children);
        merged.set("logical-id", &plan.canonical);
        system
            .children
            .retain(|c| !matches!(c,Item::Node(n) if n.name()==b"part"));
        system.children.push(Item::Node(merged));
    }
    for (i, score) in book
        .elements_mut()
        .filter(|n| n.name() == b"score")
        .enumerate()
    {
        let old: BTreeSet<_> = plans
            .iter()
            .filter(|p| p.score == i)
            .flat_map(|p| p.old.iter().cloned())
            .collect();
        score.children.retain(|c|!matches!(c,Item::Node(n) if n.name()==b"logical-part" && old.contains(&n.attr(b"id"))));
    }
    edits.insert("book.xml".into(), book.bytes()?);
    let temporary = path.with_extension("layout-tmp");
    let result = (|| {
        let mut output = zip::ZipWriter::new(File::create(&temporary).map_err(|e| e.to_string())?);
        for i in 0..zip.len() {
            let entry = zip.by_index(i).map_err(|e| e.to_string())?;
            if let Some(bytes) = edits.get(entry.name()) {
                output
                    .start_file(
                        entry.name(),
                        zip::write::SimpleFileOptions::default()
                            .compression_method(zip::CompressionMethod::Deflated)
                            .compression_level(Some(1)),
                    )
                    .map_err(|e| e.to_string())?;
                output.write_all(bytes).map_err(|e| e.to_string())?;
            } else {
                output.raw_copy_file(entry).map_err(|e| e.to_string())?;
            }
        }
        output
            .finish()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        drop(zip);
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(Report {
        systems_rejoined: plans.len(),
        source_pages: plans
            .iter()
            .filter_map(|p| p.sheet.parse().ok())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn book(layouts: &[&str]) -> Node {
        let mut systems = String::new();
        for layout in layouts {
            systems.push_str("<system>");
            for (id, count) in if *layout == "grand" {
                vec![("3", 2)]
            } else if *layout == "vocal" {
                vec![("1", 1), ("3", 2)]
            } else {
                vec![("1", 1), ("2", 1)]
            } {
                systems.push_str(&format!("<part logical-id=\"{id}\">"));
                for _ in 0..count {
                    systems.push_str("<staff-configuration line-count=\"5\"/>");
                }
                systems.push_str("</part>");
            }
            systems.push_str("</system>");
        }
        parse(format!("<book software-version=\"5.11.0\"><sheet number=\"1\"><page id=\"1\">{systems}</page></sheet><score><logical-part id=\"1\" staff-count=\"1\"/><logical-part id=\"2\" staff-count=\"1\"/><logical-part id=\"3\" staff-count=\"2\"/><page sheet-number=\"1\" sheet-page-id=\"1\"/></score></book>").as_bytes()).unwrap()
    }
    fn upper() -> Node {
        parse(br#"<part id="1"><staff id="5"><lines><line><point x="1" y="2"/></line></lines></staff><left-barline><staff-barlines>10</staff-barlines></left-barline><measure id="11"><right-barline><staff-barlines>20</staff-barlines></right-barline><head-chords>100 101</head-chords><flags>800</flags><voice id="1"><slots><entry><key>1</key><value chord="100" status="BEGIN"/></entry></slots></voice></measure><slurs>900</slurs></part>"#).unwrap()
    }
    fn lower() -> Node {
        parse(br#"<part id="2"><staff id="6"/><left-barline><staff-barlines>11</staff-barlines></left-barline><measure id="11" abnormal="true"><right-barline><staff-barlines>21</staff-barlines></right-barline><keys>700</keys><head-chords>102 103</head-chords><tuplets>801</tuplets><augmentations-dots>802</augmentations-dots><voice id="1"><slots><entry><key>1</key><value chord="102" status="BEGIN"/></entry></slots></voice></measure><slurs>901</slurs></part>"#).unwrap()
    }
    #[test]
    fn only_isolated_consensus_splits_are_repaired() {
        let mut layouts = vec!["grand"; 8];
        layouts[3] = "split";
        let plan = plans(&book(&layouts));
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].canonical, "3");
        assert_eq!(plan[0].system, 3);
        let mut named = book(&layouts);
        named
            .child_mut(b"score")
            .unwrap()
            .child_mut(b"logical-part")
            .unwrap()
            .set("name", "Singer");
        assert!(plans(&named).is_empty());
        assert!(plans(&book(&["split"; 8])).is_empty());
        layouts[5] = "vocal";
        assert!(plans(&book(&layouts)).is_empty());
        layouts[5] = "grand";
        layouts[0] = "split";
        assert!(plans(&book(&layouts)).is_empty());
        let mut small = vec!["grand"; 3];
        small[1] = "split";
        assert!(plans(&book(&small)).is_empty());
    }
    #[test]
    fn merge_preserves_both_staves_notation_and_voice_slot_references() {
        let merged = merge_part(upper(), lower(), "3").unwrap();
        assert_eq!(merged.attr(b"id"), "3");
        assert_eq!(
            merged
                .named(b"staff")
                .map(|s| s.attr(b"id"))
                .collect::<Vec<_>>(),
            ["5", "6"]
        );
        assert_eq!(
            merged.named(b"slurs").next().unwrap().text().unwrap(),
            "900 901"
        );
        assert_eq!(
            merged
                .named(b"left-barline")
                .next()
                .unwrap()
                .named(b"staff-barlines")
                .next()
                .unwrap()
                .text()
                .unwrap(),
            "10 11"
        );
        let measure = merged.named(b"measure").next().unwrap();
        assert_eq!(measure.attr(b"abnormal"), "true");
        assert_eq!(
            measure
                .named(b"head-chords")
                .next()
                .unwrap()
                .text()
                .unwrap(),
            "100 101 102 103"
        );
        assert_eq!(
            measure
                .named(b"voice")
                .map(|s| s.attr(b"id"))
                .collect::<Vec<_>>(),
            ["1", "5"]
        );
        let bytes = String::from_utf8(merged.bytes().unwrap()).unwrap();
        for reference in [
            "chord=\"100\"",
            "chord=\"102\"",
            "<keys>700</keys>",
            "<flags>800</flags>",
            "<tuplets>801</tuplets>",
            "<augmentations-dots>802</augmentations-dots>",
        ] {
            assert!(bytes.contains(reference), "{reference}");
        }
    }
    #[test]
    fn named_lyric_bearing_and_unaligned_parts_are_not_merged() {
        let mut named = lower();
        named.set("name", "77");
        assert!(merge_part(upper(), named, "3").is_err());
        let mut lyrics = lower();
        lyrics
            .children
            .push(Item::Node(parse(b"<lyric-lines>77</lyric-lines>").unwrap()));
        assert!(merge_part(upper(), lyrics, "3").is_err());
        let mut bad = lower();
        bad.child_mut(b"measure").unwrap().set("id", "12");
        assert!(merge_part(upper(), bad, "3").is_err());
    }
    #[test]
    fn archive_repair_is_atomic_idempotent_and_preserves_symbol_graph_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "sonora-layout-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("score.omr");
        let mut layouts = vec!["grand"; 8];
        layouts[3] = "split";
        let book = book(&layouts).bytes().unwrap();
        let graph=b"<sig><head id=\"100\" pitch=\"2\"/><head id=\"102\"/><relation source=\"100\" target=\"102\"><unknown-notation>retain &amp; preserve</unknown-notation></relation></sig>";
        let mut sheet = b"<sheet><page id=\"1\">".to_vec();
        for i in 0..8 {
            sheet.extend_from_slice(b"<system>");
            if i == 3 {
                sheet.extend(upper().bytes().unwrap());
                sheet.extend(lower().bytes().unwrap());
            } else {
                sheet.extend_from_slice(b"<part id=\"3\"><staff/><staff/></part>");
            }
            sheet.extend_from_slice(graph);
            sheet.extend_from_slice(b"</system>");
        }
        sheet.extend_from_slice(b"</page><glyph-index><unknown/></glyph-index></sheet>");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        for (name, bytes) in [
            ("book.xml", book.as_slice()),
            ("sheet#1/sheet#1.xml", sheet.as_slice()),
            ("sheet#1/GRAY.png", b"unchanged binary pixels".as_slice()),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        assert!(needs_repair(&path));
        let report = reconcile(&path).unwrap();
        assert_eq!(report.systems_rejoined, 1);
        assert_eq!(report.source_pages, [1]);
        assert!(!needs_repair(&path));
        assert_eq!(reconcile(&path).unwrap().systems_rejoined, 0);
        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let fixed = read_entry(&mut zip, "sheet#1/sheet#1.xml", 100000).unwrap();
        assert_eq!(
            fixed.windows(graph.len()).filter(|w| *w == graph).count(),
            8
        );
        assert_eq!(
            read_entry(&mut zip, "sheet#1/GRAY.png", 1000).unwrap(),
            b"unchanged binary pixels"
        );
        let book = parse(&read_entry(&mut zip, "book.xml", 100000).unwrap()).unwrap();
        assert_eq!(
            book.named(b"score")
                .next()
                .unwrap()
                .named(b"logical-part")
                .count(),
            1
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
