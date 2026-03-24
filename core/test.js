const { createGenesisState } = require("./state");
const { hashState } = require("./hash");

const state1 = createGenesisState();
const state2 = createGenesisState();

const hash1 = hashState(state1);
const hash2 = hashState(state2);

console.log("Hash 1:", hash1);
console.log("Hash 2:", hash2);
console.log("Equal:", hash1 === hash2);
