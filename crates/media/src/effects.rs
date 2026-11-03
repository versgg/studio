//! The Effects tab's video effects and the colour extras (HSL, curves, colour wheels, LUT)
//! as FFmpeg filters.
//!
//! Effects run on a frame of known size: the placed picture on the main track, an overlay's
//! own layer, or the composite under an adjustment layer. So effects that move pixels can
//! crop and scale back to it exactly. A few need more than one filter in a row (a blurred
//! copy screened over the picture); those come back as graph fragments with their own
//! labels, which still sit in a comma-separated chain.

use studio_engine_core::model::{Curves, Fx, HslMap, Lut, Wheel, Wheels};

/// The frame effects run on.
pub struct Frame {
    pub w: u32,
    pub h: u32,
    pub fps: u32,
    /// The output's width over the project's, so effects measured in pixels look the same in
    /// the half-size preview.
    pub k: f64,
    /// The frame has see-through parts (an overlay's layer) that must stay see-through.
    pub alpha: bool,
    /// How long the chain runs, in seconds (generated light needs a length).
    pub dur: f64,
}

/// Effects that only change colours. On a layer with alpha they run on its colour alone and
/// the alpha is put back unchanged; the others move pixels, alpha included.
fn colour_only(name: &str) -> bool {
    matches!(name, "Film grain" | "VHS" | "Sharpen" | "Black & white" | "Sepia" | "Vintage" | "Edge" | "Invert" | "Light leak")
}

/// A path inside a filter's options: forward slashes, the drive's colon escaped, quoted.
pub fn filter_path(p: &str) -> String {
    format!("'{}'", p.replace('\\', "/").replace('\'', "'\\''").replace(':', "\\:"))
}

