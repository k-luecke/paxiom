Introduce deterministic state machine scaffold and transition spec

## Summary
This PR introduces the first scaffold for Paxiom's deterministic core ledger architecture.

## Included
- /core state machine scaffold
- /engine execution wrapper scaffold
- /log action log + replay scaffold
- /signer policy scaffold
- /commit AO commit scaffold
- /spec state transition spec

## Purpose
This branch formalizes the replayable, hashable, and eventually provable state transition model for Paxiom's above-chain liquidity and settlement layer.
