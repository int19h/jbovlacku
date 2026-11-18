//! The default setup budget must not act as a whole-dictionary size cap.
//! This test uses only the policy API present on both revisions.
use jvc_runtime::RankingPreparationPolicy;

fn policy() -> RankingPreparationPolicy {
    RankingPreparationPolicy {
        core_binding: format!("sha256:{}", "a".repeat(64)),
        limits: Default::default(),
    }
}

#[test]
fn measured_shape_at_sixty_four_times_passes_at_the_default() {
    let mut c = jvc_state::RankingIndexCounts {
        words: 89687,
        word_publications: 89687,
        target_groups: 89687,
        targets: 93806,
        judgment_groups: 89687,
        key_bytes: 33432924,
        ..Default::default()
    };
    c.words *= 64;
    c.word_publications *= 64;
    c.target_groups *= 64;
    c.targets *= 64;
    c.judgment_groups *= 64;
    c.key_bytes *= 64;
    assert!(policy().setup_estimate(&c).is_ok());
}
