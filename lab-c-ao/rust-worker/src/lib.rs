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

// -----------------------------------------------------------------------------
// WASM C ABI Export Layer
// -----------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShardOutputAbi {
    pub tested: u64,
    pub has_hit: u8,
    pub _pad: [u8; 7],
    pub hit_index: u64,
    pub hit_commitment: [u8; 32],
    pub result_digest: [u8; 32],
}

static mut GLOBAL_OUTPUT: ShardOutputAbi = ShardOutputAbi {
    tested: 0,
    has_hit: 0,
    _pad: [0; 7],
    hit_index: 0,
    hit_commitment: [0; 32],
    result_digest: [0; 32],
};

#[no_mangle]
pub extern "C" fn alloc_bytes(len: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn free_bytes(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        unsafe {
            let _ = Vec::from_raw_parts(ptr, 0, len);
        }
    }
}

#[no_mangle]
pub extern "C" fn get_output_ptr() -> *const ShardOutputAbi {
    std::ptr::addr_of!(GLOBAL_OUTPUT)
}

#[no_mangle]
pub extern "C" fn get_output_size() -> usize {
    std::mem::size_of::<ShardOutputAbi>()
}

#[no_mangle]
pub extern "C" fn run_shard_abi(
    start: u64,
    end: u64,
    known_index: u64,
    run_id_ptr: *const u8,
    run_id_len: usize,
) -> *const ShardOutputAbi {
    let run_id = if run_id_ptr.is_null() || run_id_len == 0 {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(run_id_ptr, run_id_len) }
    };

    let r = run_synthetic_shard(start, end, known_index, run_id);
    unsafe {
        GLOBAL_OUTPUT.tested = r.tested;
        if let Some(h) = r.hit_commitment {
            GLOBAL_OUTPUT.has_hit = 1;
            GLOBAL_OUTPUT.hit_commitment = h;
            GLOBAL_OUTPUT.hit_index = r.hit_index.unwrap_or(0);
        } else {
            GLOBAL_OUTPUT.has_hit = 0;
            GLOBAL_OUTPUT.hit_commitment = [0u8; 32];
            GLOBAL_OUTPUT.hit_index = 0;
        }
        GLOBAL_OUTPUT.result_digest = r.result_digest;
        std::ptr::addr_of!(GLOBAL_OUTPUT)
    }
}

#[no_mangle]
pub extern "C" fn run_shard_to_buf(
    start: u64,
    end: u64,
    known_index: u64,
    run_id_ptr: *const u8,
    run_id_len: usize,
    out_ptr: *mut ShardOutputAbi,
) -> i32 {
    if out_ptr.is_null() {
        return -1;
    }
    let run_id = if run_id_ptr.is_null() || run_id_len == 0 {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(run_id_ptr, run_id_len) }
    };
    let r = run_synthetic_shard(start, end, known_index, run_id);
    unsafe {
        (*out_ptr).tested = r.tested;
        if let Some(h) = r.hit_commitment {
            (*out_ptr).has_hit = 1;
            (*out_ptr).hit_commitment = h;
            (*out_ptr).hit_index = r.hit_index.unwrap_or(0);
        } else {
            (*out_ptr).has_hit = 0;
            (*out_ptr).hit_commitment = [0u8; 32];
            (*out_ptr).hit_index = 0;
        }
        (*out_ptr).result_digest = r.result_digest;
    }
    0
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

    #[test]
    fn wasm_abi_roundtrip_hit() {
        let run_id = b"test-run-abi";
        let out_ptr = run_shard_abi(50, 150, 120, run_id.as_ptr(), run_id.len());
        assert!(!out_ptr.is_null());
        let out = unsafe { &*out_ptr };
        assert_eq!(out.tested, 100);
        assert_eq!(out.has_hit, 1);
        assert_eq!(out.hit_index, 120);

        let expected = run_synthetic_shard(50, 150, 120, run_id);
        assert_eq!(out.result_digest, expected.result_digest);
        assert_eq!(out.hit_commitment, expected.hit_commitment.unwrap());
    }

    #[test]
    fn wasm_abi_roundtrip_no_hit() {
        let run_id = b"test-run-abi";
        let out_ptr = run_shard_abi(50, 150, 200, run_id.as_ptr(), run_id.len());
        assert!(!out_ptr.is_null());
        let out = unsafe { &*out_ptr };
        assert_eq!(out.tested, 100);
        assert_eq!(out.has_hit, 0);
        assert_eq!(out.hit_commitment, [0u8; 32]);
    }
}
