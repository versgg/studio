//! Readable text from a `project.current` snapshot. The engine's own `project.summary` is
//! used when it has one; this is the fallback for an engine that doesn't, and the short
//! lines tool results use to say which project is open.

use serde_json::Value;
use std::fmt::Write;

pub fn secs(us: f64) -> String {
    format!("{:.2} s", us / 1e6)
}

fn us(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// One line: which project is open.
pub fn headline(snapshot: &Value) -> String {
    let Some(p) = snapshot.get("project").filter(|p| p.is_object()) else { return "No project is open.".into() };
    let tracks = p.get("tracks").and_then(Value::as_array).map_or(0, Vec::len);
    let media = p.get("media").and_then(Value::as_array).map_or(0, Vec::len);
    format!(
        "Project \"{}\" ({}×{}, {}, {} media, {} tracks) at {}",
        str_of(p, "name"),
        us(p, "width"),
        us(p, "height"),
        secs(us(snapshot, "durationUs")),
        media,
        tracks,
        str_of(snapshot, "dir")
    )
}

/// The value a clip setting has when nobody touched it, for the ones that aren't empty.
fn default_of(key: &str) -> Option<Value> {
    Some(match key {
        "volume" | "speed" => Value::from(1.0),
        "scale" | "opacity" => Value::from(100.0),
        "fit" => Value::from("fill"),
        "blend" => Value::from("normal"),
        "transformOn" | "keepPitch" => Value::from(true),
        _ => return None,
    })
}

fn is_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
    }
}

fn same(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => (x - y).abs() < 1e-9,
        _ => a == b,
    }
}

fn short(v: &Value) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.as_f64().map(|f| if f.fract() == 0.0 { format!("{f:.0}") } else { format!("{:.3}", f).trim_end_matches('0').trim_end_matches('.').to_string() }).unwrap_or_default(),
        other => other.to_string(),
    };
    if s.chars().count() > 120 { format!("{}…", s.chars().take(120).collect::<String>()) } else { s }
}

/// The settings on a clip that differ from a fresh clip's.
pub fn clip_settings(clip: &Value) -> Vec<String> {
    let skip = ["id", "mediaId", "startUs", "inUs", "durationUs", "text", "caption", "link", "png", "maskPng"];
    let mut out = vec![];
    let Some(map) = clip.as_object() else { return out };
    for (k, v) in map {
        if skip.contains(&k.as_str()) {
            continue;
        }
        let changed = match default_of(k) {
            Some(d) => !same(v, &d),
            None => !is_empty(v),
        };
        if !changed {
            continue;
        }
        let shown = match (k.as_str(), v) {
            ("keyframes", Value::Object(m)) => format!("keyframes on {}", m.keys().cloned().collect::<Vec<_>>().join(", ")),
            ("effects", Value::Array(list)) => format!("effects {}", list.iter().map(|e| format!("{} {}", str_of(e, "name"), short(e.get("amount").unwrap_or(&Value::Null)))).collect::<Vec<_>>().join(", ")),
            ("transition", t) if t.is_object() => format!("transition in: {} {}", str_of(t, "name"), secs(us(t, "durationUs"))),
            (k, v) if k.ends_with("Us") => format!("{k} {}", secs(v.as_f64().unwrap_or(0.0))),
            (k, v) => format!("{k} {}", short(v)),
        };
        out.push(shown);
    }
    out
}

