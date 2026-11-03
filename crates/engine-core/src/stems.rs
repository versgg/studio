//! Stems of a clip's sound (vocals, instrumental, drums… split by the server with AudioShake; the
//! app downloads them) put back on the timeline in sync with the clip. A stem file covers a
//! stretch of the clip's source, starting at `from_us` in it, at the source's own speed: each
//! stem clip plays the part of that stretch the clip plays, at the clip's place, speed and
//! direction, on a new sound track just under the clip's track (under the video for a picture
//! clip). With `replace` the clip's own sound goes off (`detached`), so only the stems play;
//! "Restore its sound" turns it back on. All of it is one undo step.

use crate::model::{Clip, MIN_CLIP, MediaKind, Project, R, Track, TrackKind, Us, err};
use serde::Deserialize;

/// One stem to place: its media (an imported stem file) and the track's role ("voice",
/// "music", or "" to let the app guess).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StemItem {
    pub media_id: String,
    #[serde(default)]
    pub role: String,
}

/// Where a stem file that starts at `from_us` in the clip's source and runs `len_us` plays
/// under the clip: (offset from the clip's start, timeline length, in point in the stem file).
/// None when it covers too little of what the clip plays.
pub fn stem_span(clip: &Clip, from_us: Us, len_us: Us) -> Option<(Us, Us, Us)> {
    let speed = if clip.speed > 0.0 && clip.speed.is_finite() { clip.speed } else { 1.0 };
    let span = clip.span_us();
    // The source both cover.
    let a = clip.in_us.max(from_us);
    let b = (clip.in_us + span).min(from_us + len_us);
    if b - a < MIN_CLIP / 2 {
        return None;
    }
    // A reversed clip starts at the end of its source range and works back.
    let (s0, s1) = if clip.reverse { (clip.in_us + span - b, clip.in_us + span - a) } else { (a - clip.in_us, b - clip.in_us) };
    let t0 = ((s0 as f64) / speed).round() as Us;
    let t1 = (((s1 as f64) / speed).round() as Us).min(clip.duration_us);
    if t1 - t0 < MIN_CLIP / 2 {
        return None;
    }
    Some((t0, t1 - t0, a - from_us))
}

impl Project {
    /// Puts stems of `clip_id`'s sound (files starting at `from_us` in its source) on new sound
    /// tracks just under it, each playing in sync with it; with `replace` its own sound goes off.
    /// Returns the new clips, in the order given (top to bottom).
    pub fn add_stems(&mut self, clip_id: &str, stems: &[StemItem], from_us: Us, replace: bool) -> R<Vec<String>> {
        let Some((ti, ci)) = self.find_clip(clip_id) else { return err(format!("no clip {clip_id}")) };
        let c = self.tracks[ti].clips[ci].clone();
        if !self.media(&c.media_id).is_some_and(|m| m.has_audio && m.kind != MediaKind::Image) {
            return err("That clip has no sound to split");
        }
        if c.speed_curve.is_some() {
            return err("A clip with a speed curve plays silent, so it has no sound to split. Take the curve off first");
        }
        if replace {
            self.check_unlocked(&[c.id.clone()])?;
        }
        if stems.is_empty() {
            return err("Choose at least one stem");
        }
        // Under a sound clip's own track; under the video (above every sound track) for a picture's sound.
        let mut at = if self.tracks[ti].kind == TrackKind::Audio && !self.tracks[ti].main {
            ti + 1
        } else {
            self.tracks.iter().position(|t| !t.main && t.kind == TrackKind::Audio).unwrap_or(self.tracks.len())
        };
        // The stems follow the clip as it moves: a main-track clip pulls its linked sound along.
        let link = match &c.link {
            Some(l) => Some(l.clone()),
            None if self.tracks[ti].main => Some(self.make_id("l")),
            None => None,
        };
        let mut created = vec![];
        for item in stems {
            let Some(m) = self.media(&item.media_id).filter(|m| m.kind == MediaKind::Audio && m.has_audio).cloned() else {
                return err("A stem's file is no longer in the library");
            };
            let Some((t0, len, in_us)) = stem_span(&c, from_us, m.duration_us) else {
                return err("These stems don't cover the part of the sound the clip plays now. Separate it again");
            };
            let id = self.make_id("c");
            let mut s = Clip::new(id.clone(), m.id.clone(), c.start_us + t0, in_us, len);
            s.volume = c.volume;
            s.speed = c.speed;
            s.reverse = c.reverse;
            s.keep_pitch = c.keep_pitch;
            s.pitch = c.pitch;
            s.declick = c.declick;
            s.fade_curve = c.fade_curve.clone();
            // A fade belongs to the clip's edge; a stem that starts later or ends sooner has none there.
            if t0 == 0 {
                s.fade_in_us = c.fade_in_us.min(len);
            }
            if t0 + len >= c.duration_us {
                s.fade_out_us = c.fade_out_us.min(len);
            }
            // The envelope and spectral edits are at source times; the stem file starts at `from_us`.
            s.envelope = c.envelope.iter().map(|p| crate::model::EnvPoint { at_us: p.at_us - from_us, ..*p }).collect();
            s.spectral = c.spectral.iter().map(|x| crate::look::Spectral { start_us: x.start_us - from_us, end_us: x.end_us - from_us, ..*x }).collect();
            s.link = link.clone();
            let mut t = Track::new(self.make_id("t"), TrackKind::Audio, false);
            if item.role == "voice" || item.role == "music" {
                t.role = item.role.clone();
            }
            t.clips.push(s);
            self.tracks.insert(at.min(self.tracks.len()), t);
            at += 1;
            created.push(id);
        }
        // The clip itself is found again: the tracks above it may have moved.
        if let Some((ti, ci)) = self.find_clip(clip_id) {
            let clip = &mut self.tracks[ti].clips[ci];
            if clip.link.is_none() {
                clip.link = link;
            }
            if replace {
                clip.detached = true;
            }
        }
        self.normalize();
        Ok(created)
    }
}