/// The effects as one chain, in order. `tag` keeps this chain's labels apart from the rest of
/// the graph. Unknown names are skipped (the model refuses them).
pub fn effect_chain(fx: &[Fx], f: &Frame, tag: &str) -> Vec<String> {
    let mut out = vec![];
    for (i, e) in fx.iter().enumerate() {
        let a = (e.amount as f64 / 100.0).clamp(0.0, 1.0);
        if a <= 0.0 {
            continue;
        }
        let l = |s: &str| format!("[{tag}x{i}{s}]");
        let alpha = f.alpha && colour_only(&e.name);
        // Planar formats keep the alpha plane when there is one.
        let (yuv, gbr) = if f.alpha && !alpha { ("yuva420p", "gbrap") } else { ("yuv420p", "gbrp") };
        let px = |x: f64| x * f.k;
        let even = |x: f64| (((x * f.k) / 2.0).round() as i64 * 2).max(2);
        let chain = match e.name.as_str() {
            "Blur" => format!("gblur=sigma={:.2}", px(1.0 + 24.0 * a)),
            "Glow" => format!("format={gbr},split{}{};{}gblur=sigma={:.2}{};{}{}blend=all_mode=screen:all_opacity={:.3}", l("a"), l("b"), l("b"), px(8.0 + 24.0 * a), l("c"), l("a"), l("c"), 0.25 + 0.6 * a),
            "Film grain" => format!("format={yuv},noise=c0s={:.0}:c0f=t+u", 6.0 + 30.0 * a),
            "VHS" => {
                let d = even(2.0 + 6.0 * a);
                format!("format={yuv},chromashift=cbh={}:crh={d}:edge=smear,noise=c0s={:.0}:c0f=t,hue=s={:.3},gblur=sigma={:.2}:sigmaV=0.1", -d, 8.0 + 16.0 * a, 1.0 + 0.35 * a, px(0.6 + 1.4 * a))
            }
            "Glitch" => {
                let (s, d) = (even(3.0 + 8.0 * a), even(6.0 + 24.0 * a));
                format!("format={yuv},chromashift=crh={s}:cbh={}:edge=smear,crop=w=iw-{}:h=ih:x='{d}*(1+gt(random(0),{:.3})*(2*random(1)-1))':y=0,pad=w=iw+{}:h=ih:x={d}:y=0:color=black@0", -s, 2 * d, 0.92 - 0.4 * a, 2 * d)
            }
            "Shake" => {
                let d = even(f.w as f64 / f.k * (0.01 + 0.035 * a));
                format!("crop=w=iw-{}:h=ih-{}:x='{d}+{d}*sin(t*31)*sin(t*7+1)':y='{d}+{d}*sin(t*23+2)*sin(t*5)',scale={}:{}", 2 * d, 2 * d, f.w, f.h)
            }
            "Zoom pulse" => {
                // One beat a second, zooming in by up to 4–20 % and back.
                let m = format!("(1-1/(1+{:.3}*(0.5-0.5*cos(2*PI*in/{}))))/2", 0.04 + 0.16 * a, f.fps.max(1));
                format!("perspective=x0='W*{m}':y0='H*{m}':x1='W*(1-{m})':y1='H*{m}':x2='W*{m}':y2='H*(1-{m})':x3='W*(1-{m})':y3='H*(1-{m})':sense=source:eval=frame")
            }
            "Sharpen" => {
                let size = (((5.0 * f.k).round() as i32) | 1).clamp(3, 13);
                format!("unsharp=lx={size}:ly={size}:la={:.3}", 0.6 + 1.6 * a)
            }
            "Black & white" => format!("hue=s={:.3}", 1.0 - a),
            "Sepia" => {
                // The classic sepia matrix, mixed with the original by the amount.
                let s = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];
                let m = |r: usize, c: usize| (if r == c { 1.0 - a } else { 0.0 }) + a * s[r][c];
                format!("colorchannelmixer=rr={:.3}:rg={:.3}:rb={:.3}:gr={:.3}:gg={:.3}:gb={:.3}:br={:.3}:bg={:.3}:bb={:.3}", m(0, 0), m(0, 1), m(0, 2), m(1, 0), m(1, 1), m(1, 2), m(2, 0), m(2, 1), m(2, 2))
            }
            "Vintage" => {
                // FFmpeg's "vintage" curves preset, drawn towards straight by the amount.
                let pt = |x: f64, y: f64| format!("{x:.2}/{:.3}", x + (y - x) * a);
                format!("curves=r='{} {} {}':g='{} {} {}':b='{} {} {}',hue=s={:.3},vignette=a={:.3}", pt(0.0, 0.11), pt(0.42, 0.51), pt(1.0, 0.95), pt(0.0, 0.0), pt(0.5, 0.48), pt(1.0, 1.0), pt(0.0, 0.22), pt(0.49, 0.44), pt(1.0, 0.8), 1.0 - 0.3 * a, 0.2 + 0.4 * a)
            }
            "Chromatic" => {
                let d = ((1.0 + 7.0 * a) * f.k).round().max(1.0) as i64;
                format!("format={},rgbashift=rh={}:bh={d}:edge=smear", if f.alpha { "gbrap" } else { "gbrp" }, -d)
            }
            "Pixelate" => {
                let b = ((4.0 + 36.0 * a) * f.k).round().max(2.0) as i64;
                format!("pixelize=w={b}:h={b}")
            }
            "Mirror" => format!("split{}{};{}crop=iw/2:ih:0:0{};{}crop=iw/2:ih:0:0,hflip{};{}{}hstack", l("a"), l("b"), l("a"), l("l"), l("b"), l("r"), l("l"), l("r")),
            "Edge" => format!("format={gbr},split{}{};{}edgedetect=mode=colormix:low=0.05:high=0.2{};{}{}blend=all_mode=normal:all_opacity={a:.3}", l("a"), l("b"), l("b"), l("c"), l("c"), l("a")),
            "Invert" => format!("format={gbr},split{}{};{}negate{};{}{}blend=all_mode=normal:all_opacity={a:.3}", l("a"), l("b"), l("b"), l("c"), l("c"), l("a")),
            "Light leak" => {
                // A slowly drifting warm gradient, screened over the picture.
                format!(
                    "format={gbr}{};gradients=s={}x{}:c0=0xffa040:c1=0x000000:c2=0xff5a3c:nb_colors=3:x0=0:y0=0:x1={}:y1={}:speed=0.015:rate={}:d={:.3},format={gbr}{};{}{}blend=all_mode=screen:all_opacity={:.3}",
                    l("m"),
                    f.w,
                    f.h,
                    f.w,
                    f.h,
                    f.fps.max(1),
                    f.dur.max(0.1) + 1.0,
                    l("g"),
                    l("m"),
                    l("g"),
                    0.25 + 0.55 * a
                )
            }
            "Lens distort" => format!("lenscorrection=k1={:.3}:k2={:.3}", 0.5 * a, 0.25 * a),
            _ => continue,
        };
        out.push(if alpha { keep_alpha(&chain, &format!("{tag}x{i}k")) } else { chain });
    }
    out
}

