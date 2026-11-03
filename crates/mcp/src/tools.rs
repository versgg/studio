//! The tools Claude sees, and how their arguments map onto the engine's JSON-RPC methods.
//!
//! Most tools forward to one engine method (`forward`). The rest need more than one call,
//! a file read or an approval, and are run in `server.rs`; their parameter building lives
//! here too so it can be unit tested.

use crate::permissions::Class;
use serde_json::{Map, Value, json};

pub type Args = Map<String, Value>;

pub struct ToolDef {
    pub name: &'static str,
    pub title: &'static str,
    pub class: Class,
    pub description: &'static str,
    pub schema: Value,
}

const US: &str = "microseconds; 1 s = 1000000";

fn int(desc: &str) -> Value {
    json!({ "type": "integer", "description": desc })
}
fn num(desc: &str) -> Value {
    json!({ "type": "number", "description": desc })
}
fn string(desc: &str) -> Value {
    json!({ "type": "string", "description": desc })
}
fn boolean(desc: &str) -> Value {
    json!({ "type": "boolean", "description": desc })
}
fn one_of(values: &[&str], desc: &str) -> Value {
    json!({ "type": "string", "enum": values, "description": desc })
}
fn ids(desc: &str) -> Value {
    json!({ "type": "array", "items": { "type": "string" }, "description": desc })
}
fn time(desc: &str) -> Value {
    int(&format!("{desc} ({US})"))
}
fn object(props: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}
fn loose(desc: &str) -> Value {
    json!({ "type": "object", "description": desc })
}

pub const ASPECTS: [&str; 4] = ["9:16", "4:5", "1:1", "16:9"];

/// The clip effects named in contract v2 (the Effects tab's tiles). `effects_list` asks the
/// engine for its own list; this is the fallback for an engine that can't say.
pub const EFFECTS: [&str; 18] = [
    "Blur", "Glow", "Film grain", "VHS", "Glitch", "Shake", "Zoom pulse", "Sharpen", "Black & white", "Sepia", "Vintage", "Chromatic", "Pixelate", "Mirror", "Edge", "Invert", "Light leak", "Lens distort",
];
pub const TRANSITIONS: [&str; 16] = [
    "Dissolve", "Fade through black", "Fade through white", "Wipe left", "Wipe right", "Slide up", "Slide down", "Slide left", "Slide right", "Zoom in", "Circle", "Pixelize", "Blur", "Radial", "Squeeze", "Smooth",
];
pub const ANIMS: [&str; 11] = ["Fade", "Slide up", "Slide down", "Slide left", "Slide right", "Zoom in", "Zoom out", "Pop", "Spin", "Blur in", "Typewriter"];
pub const LOOPS: [&str; 4] = ["Pulse", "Float", "Wiggle", "Spin"];
pub const BLENDS: [&str; 9] = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "add", "softlight", "difference"];

/// Every key `clip_set` passes on to the engine's `clip.set`.
pub const CLIP_SET_KEYS: &[&str] = &[
    "volume", "fit", "crop", "flip", "flipV", "rotate", "transformOn", "fadeInUs", "fadeOutUs", "fadeCurve", "pitch", "declick", "envelope", "scale", "posX", "posY", "rotation", "opacity", "temperature", "tint", "saturation", "brightness",
    "contrast", "highlights", "shadows", "sharpen", "vignette", "speed", "reverse", "keepPitch", "keyframes", "blend", "effects", "hsl", "curves", "wheels", "lut", "stabilize", "smooth", "speedCurve", "mask", "matte", "anim", "label",
];

/// The text fields a text clip or caption style can have (contract v2), besides `content`.
pub const TEXT_STYLE_KEYS: &[&str] = &["font", "size", "weight", "color", "align", "lineHeight", "letterSpacing", "case", "stroke", "background", "shadow", "preset", "boxW", "boxH"];

fn text_style_schema() -> Value {
    json!({
        "type": "object",
        "description": "Text look; anything left out keeps Studio's default or the preset's value.",
        "properties": {
            "font": string("Font family, one of the app's fonts (e.g. \"IBM Plex Sans\", \"Bricolage Grotesque\")"),
            "size": num("Font size in project pixels (the frame is 1080 wide for 9:16)"),
            "weight": num("Font weight, 100–900"),
            "color": string("Text colour, #RRGGBB"),
            "align": one_of(&["left", "center", "right"], "Alignment"),
            "lineHeight": num("Line height as a multiple of the size (e.g. 1.2)"),
            "letterSpacing": num("Letter spacing in pixels"),
            "case": one_of(&["none", "upper", "lower", "title"], "Letter case"),
            "stroke": { "type": ["object", "null"], "description": "Outline { color, width } or null", "properties": { "color": string("#RRGGBB"), "width": num("pixels") } },
            "background": { "type": ["object", "null"], "description": "Box behind the text { color, opacity 0–100, radius, padding } or null" },
            "shadow": { "type": ["object", "null"], "description": "Drop shadow { color, blur, x, y } or null" },
            "preset": string("A text preset name from the Text tab"),
            "boxW": num("Text box width in project pixels (wraps lines)"),
            "boxH": num("Text box height in project pixels")
        }
    })
}

