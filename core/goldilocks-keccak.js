const { keccak256 } = require("ethereum-cryptography/keccak");
const { bytesToHex, hexToBytes, utf8ToBytes } = require("ethereum-cryptography/utils");

const GOLDILOCKS_PRIME = (1n << 64n) - (1n << 32n) + 1n;

const ETHEREUM_KECCAK_VECTORS = Object.freeze([
  {
    input: "",
    hash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
  },
  {
    input: "transfer(address,uint256)",
    hash: "0xa9059cbb2ab09eb219583f4a59a5d0623ade346d962bcd4e46b11da047c9049b"
  },
  {
    input: "balanceOf(address)",
    hash: "0x70a08231b98ef4ca268c9cc3f6b4590e4bfec28280db06bb5d45e689f2a360be"
  }
]);

function normalizeHex(value) {
  if (typeof value !== "string") throw new Error("Expected hex string");
  if (value === "0x") return "0x";
  const body = value.startsWith("0x") ? value.slice(2) : value;
  return `0x${body.toLowerCase()}`;
}

function bytesFromHex(value) {
  const hex = normalizeHex(value);
  if (hex === "0x") return new Uint8Array();
  return hexToBytes(hex.length % 2 === 0 ? hex : `0x0${hex.slice(2)}`);
}

function keccak256Hex(input) {
  const bytes = typeof input === "string" ? utf8ToBytes(input) : input;
  return `0x${bytesToHex(keccak256(bytes))}`;
}

function keccakProofNodeHash(nodeHex) {
  return keccak256Hex(bytesFromHex(nodeHex));
}

function goldilocksLimbsFromBytes(bytes) {
  const limbs = [];
  for (let offset = 0; offset < bytes.length; offset += 8) {
    let limb = 0n;
    const width = Math.min(8, bytes.length - offset);
    for (let i = 0; i < width; i += 1) {
      limb += BigInt(bytes[offset + i]) << BigInt(8 * i);
    }
    limbs.push({
      raw: limb.toString(),
      field: (limb % GOLDILOCKS_PRIME).toString(),
      wraps: limb >= GOLDILOCKS_PRIME
    });
  }
  return limbs;
}

function keccakDigestGoldilocksLimbs(hexDigest) {
  return goldilocksLimbsFromBytes(bytesFromHex(hexDigest));
}

function keccakF1600CostModel() {
  const rounds = 24;
  const bitsPerLane = 64;
  const lanes = 25;

  const xorLanesPerRound = 20 + 5 + 25 + 25 + 1;
  const andLanesPerRound = 25;
  const notLanesPerRound = 25;
  const rotationsPerRound = 5 + lanes;

  return {
    model: "bit-operation transcript for Keccak-f[1600]",
    rounds,
    lanes,
    bitsPerLane,
    laneXors: xorLanesPerRound * rounds,
    laneAnds: andLanesPerRound * rounds,
    laneNots: notLanesPerRound * rounds,
    rotations: rotationsPerRound * rounds,
    bitXors: xorLanesPerRound * rounds * bitsPerLane,
    bitAnds: andLanesPerRound * rounds * bitsPerLane,
    bitNots: notLanesPerRound * rounds * bitsPerLane,
    note: "Rotations are wire permutations in a bit-sliced circuit, but bitwise XOR/AND still dominate constraint cost."
  };
}

function validateEthereumKeccakVectors(keccakImpl = keccak256Hex) {
  return ETHEREUM_KECCAK_VECTORS.map(vector => {
    const got = keccakImpl(vector.input);
    return {
      input: vector.input,
      expected: vector.hash,
      got,
      ok: got === vector.hash,
      selector: got.slice(0, 10),
      goldilocks_limbs: keccakDigestGoldilocksLimbs(got)
    };
  });
}

module.exports = {
  ETHEREUM_KECCAK_VECTORS,
  GOLDILOCKS_PRIME,
  bytesFromHex,
  goldilocksLimbsFromBytes,
  keccak256Hex,
  keccakDigestGoldilocksLimbs,
  keccakF1600CostModel,
  keccakProofNodeHash,
  validateEthereumKeccakVectors
};
