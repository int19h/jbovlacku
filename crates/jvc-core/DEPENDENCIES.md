This crate has no selected software license. Dependency licenses apply to their own source code. The disposable fixture corpus declares CC0-1.0 rights for its new test inputs.

DEPENDENCIES.json records the resolved library versions, source repositories, and license expressions from Cargo metadata. It includes native test dependencies. Cargo.lock pins the source versions for this prototype.

The core uses ssh-key 0.6.7 for SSHSIG parsing and signing. It uses ed25519-dalek 2.2.0 for the Ed25519 equation. It uses curve25519-dalek 4.1.3 for canonical point and subgroup tests. Both Dalek libraries declare BSD-3-Clause. The SSH libraries declare Apache-2.0 OR MIT.

The point tests require canonical encodings and prime-order subgroup membership. The public point must differ from the identity point. The signature point can equal the identity point. Dalek's ordinary verifier evaluates the uncofactored equation after these tests. Its verify_strict method rejects the valid identity signature point and cannot implement this profile alone.

The native test signs with OpenSSH ssh-keygen and accepts that signature. OpenSSH also accepts the core's signature. The shared corpus includes an RFC 8032 vector and hostile point, scalar, JSON, and SSHSIG inputs. The browser test compares each result with the native result.

The library source used for this choice is [ed25519-dalek 2.2.0](https://docs.rs/ed25519-dalek/2.2.0/src/ed25519_dalek/verifying.rs.html). The SSHSIG source is [ssh-key 0.6.7](https://docs.rs/ssh-key/0.6.7/src/ssh_key/sshsig.rs.html).

Fixture provenance and specification hashes are in tests/fixtures/provenance.json.

The original fixture generation sources remain in tests/fixtures/provenance.json. The current repository contract and fixture hashes are bound separately in tests/fixtures/contract-binding.json. Language tags use BCP 47 syntax without registry membership checks.
