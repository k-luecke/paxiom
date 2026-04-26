const { execFileSync } = require("child_process");
const { existsSync, mkdirSync, rmSync } = require("fs");
const { join, resolve } = require("path");

const repoRoot = resolve(__dirname, "..");
const circuit = join(repoRoot, "zk", "circuits", "uniswap_v3_slot0.circom");
const outDir = join(repoRoot, ".paxiom-runtime", "zk", "uniswap_v3_slot0");
const snarkjs = join(repoRoot, "node_modules", ".bin", "snarkjs");
const circom = join(repoRoot, "node_modules", ".bin", "circom");

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
}

mkdirSync(outDir, { recursive: true });

const r1cs = join(outDir, "uniswap_v3_slot0.r1cs");
const wasm = join(outDir, "uniswap_v3_slot0.wasm");
const sym = join(outDir, "uniswap_v3_slot0.sym");
const ptau0 = join(outDir, "pot10_0000.ptau");
const ptau1 = join(outDir, "pot10_0001.ptau");
const ptauFinal = join(outDir, "pot10_final.ptau");
const zkey0 = join(outDir, "uniswap_v3_slot0_0000.zkey");
const zkeyFinal = join(outDir, "uniswap_v3_slot0_final.zkey");
const vkey = join(outDir, "verification_key.json");

for (const file of [r1cs, wasm, sym, ptau0, ptau1, ptauFinal, zkey0, zkeyFinal, vkey]) {
  if (existsSync(file)) rmSync(file, { force: true });
}

run(circom, [circuit, "-r", r1cs, "-w", wasm, "-s", sym]);
run(snarkjs, ["powersoftau", "new", "bn128", "10", ptau0, "-v"]);
run(snarkjs, ["powersoftau", "contribute", ptau0, ptau1, "--name=Paxiom dev contribution", "-v", "-e=paxiom-slot0"]);
run(snarkjs, ["powersoftau", "prepare", "phase2", ptau1, ptauFinal, "-v"]);
run(snarkjs, ["groth16", "setup", r1cs, ptauFinal, zkey0]);
run(snarkjs, ["zkey", "contribute", zkey0, zkeyFinal, "--name=Paxiom slot0 zkey", "-v", "-e=paxiom-slot0-zkey"]);
run(snarkjs, ["zkey", "export", "verificationkey", zkeyFinal, vkey]);
run(snarkjs, ["r1cs", "info", r1cs]);

console.log(JSON.stringify({
  status: "ok",
  proof_system: "groth16-bn128-uniswap-v3-slot0-dev",
  artifacts: {
    r1cs,
    wasm,
    zkey: zkeyFinal,
    verification_key: vkey
  }
}, null, 2));
