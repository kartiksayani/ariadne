//! Size-capped rotating log at `$ARIADNE_HOME/logs/ariadne.log`.
//!
//! Callers log IDs, states and Ariadne's own error texts only: never message
//! bodies, payloads, provider output or credentials. Logging is best effort and
//! never fails or blocks the caller's operation beyond one short file append.
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

/// Each file is at most this size before it rotates.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Rotated files kept besides the active one (`ariadne.log.1` .. `.N`).
pub const ROTATED_FILES: usize = 3;
const LINE_BYTES: usize = 2048;
pub const FILE_NAME: &str = "ariadne.log";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}
impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

/// The private logs directory for one data root.
pub fn logs_dir(home: &Path) -> PathBuf {
    home.join("logs")
}

/// One rotating file. Public so tests and tools can use a private directory.
pub struct RotatingLog {
    directory: PathBuf,
    max_bytes: u64,
    keep: usize,
    file: Option<File>,
    size: u64,
}
impl RotatingLog {
    pub fn open(directory: &Path, max_bytes: u64, keep: usize) -> std::io::Result<Self> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)?;
        let mut log = Self {
            directory: directory.to_path_buf(),
            max_bytes: max_bytes.max(1),
            keep,
            file: None,
            size: 0,
        };
        log.reopen()?;
        Ok(log)
    }
    pub fn path(&self) -> PathBuf {
        self.directory.join(FILE_NAME)
    }
    fn reopen(&mut self) -> std::io::Result<()> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(self.path())?;
        self.size = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }
    fn rotate(&mut self) -> std::io::Result<()> {
        self.file = None;
        let name = |index: usize| self.directory.join(format!("{FILE_NAME}.{index}"));
        if self.keep == 0 {
            let _ = fs::remove_file(self.path());
        } else {
            let _ = fs::remove_file(name(self.keep));
            for index in (1..self.keep).rev() {
                let _ = fs::rename(name(index), name(index + 1));
            }
            let _ = fs::rename(self.path(), name(1));
        }
        self.reopen()
    }
    /// Appends one already formatted line, rotating first when it would overflow.
    pub fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        let bytes = line.len() as u64 + 1;
        if self.size > 0 && self.size + bytes > self.max_bytes {
            self.rotate()?;
        }
        if self.file.is_none() {
            self.reopen()?;
        }
        let file = self.file.as_mut().expect("reopened log file");
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        self.size += bytes;
        Ok(())
    }
}

static SINK: Mutex<Option<RotatingLog>> = Mutex::new(None);

/// Starts (or retargets) the process log under `$home/logs`. Returns the file path.
pub fn init(home: &Path) -> std::io::Result<PathBuf> {
    let log = RotatingLog::open(&logs_dir(home), MAX_FILE_BYTES, ROTATED_FILES)?;
    let path = log.path();
    *SINK.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(log);
    record(
        Level::Info,
        "app",
        &format!("Logging started (pid {}).", std::process::id()),
    );
    Ok(path)
}

/// Best-effort append; a no-op until [`init`] succeeded.
pub fn record(level: Level, component: &str, message: &str) {
    let mut sink = SINK.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some(log) = sink.as_mut() {
        let _ = log.write_line(&format_line(SystemTime::now(), level, component, message));
    }
}
pub fn info(component: &str, message: &str) {
    record(Level::Info, component, message);
}
pub fn warn(component: &str, message: &str) {
    record(Level::Warn, component, message);
}
pub fn error(component: &str, message: &str) {
    record(Level::Error, component, message);
}

/// `2026-10-07T18:41:00.123Z WARN supervisor message` on one bounded line.
pub fn format_line(at: SystemTime, level: Level, component: &str, message: &str) -> String {
    let mut line = format!("{} {} {} ", utc(at), level.label(), component);
    for character in message.chars() {
        if line.len() + character.len_utf8() > LINE_BYTES {
            line.push('…');
            break;
        }
        line.push(if character.is_control() {
            ' '
        } else {
            character
        });
    }
    line
}

/// RFC 3339 UTC with milliseconds, without a calendar dependency.
pub fn utc(at: SystemTime) -> String {
    let elapsed = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs();
    let (days, rest) = ((seconds / 86_400) as i64, seconds % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        elapsed.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, time::Duration};

    #[test]
    fn utc_formats_known_instants() {
        assert_eq!(utc(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let at = UNIX_EPOCH + Duration::from_millis(1_791_398_460_123);
        assert_eq!(utc(at), "2026-10-07T18:41:00.123Z");
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(utc(leap), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn lines_are_single_line_and_bounded() {
        let line = format_line(UNIX_EPOCH, Level::Warn, "supervisor", "a\nb\rc");
        assert_eq!(line, "1970-01-01T00:00:00.000Z WARN supervisor a b c");
        let long = format_line(UNIX_EPOCH, Level::Info, "x", &"é".repeat(5000));
        assert!(long.len() <= LINE_BYTES + '…'.len_utf8());
        assert!(long.ends_with('…'));
    }

    #[test]
    fn rotation_caps_size_and_keeps_a_bounded_number_of_files() {
        let directory = tempfile::tempdir().unwrap();
        let logs = directory.path().join("logs");
        let mut log = RotatingLog::open(&logs, 100, 2).unwrap();
        for index in 0..40 {
            log.write_line(&format!("line {index:03} padding padding"))
                .unwrap();
        }
        let mut names: Vec<_> = fs::read_dir(&logs)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["ariadne.log", "ariadne.log.1", "ariadne.log.2"]);
        for name in &names {
            assert!(fs::metadata(logs.join(name)).unwrap().len() <= 100);
        }
        let newest = fs::read_to_string(logs.join("ariadne.log")).unwrap();
        assert!(newest.contains("line 039"));
        assert_eq!(
            fs::metadata(&logs).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(logs.join("ariadne.log"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn reopening_appends_to_the_existing_file_size() {
        let directory = tempfile::tempdir().unwrap();
        let mut first = RotatingLog::open(directory.path(), 1000, 1).unwrap();
        first.write_line("first").unwrap();
        drop(first);
        let mut second = RotatingLog::open(directory.path(), 1000, 1).unwrap();
        second.write_line("second").unwrap();
        let text = fs::read_to_string(directory.path().join(FILE_NAME)).unwrap();
        assert_eq!(text, "first\nsecond\n");
    }

    #[test]
    fn init_writes_under_the_data_root_logs_directory() {
        let home = tempfile::tempdir().unwrap();
        let path = init(home.path()).unwrap();
        assert_eq!(path, home.path().join("logs/ariadne.log"));
        warn("supervisor", "binding=b1 backing off");
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("INFO app Logging started"));
        assert!(text.contains("WARN supervisor binding=b1 backing off"));
    }
}
