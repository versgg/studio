//! Contract v2's edits beyond clip settings: overlay, text and adjustment clips on picture
//! tracks of their own, captions, transitions on the main track, and the Audio page's
//! crossfade, spectral delete and drawn samples.

use crate::look::{Spectral, TextSpec, Transition, VISUAL_ROLES, xfade_name};
use crate::model::{Clip, EditError, IMAGE_DEFAULT, Lane, MIN_CLIP, Media, MediaKind, PasteItem, Project, R, TrackKind, Us, err};
use serde::Deserialize;
use serde_json::Value;

/// One caption line as `captions.set` sends it: its time, words and the renderer's drawing.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionLine {
    pub start_us: Us,
    pub end_us: Us,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub png: Option<String>,
    /// Each word with its time from the line's start (`[{ w, s, e }]`), kept with the line so it
    /// can be split, joined or re-split later without hearing the sound again.
    #[serde(default)]
    pub words: Option<Value>,
    /// Where the line sits on the picture (moved, scaled or turned there), kept when the lines
    /// are set again; none is the centre at 100 %.
    #[serde(default)]
    pub pos_x: Option<f32>,
    #[serde(default)]
    pub pos_y: Option<f32>,
    #[serde(default)]
    pub scale: Option<f32>,
    #[serde(default)]
    pub rotation: Option<f32>,
}

/// A caption line's drawing, sent after its line (`captions.draw`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionDrawing {
    pub clip_id: String,
    pub png: String,
    #[serde(default)]
    pub box_w: f64,
    #[serde(default)]
    pub box_h: f64,
}

impl Project {
    /// Gives caption lines their drawings (lines set without them show nothing until then).
    /// Lines that are gone by now are skipped. Returns how many were drawn.
    pub fn set_caption_drawings(&mut self, drawings: &[CaptionDrawing]) -> usize {
        let mut n = 0;
        for d in drawings {
            let Some(c) = self.tracks.iter_mut().flat_map(|t| t.clips.iter_mut()).find(|c| c.id == d.clip_id && c.caption) else { continue };
            let Some(text) = c.text.as_mut() else { continue };
            text.insert("png".into(), Value::String(d.png.clone()));
            text.insert("boxW".into(), serde_json::json!(d.box_w));
            text.insert("boxH".into(), serde_json::json!(d.box_h));
            n += 1;
        }
        n
    }

    /// Where a pasted clip that wasn't on the main track goes: the role it came with, else
    /// text and adjustment clips onto picture tracks (as do images, which no sound track
    /// holds), and the rest onto sound tracks as before.
    pub(crate) fn lane_for_paste(&self, c: &Clip, role: Option<&str>) -> Lane {
        if let Some(r) = role.filter(|r| VISUAL_ROLES.contains(r)) {
            return Lane::Visual(r.into());
        }
        if c.text.is_some() {
            return Lane::Visual(if c.caption { "captions" } else { "text" }.into());
        }
        if c.is_synthetic() {
            return Lane::Visual("adjust".into());
        }
        if self.media(&c.media_id).is_some_and(|m| m.kind == MediaKind::Image) {
            return Lane::Visual("overlay".into());
        }
        Lane::Audio
    }

    /// Puts media, a text clip (`text`) or an adjustment layer (neither) on a picture track at
    /// `at`: a new track on top, or `track_id` if it's a picture track with room there (if it
    /// hasn't, a new track just above it). The length is `duration`, else the media's own
    /// (3 s for pictures, text and adjustment layers). Returns (clip, track).
    pub fn add_overlay(&mut self, media_id: Option<&str>, text: Option<TextSpec>, at: Us, duration: Option<Us>, role: &str, track_id: Option<&str>) -> R<(String, String)> {
        if !VISUAL_ROLES.contains(&role) {
            return err(format!("Unknown track role \"{role}\" (text, captions, sticker, overlay or adjust)"));
        }
        let media = match media_id.filter(|m| !m.is_empty()) {
            Some(id) => {
                let m = self.media(id).cloned().ok_or_else(|| EditError(format!("no media {id}")))?;
                if m.kind == MediaKind::Audio {
                    return err("Sound goes on an audio track, not over the picture");
                }
                Some(m)
            }
            None => None,
        };
        let natural = media.as_ref().map_or(IMAGE_DEFAULT, Self::default_duration);
        let limit = media.as_ref().filter(|m| m.kind == MediaKind::Video).map_or(Us::MAX / 4, |m| m.duration_us.max(MIN_CLIP));
        let len = duration.unwrap_or(natural).clamp(MIN_CLIP, limit);
        let mut clip = Clip::new(self.make_id("c"), media.map(|m| m.id).unwrap_or_default(), at.max(0), 0, len);
        clip.caption = role == "captions";
        if text.is_some() || matches!(role, "text" | "captions") && clip.is_synthetic() {
            clip.text = Some(text.unwrap_or_default());
        }
        let lane = Lane::Visual(role.into());
        let named = track_id.filter(|id| self.track(id).is_some_and(|t| t.is_visual()));
        let ti = match named {
            Some(id) => self.track_for(&lane, &clip, Some(id), Some(id)),
            None => {
                let mut t = crate::model::Track::new(self.make_id("t"), TrackKind::Video, false);
                t.role = role.into();
                self.tracks.push(t);
                self.tracks.len() - 1
            }
        };
        let ids = (clip.id.clone(), self.tracks[ti].id.clone());
        self.tracks[ti].clips.push(clip);
        self.normalize();
        Ok(ids)
    }

