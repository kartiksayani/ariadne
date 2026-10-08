//! Opens a file named in agent text, such as `crates/foo/src/bar.rs:123`, in the
//! owner's text editor. Resolution happens only here: the reference is read
//! against the item's project folder, symlinks are followed, and the result must
//! be a regular file inside that folder. The file opens with the default text
//! editor (`open -t`), never its own app, so nothing it holds can run. The path
//! is one argument to /usr/bin/open, never shell text.
use super::*;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

const MAX_REFERENCE: usize = 1024;
/// The most references one call resolves; the rest come back as not openable.
const MAX_BATCH: usize = 64;

fn refused() -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidArgument,
        "This file cannot be opened.",
        "Only files inside the project folder open from Ariadne.",
    )
}

/// The path part of a reference: a trailing `:123` or `:123:4` is a line, not a name.
fn without_line(reference: &str) -> &str {
    let mut path = reference;
    for _ in 0..2 {
        match path.rsplit_once(':') {
            Some((head, tail))
                if !head.is_empty()
                    && !tail.is_empty()
                    && tail.bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                path = head;
            }
            _ => break,
        }
    }
    path
}

/// The canonical regular file a reference names inside `root`, else None.
/// Relative references read against `root`; absolute and `~/` ones count only
/// when they land inside it. `..` and symlinks are resolved before the check.
fn resolve(root: &Path, home: Option<&Path>, reference: &str) -> Option<PathBuf> {
    if reference.is_empty()
        || reference.len() > MAX_REFERENCE
        || reference.chars().any(char::is_control)
    {
        return None;
    }
    let path = without_line(reference);
    let candidate = if let Some(rest) = path.strip_prefix("~/") {
        home?.join(rest)
    } else if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };
    let root = root.canonicalize().ok()?;
    let file = candidate.canonicalize().ok()?;
    (file.starts_with(&root) && std::fs::metadata(&file).ok()?.is_file()).then_some(file)
}

fn resolve_in(root: &Path, reference: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    resolve(root, home.as_deref(), reference)
}

/// The arguments for /usr/bin/open: `-t` picks the text editor; the path is
/// absolute, so it can never read as an option.
fn open_args(file: &Path) -> Vec<OsString> {
    vec!["-t".into(), file.as_os_str().to_owned()]
}

impl DesktopService {
    /// The folder of a registered project, as the catalogue reports it.
    fn project_folder(&self, project_id: &UuidV4) -> Result<PathBuf, CoreError> {
        let mut cursor = None;
        loop {
            let QueryResult::ProjectList(result) = self.native_query(OwnerQueryRequest {
                session: None,
                request: QueryRequest::ProjectList(ProjectListRequest {
                    cursor,
                    limit: PageLimit::new(100).expect("literal"),
                }),
            })?
            else {
                return Err(refused());
            };
            if let Some(project) = result
                .projects
                .items
                .iter()
                .find(|project| &project.project_id == project_id)
            {
                return Ok(PathBuf::from(&project.canonical_root));
            }
            cursor = result.projects.next_cursor;
            if cursor.is_none() {
                return Err(refused());
            }
        }
    }
}

