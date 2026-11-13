# Benchmarks and evidence

Recorded on the local WSL2 environment on 2026-07-20/21. Numbers are evidence only for the exact pinned fixture and build; they are not generalized performance claims.

Results from this host must not be presented as representative SP1 prover performance. The VM exposes only about 5.7 GiB RAM and 2 GiB swap. A portable-executor attempt and a native-executor attempt both exhausted the practical memory budget before completing the first update. The native runner was compiled separately and selected with `SP1_CORE_RUNNER_OVERRIDE_BINARY` to work around a repeatable WSL2 `SIGBUS` in SP1's embedded native-runner build.

## Fixed input

| Update | Parent slot | Attested slot | Signature slot | Participants | Attested root |
|---|---:|---:|---:|---:|---|
| 0 | 14,814,117 | 14,814,118 | 14,814,119 | 511/512 | `0xa8515a9f1b374c17757898e96f8b55599fe9f012b154e6cd57ecd9f19dbef6e2` |
| 1 | 14,814,118 | 14,814,119 | 14,814,120 | 511/512 | `0xd77e44210bccb42906f791d6b49e35242b070da5f0719f21859a8e97d28ee2d4` |

Fixture SHA-256: `c097d66a6aa2b2c04787816f94214dc883c6638df444f9a00c3d67b3bf83d9eb`.

## Results

| Measurement | Result | Status |
|---|---:|---|
| Native integration tests: two positive verifications plus mutations | 2.75 s test body; 11.23 s end-to-end including rebuild | Measured 2026-07-21 |
| Base guest compile | Successful | Demonstrated |
| Accumulator guest compile | Successful | Demonstrated |
| Portable SP1 execution attempt, update 0 | Stopped after 8:58.69; peak RSS 5,523,616 KiB; no public values/report | Hardware-limited; no execution claim |
| Native SP1 execution attempt, update 0 | Stopped after about 15 min; at least 5,503,332 KiB RSS observed plus swap; no public values/report | Hardware-limited; no execution claim |
| Update verification-key setup | Stopped after 8:55.72; peak RSS 5,467,168 KiB; no key emitted | Hardware-limited; no vkey claim |
| Base guest instructions, update 0 | Not measured | Do not cite |
| Base guest instructions, update 1 | Not measured | Do not cite |
| Compressed base proof time/size/RSS | Not measured | No proof claim |
| Recursive checkpoint proof time/size/RSS | Not measured | No recursion artifact claim |
| Recursive proof verification time | Not measured | No recursion artifact claim |

[SP1's documented CPU proving requirements](https://docs.succinct.xyz/docs/sp1/getting-started/hardware-requirements) are materially higher, especially for recursion. These aborted runs are evidence of a host limit, not evidence that the zkVM statement executed correctly. The execution, vkey, base-proof, and recursive-proof claims remain unproven until completed on suitable hardware or an authorized proving service.