fn clip_set_schema() -> Value {
    let pct = |d: &str| num(&format!("{d}, −100…100 (0 = unchanged)"));
    let props = json!({
        "clipId": string("The clip to change"),
        "clipIds": ids("More clips to change the same way (with or without clipId)"),
        "label": string("History label for this change (optional)"),
        "volume": num("Sound volume, 1 = as recorded, 0–4"),
        "fit": one_of(&["fill", "fit"], "Fill the frame (crop) or fit inside it (bars)"),
        "crop": { "type": ["object", "null"], "description": "Part of the source kept, fractions 0–1 { x, y, w, h }; null removes the crop", "properties": { "x": num("left"), "y": num("top"), "w": num("width"), "h": num("height") } },
        "flip": boolean("Mirror left to right"),
        "flipV": boolean("Flip upside down"),
        "rotate": json!({ "type": "integer", "enum": [0, 90, 180, 270], "description": "Quarter turns of the source, clockwise" }),
        "transformOn": boolean("false bypasses scale, position, rotation and opacity (values are kept)"),
        "scale": num("Picture size after the fit, percent (100 = as fitted, 0–400)"),
        "posX": num("Horizontal offset of the picture's centre, project pixels (+ right)"),
        "posY": num("Vertical offset of the picture's centre, project pixels (+ down)"),
        "rotation": num("Free rotation, degrees clockwise"),
        "opacity": num("Opacity, percent 0–100"),
        "temperature": pct("Colour temperature"),
        "tint": pct("Tint"),
        "saturation": pct("Saturation"),
        "brightness": pct("Brightness"),
        "contrast": pct("Contrast"),
        "highlights": pct("Highlights"),
        "shadows": pct("Shadows"),
        "sharpen": pct("Sharpen (negative softens)"),
        "vignette": pct("Vignette (negative lightens the edges)"),
        "speed": num("Playback speed 0.1–10 (the clip's length changes)"),
        "reverse": boolean("Play backwards"),
        "keepPitch": boolean("Keep the sound's pitch when the speed changes (default true)"),
        "speedCurve": { "type": ["object", "null"], "description": "Speed ramp { name, points: [[t 0–1, speed 0.1–10], …] }; null removes it" },
        "fadeInUs": time("Sound fade in length"),
        "fadeOutUs": time("Sound fade out length"),
        "fadeCurve": one_of(&["lin", "scurve", "log"], "Fade shape"),
        "pitch": num("Pitch shift in semitones (speed kept)"),
        "declick": boolean("Take out pops and mouth clicks"),
        "envelope": { "type": "array", "description": "Volume envelope: [{ atUs (source time), gain (1 = as recorded) }, …]", "items": { "type": "object" } },
        "keyframes": loose("Animated settings by name: { scale|posX|posY|rotation|opacity|brightness|contrast|saturation: [{ atUs (from the clip's start), value }, …] }. Replaces all of the clip's keyframes."),
        "blend": one_of(&BLENDS, "Blend mode (overlay clips only)"),
        "effects": { "type": "array", "description": "Video effects, replacing the list: [{ name, amount 0–100 }]. Names: see effects_list.", "items": { "type": "object", "properties": { "name": string("Effect name"), "amount": num("0–100") }, "required": ["name"] } },
        "hsl": loose("Per-colour hue/saturation/lightness: { Red|Orange|Yellow|Green|Cyan|Blue|Purple|Magenta: { h, s, l } }, each −100…100"),
        "curves": loose("Curves: { master?, red?, green?, blue? }, each a list of [x, y] points in 0…1"),
        "wheels": loose("Colour wheels: { lift?, gamma?, gain? }, each { x, y (−1…1), lum (−100…100) }"),
        "lut": { "type": ["object", "null"], "description": "A .cube LUT { path, strength 0–100 }, or null" },
        "stabilize": { "type": ["object", "null"], "description": "Stabilise { strength 0–100 }, or null" },
        "smooth": { "type": ["object", "null"], "description": "Smooth slow motion on export { quality: \"Fast\" | \"Best\" }, or null" },
        "mask": { "type": ["object", "null"], "description": "Mask { shape: line|mirror|circle|rect|heart|star, x, y, w, h, rotation, feather 0–100, invert } in frame fractions. Studio's window draws the mask picture, so it only shows once a window has the project open." },
        "matte": { "type": ["object", "null"], "description": "Background-removal matte { path } (a grey video, white = keep), or null" },
        "anim": loose("Animations: { in?: { name, durationUs }, out?: { name, durationUs }, loop?: { name, periodUs } }. Names: see effects_list.")
    });
    json!({ "type": "object", "properties": props, "additionalProperties": false })
}

