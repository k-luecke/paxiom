function createGenesisState() {
  return {
    version: 1,
    sequence: 0,
    last_action_id: null,
    accounts: {},
    pools: {},
    positions: {},
    obligations: {},
    risk: {
      global: {
        total_exposure: "0",
        total_reserved: "0",
        total_in_flight: "0"
      }
    },
    commitments: {
      latest_state_hash: null,
      latest_batch_hash: null,
      latest_commitment_id: null
    },
    metadata: {}
  };
}

module.exports = {
  createGenesisState
};
