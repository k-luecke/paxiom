use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use paxiom_light_client_lib::{
    decode_accumulator_public_values, decode_update_public_values, hex32, BeaconHeader,
    UpdateWitness,
};
use serde::{Deserialize, Serialize};
use sp1_sdk::{
    include_elf, Elf, HashableKey, ProveRequest, Prover, ProverClient, ProvingKey, SP1Proof,
    SP1ProofWithPublicValues, SP1Stdin,
};

const UPDATE_ELF: Elf = include_elf!("paxiom-update-program");
const ACCUMULATOR_ELF: Elf = include_elf!("paxiom-accumulator-program");

#[derive(Parser, Debug)]
#[command(about = "Execute and prove Paxiom Ethereum sync-committee checkpoints")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Execute both real-mainnet update witnesses in the zkVM without proving.
    Execute {
        #[arg(long, default_value = "../fixtures/mainnet-14814119-14814120.json")]
        fixture: PathBuf,
    },
    /// Generate and locally verify a compressed base proof for one fixture update.
    ProveBase {
        #[arg(long, default_value = "../fixtures/mainnet-14814119-14814120.json")]
        fixture: PathBuf,
        #[arg(long, default_value_t = 0)]
        index: usize,
        #[arg(long, default_value = "../artifacts/proofs/base.bin")]
        output: PathBuf,
    },
    /// Prove two base updates and recursively compose them into the first checkpoint.
    ProveSeed {
        #[arg(long, default_value = "../fixtures/mainnet-14814119-14814120.json")]
        fixture: PathBuf,
        #[arg(long, default_value = "../artifacts/proofs/checkpoint-2.bin")]
        output: PathBuf,
    },
    /// Extend an accumulator proof with one newly proved base update.
    Extend {
        #[arg(long)]
        accumulator_proof: PathBuf,
        #[arg(long, default_value = "../fixtures/mainnet-14814119-14814120.json")]
        fixture: PathBuf,
        #[arg(long)]
        index: usize,
        #[arg(long, default_value = "../artifacts/proofs/checkpoint-next.bin")]
        output: PathBuf,
    },
    /// Verify a previously generated base or accumulator proof and print public values.
    Verify {
        #[arg(long)]
        proof: PathBuf,
        #[arg(long, value_parser = ["update", "accumulator"])]
        program: String,
    },
    /// Print verification-key hashes that a relying verifier must pin.
    ///
    /// Derive one key per invocation on memory-constrained hosts. `all` is
    /// convenient on a suitably provisioned machine but may retain both large
    /// setup results at once, depending on the allocator.
    Vkeys {
        #[arg(long, default_value = "all", value_parser = ["update", "accumulator", "all"])]
        program: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RecursiveInput {
    left_vkey: [u32; 8],
    right_vkey: [u32; 8],
    expected_update_vkey: [u32; 8],
    expected_accumulator_vkey: [u32; 8],
    left_public_values: Vec<u8>,
    right_public_values: Vec<u8>,
}

#[derive(Debug, Deserialize)]
struct Fixture {
    network: String,
    genesis_validators_root: String,
    fork_version: String,
    trusted_sync_committee_root: String,
    sync_committee_pubkeys: Vec<String>,
    updates: Vec<FixtureUpdate>,
}

#[derive(Debug, Deserialize)]
struct FixtureUpdate {
    parent_header: FixtureHeader,
    attested_header: FixtureHeader,
    signature_slot: String,
    sync_committee_bits: String,
    sync_committee_signature: String,
}

#[derive(Debug, Deserialize)]
struct FixtureHeader {
    slot: String,
    proposer_index: String,
    parent_root: String,
    state_root: String,
    body_root: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    sp1_sdk::utils::setup_logger();
    let cli = Cli::parse();
    let client = ProverClient::from_env().await;

    match cli.command {
        Command::Execute { fixture } => {
            let witnesses = load_fixture(&fixture)?;
            for (index, witness) in witnesses.iter().enumerate() {
                let mut stdin = SP1Stdin::new();
                stdin.write(witness);
                let started = Instant::now();
                let (public_values, report) = client.execute(UPDATE_ELF.clone(), stdin).await?;
                let decoded = decode_update_public_values(public_values.as_slice())?;
                println!(
                    "update[{index}] slot={} participants={} from={} to={} instructions={} elapsed_ms={}",
                    decoded.to_slot,
                    decoded.participant_count,
                    hex32(&decoded.from_beacon_root),
                    hex32(&decoded.to_beacon_root),
                    report.total_instruction_count(),
                    started.elapsed().as_millis(),
                );
            }
        }
        Command::ProveBase {
            fixture,
            index,
            output,
        } => {
            let witnesses = load_fixture(&fixture)?;
            let witness = witnesses
                .get(index)
                .context("fixture update index out of range")?;
            let proving_key = client.setup(UPDATE_ELF.clone()).await?;
            let mut stdin = SP1Stdin::new();
            stdin.write(witness);
            let started = Instant::now();
            let proof = client.prove(&proving_key, stdin).compressed().await?;
            client.verify(&proof, proving_key.verifying_key(), None)?;
            save_proof(&proof, &output)?;
            println!(
                "verified compressed base proof: {} ({} ms)",
                output.display(),
                started.elapsed().as_millis()
            );
        }
        Command::ProveSeed { fixture, output } => {
            let witnesses = load_fixture(&fixture)?;
            if witnesses.len() < 2 {
                bail!("seed checkpoint requires at least two updates");
            }
            let update_key = client.setup(UPDATE_ELF.clone()).await?;
            let accumulator_key = client.setup(ACCUMULATOR_ELF.clone()).await?;
            let mut left_stdin = SP1Stdin::new();
            left_stdin.write(&witnesses[0]);
            let left = client.prove(&update_key, left_stdin).compressed().await?;
            client.verify(&left, update_key.verifying_key(), None)?;

            let mut right_stdin = SP1Stdin::new();
            right_stdin.write(&witnesses[1]);
            let right = client.prove(&update_key, right_stdin).compressed().await?;
            client.verify(&right, update_key.verifying_key(), None)?;

            let mut stdin = SP1Stdin::new();
            let recursive = RecursiveInput {
                left_vkey: update_key.verifying_key().hash_u32(),
                right_vkey: update_key.verifying_key().hash_u32(),
                expected_update_vkey: update_key.verifying_key().hash_u32(),
                expected_accumulator_vkey: accumulator_key.verifying_key().hash_u32(),
                left_public_values: left.public_values.to_vec(),
                right_public_values: right.public_values.to_vec(),
            };
            stdin.write(&recursive);
            write_compressed_proof(&mut stdin, left, update_key.verifying_key())?;
            write_compressed_proof(&mut stdin, right, update_key.verifying_key())?;

            let started = Instant::now();
            let proof = client.prove(&accumulator_key, stdin).compressed().await?;
            client.verify(&proof, accumulator_key.verifying_key(), None)?;
            let public = decode_accumulator_public_values(proof.public_values.as_slice())?;
            save_proof(&proof, &output)?;
            println!(
                "verified recursive checkpoint: updates={} slots={}..{} end_root={} file={} elapsed_ms={}",
                public.update_count,
                public.start_slot,
                public.end_slot,
                hex32(&public.end_beacon_root),
                output.display(),
                started.elapsed().as_millis(),
            );
        }
        Command::Extend {
            accumulator_proof,
            fixture,
            index,
            output,
        } => {
            let witnesses = load_fixture(&fixture)?;
            let witness = witnesses
                .get(index)
                .context("fixture update index out of range")?;
            let update_key = client.setup(UPDATE_ELF.clone()).await?;
            let accumulator_key = client.setup(ACCUMULATOR_ELF.clone()).await?;

            let prior = SP1ProofWithPublicValues::load(&accumulator_proof)?;
            client.verify(&prior, accumulator_key.verifying_key(), None)?;
            decode_accumulator_public_values(prior.public_values.as_slice())?;

            let mut update_stdin = SP1Stdin::new();
            update_stdin.write(witness);
            let next = client.prove(&update_key, update_stdin).compressed().await?;
            client.verify(&next, update_key.verifying_key(), None)?;

            let recursive = RecursiveInput {
                left_vkey: accumulator_key.verifying_key().hash_u32(),
                right_vkey: update_key.verifying_key().hash_u32(),
                expected_update_vkey: update_key.verifying_key().hash_u32(),
                expected_accumulator_vkey: accumulator_key.verifying_key().hash_u32(),
                left_public_values: prior.public_values.to_vec(),
                right_public_values: next.public_values.to_vec(),
            };
            let mut stdin = SP1Stdin::new();
            stdin.write(&recursive);
            write_compressed_proof(&mut stdin, prior, accumulator_key.verifying_key())?;
            write_compressed_proof(&mut stdin, next, update_key.verifying_key())?;

            let started = Instant::now();
            let proof = client.prove(&accumulator_key, stdin).compressed().await?;
            client.verify(&proof, accumulator_key.verifying_key(), None)?;
            let public = decode_accumulator_public_values(proof.public_values.as_slice())?;
            save_proof(&proof, &output)?;
            println!(
                "verified extended checkpoint: updates={} slots={}..{} end_root={} file={} elapsed_ms={}",
                public.update_count,
                public.start_slot,
                public.end_slot,
                hex32(&public.end_beacon_root),
                output.display(),
                started.elapsed().as_millis(),
            );
        }
        Command::Verify { proof, program } => {
            let proof = SP1ProofWithPublicValues::load(&proof)?;
            let elf = if program == "update" {
                UPDATE_ELF.clone()
            } else {
                ACCUMULATOR_ELF.clone()
            };
            let key = client.setup(elf).await?;
            client.verify(&proof, key.verifying_key(), None)?;
            if program == "update" {
                let value = decode_update_public_values(proof.public_values.as_slice())?;
                println!(
                    "valid base proof: slot={} root={} participants={}",
                    value.to_slot,
                    hex32(&value.to_beacon_root),
                    value.participant_count
                );
            } else {
                let value = decode_accumulator_public_values(proof.public_values.as_slice())?;
                println!(
                    "valid accumulator proof: updates={} slots={}..{} root={}",
                    value.update_count,
                    value.start_slot,
                    value.end_slot,
                    hex32(&value.end_beacon_root)
                );
            }
        }
        Command::Vkeys { program } => {
            if program == "update" || program == "all" {
                let key = client.setup(UPDATE_ELF.clone()).await?;
                print_vkey("update", &key);
            }
            if program == "accumulator" || program == "all" {
                let key = client.setup(ACCUMULATOR_ELF.clone()).await?;
                print_vkey("accumulator", &key);
            }
        }
    }
    Ok(())
}

fn print_vkey(label: &str, key: &impl ProvingKey) {
    let words = key.verifying_key().hash_u32();
    println!("{label}_vkey_u32={words:?}");
    println!(
        "{label}_recursive_vkey_bytes=0x{}",
        hex::encode(vkey_words_le(words))
    );
    println!("{label}_vkey_bytes32={}", key.verifying_key().bytes32());
}

fn write_compressed_proof(
    stdin: &mut SP1Stdin,
    proof: SP1ProofWithPublicValues,
    vkey: &sp1_sdk::SP1VerifyingKey,
) -> Result<()> {
    let SP1Proof::Compressed(inner) = proof.proof else {
        bail!("recursive input was not a compressed proof");
    };
    stdin.write_proof(*inner, vkey.vk.clone());
    Ok(())
}

fn save_proof(proof: &SP1ProofWithPublicValues, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    proof.save(path)?;
    Ok(())
}

fn load_fixture(path: &Path) -> Result<Vec<UpdateWitness>> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("read fixture {}", path.display()))?;
    let fixture: Fixture = serde_json::from_str(&raw)?;
    if fixture.network != "mainnet" {
        bail!("only the fixed mainnet domain is supported");
    }
    let genesis_validators_root = hex_array::<32>(&fixture.genesis_validators_root)?;
    let fork_version = hex_array::<4>(&fixture.fork_version)?;
    let trusted_sync_committee_root = hex_array::<32>(&fixture.trusted_sync_committee_root)?;
    let pubkeys = fixture
        .sync_committee_pubkeys
        .iter()
        .map(|value| hex_bytes(value))
        .collect::<Result<Vec<_>>>()?;
    fixture
        .updates
        .into_iter()
        .map(|update| {
            Ok(UpdateWitness {
                parent_header: BeaconHeader {
                    slot: update.parent_header.slot.parse()?,
                    proposer_index: update.parent_header.proposer_index.parse()?,
                    parent_root: hex_array::<32>(&update.parent_header.parent_root)?,
                    state_root: hex_array::<32>(&update.parent_header.state_root)?,
                    body_root: hex_array::<32>(&update.parent_header.body_root)?,
                },
                attested_header: BeaconHeader {
                    slot: update.attested_header.slot.parse()?,
                    proposer_index: update.attested_header.proposer_index.parse()?,
                    parent_root: hex_array::<32>(&update.attested_header.parent_root)?,
                    state_root: hex_array::<32>(&update.attested_header.state_root)?,
                    body_root: hex_array::<32>(&update.attested_header.body_root)?,
                },
                signature_slot: update.signature_slot.parse()?,
                sync_committee_bits: hex_bytes(&update.sync_committee_bits)?,
                sync_committee_signature: hex_bytes(&update.sync_committee_signature)?,
                sync_committee_pubkeys: pubkeys.clone(),
                fork_version,
                genesis_validators_root,
                trusted_sync_committee_root,
            })
        })
        .collect()
}

fn hex_bytes(value: &str) -> Result<Vec<u8>> {
    Ok(hex::decode(value.strip_prefix("0x").unwrap_or(value))?)
}

fn hex_array<const N: usize>(value: &str) -> Result<[u8; N]> {
    let bytes = hex_bytes(value)?;
    bytes
        .try_into()
        .map_err(|bytes: Vec<u8>| anyhow::anyhow!("expected {N} bytes, got {}", bytes.len()))
}

fn vkey_words_le(words: [u32; 8]) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    for (index, word) in words.iter().enumerate() {
        bytes[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    bytes
}
