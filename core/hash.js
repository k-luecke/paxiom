const crypto = require("crypto");

function sortObject(obj) {
  if (Array.isArray(obj)) {
    return obj.map(sortObject);
  }

  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObject(obj[key]);
        return acc;
      }, {});
  }

  return obj;
}

function canonicalStringify(obj) {
  return JSON.stringify(sortObject(obj));
}

function hashState(state) {
  const str = canonicalStringify(state);
  return crypto.createHash("sha256").update(str).digest("hex");
}

module.exports = {
  hashState,
  canonicalStringify
};
