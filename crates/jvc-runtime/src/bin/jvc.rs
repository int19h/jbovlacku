//! Native tools for authenticated records and local Git carriers.
use jvc_core::{canonical_value, canonicalize_json, export_jsonl, verify_envelope};
use serde_json::json;
use std::{
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
fn check_input(file: &fs::File, limit: Option<u64>) -> Result<(), Box<dyn std::error::Error>> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("input must be a regular file".into());
    }
    if let Some(limit) = limit
        && metadata.len() > limit
    {
        return Err("input exceeds the configured input limit".into());
    }
    Ok(())
}
fn read_bounded(
    reader: impl Read,
    limit: Option<u64>,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    match limit {
        Some(limit) => {
            reader.take(limit + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > limit {
                return Err("input exceeds the configured input limit".into());
            }
        }
        None => {
            let mut reader = reader;
            reader.read_to_end(&mut bytes)?;
        }
    }
    Ok(bytes)
}
fn open_input(path: &str, limit: Option<u64>) -> Result<fs::File, Box<dyn std::error::Error>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Check and read the opened file. A replaced pipe must not block the command.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(not(unix))]
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err("input must be a regular file".into());
    }
    let file = options.open(path)?;
    check_input(&file, limit)?;
    Ok(file)
}
fn read(path: &str, limit: Option<u64>) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    read_bounded(open_input(path, limit)?, limit)
}
/// A reader that enforces an optional total input quota while streaming.
struct QuotaReader<R: Read> {
    inner: R,
    limit: Option<u64>,
    seen: u64,
}
impl<R: Read> Read for QuotaReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let allowed = match self.limit {
            Some(limit) => {
                let remaining = limit.saturating_sub(self.seen);
                if remaining == 0 {
                    // Probe for one more byte so an exact-fit input succeeds.
                    let mut probe = [0u8; 1];
                    return match self.inner.read(&mut probe)? {
                        0 => Ok(0),
                        _ => Err(io::Error::other("input exceeds the configured input limit")),
                    };
                }
                remaining.min(buffer.len() as u64) as usize
            }
            None => buffer.len(),
        };
        let read = self.inner.read(&mut buffer[..allowed])?;
        self.seen += read as u64;
        Ok(read)
    }
}
fn quota_reader<R: Read>(inner: R, limit: Option<u64>) -> QuotaReader<R> {
    QuotaReader {
        inner,
        limit,
        seen: 0,
    }
}
fn read_jsonl_snapshot(
    path: &str,
    limit: Option<u64>,
) -> Result<jvc_carrier::Snapshot, Box<dyn std::error::Error>> {
    let reader = io::BufReader::new(quota_reader(open_input(path, limit)?, limit));
    Ok(jvc_carrier::Snapshot::from_jsonl_reader(reader)?)
}
fn read_envelope_events(
    path: &str,
    limit: Option<u64>,
) -> Result<Vec<jvc_core::VerifiedEnvelope>, Box<dyn std::error::Error>> {
    let reader = io::BufReader::new(quota_reader(open_input(path, limit)?, limit));
    Ok(jvc_core::import_jsonl_reader(reader)?)
}

