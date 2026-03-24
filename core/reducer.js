const { runInvariants } = require("./invariants");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getBalanceSlot(state, accountId, assetKey) {
  if (!state.accounts[accountId]) {
    state.accounts[accountId] = { balances: {} };
  }

  if (!state.accounts[accountId].balances[assetKey]) {
    state.accounts[accountId].balances[assetKey] = {
      available: "0",
      reserved: "0",
      pending_credit: "0",
      pending_debit: "0"
    };
  }

  return state.accounts[accountId].balances[assetKey];
}

function addStrInt(a, b) {
  return (BigInt(a) + BigInt(b)).toString();
}

function subStrInt(a, b) {
  const result = BigInt(a) - BigInt(b);
  if (result < 0n) {
    throw new Error("Negative balance not allowed");
  }
  return result.toString();
}

function applyAction(state, action) {
  const next = clone(state);

  if (action.sequence !== state.sequence + 1) {
    throw new Error("Invalid sequence");
  }

  next.sequence = action.sequence;
  next.last_action_id = action.action_id;

  switch (action.type) {
    case "ACCOUNT_CREDIT": {
      const { account_id, asset_key, amount } = action.payload;
      const slot = getBalanceSlot(next, account_id, asset_key);
      slot.available = addStrInt(slot.available, amount);
      break;
    }

    case "ACCOUNT_DEBIT": {
      const { account_id, asset_key, amount } = action.payload;
      const slot = getBalanceSlot(next, account_id, asset_key);
      slot.available = subStrInt(slot.available, amount);
      break;
    }

    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }

  runInvariants(state, next, action);

  return next;
}

module.exports = {
  applyAction
};
