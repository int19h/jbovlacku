use jvc_carrier::*;
use jvc_core::{
    ContentDescriptor, Header, VerifiedEnvelope, body_descriptor, canonical_value,
    envelope_from_signature, hash_id, identity_from_seed, parse_json, sign_header,
    sshsig_signing_bytes,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn event(
    seed: u8,
    nonce: u8,
    body: Option<&[u8]>,
    previous: Vec<String>,
    action: Value,
) -> VerifiedEnvelope {
    sign_header(
        &[seed; 32],
        Header {
            version: 1,
            issuer: identity_from_seed(&[seed; 32]),
            previous,
            nonce: format!("{nonce:02x}").repeat(16),
            action,
            content: body.map(|b| body_descriptor(b).unwrap()),
        },
    )
    .unwrap()
}
fn add(snapshot: &mut Snapshot, event: &VerifiedEnvelope) {
    snapshot
        .insert_envelope(&event.canonical_envelope().unwrap())
        .unwrap();
}
fn profile() -> Vec<u8> {
    canonical_value(&json!({"name":"Disposable fixture","bio":[],"links":[]})).unwrap()
}
fn with_body() -> (Snapshot, VerifiedEnvelope, Vec<u8>) {
    let body = profile();
    let e = event(
        1,
        0,
        Some(&body),
        vec![],
        json!({"kind":"identity.profile"}),
    );
    let mut s = Snapshot::new();
    add(&mut s, &e);
    s.insert_body(&body_descriptor(&body).unwrap().hash, &body)
        .unwrap();
    (s, e, body)
}
fn record_path(files: &BTreeMap<String, Vec<u8>>) -> String {
    files
        .keys()
        .find(|p| p.starts_with("records/"))
        .unwrap()
        .clone()
}

#[test]
fn canonical_directory_and_inline_jsonl_round_trip() {
    let (mut snapshot, e, body) = with_body();
    let selection = canonical_value(&json!([e.id()])).unwrap();
    snapshot
        .insert_selection(&hash_id("sha256:", b"", &selection), &selection)
        .unwrap();
    let files = snapshot.to_files().unwrap();
    let decoded = Snapshot::from_files(&files).unwrap();
    assert_eq!(decoded.to_files().unwrap(), files);
    assert_eq!(
        snapshot.snapshot_id().unwrap(),
        decoded.snapshot_id().unwrap()
    );
    let jsonl = snapshot.to_jsonl().unwrap();
    let line = parse_json(&jsonl[..jsonl.len() - 1]).unwrap();
    assert_eq!(line["body"], parse_json(&body).unwrap());
    assert_eq!(line["envelope"]["id"], e.id());
    assert_eq!(
        Snapshot::from_jsonl(&jsonl).unwrap().to_jsonl().unwrap(),
        jsonl
    );
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("carrier");
    write_directory(&path, &snapshot).unwrap();
    assert_eq!(read_directory(&path).unwrap().to_files().unwrap(), files);
    assert!(write_directory(&path, &snapshot).is_err());
}

#[test]
fn every_matching_record_receives_the_body_and_refusal_wins() {
    let (mut snapshot, a, body) = with_body();
    let b = event(
        2,
        0,
        Some(&body),
        vec![],
        json!({"kind":"identity.profile"}),
    );
    add(&mut snapshot, &b);
    assert_eq!(snapshot.manifest().unwrap().bodies.count, 1);
    let lines = snapshot.to_jsonl().unwrap();
    for line in lines[..lines.len() - 1].split(|b| *b == b'\n') {
        assert!(!parse_json(line).unwrap()["body"].is_null());
    }
    let hash = body_descriptor(&body).unwrap().hash;
    let policy = RetentionPolicy {
        refused_bodies: BTreeSet::from([hash.clone()]),
        ..Default::default()
    };
    snapshot.apply_retention(&policy).unwrap();
    assert_eq!(snapshot.events().len(), 2);
    assert_eq!(snapshot.manifest().unwrap().bodies.count, 0);
    assert_eq!(
        snapshot.insert_body(&hash, &body).unwrap(),
        InsertOutcome::Refused
    );
    let mut peer = Snapshot::new();
    add(&mut peer, &a);
    peer.insert_body(&hash, &body).unwrap();
    let merged = snapshot.merge(&peer, &RetentionPolicy::default()).unwrap();
    assert_eq!(merged.manifest().unwrap().bodies.count, 0);
    for event in merged.events().values() {
        assert_eq!(
            event.id(),
            if event.id() == a.id() { a.id() } else { b.id() }
        );
    }
}

#[test]
fn authenticated_union_preserves_remote_omissions_and_independent_branches() {
    let base = event(1, 0, None, vec![], json!({"kind":"identity.merge"}));
    let left = event(
        1,
        1,
        None,
        vec![base.id().into()],
        json!({"kind":"identity.merge"}),
    );
    let right = event(
        1,
        2,
        None,
        vec![base.id().into()],
        json!({"kind":"identity.merge"}),
    );
    let independent = event(2, 0, None, vec![], json!({"kind":"identity.merge"}));
    let mut a = Snapshot::new();
    for e in [&base, &left, &independent] {
        add(&mut a, e);
    }
    let mut b = Snapshot::new();
    for e in [&base, &right] {
        add(&mut b, e);
    }
    let merged = a.merge(&b, &RetentionPolicy::default()).unwrap();
    assert_eq!(merged.events().len(), 4);
    assert_eq!(
        merged.to_files().unwrap(),
        b.merge(&a, &RetentionPolicy::default())
            .unwrap()
            .to_files()
            .unwrap()
    );
    let repeated = merged
        .merge(&Snapshot::new(), &RetentionPolicy::default())
        .unwrap();
    assert_eq!(repeated.to_files().unwrap(), merged.to_files().unwrap());
}

#[test]
fn genuine_signature_variants_use_decoded_lexicographic_order() {
    use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
    use sha2::{Digest, Sha512};
    let a = Scalar::from(7u64);
    let public = (a * ED25519_BASEPOINT_POINT).compress().to_bytes();
    let issuer = format!(
        "ed25519:{}",
        public
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let h = Header {
        version: 1,
        issuer,
        previous: vec![],
        nonce: "00".repeat(16),
        action: json!({"kind":"identity.merge"}),
        content: None,
    };
    let message = sshsig_signing_bytes(&h).unwrap();
    let sign = |r: Scalar| {
        let point = (r * ED25519_BASEPOINT_POINT).compress().to_bytes();
        let mut hash = Sha512::new();
        hash.update(point);
        hash.update(public);
        hash.update(&message);
        let k = Scalar::from_hash(hash);
        let s = r + k * a;
        let mut raw = [0; 64];
        raw[..32].copy_from_slice(&point);
        raw[32..].copy_from_slice(&s.to_bytes());
        envelope_from_signature(h.clone(), &raw).unwrap()
    };
    let first = sign(Scalar::ZERO);
    let second = sign(Scalar::ONE);
    assert_ne!(first.signature_bytes(), second.signature_bytes());
    assert_eq!(first.id(), second.id());
    let mut a = Snapshot::new();
    add(&mut a, &first);
    let mut b = Snapshot::new();
    add(&mut b, &second);
    assert_eq!(a.logical_digest().unwrap(), b.logical_digest().unwrap());
    assert_ne!(a.snapshot_id().unwrap(), b.snapshot_id().unwrap());
    let merged = a.merge(&b, &RetentionPolicy::default()).unwrap();
    let chosen = merged.events().get(first.id()).unwrap();
    assert_eq!(
        chosen.signature_bytes(),
        std::cmp::min(first.signature_bytes(), second.signature_bytes())
    );
    assert_eq!(merged.events().len(), 1);
}

#[test]
fn malformed_data_never_quarantines_valid_existing_objects() {
    let (mut snapshot, e, body) = with_body();
    let id = body_descriptor(&body).unwrap().hash;
    assert!(snapshot.insert_body(&id, b"{}").is_err());
    assert_eq!(snapshot.manifest().unwrap().bodies.count, 1);
    let mut invalid = serde_json::to_value(e.envelope()).unwrap();
    invalid["signature"] = json!("AAAA");
    assert!(
        snapshot
            .insert_envelope(&serde_json::to_vec(&invalid).unwrap())
            .is_err()
    );
    assert_eq!(snapshot.events().len(), 1);
    let selection = canonical_value(&json!([e.id()])).unwrap();
    let id = hash_id("sha256:", b"", &selection);
    snapshot.insert_selection(&id, &selection).unwrap();
    assert!(snapshot.insert_selection(&id, b"[]").is_err());
    assert_eq!(snapshot.selections().len(), 1);
}

#[test]
fn invalid_action_and_body_schema_keep_authenticated_carrier_content() {
    let body = canonical_value(&json!({"arbitrary":"unsupported payload"})).unwrap();
    let e = event(1, 0, Some(&body), vec![], json!({"kind":"unknown"}));
    let mut s = Snapshot::new();
    add(&mut s, &e);
    s.insert_body(&body_descriptor(&body).unwrap().hash, &body)
        .unwrap();
    let decoded = Snapshot::from_files(&s.to_files().unwrap()).unwrap();
    let report = decoded.validation_report().unwrap();
    assert_eq!(report.admitted_events, 1);
    assert!(report.diagnostics.iter().any(|d| d.code == "action_inert"));
    assert!(report.diagnostics.iter().any(|d| d.code == "body_invalid"));
    assert_eq!(decoded.manifest().unwrap().bodies.count, 1);
}

#[test]
fn refuses_issuer_stream_and_future_arrivals_without_peer_policy_adoption() {
    let a = event(1, 0, None, vec![], json!({"kind":"identity.merge"}));
    let b = event(
        1,
        1,
        None,
        vec![a.id().into()],
        json!({"kind":"identity.merge"}),
    );
    let c = event(2, 0, None, vec![], json!({"kind":"identity.merge"}));
    let mut s = Snapshot::new();
    for e in [&a, &b, &c] {
        add(&mut s, e);
    }
    s.apply_retention(&RetentionPolicy {
        refused_events: BTreeSet::from([a.id().into()]),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(s.events().len(), 1);
    assert!(s.refused_issuers().contains(&a.header().issuer));
    assert_eq!(
        s.insert_envelope(&a.canonical_envelope().unwrap()).unwrap(),
        InsertOutcome::Refused
    );
    let mut receiving = Snapshot::new();
    add(&mut receiving, &a);
    assert_eq!(
        receiving
            .merge(&s, &RetentionPolicy::default())
            .unwrap()
            .events()
            .len(),
        2
    );
    let future = event(
        1,
        2,
        None,
        vec![b.id().into()],
        json!({"kind":"identity.merge"}),
    );
    assert_eq!(
        s.insert_envelope(&future.canonical_envelope().unwrap())
            .unwrap(),
        InsertOutcome::Refused
    );
}

#[test]
fn rejects_path_modes_gaps_wrong_partition_noncanonical_parts_and_filling() {
    let (snapshot, _, _) = with_body();
    let original = snapshot.to_files().unwrap();
    let path = record_path(&original);
    for bad in [
        "../manifest.json",
        "records/AA/000000.jsonl",
        "records/aa/00000.jsonl",
        "records/aa/../000000.jsonl",
        "import-selections/aa/00.json",
        "hooks/pre-commit",
    ] {
        assert!(validate_path(bad).is_err(), "{bad}");
    }
    let mut files = original.clone();
    let bytes = files.remove(&path).unwrap();
    let gap = path.replace("000000.jsonl", "000001.jsonl");
    files.insert(gap, bytes);
    assert!(Snapshot::from_files(&files).is_err());
    files = original.clone();
    let bytes = files.remove(&path).unwrap();
    let wrong = if &path[8..10] == "00" { "ff" } else { "00" };
    files.insert(format!("records/{wrong}/000000.jsonl"), bytes);
    assert!(Snapshot::from_files(&files).is_err());
    files = original.clone();
    files.get_mut(&path).unwrap().push(b'\n');
    assert!(Snapshot::from_files(&files).is_err());
    files = original.clone();
    files.insert(path.clone(), vec![b' '; PART_BYTES + 1]);
    assert!(Snapshot::from_files(&files).is_err());
    files = original.clone();
    files.insert(
        "format.json".into(),
        b"{ \"format\":\"jbovlacku-git\",\"version\":1}".to_vec(),
    );
    assert!(Snapshot::from_files(&files).is_err());
    files = original.clone();
    files.insert("manifest.json".into(), b"{}".to_vec());
    assert!(Snapshot::from_files(&files).is_err());
    let mut lines = snapshot.to_jsonl().unwrap();
    lines.pop();
    assert!(Snapshot::from_jsonl(&lines).is_err());
    assert!(Snapshot::from_jsonl(b"\n").is_err());
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("carrier");
    write_directory(&root, &snapshot).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let readme = root.join("README.md");
        std::fs::set_permissions(&readme, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(read_directory(&root).is_err());
        std::fs::remove_file(&readme).unwrap();
        symlink("format.json", &readme).unwrap();
        assert!(read_directory(&root).is_err());
    }
}

#[test]
fn a_wrong_byte_count_cannot_consume_a_retained_body() {
    let body = profile();
    let descriptor = body_descriptor(&body).unwrap();
    let h = Header {
        version: 1,
        issuer: identity_from_seed(&[3; 32]),
        previous: vec![],
        nonce: "00".repeat(16),
        action: json!({"kind":"identity.profile"}),
        content: Some(ContentDescriptor {
            bytes: descriptor.bytes + 1,
            ..descriptor.clone()
        }),
    };
    let e = sign_header(&[3; 32], h).unwrap();
    let mut s = Snapshot::new();
    add(&mut s, &e);
    s.insert_body(&descriptor.hash, &body).unwrap();
    assert_eq!(s.manifest().unwrap().bodies.count, 0);
    assert!(parse_json(&s.to_jsonl().unwrap()).unwrap()["body"].is_null());
}

fn git(repo: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Disposable fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Disposable fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
        .output()
        .expect("Git is required for carrier interoperability tests");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn commit_fixture(repo: &std::path::Path, snapshot: &Snapshot, parent: Option<&str>) -> String {
    for entry in std::fs::read_dir(repo).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().unwrap() == ".git" {
            continue;
        }
        if path.is_dir() {
            std::fs::remove_dir_all(path).unwrap();
        } else {
            std::fs::remove_file(path).unwrap();
        }
    }
    for (name, bytes) in snapshot.to_files().unwrap() {
        let path = repo.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    git(repo, &["add", "--all"]);
    let tree = git(repo, &["write-tree"]);
    let commit = if let Some(parent) = parent {
        git(
            repo,
            &[
                "commit-tree",
                &tree,
                "-p",
                parent,
                "-m",
                "Disposable carrier fixture",
            ],
        )
    } else {
        git(
            repo,
            &["commit-tree", &tree, "-m", "Disposable carrier fixture"],
        )
    };
    git(repo, &["update-ref", "HEAD", &commit]);
    commit
}

#[test]
fn real_git_blobs_and_concurrent_commits_merge_by_authenticated_set_union() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    let base = event(1, 0, None, vec![], json!({"kind":"identity.merge"}));
    let mut base_snapshot = Snapshot::new();
    add(&mut base_snapshot, &base);
    let base_commit = commit_fixture(&repo, &base_snapshot, None);
    let left = event(
        1,
        1,
        None,
        vec![base.id().into()],
        json!({"kind":"identity.merge"}),
    );
    let mut left_snapshot = base_snapshot.clone();
    add(&mut left_snapshot, &left);
    let left_commit = commit_fixture(&repo, &left_snapshot, Some(&base_commit));
    let right = event(
        1,
        2,
        None,
        vec![base.id().into()],
        json!({"kind":"identity.merge"}),
    );
    let mut right_snapshot = base_snapshot.clone();
    add(&mut right_snapshot, &right);
    let right_commit = commit_fixture(&repo, &right_snapshot, Some(&base_commit));
    assert!(validate_checkout(&repo, &right_commit).is_ok());
    assert!(validate_checkout(&repo, &left_commit).is_err());
    let a = read_git_tree(&repo, &left_commit).unwrap();
    let b = read_git_tree(&repo, &right_commit).unwrap();
    let merged = a.merge(&b, &RetentionPolicy::default()).unwrap();
    assert_eq!(merged.events().len(), 3);
    assert!(merged.events().contains_key(left.id()));
    assert!(merged.events().contains_key(right.id()));
    let path = temp.path().join("merged");
    write_directory(&path, &merged).unwrap();
    assert_eq!(
        read_directory(path).unwrap().snapshot_id().unwrap(),
        merged.snapshot_id().unwrap()
    );
    assert!(read_git_tree(&repo, "HEAD").is_err());
    assert!(read_git_tree(&repo, "--help").is_err());
    std::fs::write(repo.join("README.md"), b"transformed\n").unwrap();
    assert!(validate_checkout(&repo, &right_commit).is_err());
}

#[test]
fn rejects_non_greedy_parts_and_unfilled_inline_copies() {
    let body = profile();
    let a = event(
        4,
        0,
        Some(&body),
        vec![],
        json!({"kind":"identity.profile"}),
    );
    let b = (1..10000u64)
        .map(|nonce| {
            let mut header = a.header().clone();
            header.nonce = format!("{nonce:032x}");
            sign_header(&[4; 32], header).unwrap()
        })
        .find(|e| e.id()[5..7] == a.id()[5..7])
        .expect("fixture must find two records in one partition");
    let mut snapshot = Snapshot::new();
    add(&mut snapshot, &a);
    add(&mut snapshot, &b);
    snapshot
        .insert_body(&body_descriptor(&body).unwrap().hash, &body)
        .unwrap();
    let mut files = snapshot.to_files().unwrap();
    let path = record_path(&files);
    let bytes = files.remove(&path).unwrap();
    let split = bytes.iter().position(|b| *b == b'\n').unwrap() + 1;
    files.insert(path.clone(), bytes[..split].to_vec());
    files.insert(path.replace("000000", "000001"), bytes[split..].to_vec());
    assert!(Snapshot::from_files(&files).is_err());
    files = snapshot.to_files().unwrap();
    let bytes = files.get(&path).unwrap();
    let split = bytes.iter().position(|b| *b == b'\n').unwrap() + 1;
    let mut first = parse_json(&bytes[..split]).unwrap();
    first["body"] = Value::Null;
    let mut changed = canonical_value(&first).unwrap();
    changed.push(b'\n');
    changed.extend(&bytes[split..]);
    files.insert(path, changed);
    assert!(Snapshot::from_files(&files).is_err());
}

#[test]
fn selection_shape_order_encoding_and_size_are_strict() {
    let mut snapshot = Snapshot::new();
    for bytes in [
        b"{}".as_slice(),
        b"[1]",
        b"[ ]",
        b"[\"jve1:bad\"]",
        b"[\"jvr1:bad\"]",
    ] {
        let id = hash_id("sha256:", b"", bytes);
        assert!(snapshot.insert_selection(&id, bytes).is_err());
    }
    let id = format!("jve1:{}", "00".repeat(32));
    let duplicate = canonical_value(&json!([id, id])).unwrap();
    assert!(
        snapshot
            .insert_selection(&hash_id("sha256:", b"", &duplicate), &duplicate)
            .is_err()
    );
    let oversized = vec![b' '; SELECTION_BYTES + 1];
    assert!(
        snapshot
            .insert_selection(&hash_id("sha256:", b"", &oversized), &oversized)
            .is_err()
    );
}

#[test]
fn git_reader_rejects_executable_blobs_and_symlinks_without_running_hooks() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    let (snapshot, _, _) = with_body();
    let valid = commit_fixture(&repo, &snapshot, None);
    let marker = temp.path().join("hook-ran");
    let hook = repo.join(".git/hooks/post-checkout");
    std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::{PermissionsExt, symlink};
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(read_git_tree(&repo, &valid).is_ok());
        assert!(!marker.exists());
        let readme = repo.join("README.md");
        std::fs::set_permissions(&readme, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&repo, &["add", "README.md"]);
        let tree = git(&repo, &["write-tree"]);
        let invalid = git(
            &repo,
            &["commit-tree", &tree, "-m", "Disposable executable fixture"],
        );
        assert!(read_git_tree(&repo, &invalid).is_err());
        std::fs::remove_file(&readme).unwrap();
        symlink("format.json", &readme).unwrap();
        git(&repo, &["add", "README.md"]);
        let tree = git(&repo, &["write-tree"]);
        let invalid = git(
            &repo,
            &["commit-tree", &tree, "-m", "Disposable symlink fixture"],
        );
        assert!(read_git_tree(&repo, &invalid).is_err());
    }
}

#[test]
fn stored_record_wrapper_accepts_body_at_its_own_depth_limit() {
    let body = format!("{}null{}", r#"{"x":"#.repeat(32), "}".repeat(32));
    let e = event(
        1,
        0,
        Some(body.as_bytes()),
        vec![],
        json!({"kind":"unknown"}),
    );
    let mut s = Snapshot::new();
    add(&mut s, &e);
    s.insert_body(
        &body_descriptor(body.as_bytes()).unwrap().hash,
        body.as_bytes(),
    )
    .unwrap();
    let jsonl = s.to_jsonl().unwrap();
    assert_eq!(
        Snapshot::from_jsonl(&jsonl).unwrap().to_jsonl().unwrap(),
        jsonl
    );
    assert!(Snapshot::from_files(&s.to_files().unwrap()).is_ok());
}

#[test]
fn resolved_private_policy_survives_file_reload_when_supplied_again() {
    let (original, refused, body) = with_body();
    let mut peer = original.clone();
    let other = event(
        2,
        1,
        Some(&body),
        vec![],
        json!({"kind":"identity.profile"}),
    );
    add(&mut peer, &other);
    let mut filtered = peer.clone();
    filtered
        .apply_retention(&RetentionPolicy {
            refused_events: BTreeSet::from([refused.id().to_owned()]),
            refused_bodies: BTreeSet::from([body_descriptor(&body).unwrap().hash]),
            ..RetentionPolicy::default()
        })
        .unwrap();
    let resolved = filtered.retention_policy();
    assert!(resolved.refused_events.is_empty());
    assert!(resolved.refused_issuers.contains(&refused.header().issuer));
    let temp = tempfile::tempdir().unwrap();
    let carrier = temp.path().join("carrier");
    let policy_path = temp.path().join("private-policy.json");
    write_directory(&carrier, &filtered).unwrap();
    std::fs::write(
        &policy_path,
        canonical_value(&serde_json::to_value(resolved).unwrap()).unwrap(),
    )
    .unwrap();
    let reloaded = read_directory(&carrier).unwrap();
    assert!(reloaded.retention_policy().refused_issuers.is_empty());
    let policy: RetentionPolicy =
        serde_json::from_value(parse_json(&std::fs::read(&policy_path).unwrap()).unwrap()).unwrap();
    // Public files alone do not save private refusal policy.
    assert_eq!(
        reloaded
            .merge(&peer, &RetentionPolicy::default())
            .unwrap()
            .events()
            .len(),
        2
    );
    let mut merged = reloaded.merge(&peer, &policy).unwrap();
    assert_eq!(merged.to_files().unwrap(), filtered.to_files().unwrap());
    let later = event(1, 9, None, vec![], json!({"kind":"identity.merge"}));
    assert_eq!(
        merged
            .insert_envelope(&later.canonical_envelope().unwrap())
            .unwrap(),
        InsertOutcome::Refused
    );
    assert_eq!(
        merged
            .insert_body(&body_descriptor(&body).unwrap().hash, &body)
            .unwrap(),
        InsertOutcome::Refused
    );
}

#[test]
fn native_read_limits_are_local_policy_and_can_be_raised() {
    let (s, _, _) = with_body();
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("carrier");
    write_directory(&repo, &s).unwrap();
    std::fs::write(repo.join("README.md"), vec![b'x'; 32]).unwrap();
    let small_readme = ReadLimits {
        max_readme_bytes: 16,
        ..ReadLimits::default()
    };
    assert_eq!(
        read_directory_with_limits(&repo, small_readme)
            .unwrap_err()
            .code,
        "resource_unavailable"
    );
    let small_total = ReadLimits {
        max_total_bytes: 64,
        ..ReadLimits::default()
    };
    assert_eq!(
        read_directory_with_limits(&repo, small_total)
            .unwrap_err()
            .code,
        "resource_unavailable"
    );
    let small_count = ReadLimits {
        max_files: 1,
        ..ReadLimits::default()
    };
    assert_eq!(
        read_directory_with_limits(&repo, small_count)
            .unwrap_err()
            .code,
        "resource_unavailable"
    );
    assert!(read_directory(&repo).is_ok());
    let unlimited = ReadLimits {
        max_total_bytes: usize::MAX,
        max_readme_bytes: usize::MAX,
        max_files: usize::MAX,
    };
    assert!(read_directory_with_limits(&repo, unlimited).is_ok());
    git(&repo, &["init", "-q"]);
    let with_readme = read_directory(&repo).unwrap();
    let id = commit_fixture(&repo, &with_readme, None);
    assert_eq!(
        read_git_tree_with_limits(&repo, &id, small_readme)
            .unwrap_err()
            .code,
        "resource_unavailable"
    );
    assert_eq!(
        read_git_tree_with_limits(&repo, &id, small_total)
            .unwrap_err()
            .code,
        "resource_unavailable"
    );
    assert_eq!(
        read_git_tree_with_limits(&repo, &id, small_count)
            .unwrap_err()
            .code,
        "resource_unavailable"
    );
    assert!(read_git_tree_with_limits(&repo, &id, unlimited).is_ok());
    assert_eq!(
        read_git_tree(&repo, &id).unwrap().snapshot_id().unwrap(),
        with_readme.snapshot_id().unwrap()
    );
}