fn write_new(path: &str, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(Path::new(path))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
fn policy_sidecar(path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut name = path
        .file_name()
        .ok_or("carrier path must name a directory")?
        .to_os_string();
    name.push(".retention-policy.json");
    Ok(path.with_file_name(name))
}
fn require_explicit_merge_policy(inputs: &[&str]) -> Result<(), Box<dyn std::error::Error>> {
    for input in inputs {
        let directory = fs::canonicalize(input)?;
        let sidecar = policy_sidecar(&directory)?;
        match fs::symlink_metadata(&sidecar) {
            Ok(_) => return Err(format!("input has a saved retention policy at {}. Supply --policy FILE explicitly. The supplied policy is your operator choice.", sidecar.display()).into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
fn write_filtered(
    path: &str,
    snapshot: &jvc_carrier::Snapshot,
) -> Result<(), Box<dyn std::error::Error>> {
    let sidecar_path = policy_sidecar(Path::new(path))?;
    let sidecar = sidecar_path.to_str().ok_or("policy path must use UTF-8")?;
    if Path::new(path).try_exists()? {
        return Err("output carrier path already exists".into());
    }
    write_new(
        sidecar,
        &canonical_value(&serde_json::to_value(snapshot.retention_policy())?)?,
    )?;
    jvc_carrier::write_directory(path, snapshot)?;
    println!(
        "{}",
        serde_json::to_string(
            &json!({"output":path,"retention_policy":sidecar,"later_merge_requires_policy":true})
        )?
    );
    Ok(())
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    // An optional input quota is off by default. It applies per input file.
    let mut input_limit: Option<u64> = None;
    if args.first().is_some_and(|a| a == "--input-limit") {
        if args.len() < 2 {
            return Err("--input-limit requires a byte count".into());
        }
        input_limit = Some(
            args[1]
                .parse::<u64>()
                .map_err(|_| "--input-limit requires a byte count")?,
        );
        args.drain(..2);
    } else if let Some(value) = args.first().and_then(|a| a.strip_prefix("--input-limit=")) {
        input_limit = Some(
            value
                .parse::<u64>()
                .map_err(|_| "--input-limit requires a byte count")?,
        );
        args.remove(0);
    }
    if args.len() >= 6
        && args[0] == "import"
        && args[2] == "--format"
        && args[3] == "jsonl"
        && args[4] == "--output"
    {
        let mut snapshot = read_jsonl_snapshot(&args[1], input_limit)?;
        for pair in args[6..].chunks(2) {
            if pair.len() != 2 || pair[0] != "--selection" {
                return Err("selection inputs must use --selection FILE".into());
            }
            let bytes = read(&pair[1], input_limit)?;
            let hash = jvc_core::hash_id("sha256:", b"", &bytes);
            snapshot.insert_selection(&hash, &bytes)?;
        }
        jvc_carrier::write_directory(&args[5], &snapshot)?;
        return Ok(());
    }
    match args.as_slice() {
        [command] if command == "--help" || command == "help" => {
            println!(
                "jvc canonicalize FILE\njvc verify FILE\njvc evaluate FILE\njvc validate DIRECTORY\njvc validate-git REPOSITORY COMMIT\njvc validate-checkout REPOSITORY COMMIT\njvc inventory DIRECTORY\njvc import FILE --format jsonl --output DIRECTORY [--selection FILE ...]\njvc export DIRECTORY --format jsonl\njvc merge LEFT RIGHT --output DIRECTORY [--policy FILE]\njvc retain DIRECTORY --policy FILE --output DIRECTORY\njvc validate FILE --format envelope-jsonl\njvc export FILE --format envelope-jsonl\njvc merge LEFT RIGHT --output FILE --format envelope-jsonl"
            );
            println!(
                "JSONL carriers contain body and envelope fields. Import selections require separate canonical --selection files; JSONL export omits them. Envelope JSONL contains envelopes only. Output paths must be new. If an input has an adjacent retention-policy sidecar, merge requires explicit --policy FILE. The supplied policy can intentionally override that sidecar; peer policies are never adopted automatically. Git commands require a full commit object identifier and never fetch."
            );
            println!(
                "Place --input-limit BYTES before the command to set an optional per-file input quota. It is off by default. JSONL inputs are read one record at a time. Each carrier record stays within its envelope and body limits, and each envelope record stays within the envelope limit."
            );
        }
        [command, path] if command == "validate" => println!(
            "{}",
            serde_json::to_string(&jvc_carrier::read_directory(path)?.validation_report()?)?
        ),
        [command, path] if command == "inventory" => {
            let snapshot = jvc_carrier::read_directory(path)?;
            println!(
                "{}",
                serde_json::to_string(
                    &json!({"snapshot":snapshot.snapshot_id()?,"logical_inventory":snapshot.logical_digest()?,"manifest":snapshot.manifest()?})
                )?
            );
        }
        [command, repo, commit] if command == "validate-git" || command == "validate-checkout" => {
            let snapshot = if command == "validate-git" {
                jvc_carrier::read_git_tree(repo, commit)?
            } else {
                jvc_carrier::validate_checkout(repo, commit)?
            };
            println!("{}", serde_json::to_string(&snapshot.validation_report()?)?);
        }
        [command, path, format, value]
            if command == "export" && format == "--format" && value == "jsonl" =>
        {
            jvc_carrier::read_directory(path)?.write_jsonl(&mut io::stdout().lock())?
        }
        [command, path, format, value, output, destination]
            if command == "import"
                && format == "--format"
                && value == "jsonl"
                && output == "--output" =>
        {
            jvc_carrier::write_directory(destination, &read_jsonl_snapshot(path, input_limit)?)?
        }
        [command, left, right, output, destination]
            if command == "merge" && output == "--output" =>
        {
            require_explicit_merge_policy(&[left, right])?;
            let merged = jvc_carrier::read_directory(left)?.merge(
                &jvc_carrier::read_directory(right)?,
                &jvc_carrier::RetentionPolicy::default(),
            )?;
            jvc_carrier::write_directory(destination, &merged)?;
        }
        [command, left, right, output, destination, policy, file]
            if command == "merge" && output == "--output" && policy == "--policy" =>
        {
            let policy = serde_json::from_value(jvc_core::parse_json(&read(file, input_limit)?)?)?;
            let snapshot = jvc_carrier::read_directory(left)?
                .merge(&jvc_carrier::read_directory(right)?, &policy)?;
            write_filtered(destination, &snapshot)?;
        }
        [command, path, policy, file, output, destination]
            if command == "retain" && policy == "--policy" && output == "--output" =>
        {
            let policy = serde_json::from_value(jvc_core::parse_json(&read(file, input_limit)?)?)?;
            let mut snapshot = jvc_carrier::read_directory(path)?;
            snapshot.apply_retention(&policy)?;
            write_filtered(destination, &snapshot)?;
        }
        [command, path] if command == "evaluate" => println!(
            "{}",
            serde_json::to_string(&jvc_runtime::evaluate_bytes(&read(path, input_limit)?)?)?
        ),
        [command, path] if command == "canonicalize" => {
            io::stdout().write_all(&canonicalize_json(&read(path, input_limit)?)?)?
        }
        [command, path] if command == "verify" => {
            let envelope = verify_envelope(&read(path, input_limit)?)?;
            let action = jvc_core::validate_action(envelope.header());
            println!(
                "{}",
                String::from_utf8(canonical_value(
                    &json!({"id":envelope.id(),"signature":"valid","action":if action.is_ok(){"valid"}else{"inert"},"action_error":action.err(),"body":if envelope.header().content.is_some(){"missing"}else{"none"}})
                )?)?
            );
        }
        [command, path, format, value] if format == "--format" && value == "envelope-jsonl" => {
            let events = read_envelope_events(path, input_limit)?;
            match command.as_str() {
                "validate" => {
                    let invalid_actions: Vec<_> = events
                        .iter()
                        .filter_map(|e| {
                            jvc_core::validate_action(e.header())
                                .err()
                                .map(|error| json!({"id":e.id(),"error":error}))
                        })
                        .collect();
                    let missing: Vec<_> = events
                        .iter()
                        .filter(|e| e.header().content.is_some())
                        .map(|e| e.id())
                        .collect();
                    println!(
                        "{}",
                        String::from_utf8(canonical_value(
                            &json!({"format":"envelope-jsonl","events":events.len(),"signatures":"valid","invalid_actions":invalid_actions,"missing_bodies":missing,"causal_evaluation":"not_requested"})
                        )?)?
                    );
                }
                "inventory" => println!(
                    "{}",
                    String::from_utf8(canonical_value(&json!(
                        events.iter().map(|e| e.id()).collect::<Vec<_>>()
                    ))?)?
                ),
                "export" => io::stdout().write_all(&export_jsonl(&events)?)?,
                _ => return Err("unsupported command".into()),
            }
        }
        [command, left, right, output, path, format, value]
            if command == "merge"
                && output == "--output"
                && format == "--format"
                && value == "envelope-jsonl" =>
        {
            let mut events = read_envelope_events(left, input_limit)?;
            events.extend(read_envelope_events(right, input_limit)?);
            write_new(path, &export_jsonl(&events)?)?;
        }
        _ => return Err("unsupported arguments; run jvc --help".into()),
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod input_tests {
    use super::*;

    #[test]
    fn regular_input_and_exact_size_boundary_are_read_from_the_handle() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("input.json");
        fs::write(&path, b"null").unwrap();
        assert_eq!(read(path.to_str().unwrap(), None).unwrap(), b"null");
        let file = fs::File::open(&path).unwrap();
        check_input(&file, Some(4)).unwrap();
        assert_eq!(read_bounded(file, Some(4)).unwrap(), b"null");
        let file = fs::File::open(&path).unwrap();
        assert!(check_input(&file, Some(3)).is_err());
    }

    #[test]
    fn growth_after_handle_metadata_check_cannot_bypass_the_read_limit() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("input.json");
        fs::write(&path, b"null").unwrap();
        let file = fs::File::open(&path).unwrap();
        check_input(&file, Some(4)).unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b" ")
            .unwrap();
        assert!(
            read_bounded(file, Some(4))
                .unwrap_err()
                .to_string()
                .contains("configured input limit")
        );
    }

    #[test]
    fn oversized_regular_input_is_rejected_before_reading() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("oversized.json");
        fs::File::create(&path)
            .unwrap()
            .set_len(65 * 1024 * 1024)
            .unwrap();
        // No quota by default: a file above the old 64 MiB cap is read.
        assert_eq!(
            read(path.to_str().unwrap(), None).unwrap().len(),
            65 * 1024 * 1024
        );
        assert!(
            read(path.to_str().unwrap(), Some(64 * 1024 * 1024))
                .unwrap_err()
                .to_string()
                .contains("configured input limit")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_refused_and_regular_executable_json_is_allowed() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("input.json");
        fs::write(&path, b"null").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(read(path.to_str().unwrap(), None).unwrap(), b"null");
        let link = temp.path().join("link.json");
        symlink(&path, &link).unwrap();
        assert!(read(link.to_str().unwrap(), None).is_err());
    }
}
