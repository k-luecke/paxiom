const { createGenesisState } = require("./state");
const { hashState } = require("./hash");
const { applyAction } = require("./reducer");

const genesis = createGenesisState();

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

console.log("State 2 hash:", hashState(state2));
console.log(
  "Final balance:",
  state2.accounts["acct_1"].balances["ethereum:usdc"].available
);

// 🔥 failure test
const badDebit = {
  action_id: "a3",
  sequence: 3,
  type: "ACCOUNT_DEBIT",
  payload: {
    account_id: "acct_1",
    asset_key: "ethereum:usdc",
    amount: "999999"
  }
};

try {
  applyAction(state2, badDebit);
} catch (err) {
  console.log("Expected failure:", err.message);
}
