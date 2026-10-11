#![cfg(not(target_arch = "wasm32"))]
use jvc_carrier::{Snapshot, read_directory};
use jvc_core::{Header, body_descriptor, canonical_value, identity_from_seed, sign_header};
use serde_json::json;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn cli(directory: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_jvc"))
        .current_dir(directory)
        .args(args)
        .output()
        .unwrap()
}
fn success(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn fixture() -> (Snapshot, String, String) {
    let body = canonical_value(&json!({"name":"CLI fixture","bio":[],"links":[]})).unwrap();
    let descriptor = body_descriptor(&body).unwrap();
    let mut snapshot = Snapshot::new();
    let mut refused_event = String::new();
    for seed in [1u8, 2] {
        let mut previous = Vec::new();
        for nonce in [0u8, 1] {
            let event = sign_header(
                &[seed; 32],
                Header {
                    version: 1,
                    issuer: identity_from_seed(&[seed; 32]),
                    previous,
                    nonce: format!("{nonce:02x}").repeat(16),
                    action: if nonce == 0 {
                        json!({"kind":"identity.profile"})
                    } else {
                        json!({"kind":"identity.merge"})
                    },
                    content: (nonce == 0).then(|| descriptor.clone()),
                },
            )
            .unwrap();
            snapshot
                .insert_envelope(&event.canonical_envelope().unwrap())
                .unwrap();
            if seed == 1 && nonce == 0 {
                refused_event = event.id().to_owned();
            }
            previous = vec![event.id().to_owned()];
        }
    }
    snapshot.insert_body(&descriptor.hash, &body).unwrap();
    (snapshot, refused_event, descriptor.hash)
}

#[test]
fn cli_bare_outputs_and_private_policy_survive_process_reload() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let (snapshot, refused_event, refused_body) = fixture();
    fs::write(root.join("records.jsonl"), snapshot.to_jsonl().unwrap()).unwrap();
    // Every output here is a bare relative name, without a leading ./.
    success(cli(
        root,
        &[
            "import",
            "records.jsonl",
            "--format",
            "jsonl",
            "--output",
            "full",
        ],
    ));
    assert_eq!(read_directory(root.join("full")).unwrap().events().len(), 4);
    fs::write(
        root.join("policy.json"),
        canonical_value(&json!({"refused_events":[refused_event],"refused_bodies":[refused_body]}))
            .unwrap(),
    )
    .unwrap();
    success(cli(
        root,
        &[
            "retain",
            "full",
            "--policy",
            "policy.json",
            "--output",
            "filtered",
        ],
    ));
    let saved =
        jvc_core::parse_json(&fs::read(root.join("filtered.retention-policy.json")).unwrap())
            .unwrap();
    assert_eq!(saved["refused_events"], json!([]));
    assert_eq!(
        saved["refused_issuers"],
        json!([identity_from_seed(&[1; 32])])
    );
    assert_eq!(saved["refused_bodies"], json!([refused_body]));
    let filtered = read_directory(root.join("filtered")).unwrap();
    assert_eq!(filtered.events().len(), 2);
    assert_eq!(filtered.manifest().unwrap().bodies.count, 0);
    for (left, right) in [
        ("filtered", "full"),
        ("full", "filtered"),
        ("filtered/", "full"),
    ] {
        let output = cli(root, &["merge", left, right, "--output", "blocked"]);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("--policy FILE"));
        assert!(!root.join("blocked").exists());
        assert!(!root.join("blocked.retention-policy.json").exists());
    }
    success(cli(
        root,
        &[
            "merge",
            "filtered",
            "full",
            "--output",
            "remerged",
            "--policy",
            "filtered.retention-policy.json",
        ],
    ));
    assert_eq!(
        read_directory(root.join("remerged"))
            .unwrap()
            .to_files()
            .unwrap(),
        filtered.to_files().unwrap()
    );
    // A second merge process must explicitly carry the newly saved resolved policy.
    let output = cli(root, &["merge", "remerged", "full", "--output", "blocked"]);
    assert!(!output.status.success());
    success(cli(
        root,
        &[
            "merge",
            "remerged",
            "full",
            "--output",
            "reloaded",
            "--policy",
            "remerged.retention-policy.json",
        ],
    ));
    assert_eq!(
        read_directory(root.join("reloaded"))
            .unwrap()
            .to_files()
            .unwrap(),
        filtered.to_files().unwrap()
    );
    // Plain public inputs need no policy. An explicit empty policy can override a saved refusal.
    success(cli(root, &["merge", "full", "full", "--output", "plain"]));
    assert_eq!(
        read_directory(root.join("plain")).unwrap().events().len(),
        4
    );
    fs::write(root.join("override.json"), b"{}").unwrap();
    success(cli(
        root,
        &[
            "merge",
            "filtered",
            "full",
            "--output",
            "override",
            "--policy",
            "override.json",
        ],
    ));
    let overridden = read_directory(root.join("override")).unwrap();
    assert_eq!(overridden.events().len(), 4);
    assert_eq!(overridden.manifest().unwrap().bodies.count, 1);
}
