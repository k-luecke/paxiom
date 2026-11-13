use std::{env, fs};

use paxiom_light_client_lib::{hex32, ssz_sync_committee_root};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    sync_committee_pubkeys: Vec<String>,
}

fn main() {
    let path = env::args()
        .nth(1)
        .expect("usage: committee-root FIXTURE.json");
    let fixture: Fixture = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let pubkeys = fixture
        .sync_committee_pubkeys
        .iter()
        .map(|value| hex::decode(value.strip_prefix("0x").unwrap_or(value)).unwrap())
        .collect::<Vec<_>>();
    println!("{}", hex32(&ssz_sync_committee_root(&pubkeys).unwrap()));
}