/// Runs a colour-only chain on a layer's colour and puts its alpha back as it was.
pub fn keep_alpha(chain: &str, tag: &str) -> String {
    format!("format=rgba,split[{tag}c][{tag}a];[{tag}a]alphaextract[{tag}m];[{tag}c]{chain}[{tag}d];[{tag}d][{tag}m]alphamerge")
}

/// The HSL ranges as `huesaturation` colour selections. FFmpeg selects six ranges, so
/// Orange shares red's and yellow's, and Purple shares blue's and magenta's.
fn hsl_selection(range: &str) -> Option<&'static str> {
    Some(match range {
        "Red" => "r",
        "Orange" => "r+y",
        "Yellow" => "y",
        "Green" => "g",
        "Cyan" => "c",
        "Blue" => "b",
        "Purple" => "b+m",
        "Magenta" => "m",
        _ => return None,
    })
}

fn points(p: &[[f64; 2]]) -> String {
    p.iter().map(|q| format!("{:.4}/{:.4}", q[0], q[1])).collect::<Vec<_>>().join(" ")
}

/// A wheel's push as red, green and blue offsets, on the usual colour wheel (y up): red at
/// the top, green at the bottom right, blue at the bottom left.
fn push(w: &Wheel) -> [f64; 3] {
    let (r, a) = ((w.x as f64).hypot(w.y as f64).min(1.0), (w.y as f64).atan2(w.x as f64));
    [90.0, -30f64, 210f64].map(|deg| 0.4 * r * (a - deg.to_radians()).cos())
}

