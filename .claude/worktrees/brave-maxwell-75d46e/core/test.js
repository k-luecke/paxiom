const { createActionLog, appendAction } = require("../log/action-log");
const { replayActions } = require("../log/replay");

let log = createActionLog();

log = appendAction(log, {
  action_id: "a1",
  sequence: 1,
  type: "ACCOUNT_CREDIT",
  payload: {
    account_id: "acct_1",
    asset_key: "ethereum:usdc",
    amount: "1000"
  }
});

log = appendAction(log, {
  action_id: "a2",
  sequence: 2,
  type: "ACCOUNT_DEBIT",
  payload: {
    account_id: "acct_1",
    asset_key: "ethereum:usdc",
    amount: "250"
  }
});

const result1 = replayActions(log);
const result2 = replayActions(log);

console.log("Replay hash 1:", result1.stateHash);
console.log("Replay hash 2:", result2.stateHash);
console.log("Hashes equal:", result1.stateHash === result2.stateHash);
console.log(
  "Final balance:",
  result1.state.accounts["acct_1"].balances["ethereum:usdc"].available
);
