function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function checkNoNegativeBalances(state) {
  for (const account of Object.values(state.accounts)) {
    for (const balance of Object.values(account.balances)) {
      assert(BigInt(balance.available) >= 0n, "Negative available balance");
      assert(BigInt(balance.reserved) >= 0n, "Negative reserved balance");
    }
  }
}

function checkSequence(prevState, nextState, action) {
  assert(
    nextState.sequence === prevState.sequence + 1,
    "Invalid sequence increment"
  );

  assert(
    nextState.last_action_id === action.action_id,
    "Action ID mismatch"
  );
}

function runInvariants(prevState, nextState, action) {
  checkSequence(prevState, nextState, action);
  checkNoNegativeBalances(nextState);
}

module.exports = {
  runInvariants
};