/// The colour extras as filters, in order: HSL, curves, colour wheels, LUT. Empty when
/// there are none. `tag` labels the LUT's mix with the original.
pub fn colour_extras(hsl: &HslMap, curves: &Curves, wheels: &Wheels, lut: Option<&Lut>, tag: &str) -> Vec<String> {
    let mut f = vec![];
    for (range, v) in hsl {
        if let Some(sel) = hsl_selection(range) {
            f.push(format!("huesaturation=hue={:.2}:saturation={:.3}:intensity={:.3}:colors={sel}", v.h as f64 * 0.6, v.s as f64 / 100.0, v.l as f64 / 100.0 * 0.5));
        }
    }
    let k = [("m", &curves.master), ("r", &curves.red), ("g", &curves.green), ("b", &curves.blue)];
    let set: Vec<String> = k.iter().filter_map(|(n, p)| p.as_ref().map(|p| format!("{n}='{}'", points(p)))).collect();
    if !set.is_empty() {
        f.push(format!("curves={}", set.join(":")));
    }
    let (lift, gamma, gain) = (wheels.lift.unwrap_or_default(), wheels.gamma.unwrap_or_default(), wheels.gain.unwrap_or_default());
    if [lift, gamma, gain].iter().any(|w| w.x != 0.0 || w.y != 0.0) {
        let (s, m, h) = (push(&lift), push(&gamma), push(&gain));
        f.push(format!("colorbalance=rs={:.3}:gs={:.3}:bs={:.3}:rm={:.3}:gm={:.3}:bm={:.3}:rh={:.3}:gh={:.3}:bh={:.3}", s[0], s[1], s[2], m[0], m[1], m[2], h[0], h[1], h[2]));
    }
    if [lift, gamma, gain].iter().any(|w| w.lum != 0.0) {
        // Lift raises (or crushes) the blacks, gamma bends the middle, gain the whites.
        let (l, g, n) = (lift.lum as f64 / 100.0, gamma.lum as f64 / 100.0, gain.lum as f64 / 100.0);
        let low = if l >= 0.0 { [0.0, 0.2 * l] } else { [-0.2 * l, 0.0] };
        let high = if n >= 0.0 { [1.0 - 0.2 * n, 1.0] } else { [1.0, 1.0 + 0.2 * n] };
        f.push(format!("curves=m='{}'", points(&[low, [0.5, 0.5 + 0.15 * g], high])));
    }
    if let Some(l) = lut {
        let s = (l.strength as f64 / 100.0).clamp(0.0, 1.0);
        let file = filter_path(&l.path);
        if s >= 0.999 {
            f.push(format!("lut3d=file={file}"));
        } else if s > 0.0 {
            f.push(format!("format=gbrp,split[{tag}la][{tag}lb];[{tag}lb]lut3d=file={file}[{tag}lc];[{tag}lc][{tag}la]blend=all_mode=normal:all_opacity={s:.3}"));
        }
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;
    use studio_engine_core::look::EFFECTS;
    use studio_engine_core::model::Hsl;

    #[test]
    fn every_effect_has_filters_and_labels_stay_apart() {
        let f = Frame { w: 540, h: 960, fps: 30, k: 0.5, alpha: false, dur: 2.0 };
        for name in EFFECTS {
            let chain = effect_chain(&[Fx { name: name.to_string(), amount: 50.0 }], &f, "s0");
            assert_eq!(chain.len(), 1, "{name}");
            if chain[0].contains('[') {
                assert!(chain[0].contains("[s0x0"), "{name}: {}", chain[0]);
            }
        }
        assert!(effect_chain(&[Fx { name: "Blur".into(), amount: 0.0 }], &f, "s0").is_empty(), "nothing at zero");
        let two = effect_chain(&[Fx { name: "Glow".into(), amount: 50.0 }, Fx { name: "Glow".into(), amount: 50.0 }], &f, "o3");
        assert!(two[0].contains("[o3x0a]") && two[1].contains("[o3x1a]"));
        // On a layer with alpha, colour-only effects run on the colour and keep the alpha.
        let a = Frame { alpha: true, ..f };
        let sepia = effect_chain(&[Fx { name: "Sepia".into(), amount: 100.0 }], &a, "o1");
        assert!(sepia[0].starts_with("format=rgba,split[o1x0kc][o1x0ka]") && sepia[0].ends_with("alphamerge"), "{}", sepia[0]);
        assert!(effect_chain(&[Fx { name: "Glitch".into(), amount: 50.0 }], &a, "o1")[0].starts_with("format=yuva420p"));
        assert_eq!(effect_chain(&[Fx { name: "Blur".into(), amount: 100.0 }], &f, "s")[0], "gblur=sigma=12.50");
    }

    #[test]
    fn colour_extras_in_order() {
        let mut hsl = HslMap::new();
        hsl.insert("Orange".into(), Hsl { h: 10.0, s: -50.0, l: 0.0 });
        let curves = Curves { master: Some(vec![[0.0, 0.1], [1.0, 0.9]]), ..Default::default() };
        // Pushed straight up: towards red, away from green and blue.
        let wheels = Wheels { lift: Some(Wheel { x: 0.0, y: 1.0, lum: 50.0 }), ..Default::default() };
        let lut = Lut { path: r"C:\Looks\warm.cube".into(), strength: 60.0 };
        let f = colour_extras(&hsl, &curves, &wheels, Some(&lut), "s2");
        assert_eq!(f[0], "huesaturation=hue=6.00:saturation=-0.500:intensity=0.000:colors=r+y");
        assert_eq!(f[1], "curves=m='0.0000/0.1000 1.0000/0.9000'");
        assert!(f[2].starts_with("colorbalance=rs=0.400:gs=-0.200:bs=-0.200:rm=0.000"), "{}", f[2]);
        assert_eq!(f[3], "curves=m='0.0000/0.1000 0.5000/0.5000 1.0000/1.0000'");
        assert!(f[4].contains("lut3d=file='C\\:/Looks/warm.cube'") && f[4].ends_with("all_opacity=0.600"), "{}", f[4]);
        assert!(colour_extras(&HslMap::new(), &Curves::default(), &Wheels::default(), None, "x").is_empty());
    }
}
