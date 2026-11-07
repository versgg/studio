//! Contract v2 on real FFmpeg: overlays, text, transitions, adjustment layers, blend modes,
//! effects, masks, animation and the new sound settings change the rendered pixels and
//! sound the way they should. Each test is skipped without FFmpeg.

use crate::Ffmpeg;
use crate::graph::{VideoOut, build, timeline_from, timeline_window};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use studio_engine_core::look::EFFECTS;
use studio_engine_core::model::*;

const W: u32 = 54;
const H: u32 = 96;

struct Lab {
    ff: Ffmpeg,
    dir: PathBuf,
}

impl Lab {
    fn new(name: &str) -> Option<Lab> {
        let ff = Ffmpeg::detect().ok()?;
        let dir = std::env::temp_dir().join(format!("studio-v2-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Some(Lab { ff, dir })
    }

    fn run(&self, args: &[&str], out: &Path) {
        let ok = self.ff.cmd().args(["-hide_banner", "-loglevel", "error"]).args(args).arg("-y").arg(out).status().unwrap();
        assert!(ok.success(), "{args:?}");
    }

    /// A clip of one colour (`secs` long, 10 fps, with a tone).
    fn colour(&self, name: &str, colour: &str, secs: u32) -> Media {
        let out = self.dir.join(format!("{name}.mp4"));
        self.run(&["-f", "lavfi", "-i", &format!("color=c={colour}:s=108x192:r=10:d={secs}"), "-f", "lavfi", "-i", &format!("sine=frequency=440:duration={secs}"), "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac"], &out);
        Media { id: name.into(), path: out.to_string_lossy().into(), name: format!("{name}.mp4"), kind: MediaKind::Video, duration_us: secs as Us * SECOND, width: 108, height: 192, fps: 10.0, has_audio: true, ..Default::default() }
    }

    /// A transparent PNG at project shape with an opaque rectangle (fractions of the frame).
    fn png(&self, name: &str, rgb: (u8, u8, u8), x: f64, y: f64, w: f64, h: f64) -> String {
        let out = self.dir.join(format!("{name}.png"));
        let a = format!("if(between(X,W*{x},W*{})*between(Y,H*{y},H*{}),255,0)", x + w, y + h);
        self.run(&["-f", "lavfi", "-i", "color=c=black@0:s=108x192,format=rgba", "-frames:v", "1", "-vf", &format!("geq=r={}:g={}:b={}:a='{a}'", rgb.0, rgb.1, rgb.2)], &out);
        out.to_string_lossy().into()
    }

    /// Every frame of the project at 54×96, 10 fps, as RGBA.
    fn frames(&self, p: &Project) -> Vec<Vec<u8>> {
        self.frames_of(build(&timeline_from(p, 0, false), Some(&VideoOut { width: W, height: H, fps: 10, pix_fmt: "rgba" }), true, false))
    }

    fn frames_of(&self, mut args: Vec<String>) -> Vec<Vec<u8>> {
        args.extend(["-map", "[vout]", "-f", "rawvideo", "pipe:1", "-map", "[aout]", "-f", "null", "-"].map(String::from));
        let out = self.ff.cmd().args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).output().unwrap();
        assert!(out.status.success(), "{}\n{}", String::from_utf8_lossy(&out.stderr), args.last().map_or("", |s| s.as_str()));
        out.stdout.chunks_exact((W * H * 4) as usize).map(|c| c.to_vec()).collect()
    }

    /// The exported picture through YUV, as export makes it.
    fn export_frames(&self, p: &Project) -> Vec<Vec<u8>> {
        let mut args = build(&timeline_from(p, 0, false), Some(&VideoOut { width: W, height: H, fps: 10, pix_fmt: "yuv420p" }), true, true);
        args.extend(["-map", "[vout]", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1", "-map", "[aout]", "-f", "null", "-"].map(String::from));
        let out = self.ff.cmd().args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).output().unwrap();
        assert!(out.status.success(), "{}\n{}", String::from_utf8_lossy(&out.stderr), args.last().map_or("", |s| s.as_str()));
        out.stdout.chunks_exact((W * H * 4) as usize).map(|c| c.to_vec()).collect()
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Mean RGB of a region (fractions of the frame).
fn mean(f: &[u8], x0: f64, y0: f64, x1: f64, y1: f64) -> [f64; 3] {
    let (xa, xb, ya, yb) = ((x0 * W as f64) as usize, (x1 * W as f64) as usize, (y0 * H as f64) as usize, (y1 * H as f64) as usize);
    let mut s = [0.0; 3];
    let mut n = 0.0f64;
    for y in ya..yb {
        for x in xa..xb {
            let o = (y * W as usize + x) * 4;
            for c in 0..3 {
                s[c] += f[o + c] as f64;
            }
            n += 1.0;
        }
    }
    s.map(|v| v / n.max(1.0))
}

fn near(a: [f64; 3], b: [f64; 3], tol: f64) -> bool {
    (0..3).all(|i| (a[i] - b[i]).abs() <= tol)
}

const RED: [f64; 3] = [254.0, 0.0, 0.0];
const BLUE: [f64; 3] = [0.0, 0.0, 254.0];
const WHITE: [f64; 3] = [255.0, 255.0, 255.0];

fn project(lab: &Lab, media: Vec<Media>) -> Project {
    let mut p = Project::new("T", "9:16");
    p.fps = 10;
    p.cache_dir = Some(lab.dir.to_string_lossy().into());
    p.media = media;
    p
}

fn text(png: &str, content: &str) -> TextSpec {
    let mut t = TextSpec::new();
    t.insert("content".into(), content.into());
    t.insert("png".into(), png.into());
    t
}

#[test]
fn text_and_pictures_composite_over_the_main_track_at_their_spot_and_time() {
    let Some(lab) = Lab::new("text") else { return };
    let blue = lab.colour("blue", "blue", 3);
    let mut p = project(&lab, vec![blue]);
    p.insert("blue", 0).unwrap();
    // A white box in the top-left quarter, from 1 s to 2 s.
    let png = lab.png("t", (255, 255, 255), 0.0, 0.0, 0.5, 0.5);
    p.add_overlay(None, Some(text(&png, "Hi")), SECOND, Some(SECOND), "text", None).unwrap();
    let f = lab.frames(&p);
    assert_eq!(f.len(), 30, "the overlay doesn't change the length");
    assert!(near(mean(&f[5], 0.05, 0.05, 0.45, 0.45), BLUE, 12.0), "not yet: {:?}", mean(&f[5], 0.05, 0.05, 0.45, 0.45));
    assert!(near(mean(&f[15], 0.05, 0.05, 0.45, 0.45), WHITE, 12.0), "the box at its spot: {:?}", mean(&f[15], 0.05, 0.05, 0.45, 0.45));
    assert!(near(mean(&f[15], 0.55, 0.55, 0.95, 0.95), BLUE, 12.0), "see-through elsewhere");
    assert!(near(mean(&f[25], 0.05, 0.05, 0.45, 0.45), BLUE, 12.0), "gone after 2 s");
    // Moved right by half the frame, half size, half opacity: the box lands in the top-right
    // quarter's middle, mixed with the blue.
    let tid = p.tracks[1].clips[0].id.clone();
    p.set_clip(&tid, ClipChange { pos_x: Some(540.0), opacity: Some(50.0), ..Default::default() }).unwrap();
    let f = lab.frames(&p);
    let tr = mean(&f[15], 0.55, 0.05, 0.95, 0.45);
    assert!(near(tr, [128.0, 128.0, 255.0], 25.0), "half white over blue: {tr:?}");
    assert!(near(mean(&f[15], 0.05, 0.05, 0.45, 0.45), BLUE, 12.0));
    // The same through export's YUV path.
    let e = lab.export_frames(&p);
    assert!(near(mean(&e[15], 0.6, 0.1, 0.9, 0.4), [128.0, 128.0, 255.0], 30.0), "{:?}", mean(&e[15], 0.6, 0.1, 0.9, 0.4));
    // Hidden, the track leaves the picture.
    let t = p.tracks[1].id.clone();
    p.set_track(&t, TrackChange { hidden: Some(true), ..Default::default() }).unwrap();
    assert!(near(mean(&lab.frames(&p)[15], 0.55, 0.05, 0.95, 0.45), BLUE, 12.0));
}

#[test]
fn a_transition_mixes_both_clips_at_the_cut_and_keeps_the_length() {
    let Some(lab) = Lab::new("xfade") else { return };
    let (red, blue) = (lab.colour("red", "red", 2), lab.colour("blue", "blue", 2));
    let mut p = project(&lab, vec![red, blue]);
    p.insert("red", 0).unwrap();
    let b = p.insert("blue", 9 * SECOND).unwrap();
    p.set_transition(&b, Some("Dissolve"), Some(SECOND)).unwrap();
    let f = lab.frames(&p);
    assert_eq!(f.len(), 40, "still 4 s");
    let (before, mid, after) = (mean(&f[10], 0.2, 0.2, 0.8, 0.8), mean(&f[20], 0.2, 0.2, 0.8, 0.8), mean(&f[30], 0.2, 0.2, 0.8, 0.8));
    assert!(near(before, RED, 12.0) && near(after, BLUE, 12.0), "{before:?} {after:?}");
    assert!(near(mid, [127.0, 0.0, 127.0], 30.0), "half and half at the cut: {mid:?}");
    // From the middle of the transition, playback picks up the same mix.
    let args = build(&timeline_from(&p, 2 * SECOND, false), Some(&VideoOut { width: W, height: H, fps: 10, pix_fmt: "rgba" }), true, false);
    let g = lab.frames_of(args);
    assert_eq!(g.len(), 20);
    assert!(near(mean(&g[0], 0.2, 0.2, 0.8, 0.8), mid, 20.0), "{:?} vs {mid:?}", mean(&g[0], 0.2, 0.2, 0.8, 0.8));
    // And a paused frame's window there too.
    let w = lab.frames_of(build(&timeline_window(&p, 2 * SECOND, 2 * SECOND + 200_000, false, false), Some(&VideoOut { width: W, height: H, fps: 10, pix_fmt: "rgba" }), true, false));
    assert!(near(mean(&w[0], 0.2, 0.2, 0.8, 0.8), mid, 20.0));
    // A wipe to the left, through export's YUV: the new clip comes in from the right.
    p.set_transition(&b, Some("Wipe left"), Some(SECOND)).unwrap();
    let e = lab.export_frames(&p);
    assert!(near(mean(&e[20], 0.0, 0.3, 0.3, 0.7), RED, 30.0) && near(mean(&e[20], 0.7, 0.3, 1.0, 0.7), BLUE, 30.0), "{:?} {:?}", mean(&e[20], 0.0, 0.3, 0.3, 0.7), mean(&e[20], 0.7, 0.3, 1.0, 0.7));
}

#[test]
fn an_adjustment_layer_grades_only_inside_its_range() {
    let Some(lab) = Lab::new("adjust") else { return };
    let red = lab.colour("red", "red", 3);
    let mut p = project(&lab, vec![red]);
    p.insert("red", 0).unwrap();
    let (adj, _) = p.add_overlay(None, None, SECOND, Some(SECOND), "adjust", None).unwrap();
    // Simple filters: in place, switched on between its times.
    p.set_clip(&adj, ClipChange { saturation: Some(-100.0), ..Default::default() }).unwrap();
    let args = build(&timeline_from(&p, 0, false), Some(&VideoOut { width: W, height: H, fps: 10, pix_fmt: "rgba" }), true, false);
    assert!(args.last().unwrap().contains("enable='between(t,1.000000,1.999999)'"), "{}", args.last().unwrap());
    let f = lab.frames(&p);
    let (a, b, c) = (mean(&f[5], 0.2, 0.2, 0.8, 0.8), mean(&f[15], 0.2, 0.2, 0.8, 0.8), mean(&f[25], 0.2, 0.2, 0.8, 0.8));
    assert!(near(a, RED, 15.0) && near(c, RED, 15.0), "untouched outside: {a:?} {c:?}");
    assert!((b[0] - b[1]).abs() < 15.0 && (b[1] - b[2]).abs() < 15.0, "grey inside: {b:?}");
    // An effect that needs more than one filter: split, trimmed and joined again.
    p.set_clip(&adj, ClipChange { saturation: Some(0.0), effects: Some(vec![Fx { name: "Invert".into(), amount: 100.0 }]), ..Default::default() }).unwrap();
    let f = lab.frames(&p);
    assert_eq!(f.len(), 30);
    let (a, b, c) = (mean(&f[5], 0.2, 0.2, 0.8, 0.8), mean(&f[15], 0.2, 0.2, 0.8, 0.8), mean(&f[25], 0.2, 0.2, 0.8, 0.8));
    assert!(near(a, RED, 15.0) && near(c, RED, 15.0), "{a:?} {c:?}");
    assert!(near(b, [1.0, 255.0, 255.0], 20.0), "inverted inside: {b:?}");
}

#[test]
fn blend_modes_mix_with_what_is_below() {
    let Some(lab) = Lab::new("blend") else { return };
    let red = lab.colour("red", "red", 2);
    let mut p = project(&lab, vec![red]);
    p.insert("red", 0).unwrap();
    // A blue box over the left half, multiplied: red times blue is black there.
    let png = lab.png("b", (0, 0, 255), 0.0, 0.0, 0.5, 1.0);
    p.media.push(Media { id: "box".into(), path: png, name: "box.png".into(), kind: MediaKind::Image, width: 108, height: 192, ..Default::default() });
    let (c, _) = p.add_overlay(Some("box"), None, 0, Some(2 * SECOND), "sticker", None).unwrap();
    p.set_clip(&c, ClipChange { blend: Some("multiply".into()), ..Default::default() }).unwrap();
    let f = lab.frames(&p);
    assert_eq!(f.len(), 20);
    assert!(mean(&f[10], 0.05, 0.2, 0.45, 0.8).iter().all(|v| *v < 20.0), "multiplied to black: {:?}", mean(&f[10], 0.05, 0.2, 0.45, 0.8));
    assert!(near(mean(&f[10], 0.55, 0.2, 0.95, 0.8), RED, 15.0), "untouched where the box isn't");
    p.set_clip(&c, ClipChange { blend: Some("screen".into()), ..Default::default() }).unwrap();
    let s = mean(&lab.frames(&p)[10], 0.05, 0.2, 0.45, 0.8);
    assert!(near(s, [254.0, 0.0, 254.0], 20.0), "screen adds them: {s:?}");
    // Only partly on screen: from 0.5 s to 1.5 s.
    p.trim(&c, 0, SECOND, Some(SECOND / 2)).unwrap();
    let f = lab.frames(&p);
    assert_eq!(f.len(), 20);
    assert!(near(mean(&f[2], 0.05, 0.2, 0.45, 0.8), RED, 15.0) && near(mean(&f[10], 0.05, 0.2, 0.45, 0.8), [254.0, 0.0, 254.0], 20.0) && near(mean(&f[17], 0.05, 0.2, 0.45, 0.8), RED, 15.0));
}

#[test]
fn every_effect_runs_on_the_main_track_and_on_an_overlay_keeping_its_alpha() {
    let Some(lab) = Lab::new("effects") else { return };
    let red = lab.colour("red", "red", 1);
    let mut p = project(&lab, vec![red]);
    let main = p.insert("red", 0).unwrap();
    let png = lab.png("w", (255, 255, 255), 0.3, 0.3, 0.4, 0.4);
    p.media.push(Media { id: "box".into(), path: png, name: "box.png".into(), kind: MediaKind::Image, width: 108, height: 192, ..Default::default() });
    let (over, _) = p.add_overlay(Some("box"), None, 0, Some(SECOND), "sticker", None).unwrap();
    for name in EFFECTS {
        let fx = Some(vec![Fx { name: name.to_string(), amount: 60.0 }]);
        let mut q = p.clone();
        q.set_clip(&main, ClipChange { effects: fx.clone(), ..Default::default() }).unwrap();
        assert_eq!(lab.frames(&q).len(), 10, "{name} on the main track");
        let mut q = p.clone();
        q.set_clip(&over, ClipChange { effects: fx, ..Default::default() }).unwrap();
        let f = lab.frames(&q);
        assert_eq!(f.len(), 10, "{name} on an overlay");
        // The corners stay the red below: the layer's alpha came through.
        let corner = mean(&f[5], 0.0, 0.0, 0.15, 0.1);
        assert!(corner[0] > 150.0 && corner[2] < 90.0, "{name} kept the overlay's alpha: {corner:?}");
    }
    // What a few of them do to the picture.
    let fx = |name: &str, amount: f32| {
        let mut q = p.clone();
        q.tracks.truncate(1);
        q.set_clip(&main, ClipChange { effects: Some(vec![Fx { name: name.into(), amount }]), ..Default::default() }).unwrap();
        mean(&lab.frames(&q)[5], 0.2, 0.2, 0.8, 0.8)
    };
    let inv = fx("Invert", 100.0);
    assert!(near(inv, [1.0, 255.0, 255.0], 20.0), "inverted red is cyan: {inv:?}");
    let bw = fx("Black & white", 100.0);
    assert!((bw[0] - bw[1]).abs() < 12.0 && (bw[0] - bw[2]).abs() < 12.0, "grey: {bw:?}");
    let sepia = fx("Sepia", 100.0);
    assert!(sepia[0] > sepia[1] && sepia[1] > sepia[2] && sepia[2] > 20.0, "sepia: {sepia:?}");
}

#[test]
fn masks_mattes_colour_extras_and_flips_change_the_picture() {
    let Some(lab) = Lab::new("mask") else { return };
    let red = lab.colour("red", "red", 1);
    let mut p = project(&lab, vec![red]);
    let c = p.insert("red", 0).unwrap();
    // Keep the left half: the right goes black.
    let mask = lab.png("m", (255, 255, 255), 0.0, 0.0, 0.5, 1.0);
    p.set_clip(&c, ClipChange { mask: Some(Some(Mask { shape: "rect".into(), w: 0.5, h: 1.0, ..Default::default() })), mask_png: Some(Some(mask)), ..Default::default() }).unwrap();
    let f = lab.frames(&p);
    assert!(near(mean(&f[5], 0.05, 0.2, 0.4, 0.8), RED, 15.0) && mean(&f[5], 0.6, 0.2, 0.95, 0.8).iter().all(|v| *v < 15.0), "{:?} {:?}", mean(&f[5], 0.05, 0.2, 0.4, 0.8), mean(&f[5], 0.6, 0.2, 0.95, 0.8));
    // A matte: a grey video that is white on top, black below.
    let matte = lab.dir.join("matte.mp4");
    lab.run(&["-f", "lavfi", "-i", "color=c=black:s=108x192:r=10:d=1,drawbox=x=0:y=0:w=108:h=96:color=white:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], &matte);
    p.set_clip(&c, ClipChange { mask_png: Some(None), matte: Some(Some(Matte { path: matte.to_string_lossy().into() })), ..Default::default() }).unwrap();
    let f = lab.frames(&p);
    assert!(near(mean(&f[5], 0.1, 0.05, 0.9, 0.4), RED, 20.0) && mean(&f[5], 0.1, 0.6, 0.9, 0.95).iter().all(|v| *v < 20.0), "{:?}", mean(&f[5], 0.1, 0.6, 0.9, 0.95));
    // HSL: red's hue turned, curves pulling red down, a lift wheel and an identity LUT at half.
    let lut = lab.dir.join("id.cube");
    std::fs::write(&lut, "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n").unwrap();
    let mut hsl = HslMap::new();
    hsl.insert("Red".into(), Hsl { h: 100.0, s: 0.0, l: 0.0 });
    p.set_clip(&c, ClipChange { matte: Some(None), hsl: Some(hsl), lut: Some(Some(Lut { path: lut.to_string_lossy().into(), strength: 50.0 })), ..Default::default() }).unwrap();
    let turned = mean(&lab.frames(&p)[5], 0.2, 0.2, 0.8, 0.8);
    assert!(turned[0] < 200.0 && (turned[1] > 60.0 || turned[2] > 60.0), "red's hue moved: {turned:?}");
    p.set_clip(&c, ClipChange { hsl: Some(HslMap::new()), lut: Some(None), curves: Some(Curves { red: Some(vec![[0.0, 0.0], [1.0, 0.5]]), ..Default::default() }), ..Default::default() }).unwrap();
    let halved = mean(&lab.frames(&p)[5], 0.2, 0.2, 0.8, 0.8);
    assert!((halved[0] - 128.0).abs() < 20.0, "the red curve halves red: {halved:?}");
    p.set_clip(&c, ClipChange { curves: Some(Curves::default()), wheels: Some(Wheels { lift: Some(Wheel { x: 0.0, y: 0.0, lum: 100.0 }), ..Default::default() }), ..Default::default() }).unwrap();
    let lifted = mean(&lab.frames(&p)[5], 0.2, 0.2, 0.8, 0.8);
    assert!(lifted[1] > 25.0 && lifted[2] > 25.0, "lifted blacks: {lifted:?}");
    // Upside down: a picture that's white on top shows white below.
    let half = lab.dir.join("half.mp4");
    lab.run(&["-f", "lavfi", "-i", "color=c=black:s=108x192:r=10:d=1,drawbox=x=0:y=0:w=108:h=96:color=white:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], &half);
    let mut q = project(&lab, vec![Media { id: "h".into(), path: half.to_string_lossy().into(), name: "h".into(), kind: MediaKind::Video, duration_us: SECOND, width: 108, height: 192, fps: 10.0, ..Default::default() }]);
    let h = q.insert("h", 0).unwrap();
    q.set_clip(&h, ClipChange { flip_v: Some(true), ..Default::default() }).unwrap();
    let f = lab.frames(&q);
    assert!(mean(&f[5], 0.2, 0.6, 0.8, 0.9)[0] > 200.0 && mean(&f[5], 0.2, 0.1, 0.8, 0.4)[0] < 40.0);
    // transformOn off bypasses the scale.
    q.set_clip(&h, ClipChange { flip_v: Some(false), scale: Some(10.0), transform_on: Some(false), ..Default::default() }).unwrap();
    assert!(mean(&lab.frames(&q)[5], 0.2, 0.1, 0.8, 0.4)[0] > 200.0);
}

#[test]
fn animation_presets_move_overlays_over_their_time() {
    let Some(lab) = Lab::new("anim") else { return };
    let blue = lab.colour("blue", "blue", 2);
    let mut p = project(&lab, vec![blue]);
    p.insert("blue", 0).unwrap();
    let png = lab.png("t", (255, 255, 255), 0.25, 0.25, 0.5, 0.5);
    let (t, _) = p.add_overlay(None, Some(text(&png, "Go")), 0, Some(2 * SECOND), "text", None).unwrap();
    let anim = Anim { in_: Some(AnimStep { name: "Fade".into(), duration_us: SECOND }), out: None, loop_: None };
    p.set_clip(&t, ClipChange { anim: Some(anim), ..Default::default() }).unwrap();
    let f = lab.frames(&p);
    let (start, half, end) = (mean(&f[0], 0.4, 0.4, 0.6, 0.6), mean(&f[5], 0.4, 0.4, 0.6, 0.6), mean(&f[15], 0.4, 0.4, 0.6, 0.6));
    assert!(near(start, BLUE, 20.0) && near(end, WHITE, 15.0) && half[0] > 80.0 && half[0] < 180.0, "fades in: {start:?} {half:?} {end:?}");
    // Typewriter: the left of the box shows before the right.
    p.set_clip(&t, ClipChange { anim: Some(Anim { in_: Some(AnimStep { name: "Typewriter".into(), duration_us: SECOND }), out: None, loop_: None }), text: Some(serde_json::from_str(r#"{ "boxW": 540, "boxH": 960 }"#).unwrap()), ..Default::default() }).unwrap();
    let f = lab.frames(&p);
    let (l, r) = (mean(&f[5], 0.27, 0.4, 0.35, 0.6), mean(&f[5], 0.65, 0.4, 0.73, 0.6));
    assert!(l[0] > 200.0 && r[0] < 60.0, "half typed: {l:?} {r:?}");
    assert!(mean(&f[15], 0.65, 0.4, 0.73, 0.6)[0] > 200.0, "all typed by 1.5 s");
    // A loop and a slide run.
    p.set_clip(&t, ClipChange { anim: Some(Anim { in_: Some(AnimStep { name: "Slide up".into(), duration_us: SECOND }), out: Some(AnimStep { name: "Pop".into(), duration_us: 500_000 }), loop_: Some(AnimLoop { name: "Wiggle".into(), period_us: SECOND }) }), ..Default::default() }).unwrap();
    assert_eq!(lab.frames(&p).len(), 20);
}

#[test]
fn overlay_clips_back_to_back_cover_the_main_track_at_every_frame() {
    // Repro (2026-11-07): clips cut and lifted onto an overlay track, end to end, let the main
    // track's picture through for a frame at each cut (an overlay drops its stream's last frame).
    let Some(lab) = Lab::new("abut") else { return };
    let red = lab.colour("red", "red", 4);
    let blue = lab.colour("blue", "blue", 2);
    let white = lab.colour("white", "white", 2);
    let mut p = project(&lab, vec![red, blue, white]);
    p.insert("red", 0).unwrap();
    let (a, track) = p.add_overlay(Some("blue"), None, 0, None, "overlay", None).unwrap();
    let (b, _) = p.add_overlay(Some("white"), None, 2 * SECOND, None, "overlay", Some(&track)).unwrap();
    assert_eq!(p.clip(&a).unwrap().start_us + p.clip(&a).unwrap().duration_us, p.clip(&b).unwrap().start_us, "end to end");
    let f = lab.frames(&p);
    assert_eq!(f.len(), 40);
    for (i, fr) in f.iter().enumerate() {
        let c = mean(fr, 0.3, 0.3, 0.7, 0.7);
        let want = if i < 20 { BLUE } else { WHITE };
        assert!(near(c, want, 40.0), "frame {i} ({:.1} s) shows {c:?}, not the overlay", i as f64 / 10.0);
    }
}

#[test]
fn overlay_pieces_cut_between_frames_cover_the_main_track_at_every_frame() {
    // The user's case: pieces cut at any moment (in-points and cuts between frames), lifted
    // onto an overlay track end to end.
    let Some(lab) = Lab::new("abut2") else { return };
    let red = lab.colour("red", "red", 6);
    let blue = lab.colour("blue", "blue", 6);
    let white = lab.colour("white", "white", 6);
    let mut p = project(&lab, vec![red, blue, white]);
    p.insert("red", 0).unwrap();
    let (a, track) = p.add_overlay(Some("blue"), None, 0, None, "overlay", None).unwrap();
    let (b, _) = p.add_overlay(Some("white"), None, 4 * SECOND, None, "overlay", Some(&track)).unwrap();
    let mut bad = vec![];
    for (a_in, a_start, a_dur, b_in) in [(333_333, 120_000, 1_437_000, 2_051_000), (47_000, 0, 1_963_000, 666_667), (1_250_000, 37_000, 2_010_000, 13_000), (500_000, 0, 2_000_000, 500_000)] {
        for c in p.tracks.iter_mut().flat_map(|t| t.clips.iter_mut()) {
            if c.id == a {
                (c.in_us, c.start_us, c.duration_us) = (a_in, a_start, a_dur);
            }
            if c.id == b {
                (c.in_us, c.start_us, c.duration_us) = (b_in, a_start + a_dur, 1_500_000);
            }
        }
        let f = lab.frames(&p);
        let end = a_start + a_dur + 1_500_000;
        for (i, fr) in f.iter().enumerate() {
            let t = i as Us * 100_000;
            if t < a_start || t >= end {
                continue;
            }
            let c = mean(fr, 0.3, 0.3, 0.7, 0.7);
            if near(c, RED, 60.0) {
                bad.push(format!("in {a_in}, cut at {}: frame {i} ({:.1} s) shows the main track", a_start + a_dur, t as f64 / 1e6));
            }
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn speed_ramps_smooth_slow_motion_and_video_overlays_run() {
    let Some(lab) = Lab::new("ramp") else { return };
    // Brighter over 2 s, so time order shows in the picture.
    let ramp = lab.dir.join("ramp.mp4");
    lab.run(&["-f", "lavfi", "-i", "color=c=white:s=108x192:r=10:d=2,geq=lum='255*T/2':cb=128:cr=128", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], &ramp);
    let m = Media { id: "r".into(), path: ramp.to_string_lossy().into(), name: "r".into(), kind: MediaKind::Video, duration_us: 2 * SECOND, width: 108, height: 192, fps: 10.0, ..Default::default() };
    let mut p = project(&lab, vec![m]);
    let c = p.insert("r", 0).unwrap();
    // Slow (0.5×) then fast (3×): the mean speed is about 1.75, and halfway through the clip
    // only a quarter of the source has gone by.
    p.set_clip(&c, ClipChange { speed_curve: Some(Some(SpeedCurve { name: "Bullet".into(), points: vec![[0.0, 0.5], [0.5, 0.5], [0.5001, 3.0], [1.0, 3.0]] })), ..Default::default() }).unwrap();
    let clip = p.clip(&c).unwrap().clone();
    let f = lab.frames(&p);
    assert_eq!(f.len() as Us, clip.duration_us / 100_000);
    let mid = f.len() / 2;
    let lum = |fr: &Vec<u8>| mean(fr, 0.2, 0.2, 0.8, 0.8)[0];
    assert!((lum(&f[mid]) - 255.0 * 0.15).abs() < 30.0, "a seventh of the source at the clip's middle: {}", lum(&f[mid]));
    // Smooth slow motion on export at half speed.
    p.set_clip(&c, ClipChange { speed: Some(0.5), smooth: Some(Some(Smooth { quality: "Fast".into() })), ..Default::default() }).unwrap();
    let mut args = build(&crate::graph::timeline_export(&p), Some(&VideoOut { width: W, height: H, fps: 10, pix_fmt: "yuv420p" }), true, true);
    assert!(args.last().unwrap().contains("framerate=fps=10"));
    args.extend(["-map", "[vout]", "-f", "null", "-", "-map", "[aout]", "-f", "null", "-"].map(String::from));
    assert!(lab.ff.cmd().args(&args).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success());
    // The ramp clip as an overlay, reversed and keyframed, runs too.
    let mut q = project(&lab, p.media.clone());
    q.insert("r", 0).unwrap();
    let (o, _) = q.add_overlay(Some("r"), None, 0, None, "overlay", None).unwrap();
    q.set_clip(&o, ClipChange { reverse: Some(true), scale: Some(50.0), rotation: Some(30.0), ..Default::default() }).unwrap();
    let f = lab.frames(&q);
    assert_eq!(f.len(), 20);
    assert!(mean(&f[2], 0.0, 0.0, 0.15, 0.1)[0] < 120.0, "the main track shows dark at first");
    assert!(mean(&f[2], 0.4, 0.45, 0.6, 0.55)[0] > 150.0, "the reversed overlay starts bright in the middle");
}

#[test]
fn sound_follows_pitch_spectral_edits_and_crossfades() {
    let Some(lab) = Lab::new("sound") else { return };
    let tone = lab.dir.join("tone.wav");
    lab.run(&["-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-af", "volume=6dB"], &tone);
    let m = Media { id: "t".into(), path: tone.to_string_lossy().into(), name: "t".into(), kind: MediaKind::Audio, duration_us: 4 * SECOND, has_audio: true, ..Default::default() };
    let mut p = project(&lab, vec![m]);
    let c = p.insert("t", 0).unwrap();
    // RMS of the mix per second.
    let rms = |p: &Project| -> Vec<f64> {
        let mut args = build(&timeline_from(p, 0, false), None, true, false);
        args.extend(["-map", "[aout]", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"].map(String::from));
        let out = lab.ff.cmd().args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let s: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        s.chunks(8000).map(|c| (c.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / c.len() as f64).sqrt()).collect()
    };
    let plain = rms(&p);
    // Take 300–600 Hz out between 1 s and 2 s: the 440 Hz tone drops there only.
    p.spectral_delete(&c, SECOND, 2 * SECOND, 300.0, 600.0).unwrap();
    let cut = rms(&p);
    assert!(cut[1] < plain[1] * 0.3 && (cut[0] - plain[0]).abs() < plain[0] * 0.1 && (cut[3] - plain[3]).abs() < plain[3] * 0.1, "{plain:?} {cut:?}");
    // Pitch follows speed: twice as fast is half as long either way.
    p.set_clip(&c, ClipChange { speed: Some(2.0), keep_pitch: Some(false), spectral: Some(vec![]), ..Default::default() }).unwrap();
    let args = build(&timeline_from(&p, 0, false), None, true, false);
    assert!(args.last().unwrap().contains("asetrate=96000,aresample=48000"), "{}", args.last().unwrap());
    assert_eq!(rms(&p).len(), 2);
    // A crossfade: the two tones overlap by a second, each fading.
    let mut q = project(&lab, p.media.clone());
    let a = q.insert("t", 0).unwrap();
    let b = q.insert("t", 6 * SECOND).unwrap();
    q.crossfade(&a, &b, SECOND).unwrap();
    let x = rms(&q);
    assert_eq!(x.len(), 7, "4 + 4 − 1 s");
    assert!(x[3] > plain[0] * 0.5 && x[3] < plain[0] * 1.6, "the overlap neither drops out nor doubles: {x:?}");
    // A speed ramp is silent.
    let mut r = project(&lab, p.media.clone());
    let d = r.insert("t", 0).unwrap();
    r.set_clip(&d, ClipChange { speed_curve: Some(Some(SpeedCurve { name: String::new(), points: vec![[0.0, 1.0], [1.0, 2.0]] })), ..Default::default() }).unwrap();
    assert!(rms(&r).iter().all(|v| *v < 1e-4));
}

#[test]
fn sound_read_from_inside_a_file_and_delayed_keeps_the_whole_mix() {
    let Some(lab) = Lab::new("delayed") else { return };
    // A phone clip cut at 7.8 s, its first part deleted: the rest's sound is read from 7.8 s in
    // and delayed to its place. adelay used to stamp that sound's first frames with no time,
    // which ended the whole mix there (and a loudness check after it never ended).
    let clip = lab.dir.join("clip.mp4");
    lab.run(&["-f", "lavfi", "-i", "testsrc2=s=108x192:r=25:d=11", "-f", "lavfi", "-i", "sine=frequency=440:duration=11:sample_rate=48000", "-ac", "2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac"], &clip);
    let m = Media { id: "c".into(), path: clip.to_string_lossy().into(), name: "clip.mp4".into(), kind: MediaKind::Video, duration_us: 11 * SECOND, width: 108, height: 192, fps: 25.0, has_audio: true, ..Default::default() };
    // A silent picture first, so the cut part's sound is the mix's first input, as it was in the project that hit this.
    let mut p = project(&lab, vec![m, lab.colour("still", "blue", 2)]);
    p.media[1].has_audio = false;
    p.insert("still", 0).unwrap();
    let c = p.insert("c", 2 * SECOND).unwrap();
    p.split(2 * SECOND + 7_836_021, &[c.clone()]).unwrap();
    p.delete(&[c]).unwrap();
    let tone = lab.dir.join("tone.wav");
    lab.run(&["-f", "lavfi", "-i", "sine=frequency=440:duration=5"], &tone);
    p.media.push(Media { id: "t".into(), path: tone.to_string_lossy().into(), name: "t".into(), kind: MediaKind::Audio, duration_us: 5 * SECOND, has_audio: true, ..Default::default() });
    p.insert("t", 0).unwrap();
    let mut args = build(&timeline_from(&p, 0, false), None, true, false);
    assert!(args.last().unwrap().contains("adelay=2000"), "{}", args.last().unwrap());
    // At most 8 s out: without the fix the mix never ended.
    args.extend(["-map", "[aout]", "-t", "8", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"].map(String::from));
    let out = lab.ff.cmd().args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let s: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let rms: Vec<f64> = s.chunks(8000).map(|c| (c.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / c.len() as f64).sqrt()).collect();
    // The cut part plays from 2 s to about 5.2 s, over the tone's 5 s.
    assert!(rms.len() == 6 && rms[..5].iter().all(|v| *v > 0.05), "the mix runs to the end: {rms:?}");
}

#[test]
fn webm_stickers_keep_their_alpha_and_a_hidden_main_track_plays_black() {
    let Some(lab) = Lab::new("webm") else { return };
    let red = lab.colour("red", "red", 1);
    // A WebM sticker: white on its left half, see-through on the right (VP9 with alpha).
    let webm = lab.dir.join("s.webm");
    lab.run(&["-f", "lavfi", "-i", "color=c=black@0:s=108x192:r=10:d=1,format=yuva420p,geq=lum=235:cb=128:cr=128:a='if(lt(X,54),255,0)'", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0"], &webm);
    let mut p = project(&lab, vec![red, Media { id: "s".into(), path: webm.to_string_lossy().into(), name: "s.webm".into(), kind: MediaKind::Video, duration_us: SECOND, width: 108, height: 192, fps: 10.0, codec: Some("vp9".into()), ..Default::default() }]);
    p.insert("red", 0).unwrap();
    p.add_overlay(Some("s"), None, 0, None, "sticker", None).unwrap();
    let f = lab.frames(&p);
    let (l, r) = (mean(&f[5], 0.05, 0.3, 0.45, 0.7), mean(&f[5], 0.55, 0.3, 0.95, 0.7));
    assert!(near(l, WHITE, 20.0) && near(r, RED, 20.0), "white where the sticker is opaque, red through it elsewhere: {l:?} {r:?}");
    // Hidden, the main track's picture is black but its sound still plays.
    let main = p.main_track().id.clone();
    p.set_track(&main, TrackChange { hidden: Some(true), ..Default::default() }).unwrap();
    let tl = timeline_from(&p, 0, false);
    assert!(tl.main[0].black && tl.main[0].has_audio);
    let f = lab.frames(&p);
    assert!(mean(&f[5], 0.55, 0.3, 0.95, 0.7).iter().all(|v| *v < 10.0) && near(mean(&f[5], 0.05, 0.3, 0.45, 0.7), WHITE, 20.0));
}

#[test]
fn stabilising_uses_the_transforms_once_they_exist() {
    let Some(lab) = Lab::new("stab") else { return };
    let red = lab.colour("red", "red", 1);
    let mut p = project(&lab, vec![red]);
    let c = p.insert("red", 0).unwrap();
    p.set_clip(&c, ClipChange { stabilize: Some(Some(Stabilize { strength: 60.0 })), ..Default::default() }).unwrap();
    let jobs = crate::graph::stab_jobs(&p, false);
    assert_eq!(jobs.len(), 1, "one analysis for the clip");
    assert!(!build(&timeline_from(&p, 0, false), Some(&VideoOut { width: W, height: H, fps: 10, pix_fmt: "rgba" }), false, false).last().unwrap().contains("vidstab"), "not ready: plays unstabilised");
    lab.ff.stabilize_detect(Path::new(&jobs[0].path), jobs[0].in_us, jobs[0].span_us, Path::new(&jobs[0].trf), false).unwrap();
    assert!(crate::graph::stab_jobs(&p, false).is_empty());
    let args = build(&timeline_from(&p, 0, false), Some(&VideoOut { width: W, height: H, fps: 10, pix_fmt: "rgba" }), true, false);
    assert!(args.last().unwrap().contains("vidstabtransform=input="), "{}", args.last().unwrap());
    assert_eq!(lab.frames(&p).len(), 10);
    // From the middle, it still reads the clip from its start (as the transforms count) and
    // trims to where playback starts.
    let mid = build(&timeline_from(&p, SECOND / 2, false), Some(&VideoOut { width: W, height: H, fps: 10, pix_fmt: "rgba" }), false, false);
    assert!(mid.windows(2).any(|w| w[0] == "-ss" && w[1] == "0.000000") && mid.last().unwrap().contains("vidstabtransform") && mid.last().unwrap().contains("trim=start=0.500000,setpts=PTS-STARTPTS"), "{mid:?}");
    assert_eq!(lab.frames_of(build(&timeline_from(&p, SECOND / 2, false), Some(&VideoOut { width: W, height: H, fps: 10, pix_fmt: "rgba" }), true, false)).len(), 5);
}

#[test]
fn playing_in_stretches_shows_the_same_frames_as_one_run() {
    let Some(lab) = Lab::new("stretches") else { return };
    let (red, blue) = (lab.colour("red", "red", 2), lab.colour("blue", "blue", 2));
    let mut p = project(&lab, vec![red, blue]);
    p.insert("red", 0).unwrap();
    let b = p.insert("blue", 9 * SECOND).unwrap();
    p.set_transition(&b, Some("Dissolve"), Some(600_000)).unwrap();
    // A box over both clips and the cut, so stretch ends fall inside it.
    let png = lab.png("box", (255, 255, 255), 0.1, 0.1, 0.4, 0.4);
    p.add_overlay(None, Some(text(&png, "Box")), 500_000, Some(3 * SECOND), "text", None).unwrap();
    // Keyframes run on the clip's own clock from wherever a run starts, so they may be cut.
    let moving = |from: f64, to: f64| {
        let mut k = Keyframes::new();
        k.insert("posX".into(), vec![Keyframe { at_us: 0, value: from, ..Default::default() }, Keyframe { at_us: 3 * SECOND, value: to, ..Default::default() }]);
        k
    };
    let red_clip = p.main_track().clips[0].id.clone();
    let box_clip = p.tracks[1].clips[0].id.clone();
    let plain = p.clone();
    p.set_clip(&red_clip, ClipChange { scale: Some(150.0), keyframes: Some(moving(-200.0, 200.0)), ..Default::default() }).unwrap();
    p.set_clip(&box_clip, ClipChange { keyframes: Some(moving(-300.0, 300.0)), ..Default::default() }).unwrap();
    for (p, animated) in [(plain, false), (p, true)] {
        let video = VideoOut { width: W, height: H, fps: 10, pix_fmt: "rgba" };
        let frame = 100_000;
        let whole = lab.frames_of(build(&timeline_from(&p, 0, true), Some(&video), true, false));
        // As playback goes: each stretch's frames up to its end, then the next run's.
        let mut joined = vec![];
        let mut ends = vec![];
        let mut from = 0;
        while from < p.duration_us() {
            let end = crate::graph::window_end(&p, from, 700_000, frame);
            let f = lab.frames_of(build(&crate::graph::timeline_stretch(&p, from, end, frame), Some(&video), true, false));
            joined.extend(f.into_iter().take(((end - from + frame - 1) / frame) as usize));
            ends.push(end);
            from = end;
        }
        assert_eq!(ends, [700_000, 1_400_000, 2_500_000, 3_200_000, 3_900_000, 4_000_000], "never inside the transition (1.7–2.3 s), nor just after it");
        assert_eq!(joined.len(), whole.len());
        for (i, (a, b)) in whole.iter().zip(&joined).enumerate() {
            let diff = a.iter().zip(b.iter()).map(|(x, y)| x.abs_diff(*y) as u64).sum::<u64>() as f64 / a.len() as f64;
            // Moving pictures can land a pixel apart (their positions are rounded from another start).
            assert!(diff < if animated { 4.0 } else { 1.0 }, "frame {i} differs by {diff:.2} on average");
        }
    }
}

/// Frames of `p` (rgba, or export's YUV) drawn with captions rows as one layer and stills in
/// stretches, and with every clip on its own.
fn both_ways(lab: &Lab, p: &Project, pix_fmt: &'static str) -> (Vec<Vec<u8>>, Vec<Vec<u8>>, String) {
    both_ways_from(lab, p, pix_fmt, 0)
}

/// `both_ways` from `from` on the timeline.
fn both_ways_from(lab: &Lab, p: &Project, pix_fmt: &'static str, from: Us) -> (Vec<Vec<u8>>, Vec<Vec<u8>>, String) {
    let video = VideoOut { width: W, height: H, fps: 10, pix_fmt };
    let draw = |args: Vec<String>| {
        // Read back as RGBA whatever the graph ends in.
        let mut args = args;
        args.extend(["-map", "[vout]", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1", "-map", "[aout]", "-f", "null", "-"].map(String::from));
        let out = lab.ff.cmd().args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        out.stdout.chunks_exact((W * H * 4) as usize).map(|c| c.to_vec()).collect::<Vec<_>>()
    };
    let args = build(&timeline_from(p, from, false), Some(&video), true, false);
    let fc = args.iter().skip_while(|a| *a != "-filter_complex").nth(1).cloned().unwrap_or_default();
    let fast = draw(args);
    crate::compose::PLAIN_LAYERS.with(|c| c.set(true));
    let plain = draw(build(&timeline_from(p, from, false), Some(&video), true, false));
    crate::compose::PLAIN_LAYERS.with(|c| c.set(false));
    if let Ok(dir) = std::env::var("STUDIO_TEST_DUMP") {
        for (name, frames) in [("fast", &fast), ("plain", &plain)] {
            for (i, f) in frames.iter().enumerate() {
                std::fs::write(format!("{dir}/{pix_fmt}-{name}-{i:02}.rgba"), f).unwrap();
            }
        }
        std::fs::write(format!("{dir}/{pix_fmt}-fc.txt"), &fc).unwrap();
    }
    (fast, plain, fc)
}

fn mean_diff(a: &[u8], b: &[u8]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x.abs_diff(*y) as u64).sum::<u64>() as f64 / a.len() as f64
}

#[test]
fn a_captions_row_is_one_layer_and_looks_the_same_as_a_layer_per_line() {
    let Some(lab) = Lab::new("captionrow") else { return };
    let blue = lab.colour("blue", "blue", 3);
    let mut p = project(&lab, vec![blue]);
    p.insert("blue", 0).unwrap();
    // Three lines one after another (a gap before the last), each drawn somewhere else.
    let spots = [(0.0, 0.0), (0.5, 0.0), (0.0, 0.5)];
    let times = [(0, 800_000), (800_000, 1_600_000), (2_000_000, 2_600_000)];
    let mut track = None;
    for (i, ((x, y), (a, b))) in spots.iter().zip(times).enumerate() {
        let png = lab.png(&format!("l{i}"), (255, 255, 255), *x, *y, 0.5, 0.5);
        let (c, t) = p.add_overlay(None, Some(text(&png, "Line")), a, Some(b - a), "text", track.as_deref()).unwrap();
        p.set_clip(&c, ClipChange { scale: Some(80.0), pos_y: Some(-100.0), ..Default::default() }).unwrap();
        track = Some(t);
    }
    assert_eq!(p.tracks.len(), 2, "one row");
    for pix in ["rgba", "yuv420p"] {
        let (fast, plain, fc) = both_ways(&lab, &p, pix);
        assert_eq!(fc.matches("overlay=").count(), 1, "one overlay for the row: {fc}");
        assert!(fc.contains("interleave=nb_inputs=3"), "{fc}");
        assert_eq!(fast.len(), plain.len());
        for (i, (a, b)) in fast.iter().zip(&plain).enumerate() {
            assert!(mean_diff(a, b) < 1.5, "{pix} frame {i} differs by {:.2}", mean_diff(a, b));
        }
        // The lines at their times, and nothing in the gap.
        let at = |f: &Vec<u8>, x: f64, y: f64| mean(f, x, y, x + 0.2, y + 0.1);
        assert!(at(&fast[5], 0.15, 0.1)[0] > 200.0 && at(&fast[12], 0.65, 0.1)[0] > 200.0 && at(&fast[22], 0.15, 0.55)[0] > 200.0, "{pix}: lines at their spots");
        assert!(near(at(&fast[18], 0.15, 0.1), BLUE, 30.0) && near(at(&fast[18], 0.15, 0.55), BLUE, 30.0), "{pix}: nothing in the gap");
    }
}

#[test]
fn a_still_that_turns_and_sizes_only_now_and_then_runs_in_stretches_and_looks_the_same() {
    let Some(lab) = Lab::new("stretchedstill") else { return };
    let blue = lab.colour("blue", "blue", 3);
    let mut p = project(&lab, vec![blue]);
    p.insert("blue", 0).unwrap();
    let png = lab.png("card", (255, 255, 255), 0.25, 0.35, 0.5, 0.3);
    p.media.push(Media { id: "card".into(), path: png, name: "card.png".into(), kind: MediaKind::Image, width: 108, height: 192, ..Default::default() });
    let (c, _) = p.add_overlay(Some("card"), None, 0, Some(3 * SECOND), "sticker", None).unwrap();
    // Flies in turning and growing for 0.5 s, holds, then shrinks away from 1.5 s to 2.5 s.
    let key = |v: &[(Us, f64)]| v.iter().map(|&(at_us, value)| Keyframe { at_us, value, ..Default::default() }).collect::<Vec<_>>();
    let mut k = Keyframes::new();
    k.insert("rotation".into(), key(&[(0, 30.0), (500_000, -5.0)]));
    k.insert("scale".into(), key(&[(0, 20.0), (500_000, 100.0), (1_500_000, 100.0), (2_500_000, 10.0)]));
    p.set_clip(&c, ClipChange { keyframes: Some(k), ..Default::default() }).unwrap();
    for pix in ["rgba", "yuv420p"] {
        let (fast, plain, fc) = both_ways(&lab, &p, pix);
        assert!(fc.contains("split=4"), "four stretches: {fc}");
        assert_eq!(fc.matches("rotate=a='").count(), 1, "turned frame by frame only while it turns: {fc}");
        for (i, (a, b)) in fast.iter().zip(&plain).enumerate() {
            assert!(mean_diff(a, b) < 3.0, "{pix} frame {i} differs by {:.2}", mean_diff(a, b));
        }
    }
}

#[test]
fn a_still_that_turns_and_sizes_plays_from_its_motion_file_once_made_and_looks_the_same() {
    let Some(lab) = Lab::new("motionfile") else { return };
    let blue = lab.colour("blue", "blue", 3);
    let mut p = project(&lab, vec![blue]);
    p.insert("blue", 0).unwrap();
    p.cache_dir = Some(lab.dir.join("cache").to_string_lossy().into());
    let png = lab.png("card", (255, 255, 255), 0.25, 0.35, 0.5, 0.3);
    p.media.push(Media { id: "card".into(), path: png, name: "card.png".into(), kind: MediaKind::Image, width: 108, height: 192, ..Default::default() });
    let (c, _) = p.add_overlay(Some("card"), None, 0, Some(3 * SECOND), "sticker", None).unwrap();
    // Flies up into place turning and growing for 0.5 s, holds, then shrinks away.
    let key = |v: &[(Us, f64)]| v.iter().map(|&(at_us, value)| Keyframe { at_us, value, ..Default::default() }).collect::<Vec<_>>();
    let mut k = Keyframes::new();
    k.insert("rotation".into(), key(&[(0, 30.0), (500_000, -5.0)]));
    k.insert("scale".into(), key(&[(0, 20.0), (500_000, 100.0), (1_500_000, 100.0), (2_500_000, 10.0)]));
    k.insert("posY".into(), key(&[(0, 60.0), (500_000, 0.0)]));
    p.set_clip(&c, ClipChange { keyframes: Some(k.clone()), ..Default::default() }).unwrap();
    let video = VideoOut { width: W, height: H, fps: 10, pix_fmt: "rgba" };
    let fc = |p: &Project| build(&timeline_from(p, 0, false), Some(&video), true, false).into_iter().skip_while(|a| a != "-filter_complex").nth(1).unwrap_or_default();
    // Until it's made, turned and sized as it plays.
    let jobs = crate::motion::motion_jobs(&p, W, H, 10);
    assert_eq!(jobs.len(), 1, "one file to make");
    // The card is drawn the frame's size: at 1080×1920 its file would be too big to be worth it.
    assert!(crate::motion::motion_jobs(&p, 1080, 1920, 30).is_empty(), "sized as it plays");
    assert!(fc(&p).contains("rotate=a='"), "not made yet: {}", fc(&p));
    lab.ff.render_motion(&jobs[0], false).unwrap();
    assert!(crate::motion::motion_jobs(&p, W, H, 10).is_empty(), "made");
    for (from, pix) in [(0, "rgba"), (SECOND, "rgba"), (0, "yuv420p")] {
        let (fast, plain, fc) = both_ways_from(&lab, &p, pix, from);
        if pix == "rgba" {
            assert!(!fc.contains("rotate=") && !fc.contains("eval=frame:flags"), "nothing turned or sized as it plays: {fc}");
            assert_eq!(fc.matches("overlay=").count(), 1, "one overlay for the picture: {fc}");
        } else {
            assert!(!fc.contains("motion-"), "an export draws from the picture itself: {fc}");
        }
        assert_eq!(fast.len(), plain.len());
        for (i, (a, b)) in fast.iter().zip(&plain).enumerate() {
            assert!(mean_diff(a, b) < 3.0, "{pix} from {from} frame {i} differs by {:.2}", mean_diff(a, b));
        }
    }
    // A file no clip uses any more is removed; the one in use stays.
    let file = std::path::PathBuf::from(&jobs[0].out);
    crate::motion::prune_motion(&p, W, H, 10);
    assert!(file.is_file(), "still used");
    k.insert("rotation".into(), key(&[(0, 10.0), (500_000, -5.0)]));
    p.set_clip(&c, ClipChange { keyframes: Some(k), ..Default::default() }).unwrap();
    assert_eq!(crate::motion::motion_jobs(&p, W, H, 10).len(), 1, "a new turn is a new file");
    crate::motion::prune_motion(&p, W, H, 10);
    assert!(!file.is_file(), "the old one is gone");
}
