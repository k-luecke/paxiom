use std::{fs, path::PathBuf};

use paxiom_light_client_lib::{
    beacon_header_root, verify_update, BeaconHeader, UpdateWitness, VerificationError,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    network: String,
    genesis_validators_root: String,
    fork_version: String,
    trusted_sync_committee_root: String,
    sync_committee_pubkeys: Vec<String>,
    updates: Vec<FixtureUpdate>,
}

#[derive(Deserialize)]
struct FixtureUpdate {
    parent_header: FixtureHeader,
    parent_beacon_root: String,
    attested_header: FixtureHeader,
    attested_beacon_root: String,
    signature_slot: String,
    signature_block_finalized: bool,
    signature_block_execution_optimistic: bool,
    sync_committee_bits: String,
    sync_committee_signature: String,
}

#[derive(Deserialize)]
struct FixtureHeader {
    slot: String,
    proposer_index: String,
    parent_root: String,
    state_root: String,
    body_root: String,
}

#[test]
fn verifies_two_parent_linked_finalized_mainnet_updates() {
    let (fixture, witnesses) = load_fixture();
    assert_eq!(fixture.network, "mainnet");
    assert_eq!(witnesses.len(), 2);

    let first = verify_update(&witnesses[0]).expect("first real mainnet update must verify");
    let second = verify_update(&witnesses[1]).expect("second real mainnet update must verify");
    assert_eq!(first.to_beacon_root, second.from_beacon_root);
    assert_eq!(first.to_slot + 1, second.to_slot);
    assert!(first.participant_count >= 342);
    assert!(second.participant_count >= 342);

    for (source, witness) in fixture.updates.iter().zip(witnesses.iter()) {
        assert!(source.signature_block_finalized);
        assert!(!source.signature_block_execution_optimistic);
        assert_eq!(
            format!(
                "0x{}",
                hex::encode(beacon_header_root(&witness.parent_header))
            ),
            source.parent_beacon_root,
        );
        assert_eq!(
            format!(
                "0x{}",
                hex::encode(beacon_header_root(&witness.attested_header))
            ),
            source.attested_beacon_root,
        );
        assert_eq!(witness.signature_slot.to_string(), source.signature_slot);
    }
}

#[test]
fn rejects_mutated_signature_parent_root_bits_fork_and_anchor() {
    let (_, witnesses) = load_fixture();
    let original = &witnesses[0];

    let mut bad_signature = original.clone();
    bad_signature.sync_committee_signature[20] ^= 1;
    assert!(matches!(
        verify_update(&bad_signature),
        Err(VerificationError::InvalidPoint(_)) | Err(VerificationError::InvalidSignature)
    ));

    let mut bad_parent = original.clone();
    bad_parent.attested_header.parent_root[0] ^= 1;
    assert_eq!(
        verify_update(&bad_parent),
        Err(VerificationError::ParentRootMismatch)
    );

    let mut forged_parent_header = original.clone();
    forged_parent_header.parent_header.state_root[0] ^= 1;
    assert_eq!(
        verify_update(&forged_parent_header),
        Err(VerificationError::ParentRootMismatch)
    );

    let mut bad_state_root = original.clone();
    bad_state_root.attested_header.state_root[0] ^= 1;
    assert_eq!(
        verify_update(&bad_state_root),
        Err(VerificationError::InvalidSignature)
    );

    let mut bad_bits = original.clone();
    bad_bits.sync_committee_bits[0] ^= 1;
    assert_eq!(
        verify_update(&bad_bits),
        Err(VerificationError::InvalidSignature)
    );

    let mut below_threshold = original.clone();
    below_threshold.sync_committee_bits.fill(0);
    for index in 0..341 {
        below_threshold.sync_committee_bits[index / 8] |= 1 << (index % 8);
    }
    assert_eq!(
        verify_update(&below_threshold),
        Err(VerificationError::InsufficientParticipation {
            actual: 341,
            required: 342,
        })
    );

    let mut missing_pubkey = original.clone();
    missing_pubkey.sync_committee_pubkeys.pop();
    assert_eq!(
        verify_update(&missing_pubkey),
        Err(VerificationError::InvalidLength("sync committee pubkeys"))
    );

    let mut bad_fork = original.clone();
    bad_fork.fork_version[0] ^= 1;
    assert_eq!(
        verify_update(&bad_fork),
        Err(VerificationError::InvalidSignature)
    );

    let mut bad_anchor = original.clone();
    bad_anchor.trusted_sync_committee_root[0] ^= 1;
    assert_eq!(
        verify_update(&bad_anchor),
        Err(VerificationError::TrustedCommitteeMismatch)
    );

    let mut bad_signature_slot = original.clone();
    bad_signature_slot.signature_slot = bad_signature_slot.attested_header.slot;
    assert_eq!(
        verify_update(&bad_signature_slot),
        Err(VerificationError::SignatureSlotNotAfterAttested)
    );
}

fn load_fixture() -> (Fixture, Vec<UpdateWitness>) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/mainnet-14814119-14814120.json");
    let fixture: Fixture = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let genesis_validators_root = hex_array::<32>(&fixture.genesis_validators_root);
    let fork_version = hex_array::<4>(&fixture.fork_version);
    let trusted_sync_committee_root = hex_array::<32>(&fixture.trusted_sync_committee_root);
    let pubkeys = fixture
        .sync_committee_pubkeys
        .iter()
        .map(|value| hex_bytes(value))
        .collect::<Vec<_>>();
    let witnesses = fixture
        .updates
        .iter()
        .map(|update| UpdateWitness {
            parent_header: BeaconHeader {
                slot: update.parent_header.slot.parse().unwrap(),
                proposer_index: update.parent_header.proposer_index.parse().unwrap(),
                parent_root: hex_array::<32>(&update.parent_header.parent_root),
                state_root: hex_array::<32>(&update.parent_header.state_root),
                body_root: hex_array::<32>(&update.parent_header.body_root),
            },
            attested_header: BeaconHeader {
                slot: update.attested_header.slot.parse().unwrap(),
                proposer_index: update.attested_header.proposer_index.parse().unwrap(),
                parent_root: hex_array::<32>(&update.attested_header.parent_root),
                state_root: hex_array::<32>(&update.attested_header.state_root),
                body_root: hex_array::<32>(&update.attested_header.body_root),
            },
            signature_slot: update.signature_slot.parse().unwrap(),
            sync_committee_bits: hex_bytes(&update.sync_committee_bits),
            sync_committee_signature: hex_bytes(&update.sync_committee_signature),
            sync_committee_pubkeys: pubkeys.clone(),
            fork_version,
            genesis_validators_root,
            trusted_sync_committee_root,
        })
        .collect();
    (fixture, witnesses)
}

fn hex_bytes(value: &str) -> Vec<u8> {
    hex::decode(value.strip_prefix("0x").unwrap_or(value)).unwrap()
}

fn hex_array<const N: usize>(value: &str) -> [u8; N] {
    hex_bytes(value).try_into().unwrap()
}
