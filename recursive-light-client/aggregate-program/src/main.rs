#![no_main]

sp1_zkvm::entrypoint!(main);

use paxiom_light_client_lib::{
    decode_accumulator_public_values, decode_update_public_values,
    encode_accumulator_public_values, extend_accumulator, initial_accumulator,
    AccumulatorPublicValues, UPDATE_PUBLIC_VALUES_LEN,
};
use sha2::{Digest, Sha256};

#[derive(serde::Serialize, serde::Deserialize)]
struct RecursiveInput {
    left_vkey: [u32; 8],
    right_vkey: [u32; 8],
    expected_update_vkey: [u32; 8],
    expected_accumulator_vkey: [u32; 8],
    left_public_values: Vec<u8>,
    right_public_values: Vec<u8>,
}

fn main() {
    let input = sp1_zkvm::io::read::<RecursiveInput>();

    assert_eq!(
        input.right_vkey, input.expected_update_vkey,
        "right proof must be a base update"
    );
    let right_digest: [u8; 32] = Sha256::digest(&input.right_public_values).into();
    sp1_zkvm::lib::verify::verify_sp1_proof(&input.right_vkey, &right_digest);
    let right = decode_update_public_values(&input.right_public_values)
        .expect("malformed right update public values");

    let output: AccumulatorPublicValues =
        if input.left_public_values.len() == UPDATE_PUBLIC_VALUES_LEN {
            assert_eq!(
                input.left_vkey, input.expected_update_vkey,
                "left genesis proof must be a base update"
            );
            let left_digest: [u8; 32] = Sha256::digest(&input.left_public_values).into();
            sp1_zkvm::lib::verify::verify_sp1_proof(&input.left_vkey, &left_digest);
            let left = decode_update_public_values(&input.left_public_values)
                .expect("malformed left update public values");
            initial_accumulator(
                &left,
                &right,
                input.expected_update_vkey,
                input.expected_accumulator_vkey,
            )
            .expect("non-contiguous initial updates")
        } else {
            assert_eq!(
                input.left_vkey, input.expected_accumulator_vkey,
                "left recursive proof must use the configured accumulator program"
            );
            let left_digest: [u8; 32] = Sha256::digest(&input.left_public_values).into();
            sp1_zkvm::lib::verify::verify_sp1_proof(&input.left_vkey, &left_digest);
            let left = decode_accumulator_public_values(&input.left_public_values)
                .expect("malformed accumulator public values");
            assert_eq!(
                left.update_vkey, input.expected_update_vkey,
                "update vkey anchor changed"
            );
            assert_eq!(
                left.accumulator_vkey, input.expected_accumulator_vkey,
                "accumulator vkey anchor changed"
            );
            extend_accumulator(&left, &right).expect("non-contiguous recursive update")
        };

    sp1_zkvm::io::commit_slice(&encode_accumulator_public_values(&output));
}
