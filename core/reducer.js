const { runInvariants } = require("./invariants");

// FIX: clone is safe for the current string/number/null state shape.
// If richer types (bigint, Buffer, Date) ever enter state, replace with
// a proper structured-clone or immutable update pattern.
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

// FIX: validate action schema before applying to catch malformed inputs early
function validateAction(action) {
  if (!action || typeof action !== 'object') {
    throw new Error("Action must be an object");
  }
  if (typeof action.sequence !== 'number') {
    throw new Error("Action missing numeric sequence");
  }
  if (!action.action_id || typeof action.action_id !== 'string') {
    throw new Error("Action missing string action_id");
  }
  if (!action.type || typeof action.type !== 'string') {
    throw new Error("Action missing string type");
  }
  if (!action.payload || typeof action.payload !== 'object') {
    throw new Error("Action missing payload object");
  }

  switch (action.type) {
    case "ACCOUNT_CREDIT":
    case "ACCOUNT_DEBIT": {
      const { account_id, asset_key, amount } = action.payload;
      if (!account_id || typeof account_id !== 'string') {
        throw new Error(`${action.type} missing string account_id`);
      }
      if (!asset_key || typeof asset_key !== 'string') {
        throw new Error(`${action.type} missing string asset_key`);
      }
      if (amount === undefined || amount === null) {
        throw new Error(`${action.type} missing amount`);
      }
      // Amount must be a non-negative integer string
      const amountBig = BigInt(amount);
      if (amountBig <= 0n) {
        throw new Error(`${action.type} amount must be > 0, got ${amount}`);
      }
      break;
    }
    // Add validation for new action types here as they are introduced
  }
}

function applyAction(state, action) {
  // FIX: validate schema first
  validateAction(action);

  // FIX: duplicate action_id prevention
  if (state.seen_action_ids && state.seen_action_ids[action.action_id]) {
    throw new Error(`Duplicate action_id: ${action.action_id}`);
  }

  const next = clone(state);

  if (action.sequence !== state.sequence + 1) {
    throw new Error("Invalid sequence");
  }

  next.sequence = action.sequence;
  next.last_action_id = action.action_id;

  // FIX: track seen action IDs to prevent replay
  if (!next.seen_action_ids) next.seen_action_ids = {};
  next.seen_action_ids[action.action_id] = true;

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
