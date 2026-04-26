const PREDICATES = [
  {
    id: "storage_equals",
    status: "live",
    verification_level: "mpt_verified",
    proof_system: "eip1186-mpt",
    summary: "Proves that a contract storage slot had a specific value under an Ethereum state root.",
    use_cases: [
      "verify protocol accounting inputs",
      "audit alerts and model decisions",
      "build custom contract-specific feeds"
    ],
    inputs: ["contract address", "storage slot", "block tag or block number"],
    outputs: ["slot value", "block number", "state root", "proof hash", "Paxiom commitment"]
  },
  {
    id: "uniswap_v3_slot0",
    status: "live",
    verification_level: "mpt_verified",
    proof_system: "eip1186-mpt+uniswap-v3-slot0",
    summary: "Proves and decodes a Uniswap V3 pool's slot0 price/tick state.",
    use_cases: [
      "gate trading signals on verified pool state",
      "monitor price divergence",
      "archive proof-backed tick observations"
    ],
    inputs: ["pool address", "token decimals", "block tag or block number"],
    outputs: ["sqrtPriceX96", "tick", "observation fields", "fee protocol", "lock status", "Paxiom commitment"]
  },
  {
    id: "oracle_round_data",
    status: "planned",
    verification_level: "mpt_verified",
    proof_system: "eip1186-mpt+oracle-decoder",
    summary: "Proves oracle round values and timestamps for price-risk checks.",
    use_cases: [
      "detect oracle/pool divergence",
      "gate liquidations on verified oracle inputs",
      "archive price-source evidence"
    ],
    inputs: ["oracle address", "round id or latest round", "block tag or block number"],
    outputs: ["answer", "updatedAt", "roundId", "state root", "Paxiom commitment"]
  },
  {
    id: "aave_health_inputs",
    status: "planned",
    verification_level: "mpt_verified",
    proof_system: "eip1186-mpt+aave-decoder",
    summary: "Proves the state inputs needed to independently compute borrower health.",
    use_cases: [
      "liquidation monitoring",
      "risk dashboards",
      "post-trade liquidation audit trails"
    ],
    inputs: ["market", "user address", "reserve list", "block tag or block number"],
    outputs: ["collateral inputs", "debt inputs", "oracle references", "state root", "Paxiom commitment"]
  },
  {
    id: "event_inclusion",
    status: "planned",
    verification_level: "mpt_verified",
    proof_system: "receipt-trie+log-decoder",
    summary: "Proves that a contract emitted a specific log in a canonical receipt trie.",
    use_cases: [
      "bridge and settlement checks",
      "reward and entitlement validation",
      "auditable event-triggered automation"
    ],
    inputs: ["transaction hash", "log index", "receipt proof", "block header"],
    outputs: ["event fields", "receipt root", "block hash", "Paxiom commitment"]
  }
];

function listPredicates({ includePlanned = true } = {}) {
  return includePlanned ? PREDICATES.slice() : PREDICATES.filter(predicate => predicate.status === "live");
}

function getPredicate(id) {
  return PREDICATES.find(predicate => predicate.id === id) || null;
}

module.exports = {
  PREDICATES,
  getPredicate,
  listPredicates
};
