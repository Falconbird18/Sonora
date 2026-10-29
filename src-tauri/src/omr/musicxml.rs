//! Read-only structural review. Never repair or reserialize the engine's MusicXML:
//! layout, voices, lyrics and notation that we do not understand must survive intact.
use quick_xml::{events::Event, Reader};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Review {
    pub parts: usize,
    pub measures: usize,
    pub notes: usize,
    pub rests: usize,
    pub lyrics: usize,
    pub articulations: usize,
    pub dynamics: usize,
    pub slurs: usize,
    pub ties: usize,
    pub warnings: Vec<String>,
}

impl Review {
    fn warn(&mut self, message: String) {
        if self.warnings.len() < 200 {
            self.warnings.push(message);
        }
    }
}

#[derive(Default)]
struct Note {
    duration: Option<f64>,
    chord: bool,
    grace: bool,
    rest: bool,
    unpitched: bool,
    step: String,
    octave: Option<i32>,
}

fn attribute(event: &quick_xml::events::BytesStart<'_>, key: &[u8]) -> String {
    event
        .attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        .map(|a| String::from_utf8_lossy(&a.value).into_owned())
        .unwrap_or_default()
}

/// Durations are compared in quarter notes, independently of printed note types.
/// This respects tuplets, chords, grace notes, backup/forward and division changes.
pub fn inspect(xml: &[u8]) -> Result<Review, String> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    reader.config_mut().expand_empty_elements = true;
    let mut review = Review::default();
    let mut stack: Vec<String> = Vec::new();
    let mut text = String::new();
    let mut root = false;
    let mut part = String::new();
    let mut measure = String::new();
    let mut divisions = 1.0;
    let mut expected: Option<f64> = None;
    let mut time_sum = 0.0;
    let mut beats: Option<f64> = None;
    let mut cursor: f64 = 0.0;
    let mut extent: f64 = 0.0;
    let mut onset: f64 = 0.0;
    let mut implicit = false;
    let mut note = Note::default();
    let mut events = 0usize;
    loop {
        let event = reader
            .read_event()
            .map_err(|e| format!("Malformed MusicXML: {e}"))?;
        events += 1;
        if events > 5_000_000 {
            return Err("MusicXML exceeds the review size limit".into());
        }
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let tag = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                if stack.is_empty() {
                    if root || tag != "score-partwise" {
                        return Err("Expected one score-partwise MusicXML document".into());
                    }
                    root = true;
                }
                let parent = stack.last().map(String::as_str).unwrap_or("");
                match tag.as_str() {
                    "part" if parent == "score-partwise" => {
                        part = attribute(e, b"id");
                        divisions = 1.0;
                        expected = None;
                        review.parts += 1;
                    }
                    "measure" if parent == "part" => {
                        measure = attribute(e, b"number");
                        implicit = attribute(e, b"implicit") == "yes";
                        cursor = 0.0;
                        extent = 0.0;
                        onset = 0.0;
                        review.measures += 1;
                    }
                    "time" => {
                        time_sum = 0.0;
                        beats = None;
                    }
                    "note" => note = Note::default(),
                    "chord" if parent == "note" => note.chord = true,
                    "grace" if parent == "note" => note.grace = true,
                    "rest" if parent == "note" => note.rest = true,
                    "unpitched" if parent == "note" => note.unpitched = true,
                    "lyric" => review.lyrics += 1,
                    "slur" if attribute(e, b"type") == "start" => review.slurs += 1,
                    "tie" if attribute(e, b"type") == "start" => review.ties += 1,
                    _ if parent == "articulations" => review.articulations += 1,
                    _ if parent == "dynamics" => review.dynamics += 1,
                    _ => {}
                }
                text.clear();
                if matches!(event, Event::Start(_)) {
                    stack.push(tag);
                    if stack.len() > 256 {
                        return Err("MusicXML nesting exceeds limit".into());
                    }
                }
            }
            Event::Text(e) => text.push_str(&e.decode().map_err(|e| e.to_string())?),
            Event::End(e) => {
                let tag = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                if stack.pop().as_deref() != Some(tag.as_str()) {
                    return Err("Unbalanced MusicXML elements".into());
                }
                let parent = stack.last().map(String::as_str).unwrap_or("");
                let location = || format!("Part {part}, measure {measure}");
                match tag.as_str() {
                    "divisions" => {
                        let value = text
                            .parse::<f64>()
                            .ok()
                            .filter(|v| v.is_finite() && *v > 0.0);
                        if let Some(value) = value {
                            divisions = value;
                        } else {
                            review.warn(format!("{}: invalid divisions", location()));
                        }
                    }
                    "beats" => beats = text.split('+').map(|b| b.trim().parse::<f64>().ok()).sum(),
                    "beat-type" => {
                        if let (Some(b), Ok(unit)) = (beats.take(), text.parse::<f64>()) {
                            if unit > 0.0 && unit.is_finite() && b.is_finite() {
                                time_sum += b * 4.0 / unit;
                            }
                        }
                    }
                    "time" => expected = (time_sum > 0.0).then_some(time_sum),
                    "step" if parent == "pitch" => note.step = text.clone(),
                    "octave" if parent == "pitch" => note.octave = text.parse().ok(),
                    "duration" => {
                        let duration = text
                            .parse::<f64>()
                            .ok()
                            .filter(|v| v.is_finite() && *v >= 0.0);
                        if parent == "note" {
                            note.duration = duration;
                        } else if let Some(duration) = duration {
                            if parent == "backup" {
                                cursor -= duration / divisions;
                            } else if parent == "forward" {
                                cursor += duration / divisions;
                                extent = extent.max(cursor);
                            }
                            if cursor < -1e-6 {
                                review.warn(format!(
                                    "{}: voice backup precedes the measure",
                                    location()
                                ));
                            }
                        } else {
                            review.warn(format!("{}: invalid duration", location()));
                        }
                    }
                    "note" => {
                        if note.rest {
                            review.rests += 1;
                        } else {
                            review.notes += 1;
                            if !note.unpitched
                                && (!matches!(
                                    note.step.as_str(),
                                    "A" | "B" | "C" | "D" | "E" | "F" | "G"
                                ) || !note.octave.is_some_and(|o| (0..=9).contains(&o)))
                            {
                                review.warn(format!("{}: a note has no valid pitch", location()));
                            }
                        }
                        if !note.grace {
                            if let Some(duration) = note.duration.filter(|d| *d > 0.0) {
                                if !note.chord {
                                    onset = cursor;
                                    cursor += duration / divisions;
                                }
                                extent = extent.max(onset + duration / divisions);
                            } else {
                                review.warn(format!(
                                    "{}: a note or rest has no positive duration",
                                    location()
                                ));
                            }
                        }
                    }
                    "measure" => {
                        if let Some(length) = expected {
                            if extent > length + 1e-6
                                || (!implicit && extent > 0.0 && extent < length - 1e-6)
                            {
                                review.warn(format!("{}: duration {extent:.3} quarter notes, time signature expects {length:.3}; check voices, rests or pickup", location()));
                            }
                        }
                    }
                    _ => {}
                }
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root || !stack.is_empty() || review.parts == 0 || review.measures == 0 {
        return Err("MusicXML contains no complete score parts and measures".into());
    }
    if review.notes == 0 {
        review.warn("No pitched or unpitched notes were exported".into());
    }
    Ok(review)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn score(body: &str) -> String {
        format!(
            r#"<?xml version="1.0"?><!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd"><score-partwise><part-list/><part id="P1">{body}</part></score-partwise>"#
        )
    }
    #[test]
    fn polyphony_chords_tuplets_and_grace_do_not_inflate_time() {
        let xml = score(
            r#"<measure number="1"><attributes><divisions>3</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><grace/><pitch><step>D</step><octave>4</octave></pitch></note><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><notations><slur type="start"/><articulations><staccato/></articulations></notations><lyric><text>Ah</text></lyric></note><note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration></note><note><rest/><duration>4</duration></note><backup><duration>6</duration></backup><note><pitch><step>C</step><octave>3</octave></pitch><duration>6</duration><tie type="start"/></note><direction><direction-type><dynamics><pp/></dynamics></direction-type></direction></measure>"#,
        );
        let r = inspect(xml.as_bytes()).unwrap();
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        assert_eq!(
            (
                r.notes,
                r.rests,
                r.lyrics,
                r.slurs,
                r.ties,
                r.articulations,
                r.dynamics
            ),
            (4, 1, 1, 1, 1, 1, 1)
        );
    }
    #[test]
    fn catches_malformed_and_incomplete_exports() {
        for xml in [
            "",
            "<score-partwise>",
            "<score-partwise></wrong>",
            "<html/>",
            "<score-partwise/>",
        ] {
            assert!(inspect(xml.as_bytes()).is_err(), "{xml}");
        }
        let r = inspect(
            score("<measure number=\"2\"><note><duration>1</duration></note></measure>").as_bytes(),
        )
        .unwrap();
        assert!(r.warnings.iter().any(|w| w.contains("pitch")));
    }
    #[test]
    fn checks_inherited_meter_and_division_changes_but_allows_pickups() {
        let r = inspect(score(r#"<measure number="0" implicit="yes"><attributes><divisions>1</divisions><time><beats>3+2</beats><beat-type>8</beat-type></time></attributes><note><rest/><duration>1</duration></note></measure><measure number="1"><attributes><divisions>2</divisions></attributes><note><rest/><duration>5</duration></note></measure><measure number="2"><forward><duration>6</duration></forward></measure>"#).as_bytes()).unwrap();
        assert_eq!(r.warnings.len(), 2); // overfull measure and no notes
        assert!(r.warnings[0].contains("measure 2"));
    }
}
