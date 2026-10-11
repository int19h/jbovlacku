use jvc_carrier::{
    RetentionPolicy, Snapshot, read_directory, read_git_tree, validate_checkout, write_directory,
};
use jvc_core::{Header, hash_id, identity_from_seed, sign_header};
use serde_json::json;
use std::{fs, io::Write, path::Path, process::Command};

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("gc.auto=0")
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Disposable prototype carrier")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Disposable prototype carrier")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
fn commit(repo: &Path, snapshot: &Snapshot, parent: Option<&str>) -> String {
    for entry in fs::read_dir(repo).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().unwrap() == ".git" {
            continue;
        }
        if path.is_dir() {
            fs::remove_dir_all(path).unwrap();
        } else {
            fs::remove_file(path).unwrap();
        }
    }
    for (relative, bytes) in snapshot.to_files().unwrap() {
        let path = repo.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    git(repo, &["add", "--all"]);
    let tree = git(repo, &["write-tree"]);
    let id = if let Some(parent) = parent {
        git(
            repo,
            &[
                "commit-tree",
                &tree,
                "-p",
                parent,
                "-m",
                "Disposable local carrier audit",
            ],
        )
    } else {
        git(
            repo,
            &["commit-tree", &tree, "-m", "Disposable local carrier audit"],
        )
    };
    git(repo, &["update-ref", "HEAD", &id]);
    id
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(
        args.len(),
        4,
        "provide carrier JSONL, selection JSON, and new output parent directory"
    );
    let source = fs::read(&args[1]).unwrap();
    let selection = fs::read(&args[2]).unwrap();
    let selection = jvc_core::canonicalize_json(&selection).unwrap();
    let mut base = Snapshot::from_jsonl(&source).unwrap();
    base.insert_selection(&hash_id("sha256:", b"", &selection), &selection)
        .unwrap();
    let output = Path::new(&args[3]);
    fs::create_dir(output).unwrap();
    let repo = output.join("git-carrier");
    write_directory(&repo, &base).unwrap();
    git(&repo, &["init", "-q"]);
    let base_commit = commit(&repo, &base, None);
    assert_eq!(
        read_directory(&repo).unwrap().snapshot_id().unwrap(),
        base.snapshot_id().unwrap()
    );
    let tree = read_git_tree(&repo, &base_commit).unwrap();
    assert_eq!(tree.snapshot_id().unwrap(), base.snapshot_id().unwrap());
    validate_checkout(&repo, &base_commit).unwrap();
    let stream = tree.to_jsonl().unwrap();
    let mut decoded = Snapshot::from_jsonl(&stream).unwrap();
    decoded
        .insert_selection(&hash_id("sha256:", b"", &selection), &selection)
        .unwrap();
    assert_eq!(decoded.snapshot_id().unwrap(), base.snapshot_id().unwrap());
    assert_eq!(
        decoded.logical_digest().unwrap(),
        base.logical_digest().unwrap()
    );
    fs::write(output.join("import-selection.json"), &selection).unwrap();
    assert_eq!(decoded.to_jsonl().unwrap(), stream);
    fs::write(output.join("canonical-records.jsonl"), &stream).unwrap();
    let extend = |nonce: u8| {
        let mut snapshot = base.clone();
        let e = sign_header(
            &[99; 32],
            Header {
                version: 1,
                issuer: identity_from_seed(&[99; 32]),
                previous: vec![],
                nonce: format!("{nonce:02x}").repeat(16),
                action: json!({"kind":"identity.merge"}),
                content: None,
            },
        )
        .unwrap();
        snapshot
            .insert_envelope(&e.canonical_envelope().unwrap())
            .unwrap();
        (snapshot, e.id().to_owned())
    };
    let (left, left_event) = extend(1);
    let (right, right_event) = extend(2);
    let left_commit = commit(&repo, &left, Some(&base_commit));
    git(&repo, &["update-ref", "refs/heads/left", &left_commit]);
    let right_commit = commit(&repo, &right, Some(&base_commit));
    git(&repo, &["update-ref", "refs/heads/right", &right_commit]);
    let a = read_git_tree(&repo, &left_commit).unwrap();
    let b = read_git_tree(&repo, &right_commit).unwrap();
    let merged = a.merge(&b, &RetentionPolicy::default()).unwrap();
    assert_eq!(merged.events().len(), base.events().len() + 2);
    assert!(
        merged.events().contains_key(&left_event) && merged.events().contains_key(&right_event)
    );
    assert_eq!(
        merged.to_files().unwrap(),
        b.merge(&a, &RetentionPolicy::default())
            .unwrap()
            .to_files()
            .unwrap()
    );
    let merged_path = output.join("merged-carrier");
    write_directory(&merged_path, &merged).unwrap();
    assert_eq!(
        read_directory(&merged_path).unwrap().snapshot_id().unwrap(),
        merged.snapshot_id().unwrap()
    );
    let report = json!({"source_jsonl":args[1],"source_sha256":hash_id("sha256:",b"",&source),"records":base.events().len(),"manifest":base.manifest().unwrap(),"snapshot":base.snapshot_id().unwrap(),"logical_inventory":base.logical_digest().unwrap(),"base_git_commit":base_commit,"left_git_commit":left_commit,"right_git_commit":right_commit,"canonical_jsonl_sha256":hash_id("sha256:",b"",&stream),"directory_git_jsonl_roundtrip":true,"jsonl_selection_sidecar":"import-selection.json","merged_records":merged.events().len(),"merged_snapshot":merged.snapshot_id().unwrap(),"merged_logical_inventory":merged.logical_digest().unwrap(),"concurrent_events":[left_event,right_event],"merge_commutes":true,"validation":base.validation_report().unwrap()});
    let report = serde_json::to_vec_pretty(&report).unwrap();
    fs::write(output.join("report.json"), &report).unwrap();
    std::io::stdout().write_all(&report).unwrap();
    println!();
}
