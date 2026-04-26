function mask(bits) {
  return (1n << BigInt(bits)) - 1n;
}

function toSigned(value, bits) {
  const signBit = 1n << BigInt(bits - 1);
  const full = 1n << BigInt(bits);
  return (value & signBit) === 0n ? value : value - full;
}

function hexToBigInt(value) {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error("Expected hex storage value");
  }
  return BigInt(value);
}

function decodeSlot0(value) {
  const packed = hexToBigInt(value);
  const sqrtPriceX96 = packed & mask(160);
  const tickRaw = (packed >> 160n) & mask(24);
  const observationIndex = (packed >> 184n) & mask(16);
  const observationCardinality = (packed >> 200n) & mask(16);
  const observationCardinalityNext = (packed >> 216n) & mask(16);
  const feeProtocol = (packed >> 232n) & mask(8);
  const unlocked = ((packed >> 240n) & mask(8)) !== 0n;

  return {
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: toSigned(tickRaw, 24).toString(),
    observationIndex: observationIndex.toString(),
    observationCardinality: observationCardinality.toString(),
    observationCardinalityNext: observationCardinalityNext.toString(),
    feeProtocol: feeProtocol.toString(),
    unlocked
  };
}

function estimatePriceFromTick(tick, token0Decimals = 18, token1Decimals = 18) {
  const rawToken1PerToken0 = Math.pow(1.0001, Number(tick));
  return rawToken1PerToken0 * Math.pow(10, token0Decimals - token1Decimals);
}

module.exports = {
  decodeSlot0,
  estimatePriceFromTick
};