    /// The transition into a main-track clip from the one just before it (which must end
    /// where it starts), or none. The length defaults to what it had, or 0.5 s, and is kept
    /// within both clips.
    pub fn set_transition(&mut self, clip_id: &str, name: Option<&str>, duration_us: Option<Us>) -> R<()> {
        let main = self.main_track();
        let Some(ci) = main.clips.iter().position(|c| c.id == clip_id) else {
            return err(if self.clip(clip_id).is_some() { "Transitions go between clips on the main track".to_string() } else { format!("no clip {clip_id}") });
        };
        self.check_unlocked(&[clip_id.to_string()])?;
        let Some(name) = name else {
            self.main_track_mut().clips[ci].transition = None;
            return Ok(());
        };
        if xfade_name(name).is_none() {
            return err(format!("Unknown transition \"{name}\""));
        }
        if ci == 0 || main.clips[ci - 1].end_us() != main.clips[ci].start_us {
            return err("A transition needs a clip right before this one");
        }
        let (prev, c) = (&main.clips[ci - 1], &main.clips[ci]);
        let d = duration_us.or(c.transition.as_ref().map(|t| t.duration_us)).unwrap_or(500_000).clamp(MIN_CLIP, prev.duration_us.min(c.duration_us).max(MIN_CLIP));
        self.main_track_mut().clips[ci].transition = Some(Transition { name: name.into(), duration_us: d });
        Ok(())
    }

    /// The same transition (or none) on every cut of the main track. Returns how many cuts.
    pub fn set_all_transitions(&mut self, name: Option<&str>, duration_us: Us) -> R<usize> {
        let main = self.main_track();
        let cuts: Vec<String> = main.clips.windows(2).filter(|w| w[0].end_us() == w[1].start_us).map(|w| w[1].id.clone()).collect();
        if cuts.is_empty() {
            return err("There are no cuts on the main track");
        }
        for id in &cuts {
            self.set_transition(id, name, Some(duration_us))?;
        }
        Ok(cuts.len())
    }

    /// Replaces the lines of a captions track (or makes a new one on top): one text clip per
    /// line, sharing `style`, each with its own words and drawing. No lines removes the track.
    /// Returns (track, clips).
    /// Sets a captions track's lines (`track_id`), or makes a new captions track: on top, or
    /// just above the track `above` (a second row for a language, for a line that doesn't fit).
    pub fn set_captions(&mut self, track_id: Option<&str>, above: Option<&str>, mut lines: Vec<CaptionLine>, style: TextSpec) -> R<(String, Vec<String>)> {
        let ti = match track_id {
            Some(id) => {
                let i = self.tracks.iter().position(|t| t.id == id).ok_or_else(|| EditError(format!("no track {id}")))?;
                if !self.tracks[i].is_visual() {
                    return err("Captions go on a picture track over the main one");
                }
                if self.tracks[i].locked {
                    return err(format!("The {} track is locked", self.track_name(&self.tracks[i])));
                }
                i
            }
            None => {
                let mut t = crate::model::Track::new(self.make_id("t"), TrackKind::Video, false);
                t.role = "captions".into();
                match above.and_then(|id| self.tracks.iter().position(|t| t.id == id)) {
                    Some(i) => {
                        self.tracks.insert(i + 1, t);
                        i + 1
                    }
                    None => {
                        self.tracks.push(t);
                        self.tracks.len() - 1
                    }
                }
            }
        };
        self.tracks[ti].role = "captions".into();
        self.tracks[ti].clips.clear();
        lines.sort_by_key(|l| l.start_us);
        let mut ids = vec![];
        let mut at = 0;
        for line in lines {
            // Lines share one track, so each starts where the last one ended at the earliest.
            let start = line.start_us.max(at).max(0);
            let end = line.end_us.max(start + MIN_CLIP);
            let mut c = Clip::new(self.make_id("c"), String::new(), start, 0, end - start);
            let mut text = style.clone();
            text.insert("content".into(), Value::String(line.text));
            if let Some(png) = line.png {
                text.insert("png".into(), Value::String(png));
            }
            if let Some(words) = line.words {
                text.insert("words".into(), words);
            }
            c.text = Some(text);
            c.caption = true;
            c.pos_x = line.pos_x.unwrap_or(0.0);
            c.pos_y = line.pos_y.unwrap_or(0.0);
            c.scale = line.scale.unwrap_or(100.0);
            c.rotation = line.rotation.unwrap_or(0.0);
            at = end;
            ids.push(c.id.clone());
            self.tracks[ti].clips.push(c);
        }
        let track = self.tracks[ti].id.clone();
        self.normalize();
        Ok((track, ids))
    }