#[cfg(test)]
mod tests {
    use super::{StemItem, stem_span};
    use crate::model::*;

    fn project() -> Project {
        let mut p = Project::new("T", "9:16");
        let m = |id: &str, kind, us: Us| Media { id: id.into(), path: format!("{id}.x"), name: format!("{id}.mp3"), kind, duration_us: us, width: 1080, height: 1920, fps: 30.0, has_audio: kind != MediaKind::Image, ..Default::default() };
        p.media = vec![m("v", MediaKind::Video, 20 * SECOND), m("song", MediaKind::Audio, 30 * SECOND), m("vox", MediaKind::Audio, 4 * SECOND), m("inst", MediaKind::Audio, 4 * SECOND), m("img", MediaKind::Image, 0)];
        p
    }
    fn item(id: &str, role: &str) -> StemItem {
        StemItem { media_id: id.into(), role: role.into() }
    }
    fn audio_clip(p: &mut Project, at: Us, in_us: Us, dur: Us) -> String {
        let id = p.insert("song", at).unwrap();
        p.trim(&id, in_us, dur, Some(at)).unwrap();
        id
    }

    #[test]
    fn a_stem_plays_exactly_the_part_the_clip_plays() {
        let c = |in_us, dur, speed: f64, reverse| Clip { speed, reverse, ..Clip::new("c".into(), "m".into(), 0, in_us, dur) };
        // Separated as it is: the whole clip, from the stem's start.
        assert_eq!(stem_span(&c(SECOND, 4 * SECOND, 1.0, false), SECOND, 4 * SECOND), Some((0, 4 * SECOND, 0)));
        // At 2×, 2 s on the timeline play 4 s of source; the stem keeps the clip's speed.
        assert_eq!(stem_span(&c(3 * SECOND, 2 * SECOND, 2.0, false), 3 * SECOND, 4 * SECOND), Some((0, 2 * SECOND, 0)));
        // The clip was made longer on both sides since: the stems sit where their sound plays.
        assert_eq!(stem_span(&c(0, 10 * SECOND, 1.0, false), 2 * SECOND, 5 * SECOND), Some((2 * SECOND, 5 * SECOND, 0)));
        // …and shorter: the stem starts inside its file.
        assert_eq!(stem_span(&c(3 * SECOND, 2 * SECOND, 1.0, false), 2 * SECOND, 5 * SECOND), Some((0, 2 * SECOND, SECOND)));
        // Reversed, the end of the source comes first: source 2–4 s of a clip playing 5 → 1 s.
        assert_eq!(stem_span(&c(SECOND, 4 * SECOND, 1.0, true), 2 * SECOND, 2 * SECOND), Some((SECOND, 2 * SECOND, 0)));
        // Nothing in common.
        assert_eq!(stem_span(&c(0, 2 * SECOND, 1.0, false), 5 * SECOND, 2 * SECOND), None);
    }

