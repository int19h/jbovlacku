use crate::{Error, Result, Snapshot, validate_path};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
};

/// These local read limits do not change carrier format validity.
#[derive(Clone, Copy, Debug)]
pub struct ReadLimits {
    pub max_total_bytes: usize,
    pub max_files: usize,
    pub max_readme_bytes: usize,
}
impl Default for ReadLimits {
    fn default() -> Self {
        Self {
            max_total_bytes: 128 * 1024 * 1024,
            max_files: 250_000,
            max_readme_bytes: 1024 * 1024,
        }
    }
}
fn resource(message: &str) -> Error {
    Error::new(
        "resource_unavailable",
        format!("local read policy: {message}"),
    )
}
fn file_limit(path: &str, limits: ReadLimits) -> usize {
    if path.starts_with("records/") {
        crate::PART_BYTES
    } else if path.starts_with("import-selections/") {
        crate::SELECTION_BYTES
    } else if path == "README.md" {
        limits.max_readme_bytes
    } else {
        4096
    }
}
fn check_size(
    path: &str,
    size: usize,
    total: usize,
    count: usize,
    limits: ReadLimits,
) -> Result<()> {
    if size > file_limit(path, limits) {
        return Err(if path == "README.md" {
            resource("README.md exceeds its byte limit")
        } else {
            Error::new("file_size", format!("{path} exceeds its format limit"))
        });
    }
    if count >= limits.max_files {
        return Err(resource("file count exceeds its limit"));
    }
    if size > limits.max_total_bytes.saturating_sub(total) {
        return Err(resource("total file bytes exceed their limit"));
    }
    Ok(())
}

fn io_error(path: &Path, e: std::io::Error) -> Error {
    Error::new("filesystem", format!("{}: {e}", path.display()))
}
fn permitted_directory(path: &str) -> bool {
    matches!(path, "records" | "import-selections") || {
        let p: Vec<_> = path.split('/').collect();
        p.len() == 2
            && ["records", "import-selections"].contains(&p[0])
            && p[1].len() == 2
            && p[1]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}
fn regular(path: &Path, meta: &fs::Metadata) -> Result<()> {
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(Error::new(
            "file_type",
            format!("{} must be a regular file", path.display()),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 != 0 {
            return Err(Error::new(
                "file_mode",
                format!("{} must not be executable", path.display()),
            ));
        }
    }
    Ok(())
}
fn open_regular(path: &Path) -> Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Refuse a final symlink and avoid waiting on a swapped pipe or device.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| io_error(path, e))?;
    regular(path, &file.metadata().map_err(|e| io_error(path, e))?)?;
    Ok(file)
}
fn read_files(root: &Path, limits: ReadLimits) -> Result<BTreeMap<String, Vec<u8>>> {
    let metadata = fs::symlink_metadata(root).map_err(|e| io_error(root, e))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::new(
            "directory",
            "carrier root must be a real directory",
        ));
    }
    let mut files = BTreeMap::new();
    fn visit(
        root: &Path,
        dir: &Path,
        files: &mut BTreeMap<String, Vec<u8>>,
        total: &mut usize,
        limits: ReadLimits,
    ) -> Result<()> {
        for entry in fs::read_dir(dir).map_err(|e| io_error(dir, e))? {
            let path = entry.map_err(|e| io_error(dir, e))?.path();
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .ok_or_else(|| Error::new("path", "carrier path must use UTF-8"))?
                .replace(std::path::MAIN_SEPARATOR, "/");
            if relative == ".git" {
                continue;
            }
            let meta = fs::symlink_metadata(&path).map_err(|e| io_error(&path, e))?;
            if meta.is_dir() && !meta.file_type().is_symlink() {
                if !permitted_directory(&relative) {
                    return Err(Error::new(
                        "path",
                        format!("unexpected carrier directory: {relative}"),
                    ));
                }
                visit(root, &path, files, total, limits)?;
            } else {
                validate_path(&relative)?;
                regular(&path, &meta)?;
                let size = usize::try_from(meta.len())
                    .map_err(|_| resource("file size exceeds address space"))?;
                check_size(&relative, size, *total, files.len(), limits)?;
                let file = open_regular(&path)?;
                let max = file_limit(&relative, limits)
                    .min(limits.max_total_bytes.saturating_sub(*total));
                let mut bytes = Vec::new();
                file.take((max as u64).saturating_add(1))
                    .read_to_end(&mut bytes)
                    .map_err(|e| io_error(&path, e))?;
                check_size(&relative, bytes.len(), *total, files.len(), limits)?;
                *total += bytes.len();
                files.insert(relative, bytes);
            }
        }
        Ok(())
    }
    visit(root, root, &mut files, &mut 0, limits)?;
    Ok(files)
}
pub fn read_directory(root: impl AsRef<Path>) -> Result<Snapshot> {
    read_directory_with_limits(root, ReadLimits::default())
}
pub fn read_directory_with_limits(root: impl AsRef<Path>, limits: ReadLimits) -> Result<Snapshot> {
    Snapshot::from_files(&read_files(root.as_ref(), limits)?)
}