/// The whole tool list, in the order `tools/list` shows it.
pub fn all() -> Vec<ToolDef> {
    use Class::*;
    let t = |name, title, class, description, schema| ToolDef { name, title, class, description, schema };
    let none = || object(json!({}), &[]);
    vec![
        // Status and projects
        t("studio_status", "Studio status", Look, "Which Studio engine Claude is connected to (the open app, or one started headless), whether a Studio window is open, the open project and what Claude is allowed to do in it.", none()),
        t("project_list", "List projects", Look, "Lists the projects in the Studio projects folder, newest first, with their paths (for project_open).", none()),
        t("project_open", "Open project", Look, "Opens a project (a .studio folder or its project.json). With Studio open, the window switches to it.", object(json!({ "path": string("Path of the .studio folder or its project.json") }), &["path"])),
        t("project_open_latest", "Open latest project", Look, "Opens the most recently saved project (or makes \"My first project\" if there is none). Does nothing if a project is already open.", none()),
        t("project_new", "New project", Edit, "Makes a new, empty project in the projects folder and opens it.", object(json!({ "name": string("Project name"), "aspect": one_of(&ASPECTS, "Format (default 9:16)") }), &[])),
        t("project_summary", "Project summary", Look, "The open project as readable lines: tracks, clips with their ids, names, times and look settings, text and captions. Start here to get the ids other tools need.", none()),
        t("project_state", "Project state (JSON)", Look, "The open project's full state as JSON: every track, clip and setting with ids. Media files are left out unless includeMedia is true.", object(json!({ "includeMedia": boolean("Include the media library (can be long)") }), &[])),
        t("project_set_format", "Set format", Edit, "Changes the project's format (frame size).", object(json!({ "aspect": one_of(&ASPECTS, "9:16 = 1080×1920, 4:5 = 1080×1350, 1:1 = 1080×1080, 16:9 = 1920×1080") }), &["aspect"])),
        t("project_set_options", "Project options", Edit, "Project options: main track magnet, linkage of video and its extracted audio, the cover frame and brand colours/fonts. (Claude's own permissions can only be changed by the user.)", object(json!({
            "magnet": boolean("Main track closes gaps by itself"),
            "linkage": boolean("Linked video and audio move, split and delete together"),
            "coverUs": time("The frame used as the cover (thumbnail)"),
            "brand": { "type": "object", "description": "{ colors: [\"#RRGGBB\"], fonts: [name] }" }
        }), &[])),
        // Media
        t("media_import", "Import media", Import, "Imports files into the library (video, audio, pictures). A folder path links the folder: the library mirrors its tree and files stay where they are. Thumbnails, waveforms and proxies are made in the background.", object(json!({ "paths": ids("Absolute paths of files or folders") }), &["paths"])),
        t("media_list", "List media", Look, "Lists the library: media ids, names, kinds, lengths, sizes and paths.", object(json!({ "query": string("Only names or paths containing this text"), "limit": int("At most this many (default 200)") }), &[])),
        t("media_describe", "Describe media", Look, "One library item: length, picture size, frame rate, sound, path, plus its poster frame and a 10-frame filmstrip as images.", object(json!({ "mediaId": string("Media id (m…)") }), &["mediaId"])),
        t("media_remove", "Remove media", Remove, "Removes files from the library (and their clips from the timeline). The files on disk are kept. The user is asked in Studio first.", object(json!({ "mediaIds": ids("Media ids to remove") }), &["mediaIds"])),
        // Timeline
        t("timeline_add_clip", "Add clip", Edit, "Adds a library item to the timeline. Video and pictures go on the main track (with the magnet on, atUs picks the place in the order; left out, at the end); sound goes on an audio track at atUs. newTrack puts it on a new track of its own instead. For a picture or video on top of the main track, use overlay_add.", object(json!({
            "mediaId": string("Media id (m…)"),
            "atUs": time("Where on the timeline"),
            "newTrack": boolean("Put it on a new track at atUs")
        }), &["mediaId"])),
        t("timeline_move", "Move clip", Edit, "Moves a clip. On the magnetic main track startUs picks the new place in the order; elsewhere it is the new start time, and trackId picks another track.", object(json!({ "clipId": string("Clip id (c…)"), "startUs": time("New start"), "trackId": string("Track to move it to") }), &["clipId", "startUs"])),
        t("timeline_trim", "Trim clip", Edit, "Sets which part of the source a clip plays: inUs (where in the source it starts) and durationUs (its length on the timeline). Anything left out keeps its current value. startUs moves its start on non-main tracks.", object(json!({ "clipId": string("Clip id"), "inUs": time("Start in the source"), "durationUs": time("Length on the timeline"), "startUs": time("New start on the timeline") }), &["clipId"])),
        t("timeline_split", "Split", Edit, "Splits clips at a time. With clipIds, only those clips; without, the main-track clip under atUs. Returns the new right-hand clip ids.", object(json!({ "atUs": time("Where to cut"), "clipIds": ids("Clips to split") }), &["atUs"])),
        t("timeline_delete", "Delete clips", Edit, "Deletes clips from the timeline (the main track closes the gap when the magnet is on).", object(json!({ "clipIds": ids("Clip ids") }), &["clipIds"])),
        t("timeline_delete_left", "Delete left", Edit, "Deletes the part of clips before atUs (Q in the app). With no clipIds, the main-track clip under atUs.", object(json!({ "atUs": time("Cut point"), "clipIds": ids("Clips to trim") }), &["atUs"])),
        t("timeline_delete_right", "Delete right", Edit, "Deletes the part of clips after atUs (W in the app). With no clipIds, the main-track clip under atUs.", object(json!({ "atUs": time("Cut point"), "clipIds": ids("Clips to trim") }), &["atUs"])),
        t("timeline_extract_audio", "Extract audio", Edit, "Moves video clips' sound onto an audio track of its own (linked to the video).", object(json!({ "clipIds": ids("Video clip ids") }), &["clipIds"])),
        t("timeline_compound", "Make compound clip", Edit, "Combines clips into one compound clip (rendered; can be broken apart again).", object(json!({ "clipIds": ids("Clip ids to combine") }), &["clipIds"])),
        t("timeline_break_compound", "Break compound clip", Edit, "Breaks a compound clip back into its parts.", object(json!({ "clipId": string("Compound clip id") }), &["clipId"])),
        t("timeline_freeze_frame", "Freeze frame", Edit, "Holds the frame at atUs as a still, inserted at that point.", object(json!({ "atUs": time("The frame to hold"), "clipIds": ids("Clip to freeze (default: main track under atUs)") }), &["atUs"])),
        t("clip_replace_media", "Replace clip media", Edit, "Points a clip at another library item, keeping its place, length and look.", object(json!({ "clipId": string("Clip id"), "mediaId": string("New media id") }), &["clipId", "mediaId"])),
        t("edit_undo", "Undo", Edit, "Undoes the last edit (anyone's, like Ctrl+Z in the app).", none()),
        t("edit_redo", "Redo", Edit, "Redoes the last undone edit.", none()),
        t("history_list", "History", Look, "The project's edit history: each step's label, who made it (you = the user, claude = Claude through MCP) and time. Steps after the current one are undone.", none()),
        t("history_goto", "Go to history step", Edit, "Undoes or redoes until the given step is the last one done (−1 undoes everything).", object(json!({ "index": int("Step index from history_list") }), &["index"])),
        // Look
        t("clip_set", "Clip settings", Edit, "Changes a clip's look, sound and timing settings: transform (scale, position, rotation, opacity, crop, flip), colour (nine sliders, HSL, curves, wheels, LUT), speed, reverse, keyframes, effects, blend, masks, animations, fades, pitch, envelope and more. Only the settings given change. Text content: use text_set. Transitions: use transition_set.", clip_set_schema()),
        t("effects_list", "Effect names", Look, "The names Studio accepts for clip effects, transitions, animations and blend modes.", none()),
        // Text, stickers, overlays
        t("overlay_add", "Add overlay or sticker", Edit, "Puts a library video or picture on top of the main track, on a new track of its own (or trackId). role \"sticker\" for stickers (images, GIF, WebM). Default length: the media's, or 3 s for pictures. Position and size it with clip_set.", object(json!({
            "mediaId": string("Media id"),
            "atUs": time("Start on the timeline"),
            "durationUs": time("Length"),
            "role": one_of(&["overlay", "sticker"], "Track role (default overlay)"),
            "trackId": string("Put it on this existing track instead of a new one")
        }), &["mediaId", "atUs"])),
        t("text_add", "Add text", Edit, "Adds a text clip on a new text track. Studio's window draws the text (with the app's fonts) into a picture the engine composites; with no window open the clip is saved but shows nothing in frames or exports until Studio draws it. The result says which.", object(json!({
            "content": string("The text (new lines with \\n)"),
            "atUs": time("Start on the timeline"),
            "durationUs": time("Length (default 3 s)"),
            "style": text_style_schema()
        }), &["content", "atUs"])),
        t("text_set", "Change text", Edit, "Changes a text clip's words and/or style (merged into what it has). Studio's window redraws it.", object(json!({ "clipId": string("Text clip id"), "content": string("New text"), "style": text_style_schema() }), &["clipId"])),
        t("captions_set", "Set captions", Edit, "Replaces the lines of a captions track (or makes a new one): timed lines sharing one style. Like text, Studio's window draws them.", object(json!({
            "trackId": string("Captions track to replace (default: a new one)"),
            "lines": { "type": "array", "description": "Caption lines in time order", "items": { "type": "object", "properties": { "startUs": time("Start"), "endUs": time("End"), "text": string("The words") }, "required": ["startUs", "endUs", "text"] } },
            "style": text_style_schema()
        }), &["lines"])),
        t("adjust_add", "Add adjustment layer", Edit, "Adds an adjustment layer: its look settings (colour, HSL, curves, wheels, LUT, effects; set with clip_set) apply to everything below it while it plays.", object(json!({ "atUs": time("Start"), "durationUs": time("Length (default 3 s)") }), &["atUs"])),
        t("transition_set", "Set transition", Edit, "Sets the transition into a main-track clip from the clip before it, or removes it (name null). The total length doesn't change.", object(json!({
            "clipId": string("Main-track clip the transition leads into"),
            "name": { "type": ["string", "null"], "description": "Transition name (see effects_list), or null to remove" },
            "durationUs": time("Length (default 0.5 s)")
        }), &["clipId", "name"])),
        t("transition_set_all", "Set all transitions", Edit, "Puts the same transition on every cut of the main track, or removes them all (name null).", object(json!({
            "name": { "type": ["string", "null"], "description": "Transition name, or null to remove all" },
            "durationUs": time("Length (default 0.5 s)")
        }), &["name"])),
        // Audio
        t("track_set", "Track settings", Edit, "A track's mix and state: fader, pan, mute, solo, lock, role (voice/music) and live effects (noise, voice EQ, compressor, de-esser, limiter; only the fields given change).", object(json!({
            "trackId": string("Track id (t…)"),
            "gainDb": num("Fader, dB −60…+12"),
            "pan": num("Balance −1 (left) … 1 (right)"),
            "mute": boolean("Mute"),
            "solo": boolean("Solo"),
            "locked": boolean("Lock (locked tracks refuse edits)"),
            "role": one_of(&["voice", "music", ""], "What the track holds (\"\" lets Studio guess)"),
            "effects": loose("{ noise: { on, reductionDb 0–30, sensitivity 0–24 }, eq: { on, highpassHz 20–300, presenceDb 0–12 }, comp: { on, thresholdDb −60–0, ratio 1–10, attackMs, releaseMs }, deess: { on, amountDb 0–12 }, limiter: { on, ceilingDb −6–0 } }")
        }), &["trackId"])),
        t("audio_master", "Master", Edit, "The master stage every export goes through: loudness normalising (target LUFS), true-peak limiter (ceiling dBTP) and a gain on the whole mix.", object(json!({
            "normalize": boolean("Level the export to targetLufs"),
            "targetLufs": num("Loudness target, e.g. −14"),
            "limiter": boolean("True-peak limiter"),
            "ceilingDb": num("Limiter ceiling, dBTP (e.g. −1)"),
            "gainDb": num("Gain on the whole mix, dB")
        }), &[])),
        t("audio_loudness", "Measure loudness", Look, "Measures the mix: integrated loudness (LUFS), true peak and loudness range.", none()),
        t("audio_normalize_mix", "Normalise the mix", Edit, "Measures the mix and sets the master gain so playback sits at the target loudness.", object(json!({ "targetLufs": num("Target (default: the master's, usually −14)") }), &[])),
        t("audio_normalize", "Normalise clips", Edit, "Sets clips' volume so each reaches a peak or loudness target.", object(json!({
            "clipIds": ids("Clips with sound"),
            "mode": one_of(&["peak", "loudness"], "peak (default, target dBFS) or loudness (target LUFS)"),
            "targetDb": num("Target (default −1 dBFS peak, −14 LUFS loudness)")
        }), &["clipIds"])),
        t("audio_remove_silences", "Remove silences", Edit, "Cuts pauses out of clips' sound (and their picture), closing the gaps.", object(json!({ "clipIds": ids("Clips"), "minUs": time("Shortest pause to cut (default 0.5 s)"), "keepUs": time("Pause left at each cut (default 0.2 s)") }), &["clipIds"])),
        t("audio_split_at_silences", "Split at silences", Edit, "Splits clips at the pauses in their sound.", object(json!({ "clipIds": ids("Clips") }), &["clipIds"])),
        t("audio_label_sounds", "Label sounds", Edit, "Adds a label for each stretch of sound between pauses.", object(json!({ "clipIds": ids("Clips") }), &["clipIds"])),
        t("audio_crossfade", "Crossfade", Edit, "Crossfades two clips on one audio track: the second is moved to overlap the first's end by durationUs, both with matching fades.", object(json!({ "clipIds": ids("Exactly two clip ids: [first, second]"), "durationUs": time("Overlap length") }), &["clipIds", "durationUs"])),
        t("audio_spectral_delete", "Spectral delete", Edit, "Removes a frequency band from a clip's sound between two times (a cough, a beep).", object(json!({
            "clipId": string("Clip id"),
            "startUs": time("Start, from the clip's start"),
            "endUs": time("End, from the clip's start"),
            "lowHz": num("Lowest frequency removed"),
            "highHz": num("Highest frequency removed")
        }), &["clipId", "startUs", "endUs", "lowHz", "highHz"])),
        t("labels_add", "Add labels", Edit, "Adds labels (or markers, when start equals end) on the labels track.", object(json!({ "items": { "type": "array", "items": { "type": "object", "properties": { "startUs": time("Start"), "endUs": time("End"), "text": string("Label text") }, "required": ["startUs"] } } }), &["items"])),
        t("labels_set", "Change label", Edit, "Renames or moves a label (or marker) on the labels track.", object(json!({ "labelId": string("Label id"), "text": string("New text"), "startUs": time("New start"), "endUs": time("New end") }), &["labelId"])),
        t("labels_delete", "Delete labels", Edit, "Deletes labels and markers from the labels track.", object(json!({ "labelIds": ids("Label ids") }), &["labelIds"])),
        // Export
        t("export_start", "Export", Export, "Exports the project (or just some clips) to MP4, one file per format, through the master stage. By default the user is asked in Studio first (\"Ask before export\"), and it waits for the files.", object(json!({
            "formats": { "type": "array", "items": { "type": "string", "enum": ASPECTS }, "description": "Formats (default: the project's)" },
            "quality": one_of(&["fast", "balanced", "best"], "fast = NVENC quick, balanced (default), best = x264 slow"),
            "folder": string("Output folder (default: Videos/Studio Exports)"),
            "baseName": string("File name start (default: the project name); files are <baseName>-<W>x<H>.mp4"),
            "names": loose("Exact file names (without .mp4) per format, e.g. { \"9:16\": \"Ad-v3\" }"),
            "clipIds": ids("Export only these clips (from the first one's start to the last one's end)"),
            "bitrateMbps": num("Target video bitrate instead of the quality's constant quality"),
            "fps": int("Frame rate (default: the project's)"),
            "wait": boolean("Wait for the files (default true)"),
            "timeoutS": int("How long to wait, seconds (default 600)")
        }), &[])),
        t("export_status", "Export status", Look, "The exports this session knows about: state, progress, file path, size, or the error.", object(json!({ "jobId": string("Only this job") }), &[])),
        t("export_cancel", "Cancel export", Export, "Cancels an export job.", object(json!({ "jobId": string("Job id from export_start") }), &["jobId"])),
        // Seeing
        t("preview_frame", "Preview frame", Look, "Renders the composited frame at a time (every layer, look, text and caption, as the export will look) and returns it as a PNG image, so you can check your work.", object(json!({ "atUs": time("Timeline time"), "width": int("Image width in pixels (default 540)") }), &["atUs"])),
    ]
}

