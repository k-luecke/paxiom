const { decodeSlot0 } = require("./uniswap-v3");

function mask(bits) {
  return (1n << BigInt(bits)) - 1n;
}

function hexToBigInt(value) {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error("Expected hex slot0 value");
  }
  return BigInt(value);
}

function createSlot0ZkInput(slot0Value) {
  const packed = hexToBigInt(slot0Value);
  const decoded = decodeSlot0(slot0Value);
  const tickRaw = (packed >> 160n) & mask(24);
  const unlockedByte = (packed >> 240n) & mask(8);

  return {
    packed: packed.toString(),
    sqrtPriceX96: decoded.sqrtPriceX96,
    tickRaw: tickRaw.toString(),
    observationIndex: decoded.observationIndex,
    observationCardinality: decoded.observationCardinality,
    observationCardinalityNext: decoded.observationCardinalityNext,
    feeProtocol: decoded.feeProtocol,
    unlockedByte: unlockedByte.toString()
  };
}

module.exports = {
  createSlot0ZkInput
};
