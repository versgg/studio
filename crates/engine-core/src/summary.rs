//! The timeline as readable lines (`project.summary`), so an MCP client can see what's there:
//! tracks, clips with names and times, their settings, text and captions.

use crate::model::{Clip, Fit, MediaKind, Project, TrackKind, Us};

fn secs(us: Us) -> String {
    format!("{:.2}", us as f64 / 1e6)
}

/// A value without trailing zeros: 2.0 → "2", 1.25 → "1.25".
fn num(x: f64) -> String {
    let s = format!("{x:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

impl Project {
    pub fn summary(&self) -> String {
        let aspect = ["9:16", "4:5", "1:1", "16:9"].into_iter().find(|a| crate::model::format_size(a) == Some((self.width, self.height))).unwrap_or("custom");
        let mut out = vec![format!(
            "\"{}\": {}×{} ({aspect}), {} fps, {} s long. Main track magnet {}.",
            self.name,
            self.width,
            self.height,
            self.fps,
            secs(self.duration_us()),
            if self.magnet { "on" } else { "off" }
        )];
        if !self.brand.colors.is_empty() || !self.brand.fonts.is_empty() {
            out.push(format!("Brand: colours {}; fonts {}.", self.brand.colors.join(", "), self.brand.fonts.join(", ")));
        }
        out.push("Tracks, from the bottom of the picture to the top, then sound:".into());
        let mut order: Vec<usize> = (0..self.tracks.len()).filter(|&i| self.tracks[i].kind == TrackKind::Video).collect();
        order.sort_by_key(|&i| !self.tracks[i].main);
        order.extend((0..self.tracks.len()).filter(|&i| self.tracks[i].kind == TrackKind::Audio));
        for i in order {
            let t = &self.tracks[i];
            let what = if t.main {
                "Main track".to_string()
            } else if t.kind == TrackKind::Video {
                format!("{} track", if t.role.is_empty() { "Picture".to_string() } else { capital(&t.role) })
            } else {
                format!("Audio track{}", if t.role.is_empty() { String::new() } else { format!(" ({})", t.role) })
            };
            let mut flags = vec![];
            for (on, name) in [(t.locked, "locked"), (t.hidden, "hidden"), (t.mute, "muted"), (t.solo, "solo")] {
                if on {
                    flags.push(name.to_string());
                }
            }
            if t.gain_db != 0.0 {
                flags.push(format!("fader {} dB", num(t.gain_db as f64)));
            }
            if t.effects.count_on() > 0 {
                flags.push(format!("{} sound effects on", t.effects.count_on()));
            }
            let flags = if flags.is_empty() { String::new() } else { format!(", {}", flags.join(", ")) };
            out.push(format!("{what} {} ({} clip{}{flags}):", t.id, t.clips.len(), if t.clips.len() == 1 { "" } else { "s" }));
            for c in &t.clips {
                out.push(format!("  {}", self.clip_line(c)));
            }
        }
        if !self.labels.is_empty() {
            out.push("Labels and markers:".into());
            for l in &self.labels {
                out.push(if l.start_us == l.end_us { format!("  marker \"{}\" at {} s", l.text, secs(l.start_us)) } else { format!("  \"{}\" {}–{} s", l.text, secs(l.start_us), secs(l.end_us)) });
            }
        }
        let m = &self.master;
        out.push(format!(
            "Master: {}{}{}.",
            if m.normalize { format!("levelled to {} LUFS on export", num(m.target_lufs as f64)) } else { "not levelled".into() },
            if m.limiter { format!(", peaks under {} dBTP", num(m.ceiling_db as f64)) } else { String::new() },
            if m.gain_db != 0.0 { format!(", mix gain {} dB", num(m.gain_db as f64)) } else { String::new() }
        ));
        out.join("\n")
    }

    /// One clip: id, what it shows, where it sits, and every setting away from its default.
    fn clip_line(&self, c: &Clip) -> String {
        let media = self.media(&c.media_id);
        let name = match (&c.text, media) {
            (Some(t), _) => format!("{} \"{}\"", if c.caption { "caption" } else { "text" }, t.get("content").and_then(|v| v.as_str()).unwrap_or("")),
            (None, Some(m)) => format!("\"{}\" ({})", m.name, match m.kind {
                MediaKind::Video => "video",
                MediaKind::Audio => "audio",
                MediaKind::Image => "image",
            }),
            (None, None) if c.is_synthetic() => "adjustment layer".to_string(),
            (None, None) => "missing media".to_string(),
        };
        let mut s = vec![format!("{} {name} {}–{} s", c.id, secs(c.start_us), secs(c.end_us()))];
        when(&mut s, c.busy.is_some(), "busy: text is being removed in the app, so it can't be changed until that's done".into());
        if media.is_some_and(|m| m.kind != MediaKind::Image) {
            s.push(format!("source {}–{} s", secs(c.in_us), secs(c.in_us + c.span_us())));
        }
        if let Some(r) = &c.speed_curve {
            s.push(format!("speed ramp \"{}\" (mean {}×)", r.name, num(c.speed)));
        } else if c.speed != 1.0 {
            s.push(format!("speed {}×", num(c.speed)));
        }
        when(&mut s, c.reverse, "reversed".into());
        when(&mut s, !c.keep_pitch, "pitch follows speed".into());
        when(&mut s, c.volume != 1.0, format!("volume {}%", num(c.volume as f64 * 100.0)));
        when(&mut s, c.detached, "sound extracted".into());
        when(&mut s, c.fit == Fit::Fit, "fit (bars)".into());
        when(&mut s, c.crop.is_some(), "cropped".into());
        when(&mut s, c.flip, "mirrored".into());
        when(&mut s, c.flip_v, "flipped upside down".into());
        when(&mut s, c.rotate != 0, format!("turned {}°", c.rotate));
        when(&mut s, !c.transform_on, "transform off".into());
        when(&mut s, c.scale != 100.0, format!("scale {}%", num(c.scale as f64)));
        when(&mut s, c.pos_x != 0.0 || c.pos_y != 0.0, format!("position {}, {} px", num(c.pos_x as f64), num(c.pos_y as f64)));
        when(&mut s, c.rotation != 0.0, format!("rotation {}°", num(c.rotation as f64)));
        when(&mut s, c.opacity != 100.0, format!("opacity {}%", num(c.opacity as f64)));
        for (name, v) in [("temperature", c.temperature), ("tint", c.tint), ("saturation", c.saturation), ("brightness", c.brightness), ("contrast", c.contrast), ("highlights", c.highlights), ("shadows", c.shadows), ("sharpen", c.sharpen), ("vignette", c.vignette)] {
            when(&mut s, v != 0.0, format!("{name} {}", num(v as f64)));
        }
        when(&mut s, !c.hsl.is_empty(), format!("HSL {}", c.hsl.iter().map(|(k, v)| format!("{k} h{} s{} l{}", num(v.h as f64), num(v.s as f64), num(v.l as f64))).collect::<Vec<_>>().join(", ")));
        let curves: Vec<&str> = [("master", &c.curves.master), ("red", &c.curves.red), ("green", &c.curves.green), ("blue", &c.curves.blue)].into_iter().filter(|(_, p)| p.is_some()).map(|(n, _)| n).collect();
        when(&mut s, !curves.is_empty(), format!("curves ({})", curves.join(", ")));
        let wheels: Vec<&str> = [("lift", c.wheels.lift), ("gamma", c.wheels.gamma), ("gain", c.wheels.gain)].into_iter().filter(|(_, w)| w.is_some()).map(|(n, _)| n).collect();
        when(&mut s, !wheels.is_empty(), format!("colour wheels ({})", wheels.join(", ")));
        if let Some(l) = &c.lut {
            s.push(format!("LUT {} at {}%", l.path.rsplit(['/', '\\']).next().unwrap_or(&l.path), num(l.strength as f64)));
        }
        when(&mut s, !c.effects.is_empty(), format!("effects {}", c.effects.iter().map(|f| format!("{} {}", f.name, num(f.amount as f64))).collect::<Vec<_>>().join(", ")));
        when(&mut s, c.blend != "normal", format!("blend {}", c.blend));
        if let Some(t) = &c.transition {
            s.push(format!("transition in: {} {} s", t.name, secs(t.duration_us)));
        }
        if let Some(a) = &c.anim.in_ {
            s.push(format!("animation in: {} {} s", a.name, secs(a.duration_us)));
        }
        if let Some(a) = &c.anim.out {
            s.push(format!("animation out: {} {} s", a.name, secs(a.duration_us)));
        }
        if let Some(l) = &c.anim.loop_ {
            s.push(format!("loop: {} every {} s", l.name, secs(l.period_us)));
        }
        if let Some(m) = &c.mask {
            s.push(format!("mask {}{}", m.shape, if m.invert { " (inverted)" } else { "" }));
        }
        when(&mut s, c.matte.is_some(), "background removed".into());
        if let Some(st) = &c.stabilize {
            s.push(format!("stabilised {}%", num(st.strength as f64)));
        }
        if let Some(sm) = &c.smooth {
            s.push(format!("smooth slow motion ({})", sm.quality));
        }
        when(&mut s, c.fade_in_us > 0, format!("fade in {} s", secs(c.fade_in_us)));
        when(&mut s, c.fade_out_us > 0, format!("fade out {} s", secs(c.fade_out_us)));
        when(&mut s, c.pitch != 0.0, format!("pitch {} semitones", num(c.pitch as f64)));
        when(&mut s, !c.envelope.is_empty(), format!("volume envelope ({} points)", c.envelope.len()));
        when(&mut s, !c.spectral.is_empty(), format!("{} spectral edit{}", c.spectral.len(), if c.spectral.len() == 1 { "" } else { "s" }));
        when(&mut s, !c.keyframes.is_empty(), format!("keyframes on {}", c.keyframes.keys().cloned().collect::<Vec<_>>().join(", ")));
        s.join(" · ")
    }
}

/// Adds `text` when `cond` holds.
fn when(s: &mut Vec<String>, cond: bool, text: String) {
    if cond {
        s.push(text);
    }
}

fn capital(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use crate::model::*;

    #[test]
    fn summary_lists_tracks_clips_settings_and_text() {
        let mut p = Project::new("Promo", "9:16");
        p.media.push(Media { id: "m1".into(), path: "a.mp4".into(), name: "a.mp4".into(), kind: MediaKind::Video, duration_us: 4 * SECOND, width: 1080, height: 1920, fps: 30.0, has_audio: true, ..Default::default() });
        let a = p.insert("m1", 0).unwrap();
        p.set_clip(&a, ClipChange { speed: Some(2.0), brightness: Some(20.0), effects: Some(vec![Fx { name: "Blur".into(), amount: 40.0 }]), ..Default::default() }).unwrap();
        let mut t = TextSpec::new();
        t.insert("content".into(), "Free shipping".into());
        p.add_overlay(None, Some(t), SECOND, None, "text", None).unwrap();
        let s = p.summary();
        assert!(s.starts_with("\"Promo\": 1080×1920 (9:16), 30 fps, 4.00 s long."), "{s}");
        assert!(s.contains("\"a.mp4\" (video) 0.00–2.00 s · source 0.00–4.00 s · speed 2× · brightness 20 · effects Blur 40"), "{s}");
        assert!(s.contains("Text track") && s.contains("text \"Free shipping\" 1.00–4.00 s"), "{s}");
        assert!(s.find("Main track").unwrap() < s.find("Text track").unwrap());
    }
}
