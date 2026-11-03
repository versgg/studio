//! Step 0 test pattern: colour bands sliding sideways, a dark band sliding down,
//! a bouncing square, a coral "playhead" line, and the frame number as 20 binary
//! blocks across the top so a dropped or repeated frame is visible at a glance.

const PALETTE: [[u8; 3]; 6] = [[59, 87, 240], [255, 107, 74], [255, 210, 63], [243, 242, 238], [46, 158, 106], [156, 195, 245]];

pub fn draw(px: &mut [u8], width: u32, height: u32, stride: u32, n: u64) {
    let (w, h, stride) = (width as usize, height as usize, stride as usize);
    if w == 0 || h == 0 {
        return;
    }
    let band = (w / 6).max(1);
    let cycle = band * 6;
    let shift = (n as usize * 6) % cycle;
    let mut row = vec![0u8; w * 4];
    for x in 0..w {
        let pos = (x + shift) % cycle;
        let c = PALETTE[(pos / band).min(5)];
        let shade = 160 + (pos % band * 95 / band) as u16;
        let i = x * 4;
        row[i] = (c[0] as u16 * shade / 255) as u8;
        row[i + 1] = (c[1] as u16 * shade / 255) as u8;
        row[i + 2] = (c[2] as u16 * shade / 255) as u8;
        row[i + 3] = 255;
    }
    for y in 0..h {
        px[y * stride..y * stride + w * 4].copy_from_slice(&row);
    }

    let band_h = (h / 10).max(1);
    let band_y = (n as usize * 9) % h;
    for y in band_y..(band_y + band_h).min(h) {
        for b in px[y * stride..y * stride + w * 4].iter_mut() {
            *b /= 2;
        }
        px[y * stride + 3..y * stride + w * 4].iter_mut().step_by(4).for_each(|a| *a = 255);
    }

    let size = (w / 4).max(1).min(h);
    let bx = bounce(n * 7, w - size);
    let by = bounce(n * 11, h - size);
    fill_rect(px, stride, w, h, bx, by, size, size, [17, 17, 20, 255]);
    fill_rect(px, stride, w, h, bx + size / 8, by + size / 8, size * 3 / 4, size * 3 / 4, [255, 107, 74, 255]);

    let cell = (w / 24).max(2);
    for bit in 0..20 {
        let on = (n >> bit) & 1 == 1;
        let colour = if on { [255, 255, 255, 255] } else { [40, 40, 46, 255] };
        fill_rect(px, stride, w, h, cell / 2 + bit * cell, cell / 2, cell - 2, cell - 2, colour);
    }

    let lx = (n as usize * 8) % w;
    fill_rect(px, stride, w, h, lx, 0, 3, h, [255, 107, 74, 255]);
}

fn bounce(t: u64, max: usize) -> usize {
    if max == 0 {
        return 0;
    }
    let p = t as usize % (2 * max);
    if p < max { p } else { 2 * max - p }
}

#[allow(clippy::too_many_arguments)]
fn fill_rect(px: &mut [u8], stride: usize, w: usize, h: usize, x: usize, y: usize, rw: usize, rh: usize, rgba: [u8; 4]) {
    let (x_end, y_end) = ((x + rw).min(w), (y + rh).min(h));
    if x >= x_end || y >= y_end {
        return;
    }
    for row in y..y_end {
        let line = &mut px[row * stride + x * 4..row * stride + x_end * 4];
        for p in line.chunks_exact_mut(4) {
            p.copy_from_slice(&rgba);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_any_size_without_panicking() {
        for (w, h) in [(1, 1), (7, 3), (64, 64), (1080, 1920)] {
            let mut px = vec![0u8; w * h * 4];
            for n in [0, 1, 99, 1_000_003] {
                draw(&mut px, w as u32, h as u32, (w * 4) as u32, n);
            }
        }
    }

    #[test]
    fn consecutive_frames_differ() {
        let (w, h) = (96, 160);
        let mut a = vec![0u8; w * h * 4];
        let mut b = vec![0u8; w * h * 4];
        draw(&mut a, w as u32, h as u32, (w * 4) as u32, 10);
        draw(&mut b, w as u32, h as u32, (w * 4) as u32, 11);
        assert_ne!(a, b);
    }
}