    /// Crossfades two clips: `b` moves onto `a`'s track to overlap `a`'s end by `duration_us`,
    /// and both get fades of that length, so the overlap is allowed (see `model::fits`).
    pub fn crossfade(&mut self, a: &str, b: &str, duration_us: Us) -> R<()> {
        let (Some((ta, ia)), Some((tb, ib))) = (self.find_clip(a), self.find_clip(b)) else { return err("Select the two clips to crossfade") };
        if a == b || self.tracks[ta].kind != TrackKind::Audio || self.tracks[tb].kind != TrackKind::Audio {
            return err("Crossfades are between two clips on audio tracks");
        }
        self.check_unlocked(&[a.to_string(), b.to_string()])?;
        let first = self.tracks[ta].clips[ia].clone();
        let mut second = self.tracks[tb].clips.remove(ib);
        let d = duration_us.clamp(MIN_CLIP, first.duration_us.min(second.duration_us));
        second.start_us = (first.end_us() - d).max(0);
        second.fade_in_us = d;
        second.fade_out_us = second.fade_out_us.min(second.duration_us - d);
        let ta = self.find_clip(a).map(|(t, _)| t).unwrap_or(ta);
        let ia = self.tracks[ta].clips.iter().position(|c| c.id == a).unwrap_or(0);
        let c = &mut self.tracks[ta].clips[ia];
        c.fade_out_us = d;
        c.fade_in_us = c.fade_in_us.min(c.duration_us - d);
        if !crate::model::fits(&self.tracks[ta], &second) {
            return err("The second clip doesn't fit after the first one on its track");
        }
        self.tracks[ta].clips.push(second);
        self.normalize();
        Ok(())
    }

    /// Takes a band of frequencies out of a clip's sound between two times in its source
    /// file (the spectrogram's own time), kept on the clip (`Clip::spectral`).
    pub fn spectral_delete(&mut self, clip_id: &str, start_us: Us, end_us: Us, low_hz: f32, high_hz: f32) -> R<()> {
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        let c = &self.tracks[ti].clips[ci];
        if !self.media(&c.media_id).is_some_and(|m| m.has_audio) {
            return err("That clip has no sound");
        }
        self.check_unlocked(&[clip_id.to_string()])?;
        let band = Spectral::clean(Spectral { start_us, end_us, low_hz, high_hz }).ok_or_else(|| EditError("Select a stretch of time and a band of frequencies".into()))?;
        self.tracks[ti].clips[ci].spectral.push(band);
        Ok(())
    }

    /// Cuts the timeline range [a, b) out of a track, as Audacity's select and cut does:
    /// every clip on it loses that stretch (split at both edges, the middle dropped) and
    /// everything after it moves left by the range's length (on the main track, the magnet's
    /// packing). While linkage is on, clips linked to those on the track get the same cut and
    /// move, so picture and sound stay together. Returns the length removed.
    pub fn remove_range(&mut self, track_id: &str, a: Us, b: Us) -> R<Us> {
        let (a, b) = (a.min(b).max(0), a.max(b).max(0));
        let d = b - a;
        if d <= 0 {
            return err("Select a stretch of time to cut");
        }
        let Some(ti) = self.tracks.iter().position(|t| t.id == track_id) else { return err(format!("no track {track_id}")) };
        // The track's clips from the range on, and with linkage the clips linked to them.
        let mut ids: Vec<String> = self.tracks[ti].clips.iter().filter(|c| c.end_us() > a).map(|c| c.id.clone()).collect();
        if ids.is_empty() {
            return err("There's nothing on that track from there on to cut");
        }
        if self.linkage {
            let links: Vec<String> = self.tracks[ti].clips.iter().filter(|c| ids.contains(&c.id)).filter_map(|c| c.link.clone()).collect();
            for t in self.tracks.iter().enumerate().filter(|(i, _)| *i != ti).map(|(_, t)| t) {
                ids.extend(t.clips.iter().filter(|c| c.link.as_ref().is_some_and(|l| links.contains(l))).map(|c| c.id.clone()));
            }
        }
        if self.tracks[ti].locked {
            return err(format!("The {} track is locked", self.track_name(&self.tracks[ti])));
        }
        self.check_unlocked(&ids)?;
        let mut new_links: Vec<(String, String)> = vec![];
        for t in 0..self.tracks.len() {
            let clips = std::mem::take(&mut self.tracks[t].clips);
            let mut out = vec![];
            for mut c in clips {
                if !ids.contains(&c.id) || c.end_us() <= a {
                    out.push(c);
                    continue;
                }
                if c.start_us >= b {
                    c.start_us -= d;
                    out.push(c);
                    continue;
                }
                // Across the range: what's before it stays, what's after it closes up to it.
                let (x, y) = ((a - c.start_us).max(0), (b - c.start_us).min(c.duration_us));
                let keep_left = x >= MIN_CLIP / 2;
                if keep_left {
                    let mut l = c.piece(0, x);
                    l.fade_in_us = c.fade_in_us.min(x);
                    l.fade_out_us = 0;
                    out.push(l);
                }
                if c.duration_us - y >= MIN_CLIP / 2 {
                    let mut r = c.piece(y, c.duration_us);
                    r.start_us -= d;
                    r.fade_in_us = 0;
                    r.fade_out_us = c.fade_out_us.min(r.duration_us);
                    if keep_left {
                        r.id = self.make_id("c");
                        // Both halves of a linked pair stay linked, as a split leaves them.
                        r.link = match c.link.take() {
                            Some(old) => Some(match new_links.iter().find(|(o, _)| *o == old) {
                                Some((_, n)) => n.clone(),
                                None => {
                                    let n = self.make_id("l");
                                    new_links.push((old, n.clone()));
                                    n
                                }
                            }),
                            None => None,
                        };
                    }
                    out.push(r);
                }
            }
            self.tracks[t].clips = out;
        }
        self.normalize();
        // A linked clip that moved onto another clip of its track hops to a free one.
        for id in &ids {
            let Some((t, i)) = self.find_clip(id).filter(|(t, _)| !self.tracks[*t].main) else { continue };
            if crate::model::fits(&self.tracks[t], &self.tracks[t].clips[i]) {
                continue;
            }
            let (lane, home) = (self.lane_of(t), self.tracks[t].id.clone());
            let clip = self.tracks[t].clips.remove(i);
            let to = self.track_for(&lane, &clip, None, Some(&home));
            self.tracks[to].clips.push(clip);
        }
        self.normalize();
        Ok(d)
    }

