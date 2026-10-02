use std::env;
use lab_c_ao_worker::run_synthetic_shard;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn main() {
    let a: Vec<String> = env::args().collect();
    if a.len() != 5 {
        eprintln!("usage: lab-c-ao-worker <start> <end> <known_index> <run_id>");
        std::process::exit(2);
    }
    let start: u64 = a[1].parse().expect("start");
    let end: u64 = a[2].parse().expect("end");
    let known: u64 = a[3].parse().expect("known_index");
    let r = run_synthetic_shard(start,end,known,a[4].as_bytes());
    println!("{{\"tested\":{},\"hit_index\":{},\"hit_commitment\":{},\"result_digest\":\"{}\"}}",
        r.tested,
        r.hit_index.map(|x|x.to_string()).unwrap_or_else(||"null".into()),
        r.hit_commitment.map(|x|format!("\"{}\"",hex(&x))).unwrap_or_else(||"null".into()),
        hex(&r.result_digest));
}