/// Copies the keys present in `args` (including explicit nulls) into a new object.
pub fn pick(args: &Args, keys: &[&str]) -> Map<String, Value> {
    keys.iter().filter_map(|k| args.get(*k).map(|v| (k.to_string(), v.clone()))).collect()
}

fn need<'a>(args: &'a Args, key: &str) -> Result<&'a Value, String> {
    args.get(key).filter(|v| !v.is_null()).ok_or_else(|| format!("\"{key}\" is required"))
}

fn need_ids(args: &Args, key: &str) -> Result<Vec<String>, String> {
    let list = need(args, key)?.as_array().ok_or_else(|| format!("\"{key}\" must be a list of ids"))?;
    let out: Vec<String> = list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
    if out.is_empty() || out.len() != list.len() {
        return Err(format!("\"{key}\" must be a non-empty list of strings"));
    }
    Ok(out)
}

fn with(mut m: Map<String, Value>, key: &str, v: Value) -> Map<String, Value> {
    m.insert(key.into(), v);
    m
}

/// Keys in `args` that aren't in `allowed`.
pub fn unknown_keys(args: &Args, allowed: &[&str]) -> Vec<String> {
    args.keys().filter(|k| !allowed.contains(&k.as_str())).cloned().collect()
}

/// For a tool that is one engine call: the method and its params. `None` for the tools
/// `server.rs` runs itself.
pub fn forward(name: &str, args: &Args) -> Option<Result<(&'static str, Value), String>> {
    let r = |method: &'static str, params: Map<String, Value>| Some(Ok((method, Value::Object(params))));
    let fail = |e: String| Some(Err(e));
    macro_rules! req {
        ($e:expr) => {
            match $e {
                Ok(v) => v,
                Err(e) => return fail(e),
            }
        };
    }
    match name {
        "project_open" => {
            req!(need(args, "path"));
            r("project.open", pick(args, &["path"]))
        }
        "project_open_latest" => r("project.openLatest", Map::new()),
        "project_new" => r("project.new", pick(args, &["name", "aspect"])),
        "project_set_format" => {
            let aspect = req!(need(args, "aspect")).as_str().unwrap_or_default().to_string();
            if !ASPECTS.contains(&aspect.as_str()) {
                return fail(format!("aspect must be one of {}", ASPECTS.join(", ")));
            }
            r("project.setFormat", pick(args, &["aspect"]))
        }
        "project_set_options" => {
            // Never `mcp`: Claude can't change its own permissions.
            let params = pick(args, &["magnet", "linkage", "coverUs", "brand"]);
            if params.is_empty() {
                return fail("Give at least one of magnet, linkage, coverUs or brand.".into());
            }
            r("project.setOptions", params)
        }
        "media_import" => {
            let paths = req!(need_ids(args, "paths"));
            r("media.import", Map::from_iter([("paths".to_string(), json!(paths))]))
        }
        "timeline_add_clip" => {
            req!(need(args, "mediaId"));
            if args.get("newTrack").and_then(Value::as_bool) == Some(true) {
                let mut p = pick(args, &["mediaId", "atUs"]);
                p.entry("atUs").or_insert(json!(0));
                r("timeline.insertNewTrack", p)
            } else {
                r("timeline.insert", pick(args, &["mediaId", "atUs"]))
            }
        }
        "timeline_move" => {
            req!(need(args, "clipId"));
            req!(need(args, "startUs"));
            r("timeline.move", pick(args, &["clipId", "startUs", "trackId"]))
        }
        "timeline_split" => {
            req!(need(args, "atUs"));
            r("timeline.split", pick(args, &["atUs", "clipIds"]))
        }
        "timeline_delete" => {
            let ids = req!(need_ids(args, "clipIds"));
            r("timeline.delete", Map::from_iter([("clipIds".to_string(), json!(ids))]))
        }
        "timeline_delete_left" | "timeline_delete_right" => {
            req!(need(args, "atUs"));
            // Delete left keeps the right-hand part, and the other way round.
            let keep = if name == "timeline_delete_left" { "right" } else { "left" };
            r("timeline.trimAt", with(pick(args, &["atUs", "clipIds"]), "keep", json!(keep)))
        }
        "timeline_extract_audio" => {
            let ids = req!(need_ids(args, "clipIds"));
            r("clip.extractAudio", Map::from_iter([("clipIds".to_string(), json!(ids))]))
        }
        "timeline_compound" => {
            let ids = req!(need_ids(args, "clipIds"));
            r("timeline.compound", Map::from_iter([("clipIds".to_string(), json!(ids))]))
        }
        "timeline_break_compound" => {
            req!(need(args, "clipId"));
            r("timeline.breakCompound", pick(args, &["clipId"]))
        }
        "timeline_freeze_frame" => {
            req!(need(args, "atUs"));
            r("timeline.freezeFrame", pick(args, &["atUs", "clipIds"]))
        }
        "clip_replace_media" => {
            req!(need(args, "clipId"));
            req!(need(args, "mediaId"));
            r("clip.replaceMedia", pick(args, &["clipId", "mediaId"]))
        }
        "edit_undo" => r("edit.undo", Map::new()),
        "edit_redo" => r("edit.redo", Map::new()),
        "history_goto" => {
            req!(need(args, "index"));
            r("history.goto", pick(args, &["index"]))
        }
        "clip_set" => {
            if args.get("clipId").and_then(Value::as_str).is_none() && args.get("clipIds").and_then(Value::as_array).is_none_or(|a| a.is_empty()) {
                return fail("Give clipId or clipIds.".into());
            }
            let settings = pick(args, CLIP_SET_KEYS);
            if settings.keys().all(|k| k == "label") {
                return fail("Give at least one setting to change.".into());
            }
            let mut params = pick(args, &["clipId", "clipIds"]);
            params.extend(settings);
            r("clip.set", params)
        }
        "overlay_add" => {
            req!(need(args, "mediaId"));
            req!(need(args, "atUs"));
            let role = args.get("role").and_then(Value::as_str).unwrap_or("overlay");
            if !["overlay", "sticker"].contains(&role) {
                return fail("role must be overlay or sticker (text: text_add, adjustment layers: adjust_add)".into());
            }
            r("overlay.add", with(pick(args, &["mediaId", "atUs", "durationUs", "trackId"]), "role", json!(role)))
        }
        "adjust_add" => {
            req!(need(args, "atUs"));
            r("adjust.add", pick(args, &["atUs", "durationUs"]))
        }
        "transition_set" => {
            req!(need(args, "clipId"));
            if !args.contains_key("name") {
                return fail("\"name\" is required (null removes the transition)".into());
            }
            r("transition.set", pick(args, &["clipId", "name", "durationUs"]))
        }
        "transition_set_all" => {
            if !args.contains_key("name") {
                return fail("\"name\" is required (null removes every transition)".into());
            }
            let mut p = pick(args, &["name", "durationUs"]);
            p.entry("durationUs").or_insert(json!(500_000));
            r("transition.setAll", p)
        }
        "track_set" => {
            req!(need(args, "trackId"));
            r("track.set", pick(args, &["trackId", "gainDb", "pan", "mute", "solo", "locked", "role", "effects"]))
        }
        "audio_master" => {
            let p = pick(args, &["normalize", "targetLufs", "limiter", "ceilingDb", "gainDb"]);
            if p.is_empty() {
                return fail("Give at least one master setting.".into());
            }
            r("project.setMaster", p)
        }
        "audio_normalize_mix" => r("audio.normalizeMix", pick(args, &["targetLufs"])),
        "audio_normalize" => {
            req!(need_ids(args, "clipIds"));
            r("audio.normalize", pick(args, &["clipIds", "mode", "targetDb"]))
        }
        "audio_remove_silences" => {
            req!(need_ids(args, "clipIds"));
            r("audio.removeSilences", pick(args, &["clipIds", "minUs", "keepUs"]))
        }
        "audio_split_at_silences" => {
            req!(need_ids(args, "clipIds"));
            r("audio.splitAtSilences", pick(args, &["clipIds"]))
        }
        "audio_label_sounds" => {
            req!(need_ids(args, "clipIds"));
            r("audio.labelSounds", pick(args, &["clipIds"]))
        }
        "audio_crossfade" => {
            let ids = req!(need_ids(args, "clipIds"));
            if ids.len() != 2 {
                return fail("clipIds must be exactly two clips: [first, second]".into());
            }
            req!(need(args, "durationUs"));
            r("audio.crossfade", pick(args, &["clipIds", "durationUs"]))
        }
        "audio_spectral_delete" => {
            for k in ["clipId", "startUs", "endUs", "lowHz", "highHz"] {
                req!(need(args, k));
            }
            r("audio.spectralDelete", pick(args, &["clipId", "startUs", "endUs", "lowHz", "highHz"]))
        }
        "labels_add" => {
            req!(need(args, "items"));
            r("labels.add", pick(args, &["items"]))
        }
        "labels_set" => {
            req!(need(args, "labelId"));
            r("labels.set", pick(args, &["labelId", "text", "startUs", "endUs"]))
        }
        "labels_delete" => {
            req!(need_ids(args, "labelIds"));
            r("labels.delete", pick(args, &["labelIds"]))
        }
        "export_cancel" => {
            req!(need(args, "jobId"));
            r("export.cancel", pick(args, &["jobId"]))
        }
        _ => None,
    }
}