/// Write a new directory. An existing output path returns output_exists.
pub fn write_directory(root: impl AsRef<Path>, snapshot: &Snapshot) -> Result<()> {
    let root = root.as_ref();
    let files = snapshot.to_files()?;
    if root.try_exists().map_err(|e| io_error(root, e))? {
        return Err(Error::new("output_exists", "output path already exists"));
    }
    let parent = root
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err(Error::new(
            "output_parent",
            "output parent directory does not exist",
        ));
    }
    fs::create_dir(root).map_err(|e| io_error(root, e))?;
    for (relative, bytes) in files {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| io_error(parent, e))?;
        }
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|e| io_error(&path, e))?;
        file.write_all(&bytes).map_err(|e| io_error(&path, e))?;
        file.sync_all().map_err(|e| io_error(&path, e))?;
    }
    Ok(())
}

fn git(repo: &Path) -> Command {
    let mut c = Command::new("git");
    // These commands read local trees and blobs. They never invoke a worktree filter.
    c.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        c.env("PATH", path);
    }
    for (key, value) in [
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_NO_LAZY_FETCH", "1"),
        ("GIT_OPTIONAL_LOCKS", "0"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_PAGER", "cat"),
    ] {
        c.env(key, value);
    }
    c.arg("--no-pager")
        .arg("--no-replace-objects")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("gc.auto=0")
        .arg("-c")
        .arg("maintenance.auto=false")
        .arg("-c")
        .arg("protocol.allow=never")
        .arg("-C")
        .arg(repo);
    c
}
fn run_git(repo: &Path, args: &[&OsStr], max_output: usize) -> Result<Vec<u8>> {
    let mut child = git(repo)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::new("git", e.to_string()))?;
    let mut stderr = child.stderr.take().unwrap();
    // Drain error output without retaining an unbounded error message.
    let errors = std::thread::spawn(move || {
        let mut prefix = Vec::new();
        let mut block = [0; 4096];
        loop {
            match stderr.read(&mut block) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let keep = n.min(4096usize.saturating_sub(prefix.len()));
                    prefix.extend_from_slice(&block[..keep]);
                }
            }
        }
        prefix
    });
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .unwrap()
        .take((max_output as u64).saturating_add(1))
        .read_to_end(&mut bytes);
    if read.is_err() || bytes.len() > max_output {
        let _ = child.kill();
        let _ = child.wait();
        let _ = errors.join();
        return Err(resource(
            "Git command output exceeds its byte limit or cannot be read",
        ));
    }
    let status = child.wait().map_err(|e| Error::new("git", e.to_string()))?;
    let stderr = errors.join().unwrap_or_default();
    if !status.success() {
        return Err(Error::new(
            "git",
            String::from_utf8_lossy(&stderr).trim().to_owned(),
        ));
    }
    Ok(bytes)
}
fn git_files(repo: &Path, commit: &str, limits: ReadLimits) -> Result<BTreeMap<String, Vec<u8>>> {
    // Only full object identifiers enter Git arguments. No ref expression is evaluated.
    if ![40, 64].contains(&commit.len())
        || !commit
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::new(
            "git_commit",
            "provide a full lowercase Git commit object identifier",
        ));
    }
    let resolved = run_git(
        repo,
        &[
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new("--end-of-options"),
            OsStr::new(&format!("{commit}^{{commit}}")),
        ],
        4096,
    )?;
    if String::from_utf8_lossy(&resolved).trim() != commit {
        return Err(Error::new(
            "git_commit",
            "requested object is not the exact commit",
        ));
    }
    let listing = run_git(
        repo,
        &[
            OsStr::new("ls-tree"),
            OsStr::new("-r"),
            OsStr::new("-t"),
            OsStr::new("-z"),
            OsStr::new("--full-tree"),
            OsStr::new(commit),
        ],
        limits.max_total_bytes,
    )?;
    let mut files = BTreeMap::new();
    let mut total = 0;
    for entry in listing.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let tab = entry
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| Error::new("git_tree", "Git tree entry lacks a path"))?;
        let metadata = std::str::from_utf8(&entry[..tab])
            .map_err(|_| Error::new("git_tree", "Git metadata uses invalid encoding"))?;
        let path = std::str::from_utf8(&entry[tab + 1..])
            .map_err(|_| Error::new("path", "Git path must use UTF-8"))?;
        let fields: Vec<_> = metadata.split(' ').collect();
        if fields.len() == 3 && fields[0] == "040000" && fields[1] == "tree" {
            if !permitted_directory(path) {
                return Err(Error::new(
                    "path",
                    format!("unexpected carrier tree: {path}"),
                ));
            }
            continue;
        }
        validate_path(path)?;
        if fields.len() != 3 || fields[0] != "100644" || fields[1] != "blob" {
            return Err(Error::new(
                "git_mode",
                format!("{path} must be a nonexecutable regular blob"),
            ));
        }
        let oid = fields[2];
        if ![40, 64].contains(&oid.len())
            || !oid
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::new(
                "git_blob",
                "Git tree has an invalid blob identifier",
            ));
        }
        let size = run_git(
            repo,
            &[OsStr::new("cat-file"), OsStr::new("-s"), OsStr::new(oid)],
            4096,
        )?;
        let size = String::from_utf8_lossy(&size)
            .trim()
            .parse::<usize>()
            .map_err(|_| Error::new("git_blob", "Git returned an invalid blob size"))?;
        check_size(path, size, total, files.len(), limits)?;
        let body = run_git(
            repo,
            &[OsStr::new("cat-file"), OsStr::new("blob"), OsStr::new(oid)],
            size,
        )?;
        if body.len() != size {
            return Err(Error::new(
                "git_blob",
                "Git blob length differs from its reported size",
            ));
        }
        total += size;
        files.insert(path.to_owned(), body);
    }
    Ok(files)
}
pub fn read_git_tree(repo: impl AsRef<Path>, commit: &str) -> Result<Snapshot> {
    read_git_tree_with_limits(repo, commit, ReadLimits::default())
}
pub fn read_git_tree_with_limits(
    repo: impl AsRef<Path>,
    commit: &str,
    limits: ReadLimits,
) -> Result<Snapshot> {
    Snapshot::from_files(&git_files(repo.as_ref(), commit, limits)?)
}
pub fn validate_checkout(repo: impl AsRef<Path>, commit: &str) -> Result<Snapshot> {
    validate_checkout_with_limits(repo, commit, ReadLimits::default())
}
pub fn validate_checkout_with_limits(
    repo: impl AsRef<Path>,
    commit: &str,
    limits: ReadLimits,
) -> Result<Snapshot> {
    let repo = repo.as_ref();
    let blobs = git_files(repo, commit, limits)?;
    let checkout = read_files(repo, limits)?;
    if blobs != checkout {
        return Err(Error::new(
            "checkout_transformed",
            "checkout files differ from the exact committed Git blob bytes",
        ));
    }
    Snapshot::from_files(&checkout)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn final_open_refuses_a_file_swapped_for_a_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("README.md");
        let outside = temp.path().join("outside");
        fs::write(&path, b"original").unwrap();
        fs::write(&outside, b"replacement").unwrap();
        regular(&path, &fs::symlink_metadata(&path).unwrap()).unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(open_regular(&path).is_err());
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"regular").unwrap();
        let mut bytes = Vec::new();
        open_regular(&path)
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"regular");
    }
}
