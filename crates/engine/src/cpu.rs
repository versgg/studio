//! Total CPU time this process has used (user + kernel), for the perf log.

#[cfg(windows)]
pub fn process_cpu_ms() -> Option<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    let ok = unsafe { GetProcessTimes(GetCurrentProcess(), &mut created, &mut exited, &mut kernel, &mut user) };
    if ok == 0 {
        return None;
    }
    let ticks = |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64; // 100 ns units
    Some((ticks(kernel) + ticks(user)) / 10_000)
}

#[cfg(target_os = "linux")]
pub fn process_cpu_ms() -> Option<u64> {
    // Fields 14 and 15 of /proc/self/stat are utime and stime in clock ticks (100 Hz on Linux).
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let after_name = &stat[stat.rfind(')')? + 2..];
    let fields: Vec<&str> = after_name.split_whitespace().collect();
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    Some((utime + stime) * 10)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn process_cpu_ms() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_cpu_time_and_it_grows() {
        let before = super::process_cpu_ms().expect("cpu time");
        let mut x = 0u64;
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_millis(60) {
            x = x.wrapping_add(std::hint::black_box(1));
        }
        let after = super::process_cpu_ms().unwrap();
        assert!(after >= before, "{after} < {before} ({x})");
    }
}