/// `text` for `text.add` / `text.set`: `content` plus the style fields.
pub fn text_object(args: &Args) -> Map<String, Value> {
    let mut text = Map::new();
    if let Some(Value::Object(style)) = args.get("style") {
        text.extend(pick(style, TEXT_STYLE_KEYS));
    }
    if let Some(c) = args.get("content").filter(|v| v.is_string()) {
        text.insert("content".into(), c.clone());
    }
    text
}

pub fn text_add_params(args: &Args) -> Result<Value, String> {
    let content = need(args, "content")?.as_str().ok_or("\"content\" must be text")?;
    if content.trim().is_empty() {
        return Err("\"content\" is empty".into());
    }
    need(args, "atUs")?;
    let mut p = pick(args, &["atUs", "durationUs"]);
    p.insert("text".into(), Value::Object(text_object(args)));
    Ok(Value::Object(p))
}

pub fn text_set_params(args: &Args) -> Result<Value, String> {
    need(args, "clipId")?;
    let text = text_object(args);
    if text.is_empty() {
        return Err("Give content and/or style to change.".into());
    }
    Ok(json!({ "clipId": args["clipId"], "text": text }))
}

pub fn captions_params(args: &Args) -> Result<Value, String> {
    let lines = need(args, "lines")?.as_array().ok_or("\"lines\" must be a list")?;
    let mut out = vec![];
    for (i, l) in lines.iter().enumerate() {
        let (Some(start), Some(end), Some(text)) = (l.get("startUs").and_then(Value::as_f64), l.get("endUs").and_then(Value::as_f64), l.get("text").and_then(Value::as_str)) else {
            return Err(format!("line {i} needs startUs, endUs and text"));
        };
        if end <= start {
            return Err(format!("line {i} ends before it starts"));
        }
        out.push(json!({ "startUs": start as i64, "endUs": end as i64, "text": text }));
    }
    let mut p = pick(args, &["trackId"]);
    p.insert("lines".into(), json!(out));
    let style = match args.get("style") {
        Some(Value::Object(s)) => pick(s, TEXT_STYLE_KEYS),
        _ => Map::new(),
    };
    p.insert("style".into(), Value::Object(style));
    Ok(Value::Object(p))
}

