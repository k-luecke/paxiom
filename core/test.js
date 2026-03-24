const { createGenesisState } = require("./state");
const { hashState } = require("./hash");
const { applyAction } = require("./reducer");

const genesis = createGenesisState();
const genesisHash = hashState(genesis);

const creditAction = {
  action_id: "a1",
  sequence: 1,
  type: "ACCOUNT_CREDIT",
  payload: {
    account_id: "acct_1",
    asset_key: "ethereum:usdc",
    amount: "1000"
  }
};

const debitAction = {
  action_id: "a2",
  sequence: 2,
  type: "ACCOUNT_DEBIT",
  payload: {
    account_id: "acct_1",
    asset_key: "ethereum:usdc",
    amount: "250"
  }
};

const state1 = applyAction(genesis, creditAction);
const state2 = applyAction(state1, debitAction);

console.log("Genesis hash:", genesisHash);
console.log("State 1 hash:", hashState(state1));
console.log("State 2 hash:", hashState(state2));
console.log("Final balance:", state2.accounts["acct_1"].balances["ethereum:usdc"].available);
