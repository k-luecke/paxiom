# C95-AO-00 coordination benchmark

## Gate

Do not attach a live puzzle kernel until the synthetic run demonstrates:

1. exact interval coverage of [0,N)
2. zero accepted duplicate shard completions
3. digest mismatch rejection
4. plaintext-secret rejection
5. known-answer commitment recovered
6. aggregate tested count equals N
7. worker loss can be recovered by lease expiry/requeue

## Scaling series

Run the same frozen synthetic family at worker counts:

1, 2, 4, 8, 16, 32, 64

Record wall seconds, total worker seconds, candidates tested, duplicate attempts,
failed leases, coordination messages, and effective candidates/sec.

The practical success metric is wall-clock reduction at negligible monetary
cost. Aggregate-work improvement is a separate research metric.

## Next implementation gate

The current coordinator has leasing but not lease expiry. Add deterministic
expiry/requeue before a network benchmark. Then package the Rust worker for
wasm32-unknown-unknown and connect the AO worker process to the coordinator.