/// `timeline.trim` needs both inUs and durationUs; the tool lets either be left out and
/// fills it from the clip as it is now.
pub fn trim_params(args: &Args, clip: &Value) -> Result<Value, String> {
    let clip_id = need(args, "clipId")?;
    let current = |k: &str| clip.get(k).cloned().unwrap_or(json!(0));
    let in_us = args.get("inUs").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| current("inUs"));
    let dur = args.get("durationUs").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| current("durationUs"));
    if dur.as_f64().unwrap_or(0.0) <= 0.0 {
        return Err("durationUs must be more than 0".into());
    }
    let mut p = json!({ "clipId": clip_id, "inUs": in_us, "durationUs": dur });
    if let Some(s) = args.get("startUs").filter(|v| !v.is_null()) {
        p["startUs"] = s.clone();
    }
    Ok(p)
}

/// `export.start` params with the defaults filled in, and whether to wait and for how long.
pub struct ExportPlan {
    pub params: Value,
    pub wait: bool,
    pub timeout_s: u64,
}

pub fn export_plan(args: &Args, default_folder: &str, default_format: &str) -> Result<ExportPlan, String> {
    let mut p = pick(args, &["quality", "baseName", "names", "clipIds", "bitrateMbps", "fps"]);
    let formats: Vec<String> = match args.get("formats").and_then(Value::as_array) {
        Some(list) if !list.is_empty() => list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => vec![default_format.to_string()],
    };
    if let Some(bad) = formats.iter().find(|f| !ASPECTS.contains(&f.as_str())) {
        return Err(format!("Unknown format {bad}; use {}", ASPECTS.join(", ")));
    }
    if let Some(q) = p.get("quality").and_then(Value::as_str) {
        if !["fast", "balanced", "best"].contains(&q) {
            return Err("quality must be fast, balanced or best".into());
        }
    }
    p.insert("formats".into(), json!(formats));
    let folder = args.get("folder").and_then(Value::as_str).filter(|f| !f.trim().is_empty()).unwrap_or(default_folder);
    p.insert("folder".into(), json!(folder));
    Ok(ExportPlan {
        params: Value::Object(p),
        wait: args.get("wait").and_then(Value::as_bool).unwrap_or(true),
        timeout_s: args.get("timeoutS").and_then(Value::as_u64).unwrap_or(600).clamp(1, 3600),
    })
}