/// The whole timeline as lines, with every id an edit needs.
pub fn render(snapshot: &Value) -> String {
    let Some(p) = snapshot.get("project").filter(|p| p.is_object()) else {
        return "No project is open. Open one with project_open_latest, project_open or project_new.".into();
    };
    let mut o = String::new();
    let _ = writeln!(o, "\"{}\": {}×{} at {} fps, {} long. Folder: {}", str_of(p, "name"), us(p, "width"), us(p, "height"), us(p, "fps"), secs(us(snapshot, "durationUs")), str_of(snapshot, "dir"));
    let onoff = |b: bool| if b { "on" } else { "off" };
    let _ = writeln!(
        o,
        "Main track magnet {}, linkage {}. Undo {}, redo {}.",
        onoff(p.get("magnet").and_then(Value::as_bool).unwrap_or(true)),
        onoff(p.get("linkage").and_then(Value::as_bool).unwrap_or(true)),
        if snapshot.get("canUndo").and_then(Value::as_bool).unwrap_or(false) { "available" } else { "empty" },
        if snapshot.get("canRedo").and_then(Value::as_bool).unwrap_or(false) { "available" } else { "empty" },
    );
    if let Some(m) = p.get("master").filter(|m| m.is_object()) {
        let _ = writeln!(
            o,
            "Master: normalise {} to {} LUFS, limiter {} at {} dB, gain {} dB.",
            onoff(m.get("normalize").and_then(Value::as_bool).unwrap_or(false)),
            short(m.get("targetLufs").unwrap_or(&Value::Null)),
            onoff(m.get("limiter").and_then(Value::as_bool).unwrap_or(false)),
            short(m.get("ceilingDb").unwrap_or(&Value::Null)),
            short(m.get("gainDb").unwrap_or(&Value::Null)),
        );
    }
    if let Some(mcp) = p.get("mcp").filter(|m| m.is_object()) {
        let _ = writeln!(o, "Claude may: {} (ask before export: {}).", str_of(mcp, "allowed"), mcp.get("askBeforeExport").and_then(Value::as_bool).unwrap_or(true));
    }

    let media: Vec<&Value> = p.get("media").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    let name_of = |id: &str| media.iter().find(|m| str_of(m, "id") == id).map(|m| str_of(m, "name").to_string());

    let tracks = p.get("tracks").and_then(Value::as_array).cloned().unwrap_or_default();
    let _ = writeln!(o, "\nTracks ({}; later tracks draw on top):", tracks.len());
    for t in &tracks {
        let mut kind = str_of(t, "kind").to_string();
        if t.get("main").and_then(Value::as_bool) == Some(true) {
            kind = format!("main {kind}");
        }
        let role = str_of(t, "role");
        if !role.is_empty() {
            kind = format!("{kind}, {role}");
        }
        let mut extras = vec![];
        for (k, label) in [("gainDb", "gain dB"), ("pan", "pan")] {
            if let Some(v) = t.get(k).filter(|v| !is_empty(v)) {
                extras.push(format!("{label} {}", short(v)));
            }
        }
        for k in ["mute", "solo", "locked"] {
            if t.get(k).and_then(Value::as_bool) == Some(true) {
                extras.push(k.to_string());
            }
        }
        let clips = t.get("clips").and_then(Value::as_array).cloned().unwrap_or_default();
        let _ = writeln!(o, "- {} [{}] {} clip{}{}", str_of(t, "id"), kind, clips.len(), if clips.len() == 1 { "" } else { "s" }, if extras.is_empty() { String::new() } else { format!("; {}", extras.join(", ")) });
        for c in &clips {
            let start = us(c, "startUs");
            let end = start + us(c, "durationUs");
            let what = if let Some(text) = c.get("text").filter(|t| t.is_object()) {
                let drawn = if text.get("png").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) { "" } else { " (not drawn yet)" };
                let cap = if c.get("caption").and_then(Value::as_bool) == Some(true) { "caption" } else { "text" };
                format!("{cap} \"{}\"{drawn}", short(text.get("content").unwrap_or(&Value::Null)))
            } else {
                let id = str_of(c, "mediaId");
                if id.is_empty() { "adjustment layer".to_string() } else { format!("\"{}\" ({id})", name_of(id).unwrap_or_else(|| "?".into())) }
            };
            let settings = clip_settings(c);
            let _ = writeln!(
                o,
                "  - {} {} {}–{}, from {} in the source{}",
                str_of(c, "id"),
                what,
                secs(start),
                secs(end),
                secs(us(c, "inUs")),
                if settings.is_empty() { String::new() } else { format!("; {}", settings.join(", ")) }
            );
        }
    }

    if let Some(labels) = p.get("labels").and_then(Value::as_array).filter(|l| !l.is_empty()) {
        let _ = writeln!(o, "\nLabels:");
        for l in labels {
            let _ = writeln!(o, "- {} \"{}\" {}–{}", str_of(l, "id"), str_of(l, "text"), secs(us(l, "startUs")), secs(us(l, "endUs")));
        }
    }

    let _ = writeln!(o, "\nMedia ({}):", media.len());
    for m in media.iter().take(100) {
        let _ = writeln!(o, "- {}", media_line(m));
    }
    if media.len() > 100 {
        let _ = writeln!(o, "- … and {} more (media_list shows them all)", media.len() - 100);
    }
    if let Some(busy) = snapshot.get("processing").and_then(Value::as_array).filter(|a| !a.is_empty()) {
        let _ = writeln!(o, "\nStill making thumbnails/proxies for: {}", busy.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "));
    }
    o
}

pub fn media_line(m: &Value) -> String {
    let kind = str_of(m, "kind");
    let mut parts = vec![format!("{} {} \"{}\"", str_of(m, "id"), kind, str_of(m, "name"))];
    if kind != "image" {
        parts.push(secs(us(m, "durationUs")));
    }
    if us(m, "width") > 0.0 {
        parts.push(format!("{}×{}", us(m, "width"), us(m, "height")));
    }
    if us(m, "fps") > 0.0 && kind == "video" {
        parts.push(format!("{:.3} fps", us(m, "fps")).replace(".000", ""));
    }
    if m.get("hasAudio").and_then(Value::as_bool) == Some(true) {
        parts.push("sound".into());
    }
    if m.get("missing").and_then(Value::as_bool) == Some(true) {
        parts.push("MISSING".into());
    }
    if m.get("parts").is_some_and(|p| p.is_array()) {
        parts.push("compound".into());
    }
    format!("{} — {}", parts.join(", "), str_of(m, "path"))
}