/// Which of the references name a file the owner can open from this project.
#[tauri::command]
pub async fn file_references_resolve<R: tauri::Runtime>(
    project_id: UuidV4,
    references: Vec<String>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<bool>, CoreError> {
    let service = app.state::<DesktopService>().inner().clone();
    blocking(move || {
        let root = service.project_folder(&project_id)?;
        Ok(references
            .iter()
            .enumerate()
            .map(|(at, reference)| at < MAX_BATCH && resolve_in(&root, reference).is_some())
            .collect())
    })
    .await
    .map_err(|()| refused())?
}

/// Opens the file a reference names in the owner's default text editor.
#[tauri::command]
pub async fn file_reference_open<R: tauri::Runtime>(
    project_id: UuidV4,
    reference: String,
    app: tauri::AppHandle<R>,
) -> Result<(), CoreError> {
    let service = app.state::<DesktopService>().inner().clone();
    let status = blocking(move || {
        let root = service.project_folder(&project_id)?;
        let file = resolve_in(&root, &reference).ok_or_else(refused)?;
        Ok::<_, CoreError>(
            std::process::Command::new("/usr/bin/open")
                .args(open_args(&file))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status(),
        )
    })
    .await
    .map_err(|()| refused())??;
    match status {
        Ok(status) if status.success() => Ok(()),
        _ => Err(CoreError::new(
            CoreErrorCode::IoError,
            "The file did not open.",
            "Open it from your project folder instead.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    struct Folders {
        _dir: tempfile::TempDir,
        project: PathBuf,
        outside: PathBuf,
    }

    fn folders() -> Folders {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let project = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(project.join("src/deep")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(project.join("src/app.ts"), "x").unwrap();
        fs::write(project.join("src/deep/bar.rs"), "x").unwrap();
        fs::write(outside.join("secret.txt"), "x").unwrap();
        Folders {
            _dir: dir,
            project,
            outside,
        }
    }

    #[test]
    fn a_file_inside_the_project_resolves_with_or_without_a_line() {
        let f = folders();
        let app = f.project.join("src/app.ts");
        assert_eq!(resolve(&f.project, None, "src/app.ts"), Some(app.clone()));
        assert_eq!(
            resolve(&f.project, None, "src/app.ts:12"),
            Some(app.clone())
        );
        assert_eq!(resolve(&f.project, None, "src/app.ts:12:4"), Some(app));
        assert_eq!(
            resolve(&f.project, None, "src/deep/bar.rs:123"),
            Some(f.project.join("src/deep/bar.rs"))
        );
    }

    #[test]
    fn a_file_outside_the_project_is_refused() {
        let f = folders();
        let secret = f.outside.join("secret.txt");
        assert_eq!(resolve(&f.project, None, "../outside/secret.txt"), None);
        assert_eq!(resolve(&f.project, None, secret.to_str().unwrap()), None);
        let with_line = format!("{}:3", secret.display());
        assert_eq!(resolve(&f.project, None, &with_line), None);
    }

    #[test]
    fn dot_dot_that_stays_inside_the_project_resolves() {
        let f = folders();
        assert_eq!(
            resolve(&f.project, None, "src/deep/../app.ts"),
            Some(f.project.join("src/app.ts"))
        );
        assert_eq!(
            resolve(&f.project, None, "src/../../outside/secret.txt"),
            None
        );
        assert_eq!(resolve(&f.project, None, ".."), None);
    }

    #[test]
    fn an_absolute_path_inside_the_project_resolves() {
        let f = folders();
        let app = f.project.join("src/app.ts");
        assert_eq!(resolve(&f.project, None, app.to_str().unwrap()), Some(app));
    }

    #[test]
    fn a_tilde_path_counts_only_when_it_lands_inside_the_project() {
        let f = folders();
        let home = f.project.parent().unwrap().to_owned();
        assert_eq!(
            resolve(&f.project, Some(&home), "~/project/src/app.ts:9"),
            Some(f.project.join("src/app.ts"))
        );
        assert_eq!(
            resolve(&f.project, Some(&home), "~/outside/secret.txt"),
            None
        );
        // No home folder: a tilde path cannot resolve.
        assert_eq!(resolve(&f.project, None, "~/project/src/app.ts"), None);
    }

    #[test]
    fn a_symlink_that_escapes_the_project_is_refused() {
        let f = folders();
        symlink(f.outside.join("secret.txt"), f.project.join("link.txt")).unwrap();
        symlink(&f.outside, f.project.join("linked-dir")).unwrap();
        assert_eq!(resolve(&f.project, None, "link.txt"), None);
        assert_eq!(resolve(&f.project, None, "linked-dir/secret.txt"), None);
    }

    #[test]
    fn a_symlink_that_stays_inside_resolves_to_the_real_file() {
        let f = folders();
        symlink(f.project.join("src/app.ts"), f.project.join("alias.ts")).unwrap();
        assert_eq!(
            resolve(&f.project, None, "alias.ts"),
            Some(f.project.join("src/app.ts"))
        );
    }

    #[test]
    fn a_symlinked_project_folder_still_resolves_its_files() {
        let f = folders();
        let alias = f.outside.join("project-alias");
        symlink(&f.project, &alias).unwrap();
        assert_eq!(
            resolve(&alias, None, "src/app.ts"),
            Some(f.project.join("src/app.ts"))
        );
    }

    #[test]
    fn a_directory_is_refused() {
        let f = folders();
        assert_eq!(resolve(&f.project, None, "src"), None);
        assert_eq!(resolve(&f.project, None, "src/deep/"), None);
        assert_eq!(resolve(&f.project, None, f.project.to_str().unwrap()), None);
    }

    #[test]
    fn a_missing_file_or_a_malformed_reference_is_refused() {
        let f = folders();
        assert_eq!(resolve(&f.project, None, "src/missing.rs:1"), None);
        assert_eq!(resolve(&f.project, None, ""), None);
        assert_eq!(resolve(&f.project, None, ":12"), None);
        assert_eq!(resolve(&f.project, None, "src/app.ts\n"), None);
        assert_eq!(resolve(&f.project, None, "src/app.ts\0"), None);
        let long = format!("{}.rs", "a".repeat(MAX_REFERENCE));
        assert_eq!(resolve(&f.project, None, &long), None);
        // A missing project folder resolves nothing.
        assert_eq!(resolve(&f.project.join("gone"), None, "src/app.ts"), None);
    }

    #[test]
    fn only_a_numeric_suffix_is_a_line() {
        assert_eq!(without_line("a/b.rs:123"), "a/b.rs");
        assert_eq!(without_line("a/b.rs:123:4"), "a/b.rs");
        assert_eq!(without_line("a/b.rs:12:3:4"), "a/b.rs:12");
        assert_eq!(without_line("a/b.rs:x"), "a/b.rs:x");
        assert_eq!(without_line("a/b.rs:"), "a/b.rs:");
        assert_eq!(without_line("a/b.rs"), "a/b.rs");
    }

    #[test]
    fn the_file_opens_in_the_text_editor_as_one_argument() {
        let args = open_args(Path::new("/p/a b;rm -rf.sh"));
        assert_eq!(
            args,
            vec![OsString::from("-t"), OsString::from("/p/a b;rm -rf.sh")]
        );
    }
}