/// Adds `_actor: "claude"` to a call's params, so the engine records Claude as the one who
/// made the edit.
pub fn with_actor(params: Value) -> Value {
    let mut m = match params {
        Value::Object(m) => m,
        Value::Null => Map::new(),
        other => return other,
    };
    m.insert("_actor".into(), json!("claude"));
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn args(v: Value) -> Args {
        v.as_object().cloned().unwrap()
    }

    fn call(name: &str, v: Value) -> (&'static str, Value) {
        forward(name, &args(v)).expect("a forwarded tool").expect("valid args")
    }

    fn refused(name: &str, v: Value) -> String {
        forward(name, &args(v)).expect("a forwarded tool").expect_err("should be refused")
    }

    #[test]
    fn tool_names_are_valid_and_unique() {
        let tools = all();
        let mut seen = HashSet::new();
        for t in &tools {
            assert!(!t.name.is_empty() && t.name.len() <= 64, "{}", t.name);
            assert!(t.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'), "{}", t.name);
            assert!(seen.insert(t.name), "duplicate {}", t.name);
            assert_eq!(t.schema["type"], "object", "{}", t.name);
            assert!(t.schema["properties"].is_object(), "{}", t.name);
            assert!(t.description.len() > 20, "{}", t.name);
            for r in t.schema.get("required").and_then(Value::as_array).into_iter().flatten() {
                assert!(t.schema["properties"].get(r.as_str().unwrap()).is_some(), "{} requires unknown {r}", t.name);
            }
        }
        assert!(tools.len() >= 50);
    }

    #[test]
    fn classes_match_what_tools_do() {
        let class = |n: &str| all().into_iter().find(|t| t.name == n).unwrap().class;
        for n in ["studio_status", "project_summary", "project_state", "media_list", "media_describe", "preview_frame", "history_list", "export_status", "audio_loudness", "effects_list"] {
            assert_eq!(class(n), Class::Look, "{n}");
        }
        for n in ["clip_set", "timeline_split", "timeline_delete", "text_add", "captions_set", "transition_set", "edit_undo", "track_set", "audio_master"] {
            assert_eq!(class(n), Class::Edit, "{n}");
        }
        assert_eq!(class("media_import"), Class::Import);
        assert_eq!(class("media_remove"), Class::Remove);
        assert_eq!(class("export_start"), Class::Export);
        assert_eq!(class("export_cancel"), Class::Export);
    }

    #[test]
    fn every_tool_is_forwarded_or_handled() {
        let special = ["studio_status", "project_list", "project_summary", "project_state", "media_list", "media_describe", "media_remove", "timeline_trim", "history_list", "effects_list", "text_add", "text_set", "captions_set", "audio_loudness", "export_start", "export_status", "preview_frame"];
        for t in all() {
            let forwarded = forward(t.name, &Map::new()).is_some();
            assert!(forwarded != special.contains(&t.name), "{} must be exactly one of forwarded/special", t.name);
        }
    }

    #[test]
    fn no_tool_reaches_approval_answers_or_permissions() {
        // Fill every property with something plausible and check what goes out.
        for t in all() {
            let mut a = Map::new();
            for (k, _) in t.schema["properties"].as_object().unwrap() {
                a.insert(k.clone(), json!("x"));
            }
            a.insert("mcp".into(), json!({ "allowed": "all", "askBeforeExport": false }));
            if let Some(Ok((method, params))) = forward(t.name, &a) {
                assert!(!method.starts_with("approval."), "{} calls {method}", t.name);
                assert!(params.get("mcp").is_none(), "{} passes mcp", t.name);
            }
        }
    }

    #[test]
    fn delete_left_keeps_the_right_part() {
        let (m, p) = call("timeline_delete_left", json!({ "atUs": 1_000_000, "clipIds": ["c1"] }));
        assert_eq!(m, "timeline.trimAt");
        assert_eq!(p, json!({ "atUs": 1_000_000, "clipIds": ["c1"], "keep": "right" }));
        let (_, p) = call("timeline_delete_right", json!({ "atUs": 5 }));
        assert_eq!(p["keep"], "left");
    }

    #[test]
    fn add_clip_on_main_or_new_track() {
        assert_eq!(call("timeline_add_clip", json!({ "mediaId": "m1" })), ("timeline.insert", json!({ "mediaId": "m1" })));
        assert_eq!(call("timeline_add_clip", json!({ "mediaId": "m1", "newTrack": true })), ("timeline.insertNewTrack", json!({ "mediaId": "m1", "atUs": 0 })));
        assert!(refused("timeline_add_clip", json!({})).contains("mediaId"));
    }

    #[test]
    fn clip_set_passes_known_settings_only() {
        let (m, p) = call("clip_set", json!({ "clipId": "c1", "scale": 120, "effects": [{ "name": "Glow", "amount": 40 }], "crop": null, "bogus": 1 }));
        assert_eq!(m, "clip.set");
        assert_eq!(p, json!({ "clipId": "c1", "scale": 120, "effects": [{ "name": "Glow", "amount": 40 }], "crop": null }));
        let (_, p) = call("clip_set", json!({ "clipIds": ["a", "b"], "flipV": true, "blend": "screen" }));
        assert_eq!(p, json!({ "clipIds": ["a", "b"], "flipV": true, "blend": "screen" }));
        assert!(refused("clip_set", json!({ "scale": 1 })).contains("clipId"));
        assert!(refused("clip_set", json!({ "clipId": "c1" })).contains("setting"));
        assert!(refused("clip_set", json!({ "clipId": "c1", "label": "x" })).contains("setting"));
        assert_eq!(unknown_keys(&args(json!({ "clipId": "c", "scale": 1, "bogus": 2 })), &[&["clipId", "clipIds"], CLIP_SET_KEYS].concat()), vec!["bogus"]);
    }

    #[test]
    fn every_clip_set_key_is_in_its_schema() {
        let tools = all();
        let schema = &tools.iter().find(|t| t.name == "clip_set").unwrap().schema["properties"];
        for k in CLIP_SET_KEYS {
            assert!(schema.get(*k).is_some(), "{k}");
        }
    }

    #[test]
    fn options_never_carry_permissions() {
        let (m, p) = call("project_set_options", json!({ "magnet": false, "mcp": { "allowed": "all" } }));
        assert_eq!(m, "project.setOptions");
        assert_eq!(p, json!({ "magnet": false }));
        assert!(refused("project_set_options", json!({ "mcp": { "allowed": "all" } })).contains("at least one"));
    }

    #[test]
    fn transitions_keep_null_names() {
        assert_eq!(call("transition_set", json!({ "clipId": "c2", "name": null })), ("transition.set", json!({ "clipId": "c2", "name": null })));
        assert_eq!(call("transition_set_all", json!({ "name": "Dissolve" })).1, json!({ "name": "Dissolve", "durationUs": 500_000 }));
        assert!(refused("transition_set", json!({ "clipId": "c2" })).contains("name"));
    }

    #[test]
    fn crossfade_needs_two_clips() {
        assert!(refused("audio_crossfade", json!({ "clipIds": ["a"], "durationUs": 1 })).contains("two"));
        assert_eq!(call("audio_crossfade", json!({ "clipIds": ["a", "b"], "durationUs": 300_000 })).0, "audio.crossfade");
    }

    #[test]
    fn overlay_roles() {
        assert_eq!(call("overlay_add", json!({ "mediaId": "m", "atUs": 0 })).1["role"], "overlay");
        assert_eq!(call("overlay_add", json!({ "mediaId": "m", "atUs": 0, "role": "sticker" })).1["role"], "sticker");
        assert!(refused("overlay_add", json!({ "mediaId": "m", "atUs": 0, "role": "text" })).contains("text_add"));
    }

    #[test]
    fn format_must_be_known() {
        assert!(refused("project_set_format", json!({ "aspect": "2:1" })).contains("9:16"));
        assert_eq!(call("project_set_format", json!({ "aspect": "4:5" })).1, json!({ "aspect": "4:5" }));
    }

    #[test]
    fn import_needs_paths() {
        assert!(refused("media_import", json!({ "paths": [] })).contains("non-empty"));
        assert!(refused("media_import", json!({ "paths": [1] })).contains("strings"));
        assert_eq!(call("media_import", json!({ "paths": ["C:/a.mp4"] })).1, json!({ "paths": ["C:/a.mp4"] }));
    }

    #[test]
    fn text_params() {
        let p = text_add_params(&args(json!({ "content": "Hej!", "atUs": 0, "style": { "size": 96, "color": "#FFFFFF", "png": "nope" } }))).unwrap();
        assert_eq!(p, json!({ "atUs": 0, "text": { "content": "Hej!", "size": 96, "color": "#FFFFFF" } }));
        assert!(text_add_params(&args(json!({ "content": " ", "atUs": 0 }))).is_err());
        assert!(text_add_params(&args(json!({ "content": "x" }))).is_err());
        let p = text_set_params(&args(json!({ "clipId": "c9", "content": "New" }))).unwrap();
        assert_eq!(p, json!({ "clipId": "c9", "text": { "content": "New" } }));
        assert!(text_set_params(&args(json!({ "clipId": "c9" }))).is_err());
    }

    #[test]
    fn caption_lines_are_checked() {
        let p = captions_params(&args(json!({ "lines": [{ "startUs": 0, "endUs": 1_000_000, "text": "Hi" }], "style": { "size": 60 } }))).unwrap();
        assert_eq!(p, json!({ "lines": [{ "startUs": 0, "endUs": 1_000_000, "text": "Hi" }], "style": { "size": 60 } }));
        assert!(captions_params(&args(json!({ "lines": [{ "startUs": 5, "endUs": 1, "text": "x" }] }))).unwrap_err().contains("ends before"));
        assert!(captions_params(&args(json!({ "lines": [{ "text": "x" }] }))).unwrap_err().contains("line 0"));
    }

    #[test]
    fn trim_fills_from_the_clip() {
        let clip = json!({ "id": "c1", "inUs": 500_000, "durationUs": 2_000_000 });
        assert_eq!(trim_params(&args(json!({ "clipId": "c1", "durationUs": 1_000_000 })), &clip).unwrap(), json!({ "clipId": "c1", "inUs": 500_000, "durationUs": 1_000_000 }));
        assert_eq!(trim_params(&args(json!({ "clipId": "c1", "inUs": 0, "startUs": 3 })), &clip).unwrap(), json!({ "clipId": "c1", "inUs": 0, "durationUs": 2_000_000, "startUs": 3 }));
        assert!(trim_params(&args(json!({ "clipId": "c1", "durationUs": 0 })), &clip).is_err());
    }

    #[test]
    fn export_defaults() {
        let plan = export_plan(&args(json!({})), "D:/Exports", "4:5").unwrap();
        assert_eq!(plan.params, json!({ "formats": ["4:5"], "folder": "D:/Exports" }));
        assert!(plan.wait);
        assert_eq!(plan.timeout_s, 600);
        let plan = export_plan(&args(json!({ "formats": ["9:16", "1:1"], "quality": "fast", "folder": "E:/x", "wait": false, "baseName": "Ad" })), "D:/Exports", "9:16").unwrap();
        assert_eq!(plan.params, json!({ "formats": ["9:16", "1:1"], "quality": "fast", "folder": "E:/x", "baseName": "Ad" }));
        assert!(!plan.wait);
        assert!(export_plan(&args(json!({ "formats": ["3:2"] })), "D", "9:16").is_err());
        assert!(export_plan(&args(json!({ "quality": "ultra" })), "D", "9:16").is_err());
    }

    #[test]
    fn actor_is_added_to_every_call() {
        assert_eq!(with_actor(json!({ "clipId": "c1" })), json!({ "clipId": "c1", "_actor": "claude" }));
        assert_eq!(with_actor(Value::Null), json!({ "_actor": "claude" }));
        // An agent can't pass itself off as the user.
        assert_eq!(with_actor(json!({ "_actor": "you" }))["_actor"], "claude");
    }
}