/// `history.list` as lines: index, label, who, when; undone steps marked.
pub fn history(result: &Value) -> String {
    let current = result.get("current").and_then(Value::as_i64).unwrap_or(-1);
    let steps = result.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
    if steps.is_empty() {
        return "No edits yet.".into();
    }
    let mut o = String::new();
    for s in &steps {
        let i = s.get("index").and_then(Value::as_i64).unwrap_or(0);
        let actor = str_of(s, "actor");
        let who = if actor == "you" { "you".to_string() } else { format!("{actor} (Claude · MCP)") };
        let mark = if i == current { "  ← current" } else if i > current { "  (undone)" } else { "" };
        let _ = writeln!(o, "{i}. {} — {who} — {}{mark}", str_of(s, "label"), str_of(s, "time"));
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snap() -> Value {
        json!({
            "revision": 4, "dir": "C:/P/Ad.studio", "canUndo": true, "canRedo": false, "durationUs": 8_000_000, "processing": ["m2"],
            "project": {
                "name": "Ad", "width": 1080, "height": 1920, "fps": 30, "magnet": true, "linkage": true,
                "master": { "normalize": true, "targetLufs": -14.0, "limiter": true, "ceilingDb": -1.0, "gainDb": 0.0 },
                "mcp": { "allowed": "edit", "askBeforeExport": true },
                "media": [
                    { "id": "m1", "name": "clip.mp4", "path": "C:/m/clip.mp4", "kind": "video", "durationUs": 4_000_000, "width": 720, "height": 1280, "fps": 30.0, "hasAudio": true },
                    { "id": "m2", "name": "vo.wav", "path": "C:/m/vo.wav", "kind": "audio", "durationUs": 6_000_000, "width": 0, "height": 0, "fps": 0.0, "hasAudio": true }
                ],
                "tracks": [
                    { "id": "t1", "kind": "video", "main": true, "clips": [
                        { "id": "c1", "mediaId": "m1", "startUs": 0, "inUs": 0, "durationUs": 4_000_000, "volume": 1.0, "fit": "fill", "scale": 120.0, "posX": 0.0, "opacity": 100.0, "speed": 1.0, "reverse": false, "keyframes": {} },
                        { "id": "c2", "mediaId": "m1", "startUs": 4_000_000, "inUs": 1_000_000, "durationUs": 4_000_000, "volume": 1.0, "scale": 100.0, "speed": 2.0, "keyframes": { "scale": [{ "atUs": 0, "value": 100 }] }, "transition": { "name": "Dissolve", "durationUs": 500_000 } }
                    ] },
                    { "id": "t2", "kind": "video", "role": "text", "clips": [
                        { "id": "c3", "mediaId": "", "startUs": 0, "inUs": 0, "durationUs": 3_000_000, "text": { "content": "Hej!", "png": "" } }
                    ] },
                    { "id": "t3", "kind": "audio", "role": "voice", "gainDb": -6.0, "mute": true, "clips": [
                        { "id": "c4", "mediaId": "m2", "startUs": 500_000, "inUs": 0, "durationUs": 6_000_000, "volume": 0.8, "fadeInUs": 300_000 }
                    ] }
                ],
                "labels": [{ "id": "l1", "startUs": 0, "endUs": 1_000_000, "text": "Hook" }]
            }
        })
    }

    #[test]
    fn summary_has_ids_times_and_changed_settings() {
        let text = render(&snap());
        for needle in [
            "\"Ad\": 1080×1920 at 30 fps, 8.00 s long",
            "t1 [main video] 2 clips",
            "c1 \"clip.mp4\" (m1) 0.00 s–4.00 s",
            "scale 120",
            "speed 2",
            "keyframes on scale",
            "transition in: Dissolve 0.50 s",
            "c3 text \"Hej!\" (not drawn yet)",
            "t3 [audio, voice] 1 clip; gain dB -6, mute",
            "volume 0.8",
            "fadeInUs 0.30 s",
            "l1 \"Hook\"",
            "m2 audio \"vo.wav\", 6.00 s, sound",
            "Claude may: edit",
            "Still making thumbnails/proxies for: m2",
        ] {
            assert!(text.contains(needle), "missing {needle:?} in:\n{text}");
        }
        // Untouched settings stay out of it.
        assert!(!text.contains("opacity"), "{text}");
        assert!(!text.contains("posX"), "{text}");
        assert!(!text.contains("reverse"), "{text}");
    }

    #[test]
    fn no_project() {
        assert!(render(&Value::Null).contains("No project is open"));
        assert_eq!(headline(&Value::Null), "No project is open.");
    }

    #[test]
    fn headline_line() {
        assert_eq!(headline(&snap()), "Project \"Ad\" (1080×1920, 8.00 s, 2 media, 3 tracks) at C:/P/Ad.studio");
    }

    #[test]
    fn history_lines_name_claude() {
        let text = history(&json!({ "current": 1, "steps": [
            { "index": 0, "label": "Import 1 file", "actor": "you", "time": "T0" },
            { "index": 1, "label": "Split", "actor": "claude", "time": "T1" },
            { "index": 2, "label": "Delete", "actor": "claude", "time": "T2" }
        ] }));
        assert!(text.contains("0. Import 1 file — you — T0"));
        assert!(text.contains("1. Split — claude (Claude · MCP) — T1  ← current"));
        assert!(text.contains("2. Delete — claude (Claude · MCP) — T2  (undone)"));
    }
}
