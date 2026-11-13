#![no_main]

sp1_zkvm::entrypoint!(main);

use paxiom_light_client_lib::{encode_update_public_values, verify_update, UpdateWitness};

pub fn main() {
    let witness = sp1_zkvm::io::read::<UpdateWitness>();
    let public = verify_update(&witness).expect("invalid Ethereum sync-committee update");
    sp1_zkvm::io::commit_slice(&encode_update_public_values(&public));
}