    /// Pastes copied clips onto one track at `at` (`clips.paste` with a `trackId`). The main
    /// track takes them as a normal paste. A sound track first opens a gap the length of the
    /// pasted run, Audacity's insert-paste: a clip across `at` splits there and everything
    /// from `at` on moves right. A picture track takes them where they fit (a new track just
    /// above it where they don't). Returns the new clips.
    pub fn paste_onto(&mut self, items: Vec<PasteItem>, at: Us, track_id: &str) -> R<Vec<String>> {
        let Some(ti) = self.tracks.iter().position(|t| t.id == track_id) else { return err(format!("no track {track_id}")) };
        if self.tracks[ti].locked {
            return err(format!("The {} track is locked", self.track_name(&self.tracks[ti])));
        }
        let at = at.max(0);
        let picture = |p: &Project, c: &Clip| !c.is_synthetic() && p.media(&c.media_id).is_some_and(|m| m.kind != MediaKind::Audio);
        if self.tracks[ti].main {
            let items = items.into_iter().map(|mut i| {
                i.main = picture(self, &i.clip);
                i
            });
            return self.paste(items.collect(), at);
        }
        let mut items: Vec<PasteItem> = items.into_iter().filter(|i| i.clip.is_synthetic() || self.media(&i.clip.media_id).is_some()).collect();
        if items.is_empty() {
            return err("The copied clips' media is no longer in the library");
        }
        let audio = self.tracks[ti].kind == TrackKind::Audio;
        if audio && !items.iter().all(|i| self.media(&i.clip.media_id).is_some_and(|m| m.has_audio && m.kind != MediaKind::Image)) {
            return err("Only sound goes on an audio track");
        }
        items.sort_by_key(|i| i.offset_us);
        let first = items[0].offset_us;
        let run = items.iter().map(|i| i.offset_us - first + i.clip.duration_us).max().unwrap_or(0);
        let track = self.tracks[ti].id.clone();
        if audio {
            // The gap: what's across the paste point splits there, and all from it moves on.
            let across: Vec<String> = self.tracks[ti].clips.iter().filter(|c| c.start_us < at && c.end_us() > at).map(|c| c.id.clone()).collect();
            for id in across {
                let _ = self.split(at, std::slice::from_ref(&id));
            }
            let ti = self.tracks.iter().position(|t| t.id == track).unwrap_or(ti);
            for c in self.tracks[ti].clips.iter_mut().filter(|c| c.start_us >= at) {
                c.start_us += run;
            }
        }
        let lane = if audio { Lane::Audio } else { Lane::Visual(self.tracks[ti].role.clone()) };
        let mut links: Vec<(String, String)> = vec![];
        let mut created = vec![];
        for item in items {
            let mut c = item.clip;
            c.id = self.make_id("c");
            c.start_us = at + item.offset_us - first;
            c.link = match c.link.take() {
                Some(old) => Some(match links.iter().find(|(o, _)| *o == old) {
                    Some((_, n)) => n.clone(),
                    None => {
                        let n = self.make_id("l");
                        links.push((old, n.clone()));
                        n
                    }
                }),
                None => None,
            };
            created.push(c.id.clone());
            let to = self.track_for(&lane, &c, Some(&track), Some(&track));
            self.tracks[to].clips.push(c);
        }
        self.normalize();
        Ok(created)
    }

