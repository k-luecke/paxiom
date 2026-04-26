const { bytesToHex, hexToBytes, utf8ToBytes } = require("ethereum-cryptography/utils");
const { normalizeHex } = require("./eth-proof");

const KECCAK_RATE_BYTES = 136;
const MASK_64 = (1n << 64n) - 1n;

const ROUND_CONSTANTS = Object.freeze([
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
]);

const ROTATION_OFFSETS = Object.freeze([
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function bytesFromHex(value) {
  const hex = normalizeHex(value);
  if (hex === "0x") return new Uint8Array();
  return hexToBytes(hex.length % 2 === 0 ? hex : `0x0${hex.slice(2)}`);
}

function bytesFromInput(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === "string") {
    return input.startsWith("0x") ? bytesFromHex(input) : utf8ToBytes(input);
  }
  if (Array.isArray(input)) return Uint8Array.from(input);
  throw new Error("Unsupported Keccak input");
}

function rotateLeft64(value, shift) {
  const n = BigInt(shift % 64);
  const lane = value & MASK_64;
  if (n === 0n) return lane;
  return ((lane << n) | (lane >> (64n - n))) & MASK_64;
}

function cloneState(state) {
  return state.map(value => BigInt(value));
}

function laneToHex(lane) {
  return `0x${(lane & MASK_64).toString(16).padStart(16, "0")}`;
}

function stateToHex(state) {
  return state.map(laneToHex);
}

function bytesToLane(bytes, offset) {
  let lane = 0n;
  for (let i = 0; i < 8; i += 1) {
    lane |= BigInt(bytes[offset + i] || 0) << BigInt(8 * i);
  }
  return lane;
}

function laneToBytes(lane, out, offset) {
  for (let i = 0; i < 8; i += 1) {
    out[offset + i] = Number((lane >> BigInt(8 * i)) & 0xffn);
  }
}

function keccakF1600(inputState) {
  const state = cloneState(inputState);

  for (let round = 0; round < 24; round += 1) {
    const c = new Array(5).fill(0n);
    const d = new Array(5).fill(0n);
    const b = new Array(25).fill(0n);

    for (let x = 0; x < 5; x += 1) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5] ^ rotateLeft64(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (state[x + 5 * y] ^ d[x]) & MASK_64;
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const source = x + 5 * y;
        const destX = y;
        const destY = (2 * x + 3 * y) % 5;
        b[destX + 5 * destY] = rotateLeft64(state[source], ROTATION_OFFSETS[source]);
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] =
          (b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y] & MASK_64) & b[((x + 2) % 5) + 5 * y])) & MASK_64;
      }
    }

    state[0] = (state[0] ^ ROUND_CONSTANTS[round]) & MASK_64;
  }

  return state;
}

function keccakPad(message) {
  const paddedLength = Math.ceil((message.length + 1) / KECCAK_RATE_BYTES) * KECCAK_RATE_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  return padded;
}

function traceKeccak256(input) {
  const message = bytesFromInput(input);
  const padded = keccakPad(message);
  let state = new Array(25).fill(0n);
  const permutations = [];

  for (let offset = 0; offset < padded.length; offset += KECCAK_RATE_BYTES) {
    for (let lane = 0; lane < KECCAK_RATE_BYTES / 8; lane += 1) {
      state[lane] = (state[lane] ^ bytesToLane(padded, offset + lane * 8)) & MASK_64;
    }

    const inputState = cloneState(state);
    state = keccakF1600(state);
    permutations.push({
      index: permutations.length,
      input_state: stateToHex(inputState),
      output_state: stateToHex(state)
    });
  }

  const out = new Uint8Array(KECCAK_RATE_BYTES);
  for (let lane = 0; lane < KECCAK_RATE_BYTES / 8; lane += 1) {
    laneToBytes(state[lane], out, lane * 8);
  }

  return {
    message_hex: `0x${bytesToHex(message)}`,
    message_byte_length: message.length,
    padded_byte_length: padded.length,
    digest: `0x${bytesToHex(out.slice(0, 32))}`,
    permutations
  };
}

function assertKeccakDigest(input, expected) {
  const got = traceKeccak256(input).digest;
  assert(got === normalizeHex(expected), `Keccak digest mismatch: expected ${expected}, got ${got}`);
  return got;
}

module.exports = {
  KECCAK_RATE_BYTES,
  assertKeccakDigest,
  bytesFromHex,
  keccakF1600,
  keccakPad,
  traceKeccak256
};
