const { createGenesisState } = require("../core/state");
const { applyAction } = require("../core/reducer");
const { hashState } = require("../core/hash");

function replayActions(actions) {
  let state = createGenesisState();

  for (const action of actions) {
    state = applyAction(state, action);
  }

  return {
    state,
    stateHash: hashState(state)
  };
}

module.exports = {
  replayActions
};