    /// Points a clip on an audio track at a new copy of its sound (the same timing as the
    /// file it had, so its in point and length stay). Returns the new media's id.
    pub fn repoint_sound(&mut self, clip_id: &str, mut media: Media) -> R<String> {
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        if self.tracks[ti].kind != TrackKind::Audio {
            return err("Extract the clip's audio first, then draw on it");
        }
        self.check_unlocked(&[clip_id.to_string()])?;
        media.id = self.make_id("m");
        let id = media.id.clone();
        self.media.push(media);
        self.tracks[ti].clips[ci].media_id = id.clone();
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::CaptionLine;
    use crate::model::*;

    fn project() -> Project {
        let mut p = Project::new("T", "9:16");
        let m = |id: &str, kind, secs: Us| Media { id: id.into(), path: format!("{id}.x"), name: format!("{id}.mp4"), kind, duration_us: secs * SECOND, width: 1080, height: 1920, fps: 30.0, has_audio: kind != MediaKind::Image, ..Default::default() };
        p.media = vec![m("a", MediaKind::Video, 4), m("b", MediaKind::Video, 4), m("img", MediaKind::Image, 0), m("vo", MediaKind::Audio, 6), m("music", MediaKind::Audio, 6)];
        p.insert("a", 0).unwrap();
        p.insert("b", 10 * SECOND).unwrap();
        p
    }

    fn text(s: &str) -> TextSpec {
        let mut t = TextSpec::new();
        t.insert("content".into(), s.into());
        t.insert("png".into(), "t.png".into());
        t
    }

    #[test]
    fn overlays_get_their_own_tracks_on_top_and_stay_on_picture_tracks() {
        let mut p = project();
        let (sticker, st) = p.add_overlay(Some("img"), None, SECOND, None, "sticker", None).unwrap();
        let (title, tt) = p.add_overlay(None, Some(text("Hi")), 0, Some(2 * SECOND), "text", None).unwrap();
        assert_ne!(st, tt, "each gets its own track");
        assert_eq!(p.tracks.iter().map(|t| t.role.as_str()).collect::<Vec<_>>(), ["", "sticker", "text"], "later tracks are drawn on top");
        assert_eq!(p.clip(&sticker).unwrap().duration_us, IMAGE_DEFAULT);
        assert!(p.clip(&title).unwrap().is_synthetic() && p.clip(&title).unwrap().text.as_ref().unwrap()["content"] == "Hi");
        assert!(p.add_overlay(Some("vo"), None, 0, None, "overlay", None).is_err(), "sound isn't a picture");
        assert!(p.add_overlay(None, None, 0, None, "banner", None).is_err());

        // Named track: used while it has room, else a new track just above it.
        let (_, same) = p.add_overlay(Some("img"), None, 5 * SECOND, None, "sticker", Some(&st)).unwrap();
        assert_eq!(same, st);
        let (_, above) = p.add_overlay(Some("img"), None, 2 * SECOND, None, "sticker", Some(&st)).unwrap();
        assert_eq!(p.tracks.iter().position(|t| t.id == above), Some(2));

        // Moving and trimming keep a picture clip on a picture track, never on a sound one.
        p.move_clip(&title, 6 * SECOND, None).unwrap();
        let ti = p.find_clip(&title).unwrap().0;
        assert!(p.tracks[ti].is_visual() && p.clip(&title).unwrap().start_us == 6 * SECOND);
        p.trim(&title, 0, 20 * SECOND, Some(6 * SECOND)).unwrap();
        assert_eq!(p.clip(&title).unwrap().duration_us, 20 * SECOND, "a text clip can be any length");
        p.split(7 * SECOND, std::slice::from_ref(&title)).unwrap();
        assert_eq!(p.tracks[p.find_clip(&title).unwrap().0].clips.len(), 2);

        // Deleting the last clip on a track removes the track.
        let n = p.tracks.len();
        p.delete(&[sticker]).unwrap();
        assert_eq!(p.tracks.len(), n);
        let adj = p.add_overlay(None, None, 0, None, "adjust", None).unwrap().0;
        assert!(p.clip(&adj).unwrap().text.is_none());
        p.delete(&[adj]).unwrap();
        assert_eq!(p.tracks.len(), n);
    }

    #[test]
    fn pasted_and_compound_overlays_keep_to_picture_tracks() {
        let mut p = project();
        let (title, _) = p.add_overlay(None, Some(text("Hi")), 0, None, "text", None).unwrap();
        let c = p.clip(&title).unwrap().clone();
        let ids = p.paste(vec![PasteItem { clip: c, main: false, offset_us: 0, role: None }], 20 * SECOND).unwrap();
        let ti = p.find_clip(&ids[0]).unwrap().0;
        assert!(p.tracks[ti].is_visual() && p.tracks[ti].role == "text");
        let img = p.add_overlay(Some("img"), None, 0, None, "sticker", None).unwrap().0;
        let a = p.main_track().clips[0].id.clone();
        let parts = p.sub_project(&[a.clone(), img.clone()]).unwrap().0;
        assert_eq!(parts.tracks.iter().filter(|t| t.is_visual()).count(), 1);
    }

    #[test]
    fn transitions_need_a_clip_before_and_fit_both() {
        let mut p = project();
        let (a, b) = (p.main_track().clips[0].id.clone(), p.main_track().clips[1].id.clone());
        assert!(p.set_transition(&a, Some("Dissolve"), None).is_err(), "nothing before the first clip");
        assert!(p.set_transition(&b, Some("Nope"), None).is_err());
        p.set_transition(&b, Some("Wipe left"), Some(9 * SECOND)).unwrap();
        assert_eq!(p.clip(&b).unwrap().transition.as_ref().map(|t| (t.name.as_str(), t.duration_us)), Some(("Wipe left", 4 * SECOND)), "kept within both clips");
        p.set_transition(&b, None, None).unwrap();
        assert!(p.clip(&b).unwrap().transition.is_none());
        assert_eq!(p.set_all_transitions(Some("Dissolve"), 300_000).unwrap(), 1);
        // Split, the way in stays with the left piece.
        let right = p.split(6 * SECOND, std::slice::from_ref(&b)).unwrap();
        assert!(p.clip(&b).unwrap().transition.is_some() && p.clip(&right[0]).unwrap().transition.is_none());
        // set_clip refuses unknown names and transitions off the main track.
        assert!(p.set_clip(&b, ClipChange { effects: Some(vec![Fx { name: "Sparkle".into(), amount: 50.0 }]), ..Default::default() }).unwrap_err().0.contains("Sparkle"));
        let (t, _) = p.add_overlay(None, Some(text("x")), 0, None, "text", None).unwrap();
        assert!(p.set_clip(&t, ClipChange { transition: Some(Some(Transition { name: "Dissolve".into(), duration_us: SECOND })), ..Default::default() }).is_err());
    }

    #[test]
    fn captions_replace_their_lines() {
        let mut p = project();
        let style = text("");
        let line = |a: Us, b: Us, s: &str| CaptionLine { start_us: a, end_us: b, text: s.into(), png: Some(format!("{s}.png")), ..Default::default() };
        let (track, ids) = p.set_captions(None, None, vec![line(0, SECOND, "one"), line(SECOND / 2, 2 * SECOND, "two")], style.clone()).unwrap();
        assert_eq!(ids.len(), 2);
        let c = p.clip(&ids[1]).unwrap();
        assert_eq!((c.start_us, c.caption, c.text.as_ref().unwrap()["content"].as_str(), c.text.as_ref().unwrap()["png"].as_str()), (SECOND, true, Some("two"), Some("two.png")), "lines never overlap");
        assert_eq!(p.track(&track).unwrap().role, "captions");
        let (again, ids) = p.set_captions(Some(&track), None, vec![line(0, SECOND, "only")], style.clone()).unwrap();
        assert_eq!((again.as_str(), p.track(&track).unwrap().clips.len(), ids.len()), (track.as_str(), 1, 1));
        // A line keeps its words' times, for splitting it later.
        let words = serde_json::json!([{ "w": "only", "s": 0, "e": 400_000 }]);
        let (_, ids) = p.set_captions(Some(&track), None, vec![CaptionLine { words: Some(words.clone()), ..line(0, SECOND, "only") }], style.clone()).unwrap();
        assert_eq!(p.clip(&ids[0]).unwrap().text.as_ref().unwrap()["words"], words);
        // A second row for the language goes just above the first, not on top of everything.
        let (top, _) = p.add_overlay(None, Some(text("title")), 0, None, "text", None).unwrap();
        let first = p.tracks.iter().position(|t| t.id == track).unwrap();
        let (row, _) = p.set_captions(None, Some(&track), vec![line(SECOND, 2 * SECOND, "extra")], style.clone()).unwrap();
        assert_eq!(p.tracks.iter().position(|t| t.id == row), Some(first + 1));
        assert!(p.tracks.iter().position(|t| t.clips.iter().any(|c| c.id == top)).unwrap() > first + 1, "the title stays on top");
        // A line moved on the picture keeps its place when the lines are set again.
        let (_, ids) = p.set_captions(Some(&track), None, vec![CaptionLine { pos_x: Some(12.0), pos_y: Some(-300.0), rotation: Some(5.0), ..line(0, SECOND, "moved") }], style.clone()).unwrap();
        let c = p.clip(&ids[0]).unwrap();
        assert_eq!((c.pos_x, c.pos_y, c.scale, c.rotation), (12.0, -300.0, 100.0, 5.0));
        // Lines first, drawings after: a line that's gone by then is skipped.
        let (_, ids) = p.set_captions(Some(&track), None, vec![CaptionLine { png: None, ..line(0, SECOND, "later") }], style.clone()).unwrap();
        let draw = |id: &str| CaptionDrawing { clip_id: id.into(), png: "later.png".into(), box_w: 300.0, box_h: 80.0 };
        assert_eq!(p.set_caption_drawings(&[draw(&ids[0]), draw("gone")]), 1);
        assert_eq!(p.clip(&ids[0]).unwrap().text.as_ref().unwrap()["png"].as_str(), Some("later.png"));
        p.set_captions(Some(&track), None, vec![], style).unwrap();
        assert!(p.track(&track).is_none(), "no lines, no track");
    }

    #[test]
    fn crossfades_overlap_on_one_track_and_survive_moves() {
        let mut p = project();
        let a = p.insert("vo", 0).unwrap();
        let b = p.insert("music", 8 * SECOND).unwrap();
        p.crossfade(&a, &b, SECOND).unwrap();
        let (ca, cb) = (p.clip(&a).unwrap().clone(), p.clip(&b).unwrap().clone());
        assert_eq!((cb.start_us, ca.fade_out_us, cb.fade_in_us), (5 * SECOND, SECOND, SECOND));
        assert_eq!(p.find_clip(&a).unwrap().0, p.find_clip(&b).unwrap().0, "one track");
        // A small nudge that keeps the overlap within the fades stays on the track.
        p.move_clip(&b, 5 * SECOND + 200_000, None).unwrap();
        assert_eq!(p.find_clip(&a).unwrap().0, p.find_clip(&b).unwrap().0);
        // Overlapping more than the fades cover hops to another track, as before.
        p.move_clip(&b, 3 * SECOND, None).unwrap();
        assert_ne!(p.find_clip(&a).unwrap().0, p.find_clip(&b).unwrap().0);
        let main = p.main_track().clips[0].id.clone();
        assert!(p.crossfade(&main, &b, SECOND).is_err(), "audio tracks only");
    }

    #[test]
    fn spectral_edits_are_kept_in_source_time() {
        let mut p = project();
        let vo = p.insert("vo", 2 * SECOND).unwrap();
        p.set_clip(&vo, ClipChange { speed: Some(2.0), ..Default::default() }).unwrap();
        p.spectral_delete(&vo, 2 * SECOND, SECOND, 3000.0, 1000.0).unwrap();
        assert_eq!(p.clip(&vo).unwrap().spectral, vec![Spectral { start_us: SECOND, end_us: 2 * SECOND, low_hz: 1000.0, high_hz: 3000.0 }]);
        assert!(p.spectral_delete(&vo, 0, 0, 100.0, 200.0).is_err(), "no time selected");
        let img = p.add_overlay(Some("img"), None, 0, None, "sticker", None).unwrap().0;
        assert!(p.spectral_delete(&img, 0, SECOND, 100.0, 200.0).is_err());
    }

    #[test]
    fn removing_a_range_closes_the_track_and_keeps_linked_sound_in_step() {
        let mut p = project();
        // Main: a (0–4 s), b (4–8 s), each with its sound extracted to a linked audio clip.
        let (a, b) = (p.main_track().clips[0].id.clone(), p.main_track().clips[1].id.clone());
        let sound = p.extract_audio(&[a.clone(), b.clone()]).unwrap();
        let audio_track = p.find_clip(&sound[0]).unwrap().0;
        let at = p.tracks[audio_track].id.clone();
        assert_eq!(p.remove_range(&at, SECOND, 1_500_000).unwrap(), 500_000);
        let main: Vec<(Us, Us, Us)> = p.main_track().clips.iter().map(|c| (c.start_us, c.in_us, c.duration_us)).collect();
        assert_eq!(main, vec![(0, 0, SECOND), (SECOND, 1_500_000, 2_500_000), (3_500_000, 0, 4 * SECOND)], "the linked picture is cut the same way");
        let t = &p.tracks[p.find_clip(&sound[1]).unwrap().0];
        let sounds: Vec<(Us, Us)> = t.clips.iter().map(|c| (c.start_us, c.in_us)).collect();
        assert_eq!(sounds, vec![(0, 0), (SECOND, 1_500_000), (3_500_000, 0)], "every sound still under its picture");
        assert_eq!(p.duration_us(), 7_500_000);
        // The halves after the cut stay linked to each other.
        let (v, s) = (&p.main_track().clips[1], &t.clips[1]);
        assert!(v.link.is_some() && v.link == s.link && v.link != p.main_track().clips[0].link);
        // A gap on a sound track closes up too (select the gap and cut).
        let vo = p.insert_on_new_track("vo", 10 * SECOND).unwrap();
        let vt = p.tracks[p.find_clip(&vo).unwrap().0].id.clone();
        p.remove_range(&vt, 0, 4 * SECOND).unwrap();
        assert_eq!(p.clip(&vo).unwrap().start_us, 6 * SECOND);
        assert!(p.remove_range(&vt, 20 * SECOND, 21 * SECOND).is_err(), "nothing from there on");
        p.set_track(&vt, TrackChange { locked: Some(true), ..Default::default() }).unwrap();
        assert!(p.remove_range(&vt, 0, SECOND).is_err());
    }

    #[test]
    fn pasting_onto_a_sound_track_opens_a_gap_for_the_run() {
        let mut p = project();
        let a = p.insert_on_new_track("vo", 0).unwrap();
        let t = p.tracks[p.find_clip(&a).unwrap().0].id.clone();
        let b = p.insert("music", 6 * SECOND).unwrap();
        p.move_clip(&b, 6 * SECOND, Some(&t)).unwrap();
        assert_eq!(p.find_clip(&b).unwrap().0, p.find_clip(&a).unwrap().0, "both on one track");
        // Paste a 2 s copy at 3 s: the clip across 3 s splits, everything from there moves 2 s on.
        let mut copy = p.clip(&a).unwrap().clone();
        copy.duration_us = 2 * SECOND;
        let ids = p.paste_onto(vec![PasteItem { clip: copy, main: false, offset_us: 0, role: None }], 3 * SECOND, &t).unwrap();
        let track = p.track(&t).unwrap();
        let spans: Vec<(Us, Us)> = track.clips.iter().map(|c| (c.start_us, c.end_us())).collect();
        assert_eq!(spans, vec![(0, 3 * SECOND), (3 * SECOND, 5 * SECOND), (5 * SECOND, 8 * SECOND), (8 * SECOND, 14 * SECOND)]);
        assert_eq!(track.clips[1].id, ids[0]);
        assert_eq!(track.clips[2].in_us, 3 * SECOND, "the split's right half plays on from where it was cut");
        // Pictures can't go on a sound track; a locked track refuses; the main track pastes as before.
        let img = p.add_overlay(Some("img"), None, 0, None, "sticker", None).unwrap().0;
        let pic = p.clip(&img).unwrap().clone();
        assert!(p.paste_onto(vec![PasteItem { clip: pic, main: false, offset_us: 0, role: None }], 0, &t).is_err());
        let main = p.main_track().id.clone();
        let v = p.main_track().clips[0].clone();
        let n = p.main_track().clips.len();
        p.paste_onto(vec![PasteItem { clip: v, main: false, offset_us: 0, role: None }], 0, &main).unwrap();
        assert_eq!(p.main_track().clips.len(), n + 1);
        p.set_track(&t, TrackChange { locked: Some(true), ..Default::default() }).unwrap();
        let again = p.clip(&a).unwrap().clone();
        assert!(p.paste_onto(vec![PasteItem { clip: again, main: false, offset_us: 0, role: None }], 0, &t).is_err());
    }

    #[test]
    fn keyframes_ease_between_points_and_keep_it_when_cut() {
        let pts = vec![Keyframe { at_us: 0, value: 0.0, ease: Ease::InOut }, Keyframe { at_us: SECOND, value: 100.0, ease: Ease::Linear }];
        assert_eq!(keyframe_value(&pts, SECOND / 2), Some(50.0));
        assert!((keyframe_value(&pts, SECOND / 4).unwrap() - 15.625).abs() < 1e-9, "smoothstep is slow at first");
        let pin = vec![Keyframe { ease: Ease::In, ..pts[0] }, pts[1]];
        assert_eq!(keyframe_value(&pin, SECOND / 2), Some(25.0));
        let pout = vec![Keyframe { ease: Ease::Out, ..pts[0] }, pts[1]];
        assert_eq!(keyframe_value(&pout, SECOND / 2), Some(75.0));
        let k: Keyframe = serde_json::from_str(r#"{ "atUs": 5, "value": 1, "ease": "Ease in and out" }"#).unwrap();
        assert_eq!(k.ease, Ease::InOut);
        assert_eq!(serde_json::to_value(k).unwrap()["ease"], "Ease in and out");
        let old: Keyframe = serde_json::from_str(r#"{ "atUs": 5, "value": 1 }"#).unwrap();
        assert_eq!(old.ease, Ease::Linear);
    }

    #[test]
    fn speed_ramps_keep_the_source_range_and_cut_cleanly() {
        let mut p = project();
        let a = p.main_track().clips[0].id.clone();
        let ramp = SpeedCurve { name: "Montage".into(), points: vec![[0.0, 1.0], [1.0, 3.0]] };
        p.set_clip(&a, ClipChange { speed_curve: Some(Some(ramp)), ..Default::default() }).unwrap();
        let c = p.clip(&a).unwrap().clone();
        assert!((c.speed - 2.0).abs() < 1e-9 && c.duration_us == 2 * SECOND && c.span_us() == 4 * SECOND, "the mean speed reads the same 4 s of source: {c:?}");
        // Halfway through the clip, a ramp from 1× to 3× has shown 0.75 of its 2 units of source: 1.5 of the 4 s.
        assert_eq!(c.source_at(SECOND), 1_500_000);
        let right = p.split(SECOND, std::slice::from_ref(&a)).unwrap();
        let (l, r) = (p.clip(&a).unwrap().clone(), p.clip(&right[0]).unwrap().clone());
        assert_eq!((l.in_us, l.span_us(), r.in_us, r.span_us()), (0, 1_500_000, 1_500_000, 2_500_000), "{l:?} {r:?}");
        assert!(l.speed_curve.is_some() && r.speed_curve.as_ref().unwrap().points.first().unwrap()[1] == 2.0);
        // A plain speed takes the ramp off.
        p.set_clip(&a, ClipChange { speed: Some(1.0), ..Default::default() }).unwrap();
        assert!(p.clip(&a).unwrap().speed_curve.is_none());
    }

    #[test]
    fn new_settings_are_cleaned_and_round_trip() {
        let mut p = project();
        let a = p.main_track().clips[0].id.clone();
        let mut hsl = HslMap::new();
        hsl.insert("Orange".into(), Hsl { h: 250.0, s: 0.0, l: 0.0 });
        hsl.insert("Blue".into(), Hsl::default());
        let change = ClipChange {
            hsl: Some(hsl),
            curves: Some(Curves { master: Some(vec![[0.0, 0.1], [1.0, 0.9]]), red: Some(vec![[0.0, 0.0], [1.0, 1.0]]), ..Default::default() }),
            wheels: Some(Wheels { lift: Some(Wheel { x: 3.0, y: 0.0, lum: 0.0 }), gamma: Some(Wheel::default()), gain: None }),
            effects: Some(vec![Fx { name: "Blur".into(), amount: 140.0 }]),
            lut: Some(Some(Lut { path: "x.cube".into(), strength: 50.0 })),
            stabilize: Some(Some(Stabilize { strength: 70.0 })),
            mask_png: Some(Some("m.png".into())),
            keep_pitch: Some(false),
            flip_v: Some(true),
            blend: Some("screen".into()),
            ..Default::default()
        };
        p.set_clip(&a, change).unwrap();
        let c = p.clip(&a).unwrap().clone();
        assert_eq!(c.hsl.len(), 1, "a range left at zero is dropped");
        assert_eq!(c.hsl["Orange"].h, 100.0);
        assert!(c.curves.master.is_some() && c.curves.red.is_none(), "a straight curve is none");
        assert_eq!((c.wheels.lift.unwrap().x, c.wheels.gamma), (1.0, None));
        assert_eq!(c.effects[0].amount, 100.0);
        assert!(!c.keep_pitch && c.flip_v && c.blend == "screen" && c.mask_png.as_deref() == Some("m.png"));
        assert!(p.set_clip(&a, ClipChange { blend: Some("glow".into()), ..Default::default() }).is_err());
        let json = serde_json::to_value(&c).unwrap();
        for key in ["flipV", "transformOn", "blend", "effects", "transition", "hsl", "curves", "wheels", "lut", "stabilize", "smooth", "keepPitch", "speedCurve", "mask", "maskPng", "matte", "anim", "text", "caption", "spectral"] {
            assert!(json.get(key).is_some(), "{key} is written out");
        }
        let back: Clip = serde_json::from_value(json).unwrap();
        assert_eq!(back, c);
        // Old clips load with the defaults.
        let old: Clip = serde_json::from_str(r#"{ "id": "c1", "mediaId": "a", "startUs": 0, "inUs": 0, "durationUs": 1 }"#).unwrap();
        assert!(old.transform_on && old.keep_pitch && old.blend == "normal" && old.effects.is_empty());
        // Text merges, and null takes a key out.
        let (t, _) = p.add_overlay(None, Some(text("Hi")), 0, None, "text", None).unwrap();
        let mut patch = TextSpec::new();
        patch.insert("content".into(), "Hello".into());
        patch.insert("png".into(), serde_json::Value::Null);
        p.set_clip(&t, ClipChange { text: Some(patch), ..Default::default() }).unwrap();
        let tx = p.clip(&t).unwrap().text.clone().unwrap();
        assert_eq!((tx["content"].as_str(), tx.get("png")), (Some("Hello"), None));
    }
}
