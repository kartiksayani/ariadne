//! The folder an owner types to register a project: `~` and `~/…` name the home
//! folder, and a folder that cannot be used fails with plain words, never the
//! store's Debug text.
use crate::{CoreError, CoreErrorCode};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// The folder `root` names, checked to exist and be a directory.
pub(super) fn resolve(root: &str) -> Result<PathBuf, CoreError> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let path = expand_home(root, home.as_deref());
    match std::fs::metadata(&path) {
        Ok(metadata) if metadata.is_dir() => Ok(path),
        Ok(_) => Err(failure(
            CoreErrorCode::InvalidArgument,
            format!("Not a folder: {}", path.display()),
            "Choose the project folder itself, not a file in it.",
        )),
        Err(error) => Err(match error.kind() {
            ErrorKind::NotFound => failure(
                CoreErrorCode::NotFound,
                format!("Folder not found: {}", path.display()),
                "Check the folder path, then register again.",
            ),
            ErrorKind::PermissionDenied => failure(
                CoreErrorCode::PermissionDenied,
                format!(
                    "Ariadne can't read {}. Check its permissions.",
                    path.display()
                ),
                "Allow Ariadne to read the folder, then register again.",
            ),
            _ => failure(
                CoreErrorCode::IoError,
                format!("Couldn't open folder {}.", path.display()),
                "Check that the folder is available, then register again.",
            ),
        }),
    }
}

/// `~` alone or a leading `~/` against `home`; anything else, `~user/…` included, unchanged.
pub(super) fn expand_home(root: &str, home: Option<&Path>) -> PathBuf {
    match (home, root.strip_prefix('~')) {
        (Some(home), Some("")) => home.to_path_buf(),
        (Some(home), Some(rest)) if rest.starts_with('/') => {
            home.join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(root),
    }
}

fn failure(code: CoreErrorCode, message: String, hint: &str) -> CoreError {
    CoreError::new(code, message, hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_only_the_owners_home() {
        let home = Path::new("/Users/owner");
        assert_eq!(expand_home("~", Some(home)), PathBuf::from("/Users/owner"));
        assert_eq!(expand_home("~/", Some(home)), PathBuf::from("/Users/owner"));
        assert_eq!(
            expand_home("~/Code/app", Some(home)),
            PathBuf::from("/Users/owner/Code/app")
        );
        assert_eq!(
            expand_home("~other/app", Some(home)),
            PathBuf::from("~other/app")
        );
        assert_eq!(
            expand_home("Code/app", Some(home)),
            PathBuf::from("Code/app")
        );
        assert_eq!(
            expand_home("/srv/app/~", Some(home)),
            PathBuf::from("/srv/app/~")
        );
        assert_eq!(expand_home("~/app", None), PathBuf::from("~/app"));
    }

    #[test]
    fn names_a_missing_folder_or_a_file_in_plain_words() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("project");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(resolve(folder.to_str().unwrap()).unwrap(), folder);

        let missing = temp.path().join("missing");
        let error = resolve(missing.to_str().unwrap()).unwrap_err();
        assert_eq!(error.code, CoreErrorCode::NotFound);
        assert_eq!(
            error.message,
            format!("Folder not found: {}", missing.display())
        );

        let file = temp.path().join("notes.txt");
        std::fs::write(&file, "x").unwrap();
        let error = resolve(file.to_str().unwrap()).unwrap_err();
        assert_eq!(error.code, CoreErrorCode::InvalidArgument);
        assert_eq!(error.message, format!("Not a folder: {}", file.display()));
    }

    #[test]
    fn a_relative_path_is_checked_as_given() {
        let error = resolve("no-such-ariadne-folder/inner").unwrap_err();
        assert_eq!(error.code, CoreErrorCode::NotFound);
        assert_eq!(
            error.message,
            "Folder not found: no-such-ariadne-folder/inner"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_parent_says_check_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let locked = temp.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let inner = locked.join("project");
        let result = resolve(inner.to_str().unwrap());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Root reads through any mode bits; there the folder is simply missing.
        let error = result.unwrap_err();
        if error.code == CoreErrorCode::PermissionDenied {
            assert_eq!(
                error.message,
                format!(
                    "Ariadne can't read {}. Check its permissions.",
                    inner.display()
                )
            );
        } else {
            assert_eq!(error.code, CoreErrorCode::NotFound);
        }
        assert!(!error.message.contains("Io {"));
    }
}
