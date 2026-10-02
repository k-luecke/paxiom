//! Lab C deterministic shard kernel scaffold.
//! Replace synthetic_candidate/synthetic_oracle with the frozen puzzle kernel
//! only after the AO coordination benchmark passes.

use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardResult {
    pub tested: u64,
    pub hit_index: Option<u64>,
    pub hit_commitment: Option<[u8; 32]>,
    pub result_digest: [u8; 32],
}

fn synthetic_candidate(index: u64) -> [u8; 8] {
    index.to_be_bytes()
}

fn synthetic_oracle(candidate: &[u8; 8], known_index: u64) -> bool {
    *candidate == known_index.to_be_bytes()
}

pub fn run_synthetic_shard(
    start: u64,
    end: u64,
    known_index: u64,
    run_id: &[u8],
) -> ShardResult {
    assert!(start <= end);
    let mut digest = Sha256::new();
    let mut hit_index = None;
    let mut hit_commitment = None;

    for i in start..end {
        let candidate = synthetic_candidate(i);
        digest.update(i.to_be_bytes());
        digest.update(candidate);

        if synthetic_oracle(&candidate, known_index) {
            hit_index = Some(i);
            let mut h = Sha256::new();
            h.update(b"LAB-C-WIN-v1");
            h.update(run_id);
            h.update(candidate);
            hit_commitment = Some(h.finalize().into());
        }
    }

    ShardResult {
        tested: end - start,
        hit_index,
        hit_commitment,
        result_digest: digest.finalize().into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_half_open_coverage_and_hit() {
        let r = run_synthetic_shard(100, 200, 137, b"synthetic-1");
        assert_eq!(r.tested, 100);
        assert_eq!(r.hit_index, Some(137));
        assert!(r.hit_commitment.is_some());
    }

    #[test]
    fn no_hit_outside_interval() {
        let r = run_synthetic_shard(100, 200, 99, b"synthetic-1");
        assert_eq!(r.tested, 100);
        assert_eq!(r.hit_index, None);
        assert_eq!(r.hit_commitment, None);
    }
}
