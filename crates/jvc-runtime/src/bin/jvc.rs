//! Native tools for authenticated records and local Git carriers.
use jvc_core::{canonical_value, canonicalize_json, export_jsonl, import_jsonl, verify_envelope};
use serde_json::json;
use std::{
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
};
fn read(path: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("input must be a regular file".into());
    }
    if metadata.len() > 64 * 1024 * 1024 {
        return Err("input exceeds the prototype 64 MiB limit".into());
    }
    Ok(fs::read(path)?)
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
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() >= 6
        && args[0] == "import"
        && args[2] == "--format"
        && args[3] == "jsonl"
        && args[4] == "--output"
    {
        let mut snapshot = jvc_carrier::Snapshot::from_jsonl(&read(&args[1])?)?;
        for pair in args[6..].chunks(2) {
            if pair.len() != 2 || pair[0] != "--selection" {
                return Err("selection inputs must use --selection FILE".into());
            }
            let bytes = read(&pair[1])?;
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
            io::stdout().write_all(&jvc_carrier::read_directory(path)?.to_jsonl()?)?
        }
        [command, path, format, value, output, destination]
            if command == "import"
                && format == "--format"
                && value == "jsonl"
                && output == "--output" =>
        {
            jvc_carrier::write_directory(
                destination,
                &jvc_carrier::Snapshot::from_jsonl(&read(path)?)?,
            )?
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
            let policy = serde_json::from_value(jvc_core::parse_json(&read(file)?)?)?;
            let snapshot = jvc_carrier::read_directory(left)?
                .merge(&jvc_carrier::read_directory(right)?, &policy)?;
            write_filtered(destination, &snapshot)?;
        }
        [command, path, policy, file, output, destination]
            if command == "retain" && policy == "--policy" && output == "--output" =>
        {
            let policy = serde_json::from_value(jvc_core::parse_json(&read(file)?)?)?;
            let mut snapshot = jvc_carrier::read_directory(path)?;
            snapshot.apply_retention(&policy)?;
            write_filtered(destination, &snapshot)?;
        }
        [command, path] if command == "evaluate" => println!(
            "{}",
            serde_json::to_string(&jvc_runtime::evaluate_bytes(&read(path)?)?)?
        ),
        [command, path] if command == "canonicalize" => {
            io::stdout().write_all(&canonicalize_json(&read(path)?)?)?
        }
        [command, path] if command == "verify" => {
            let envelope = verify_envelope(&read(path)?)?;
            let action = jvc_core::validate_action(envelope.header());
            println!(
                "{}",
                String::from_utf8(canonical_value(
                    &json!({"id":envelope.id(),"signature":"valid","action":if action.is_ok(){"valid"}else{"inert"},"action_error":action.err(),"body":if envelope.header().content.is_some(){"missing"}else{"none"}})
                )?)?
            );
        }
        [command, path, format, value] if format == "--format" && value == "envelope-jsonl" => {
            let events = import_jsonl(&read(path)?)?;
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
            let mut events = import_jsonl(&read(left)?)?;
            events.extend(import_jsonl(&read(right)?)?);
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
