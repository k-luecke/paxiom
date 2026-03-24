function createActionLog() {
  return [];
}

function appendAction(log, action) {
  return [...log, action];
}

module.exports = {
  createActionLog,
  appendAction
};
