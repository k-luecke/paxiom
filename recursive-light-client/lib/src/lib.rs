#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::{string::String, vec::Vec};
use bls12_381::{
    hash_to_curve::{ExpandMsgXmd, HashToCurve},
    pairing, G1Affine, G1Projective, G2Affine, G2Projective,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sha2_09::Sha256 as Sha256V09;

pub const SYNC_COMMITTEE_SIZE: usize = 512;
pub const SYNC_COMMITTEE_BITS_BYTES: usize = 64;
pub const MIN_SUPERMAJORITY_PARTICIPANTS: u16 = 342;
pub const DOMAIN_SYNC_COMMITTEE: [u8; 4] = [0x07, 0x00, 0x00, 0x00];
pub const ETHEREUM_BLS_DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";
pub const UPDATE_PUBLIC_VALUES_LEN: usize = 190;
pub const ACCUMULATOR_PUBLIC_VALUES_LEN: usize = 260;

const UPDATE_MAGIC: &[u8; 8] = b"PAXUPD01";
const ACCUMULATOR_MAGIC: &[u8; 8] = b"PAXACC01";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeaconHeader {
    pub slot: u64,
    pub proposer_index: u64,
    pub parent_root: [u8; 32],
    pub state_root: [u8; 32],
    pub body_root: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateWitness {
    /// The exact parent header, bound to `attested_header.parent_root` by SSZ hash.
    pub parent_header: BeaconHeader,
    /// The beacon header whose SSZ root is authenticated by the sync aggregate.
    pub attested_header: BeaconHeader,
    /// Slot of the block carrying the aggregate. It must follow the attested slot.
    pub signature_slot: u64,
    pub sync_committee_bits: Vec<u8>,
    pub sync_committee_signature: Vec<u8>,
    pub sync_committee_pubkeys: Vec<Vec<u8>>,
    pub fork_version: [u8; 4],
    pub genesis_validators_root: [u8; 32],
    /// The SSZ hash_tree_root of SyncCommittee, fixed by the relying verifier.
    pub trusted_sync_committee_root: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdatePublicValues {
    pub from_slot: u64,
    pub to_slot: u64,
    pub from_beacon_root: [u8; 32],
    pub to_beacon_root: [u8; 32],
    pub sync_committee_root: [u8; 32],
    pub genesis_validators_root: [u8; 32],
    pub witness_root: [u8; 32],
    pub fork_version: [u8; 4],
    pub participant_count: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccumulatorPublicValues {
    pub start_slot: u64,
    pub end_slot: u64,
    pub update_count: u64,
    pub start_beacon_root: [u8; 32],
    pub end_beacon_root: [u8; 32],
    pub sync_committee_root: [u8; 32],
    pub genesis_validators_root: [u8; 32],
    pub update_chain_root: [u8; 32],
    pub update_vkey: [u32; 8],
    pub accumulator_vkey: [u32; 8],
    pub fork_version: [u8; 4],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VerificationError {
    InvalidLength(&'static str),
    InvalidPoint(&'static str),
    IdentityPoint(&'static str),
    EmptyParticipation,
    InsufficientParticipation { actual: u16, required: u16 },
    InvalidSignature,
    TrustedCommitteeMismatch,
    SlotZero,
    ParentSlotNotBeforeAttested,
    ParentRootMismatch,
    SignatureSlotNotAfterAttested,
    MalformedPublicValues,
    DiscontinuousRoots,
    NonIncreasingSlots,
    AnchorChanged(&'static str),
    CountOverflow,
}

impl core::fmt::Display for VerificationError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}

#[cfg(feature = "std")]
impl std::error::Error for VerificationError {}

pub fn verify_update(witness: &UpdateWitness) -> Result<UpdatePublicValues, VerificationError> {
    if witness.parent_header.slot == 0 || witness.attested_header.slot == 0 {
        return Err(VerificationError::SlotZero);
    }
    if witness.parent_header.slot >= witness.attested_header.slot {
        return Err(VerificationError::ParentSlotNotBeforeAttested);
    }
    if witness.signature_slot <= witness.attested_header.slot {
        return Err(VerificationError::SignatureSlotNotAfterAttested);
    }
    let parent_root = beacon_header_root(&witness.parent_header);
    if parent_root != witness.attested_header.parent_root {
        return Err(VerificationError::ParentRootMismatch);
    }
    if witness.sync_committee_bits.len() != SYNC_COMMITTEE_BITS_BYTES {
        return Err(VerificationError::InvalidLength("sync committee bits"));
    }
    if witness.sync_committee_signature.len() != 96 {
        return Err(VerificationError::InvalidLength("sync committee signature"));
    }
    if witness.sync_committee_pubkeys.len() != SYNC_COMMITTEE_SIZE {
        return Err(VerificationError::InvalidLength("sync committee pubkeys"));
    }

    let mut all_pubkeys = G1Projective::identity();
    let mut participant_pubkeys = G1Projective::identity();
    let mut participant_count = 0u16;
    let mut pubkey_roots = Vec::with_capacity(SYNC_COMMITTEE_SIZE);

    for (index, bytes) in witness.sync_committee_pubkeys.iter().enumerate() {
        let point =
            parse_g1(bytes).ok_or(VerificationError::InvalidPoint("sync committee pubkey"))?;
        if point == G1Affine::identity() {
            return Err(VerificationError::IdentityPoint("sync committee pubkey"));
        }
        let projective = G1Projective::from(point);
        all_pubkeys += projective;
        if bit_is_set(&witness.sync_committee_bits, index) {
            participant_pubkeys += projective;
            participant_count += 1;
        }
        pubkey_roots.push(ssz_pubkey_root(bytes)?);
    }

    if participant_count == 0 {
        return Err(VerificationError::EmptyParticipation);
    }
    if participant_count < MIN_SUPERMAJORITY_PARTICIPANTS {
        return Err(VerificationError::InsufficientParticipation {
            actual: participant_count,
            required: MIN_SUPERMAJORITY_PARTICIPANTS,
        });
    }

    let pubkeys_root = merkleize_power_of_two(pubkey_roots)?;
    let aggregate_pubkey_bytes = G1Affine::from(all_pubkeys).to_compressed();
    let aggregate_pubkey_root = ssz_pubkey_root(&aggregate_pubkey_bytes)?;
    let sync_committee_root = sha256_pair(&pubkeys_root, &aggregate_pubkey_root);
    if sync_committee_root != witness.trusted_sync_committee_root {
        return Err(VerificationError::TrustedCommitteeMismatch);
    }

    let signature = parse_g2(&witness.sync_committee_signature)
        .ok_or(VerificationError::InvalidPoint("sync committee signature"))?;
    if signature == G2Affine::identity() {
        return Err(VerificationError::IdentityPoint("sync committee signature"));
    }

    let domain =
        compute_sync_committee_domain(witness.fork_version, witness.genesis_validators_root);
    let attested_root = beacon_header_root(&witness.attested_header);
    let signing_root = sha256_pair(&attested_root, &domain);
    let message_point = <G2Projective as HashToCurve<ExpandMsgXmd<Sha256V09>>>::hash_to_curve(
        signing_root,
        ETHEREUM_BLS_DST,
    );
    let participant_affine = G1Affine::from(participant_pubkeys);
    let message_affine = G2Affine::from(message_point);
    if pairing(&participant_affine, &message_affine) != pairing(&G1Affine::generator(), &signature)
    {
        return Err(VerificationError::InvalidSignature);
    }

    Ok(UpdatePublicValues {
        from_slot: witness.parent_header.slot,
        to_slot: witness.attested_header.slot,
        from_beacon_root: parent_root,
        to_beacon_root: attested_root,
        sync_committee_root,
        genesis_validators_root: witness.genesis_validators_root,
        witness_root: update_witness_root(witness),
        fork_version: witness.fork_version,
        participant_count,
    })
}

pub fn compute_sync_committee_domain(
    fork_version: [u8; 4],
    genesis_validators_root: [u8; 32],
) -> [u8; 32] {
    let mut version_chunk = [0u8; 32];
    version_chunk[..4].copy_from_slice(&fork_version);
    let fork_data_root = sha256_pair(&version_chunk, &genesis_validators_root);
    let mut domain = [0u8; 32];
    domain[..4].copy_from_slice(&DOMAIN_SYNC_COMMITTEE);
    domain[4..].copy_from_slice(&fork_data_root[..28]);
    domain
}

pub fn beacon_header_root(header: &BeaconHeader) -> [u8; 32] {
    let mut slot_root = [0u8; 32];
    slot_root[..8].copy_from_slice(&header.slot.to_le_bytes());
    let mut proposer_root = [0u8; 32];
    proposer_root[..8].copy_from_slice(&header.proposer_index.to_le_bytes());
    let zero = [0u8; 32];

    let left_0 = sha256_pair(&slot_root, &proposer_root);
    let left_1 = sha256_pair(&header.parent_root, &header.state_root);
    let right_0 = sha256_pair(&header.body_root, &zero);
    let right_1 = sha256_pair(&zero, &zero);
    let left = sha256_pair(&left_0, &left_1);
    let right = sha256_pair(&right_0, &right_1);
    sha256_pair(&left, &right)
}

pub fn ssz_sync_committee_root(pubkeys: &[Vec<u8>]) -> Result<[u8; 32], VerificationError> {
    if pubkeys.len() != SYNC_COMMITTEE_SIZE {
        return Err(VerificationError::InvalidLength("sync committee pubkeys"));
    }
    let mut points = G1Projective::identity();
    let mut roots = Vec::with_capacity(SYNC_COMMITTEE_SIZE);
    for bytes in pubkeys {
        let point =
            parse_g1(bytes).ok_or(VerificationError::InvalidPoint("sync committee pubkey"))?;
        if point == G1Affine::identity() {
            return Err(VerificationError::IdentityPoint("sync committee pubkey"));
        }
        points += G1Projective::from(point);
        roots.push(ssz_pubkey_root(bytes)?);
    }
    let pubkeys_root = merkleize_power_of_two(roots)?;
    let aggregate_root = ssz_pubkey_root(&G1Affine::from(points).to_compressed())?;
    Ok(sha256_pair(&pubkeys_root, &aggregate_root))
}

pub fn encode_update_public_values(values: &UpdatePublicValues) -> Vec<u8> {
    let mut out = Vec::with_capacity(UPDATE_PUBLIC_VALUES_LEN);
    out.extend_from_slice(UPDATE_MAGIC);
    out.extend_from_slice(&values.from_slot.to_le_bytes());
    out.extend_from_slice(&values.to_slot.to_le_bytes());
    out.extend_from_slice(&values.from_beacon_root);
    out.extend_from_slice(&values.to_beacon_root);
    out.extend_from_slice(&values.sync_committee_root);
    out.extend_from_slice(&values.genesis_validators_root);
    out.extend_from_slice(&values.witness_root);
    out.extend_from_slice(&values.fork_version);
    out.extend_from_slice(&values.participant_count.to_le_bytes());
    debug_assert_eq!(out.len(), UPDATE_PUBLIC_VALUES_LEN);
    out
}

pub fn decode_update_public_values(bytes: &[u8]) -> Result<UpdatePublicValues, VerificationError> {
    if bytes.len() != UPDATE_PUBLIC_VALUES_LEN || &bytes[..8] != UPDATE_MAGIC {
        return Err(VerificationError::MalformedPublicValues);
    }
    Ok(UpdatePublicValues {
        from_slot: read_u64(bytes, 8)?,
        to_slot: read_u64(bytes, 16)?,
        from_beacon_root: read_32(bytes, 24)?,
        to_beacon_root: read_32(bytes, 56)?,
        sync_committee_root: read_32(bytes, 88)?,
        genesis_validators_root: read_32(bytes, 120)?,
        witness_root: read_32(bytes, 152)?,
        fork_version: read_4(bytes, 184)?,
        participant_count: u16::from_le_bytes(
            bytes[188..190]
                .try_into()
                .map_err(|_| VerificationError::MalformedPublicValues)?,
        ),
    })
}

pub fn encode_accumulator_public_values(values: &AccumulatorPublicValues) -> Vec<u8> {
    let mut out = Vec::with_capacity(ACCUMULATOR_PUBLIC_VALUES_LEN);
    out.extend_from_slice(ACCUMULATOR_MAGIC);
    out.extend_from_slice(&values.start_slot.to_le_bytes());
    out.extend_from_slice(&values.end_slot.to_le_bytes());
    out.extend_from_slice(&values.update_count.to_le_bytes());
    out.extend_from_slice(&values.start_beacon_root);
    out.extend_from_slice(&values.end_beacon_root);
    out.extend_from_slice(&values.sync_committee_root);
    out.extend_from_slice(&values.genesis_validators_root);
    out.extend_from_slice(&values.update_chain_root);
    for word in values.update_vkey {
        out.extend_from_slice(&word.to_le_bytes());
    }
    for word in values.accumulator_vkey {
        out.extend_from_slice(&word.to_le_bytes());
    }
    out.extend_from_slice(&values.fork_version);
    debug_assert_eq!(out.len(), ACCUMULATOR_PUBLIC_VALUES_LEN);
    out
}

pub fn decode_accumulator_public_values(
    bytes: &[u8],
) -> Result<AccumulatorPublicValues, VerificationError> {
    if bytes.len() != ACCUMULATOR_PUBLIC_VALUES_LEN || &bytes[..8] != ACCUMULATOR_MAGIC {
        return Err(VerificationError::MalformedPublicValues);
    }
    Ok(AccumulatorPublicValues {
        start_slot: read_u64(bytes, 8)?,
        end_slot: read_u64(bytes, 16)?,
        update_count: read_u64(bytes, 24)?,
        start_beacon_root: read_32(bytes, 32)?,
        end_beacon_root: read_32(bytes, 64)?,
        sync_committee_root: read_32(bytes, 96)?,
        genesis_validators_root: read_32(bytes, 128)?,
        update_chain_root: read_32(bytes, 160)?,
        update_vkey: read_vkey(bytes, 192)?,
        accumulator_vkey: read_vkey(bytes, 224)?,
        fork_version: read_4(bytes, 256)?,
    })
}

pub fn initial_accumulator(
    left: &UpdatePublicValues,
    right: &UpdatePublicValues,
    update_vkey: [u32; 8],
    accumulator_vkey: [u32; 8],
) -> Result<AccumulatorPublicValues, VerificationError> {
    assert_updates_connect(left, right)?;
    let mut seed = Vec::with_capacity(65);
    seed.push(0u8);
    seed.extend_from_slice(&left.witness_root);
    seed.extend_from_slice(&right.witness_root);
    Ok(AccumulatorPublicValues {
        start_slot: left.from_slot,
        end_slot: right.to_slot,
        update_count: 2,
        start_beacon_root: left.from_beacon_root,
        end_beacon_root: right.to_beacon_root,
        sync_committee_root: left.sync_committee_root,
        genesis_validators_root: left.genesis_validators_root,
        update_chain_root: sha256(&seed),
        update_vkey,
        accumulator_vkey,
        fork_version: left.fork_version,
    })
}

pub fn extend_accumulator(
    accumulator: &AccumulatorPublicValues,
    next: &UpdatePublicValues,
) -> Result<AccumulatorPublicValues, VerificationError> {
    if accumulator.end_beacon_root != next.from_beacon_root {
        return Err(VerificationError::DiscontinuousRoots);
    }
    if next.to_slot <= accumulator.end_slot || next.from_slot < accumulator.end_slot {
        return Err(VerificationError::NonIncreasingSlots);
    }
    assert_anchor(
        "sync committee",
        accumulator.sync_committee_root,
        next.sync_committee_root,
    )?;
    assert_anchor(
        "genesis validators root",
        accumulator.genesis_validators_root,
        next.genesis_validators_root,
    )?;
    if accumulator.fork_version != next.fork_version {
        return Err(VerificationError::AnchorChanged("fork version"));
    }
    let update_count = accumulator
        .update_count
        .checked_add(1)
        .ok_or(VerificationError::CountOverflow)?;
    Ok(AccumulatorPublicValues {
        start_slot: accumulator.start_slot,
        end_slot: next.to_slot,
        update_count,
        start_beacon_root: accumulator.start_beacon_root,
        end_beacon_root: next.to_beacon_root,
        sync_committee_root: accumulator.sync_committee_root,
        genesis_validators_root: accumulator.genesis_validators_root,
        update_chain_root: sha256_pair(&accumulator.update_chain_root, &next.witness_root),
        update_vkey: accumulator.update_vkey,
        accumulator_vkey: accumulator.accumulator_vkey,
        fork_version: accumulator.fork_version,
    })
}

pub fn hex32(bytes: &[u8; 32]) -> String {
    let mut out = String::from("0x");
    out.push_str(&hex::encode(bytes));
    out
}

fn assert_updates_connect(
    left: &UpdatePublicValues,
    right: &UpdatePublicValues,
) -> Result<(), VerificationError> {
    if left.to_beacon_root != right.from_beacon_root {
        return Err(VerificationError::DiscontinuousRoots);
    }
    if right.to_slot <= left.to_slot || right.from_slot < left.to_slot {
        return Err(VerificationError::NonIncreasingSlots);
    }
    assert_anchor(
        "sync committee",
        left.sync_committee_root,
        right.sync_committee_root,
    )?;
    assert_anchor(
        "genesis validators root",
        left.genesis_validators_root,
        right.genesis_validators_root,
    )?;
    if left.fork_version != right.fork_version {
        return Err(VerificationError::AnchorChanged("fork version"));
    }
    Ok(())
}

fn assert_anchor(
    name: &'static str,
    left: [u8; 32],
    right: [u8; 32],
) -> Result<(), VerificationError> {
    if left != right {
        return Err(VerificationError::AnchorChanged(name));
    }
    Ok(())
}

fn parse_g1(bytes: &[u8]) -> Option<G1Affine> {
    let encoded: [u8; 48] = bytes.try_into().ok()?;
    Option::<G1Affine>::from(G1Affine::from_compressed(&encoded))
}

fn parse_g2(bytes: &[u8]) -> Option<G2Affine> {
    let encoded: [u8; 96] = bytes.try_into().ok()?;
    Option::<G2Affine>::from(G2Affine::from_compressed(&encoded))
}

fn bit_is_set(bits: &[u8], index: usize) -> bool {
    bits[index / 8] & (1u8 << (index % 8)) != 0
}

fn ssz_pubkey_root(bytes: &[u8]) -> Result<[u8; 32], VerificationError> {
    if bytes.len() != 48 {
        return Err(VerificationError::InvalidLength("BLS pubkey"));
    }
    let mut left = [0u8; 32];
    let mut right = [0u8; 32];
    left.copy_from_slice(&bytes[..32]);
    right[..16].copy_from_slice(&bytes[32..]);
    Ok(sha256_pair(&left, &right))
}

fn merkleize_power_of_two(mut roots: Vec<[u8; 32]>) -> Result<[u8; 32], VerificationError> {
    if roots.is_empty() || !roots.len().is_power_of_two() {
        return Err(VerificationError::InvalidLength("SSZ power-of-two vector"));
    }
    while roots.len() > 1 {
        let mut parent = Vec::with_capacity(roots.len() / 2);
        for pair in roots.chunks_exact(2) {
            parent.push(sha256_pair(&pair[0], &pair[1]));
        }
        roots = parent;
    }
    Ok(roots[0])
}

fn update_witness_root(witness: &UpdateWitness) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"PAXIOM_ETH_SYNC_UPDATE_WITNESS_V1");
    hasher.update(beacon_header_root(&witness.parent_header));
    hasher.update(beacon_header_root(&witness.attested_header));
    hasher.update(witness.signature_slot.to_le_bytes());
    hasher.update(&witness.sync_committee_bits);
    hasher.update(&witness.sync_committee_signature);
    for pubkey in &witness.sync_committee_pubkeys {
        hasher.update(pubkey);
    }
    hasher.update(witness.fork_version);
    hasher.update(witness.genesis_validators_root);
    hasher.update(witness.trusted_sync_committee_root);
    hasher.finalize().into()
}

fn sha256_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(left);
    hasher.update(right);
    hasher.finalize().into()
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn read_u64(bytes: &[u8], start: usize) -> Result<u64, VerificationError> {
    Ok(u64::from_le_bytes(
        bytes
            .get(start..start + 8)
            .ok_or(VerificationError::MalformedPublicValues)?
            .try_into()
            .map_err(|_| VerificationError::MalformedPublicValues)?,
    ))
}

fn read_32(bytes: &[u8], start: usize) -> Result<[u8; 32], VerificationError> {
    bytes
        .get(start..start + 32)
        .ok_or(VerificationError::MalformedPublicValues)?
        .try_into()
        .map_err(|_| VerificationError::MalformedPublicValues)
}

fn read_4(bytes: &[u8], start: usize) -> Result<[u8; 4], VerificationError> {
    bytes
        .get(start..start + 4)
        .ok_or(VerificationError::MalformedPublicValues)?
        .try_into()
        .map_err(|_| VerificationError::MalformedPublicValues)
}

fn read_vkey(bytes: &[u8], start: usize) -> Result<[u32; 8], VerificationError> {
    let mut result = [0u32; 8];
    for (index, word) in result.iter_mut().enumerate() {
        let offset = start + index * 4;
        *word = u32::from_le_bytes(
            bytes
                .get(offset..offset + 4)
                .ok_or(VerificationError::MalformedPublicValues)?
                .try_into()
                .map_err(|_| VerificationError::MalformedPublicValues)?,
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(from_slot: u64, from: u8, to: u8, witness: u8) -> UpdatePublicValues {
        UpdatePublicValues {
            from_slot,
            to_slot: from_slot + 1,
            from_beacon_root: [from; 32],
            to_beacon_root: [to; 32],
            sync_committee_root: [7; 32],
            genesis_validators_root: [8; 32],
            witness_root: [witness; 32],
            fork_version: [6, 0, 0, 0],
            participant_count: 500,
        }
    }

    #[test]
    fn update_public_values_round_trip() {
        let value = update(10, 1, 2, 3);
        let bytes = encode_update_public_values(&value);
        assert_eq!(bytes.len(), UPDATE_PUBLIC_VALUES_LEN);
        assert_eq!(decode_update_public_values(&bytes).unwrap(), value);
    }

    #[test]
    fn rolling_accumulator_enforces_continuity_and_anchors() {
        let first = update(10, 1, 2, 10);
        let second = update(11, 2, 3, 11);
        let third = update(12, 3, 4, 12);
        let accumulator = initial_accumulator(&first, &second, [1; 8], [2; 8]).unwrap();
        assert_eq!(accumulator.update_count, 2);
        let accumulator = extend_accumulator(&accumulator, &third).unwrap();
        assert_eq!(accumulator.update_count, 3);
        assert_eq!(accumulator.start_beacon_root, [1; 32]);
        assert_eq!(accumulator.end_beacon_root, [4; 32]);

        let bytes = encode_accumulator_public_values(&accumulator);
        assert_eq!(bytes.len(), ACCUMULATOR_PUBLIC_VALUES_LEN);
        assert_eq!(
            decode_accumulator_public_values(&bytes).unwrap(),
            accumulator
        );

        let discontinuous = update(13, 9, 5, 13);
        assert_eq!(
            extend_accumulator(&accumulator, &discontinuous),
            Err(VerificationError::DiscontinuousRoots)
        );
    }

    #[test]
    fn beacon_header_ssz_root_has_expected_shape() {
        let header = BeaconHeader {
            slot: 1,
            proposer_index: 2,
            parent_root: [3; 32],
            state_root: [4; 32],
            body_root: [5; 32],
        };
        assert_ne!(beacon_header_root(&header), [0; 32]);
    }
}