    #[test]
    fn stems_go_on_new_tracks_just_under_a_sound_clip_in_sync() {
        let mut p = project();
        let first = audio_clip(&mut p, 0, 0, 3 * SECOND);
        let c = audio_clip(&mut p, 2 * SECOND, SECOND, 4 * SECOND);
        p.set_clip(&c, ClipChange { volume: Some(0.5), fade_in_us: Some(300_000), envelope: Some(vec![EnvPoint { at_us: 2 * SECOND, gain: 0.8 }]), ..Default::default() }).unwrap();
        let (tracks_before, under) = (p.tracks.len(), p.find_clip(&c).unwrap().0);
        assert_ne!(under, p.find_clip(&first).unwrap().0, "the two overlap, so they sit on two tracks");
        let ids = p.add_stems(&c, &[item("vox", "voice"), item("inst", "music")], SECOND, false).unwrap();
        assert_eq!(p.tracks.len(), tracks_before + 2);
        let ti = p.find_clip(&c).unwrap().0;
        assert_eq!((p.find_clip(&ids[0]).unwrap().0, p.find_clip(&ids[1]).unwrap().0), (ti + 1, ti + 2), "right under the clip, in the order given");
        assert_eq!((p.tracks[ti + 1].role.as_str(), p.tracks[ti + 2].role.as_str()), ("voice", "music"));
        let s = p.clip(&ids[0]).unwrap();
        assert_eq!((s.start_us, s.in_us, s.duration_us, s.media_id.as_str()), (2 * SECOND, 0, 4 * SECOND, "vox"));
        assert_eq!((s.volume, s.fade_in_us), (0.5, 300_000), "it sounds like the clip did");
        assert_eq!(s.envelope[0].at_us, SECOND, "source times move with the file's start");
        let clip = p.clip(&c).unwrap();
        assert!(!clip.detached && clip.link.is_none(), "added, not replacing; sound tracks aren't linked");
    }

    #[test]
    fn use_only_these_silences_a_main_video_and_links_the_stems_to_it() {
        let mut p = project();
        let v = p.insert("v", 0).unwrap();
        p.trim(&v, 3 * SECOND, 4 * SECOND, None).unwrap();
        p.set_clip(&v, ClipChange { speed: Some(2.0), ..Default::default() }).unwrap();
        let v_clip = p.clip(&v).unwrap().clone();
        let music = audio_clip(&mut p, 0, 0, 5 * SECOND);
        // Stems of the 4 s of source the 2 s clip plays.
        let ids = p.add_stems(&v, &[item("vox", "")], v_clip.in_us, true).unwrap();
        let s = p.clip(&ids[0]).unwrap();
        assert_eq!((s.start_us, s.in_us, s.duration_us, s.speed), (v_clip.start_us, 0, v_clip.duration_us, 2.0));
        let ti = p.find_clip(&ids[0]).unwrap().0;
        assert!(ti < p.find_clip(&music).unwrap().0, "under the video, above the other sound");
        let clip = p.clip(&v).unwrap();
        assert!(clip.detached, "its own sound is off");
        assert!(clip.link.is_some() && clip.link == s.link, "the stem follows the video");
        // Moving the video's place on the magnetic track takes the stem along.
        let w = p.insert("v", 0).unwrap();
        let moved = p.clip(&v).unwrap().start_us;
        assert_eq!(p.clip(&ids[0]).unwrap().start_us, moved, "still in sync after a clip went in before it");
        assert!(p.clip(&w).is_some());
    }

    #[test]
    fn what_cant_be_split_says_so() {
        let mut p = project();
        let c = audio_clip(&mut p, 0, 0, 3 * SECOND);
        assert!(p.add_stems(&c, &[item("vox", "")], 10 * SECOND, false).is_err(), "no overlap");
        assert!(p.add_stems(&c, &[], 0, false).is_err(), "nothing chosen");
        assert!(p.add_stems(&c, &[item("v", "")], 0, false).is_err(), "a stem is a sound file");
        let tid = p.tracks[p.find_clip(&c).unwrap().0].id.clone();
        p.set_track(&tid, TrackChange { locked: Some(true), ..Default::default() }).unwrap();
        assert!(p.add_stems(&c, &[item("vox", "")], 0, true).is_err(), "its track is locked");
        assert!(p.add_stems(&c, &[item("vox", "")], 0, false).is_ok(), "adding leaves the locked clip alone");
    }
}
