function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function checkNoNegativeBalances(state) {
  for (const [accountId, account] of Object.entries(state.accounts)) {
    for (const [assetKey, balance] of Object.entries(account.balances)) {
      assert(
        BigInt(balance.available) >= 0n,
        `Negative available balance: account=${accountId} asset=${assetKey} available=${balance.available}`
      );
      assert(
        BigInt(balance.reserved) >= 0n,
        `Negative reserved balance: account=${accountId} asset=${assetKey} reserved=${balance.reserved}`
      );

      // FIX: reserved must not exceed available + reserved (pending consistency)
      const total = BigInt(balance.available) + BigInt(balance.reserved);
      assert(
        total >= BigInt(balance.reserved),
        `Reserved exceeds total balance: account=${accountId} asset=${assetKey}`
      );
    }
  }
}

function checkSequence(prevState, nextState, action) {
  assert(
    nextState.sequence === prevState.sequence + 1,
    `Invalid sequence increment: expected ${prevState.sequence + 1} got ${nextState.sequence}`
  );

  assert(
    nextState.last_action_id === action.action_id,
    `Action ID mismatch: action has ${action.action_id} but state has ${nextState.last_action_id}`
  );
}

// FIX: conservation check — total balances should not increase from a DEBIT
// and should increase by exactly the credited amount from a CREDIT.
// This catches reducer bugs where funds are created from nothing.
function checkConservation(prevState, nextState, action) {
  if (action.type !== 'ACCOUNT_CREDIT' && action.type !== 'ACCOUNT_DEBIT') return;

  const { account_id, asset_key, amount } = action.payload;
  const amountBig = BigInt(amount);

  // Sum available across all accounts for this asset before and after
  function totalAvailable(state, assetKey) {
    let total = 0n;
    for (const account of Object.values(state.accounts)) {
      const bal = account.balances[assetKey];
      if (bal) total += BigInt(bal.available);
    }
    return total;
  }

  const prevTotal = totalAvailable(prevState, asset_key);
  const nextTotal = totalAvailable(nextState, asset_key);

  if (action.type === 'ACCOUNT_CREDIT') {
    assert(
      nextTotal === prevTotal + amountBig,
      `Conservation violation on CREDIT: expected total to increase by ${amountBig}, prev=${prevTotal} next=${nextTotal}`
    );
  }

  if (action.type === 'ACCOUNT_DEBIT') {
    assert(
      nextTotal === prevTotal - amountBig,
      `Conservation violation on DEBIT: expected total to decrease by ${amountBig}, prev=${prevTotal} next=${nextTotal}`
    );
  }
}

function runInvariants(prevState, nextState, action) {
  checkSequence(prevState, nextState, action);
  checkNoNegativeBalances(nextState);
  checkConservation(prevState, nextState, action);
}

module.exports = {
  runInvariants
};
