const { existsSync } = require("fs");
const { join, resolve } = require("path");

const repoRoot = resolve(__dirname, "..");

function backendFromEnv(env = process.env) {
  const kind = env.PAXIOM_ZK_PROVER_BACKEND || "snarkjs";
  if (kind === "snarkjs") {
    return {
      kind,
      command: join(repoRoot, "node_modules", ".bin", "snarkjs"),
      mode: "local-wasm"
    };
  }
  if (kind === "rapidsnark") {
    const command = env.PAXIOM_RAPIDSNARK_BIN || "rapidsnark";
    return {
      kind,
      command,
      mode: "accelerated-native"
    };
  }
  if (kind === "external") {
    if (!env.PAXIOM_ZK_PROVER_CMD) throw new Error("PAXIOM_ZK_PROVER_CMD is required for external backend");
    return {
      kind,
      command: env.PAXIOM_ZK_PROVER_CMD,
      mode: "external"
    };
  }
  throw new Error(`Unsupported prover backend: ${kind}`);
}

function assertBackendAvailable(backend) {
  if (backend.kind === "snarkjs" && !existsSync(backend.command)) {
    throw new Error("snarkjs backend not installed. Run npm install.");
  }
  return backend;
}

module.exports = {
  assertBackendAvailable,
  backendFromEnv
};
