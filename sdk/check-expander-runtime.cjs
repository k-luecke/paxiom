const { existsSync, writeFileSync } = require("fs");
const { join, resolve } = require("path");
const { spawnSync } = require("child_process");

const repoRoot = resolve(__dirname, "..");
const expanderRoot = join(repoRoot, ".paxiom-runtime", "upstream", "Expander");

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function checkExpanderRuntime() {
  const cargo = commandExists("cargo");
  const mpiexec = commandExists("mpiexec") || commandExists("mpirun");
  const expanderPresent = existsSync(expanderRoot);
  const status = {
    schema: "paxiom.expander_runtime_check.v1",
    generated_at: new Date().toISOString(),
    expander_root: expanderRoot,
    expander_present: expanderPresent,
    cargo,
    mpiexec,
    can_build_expander_exec: Boolean(expanderPresent && cargo && mpiexec),
    notes: []
  };

  if (!expanderPresent) {
    status.notes.push("Clone https://github.com/PolyhedraZK/Expander into .paxiom-runtime/upstream/Expander.");
  }
  if (!cargo) {
    status.notes.push("Rust cargo is required for Expander.");
  }
  if (!mpiexec) {
    status.notes.push("MPICH or OpenMPI is required; local build currently fails in mpi-sys without it.");
  }
  if (expanderPresent) {
    status.notes.push("Public Expander repository is AGPL-3.0; integrate as an explicit external worker unless license strategy changes.");
  }

  return status;
}

if (require.main === module) {
  const status = checkExpanderRuntime();
  const out = join(repoRoot, ".paxiom-runtime", "expander-runtime-check.json");
  writeFileSync(out, `${JSON.stringify(status, null, 2)}\n`);
  console.log(JSON.stringify({ status: "ok", out, ...status }, null, 2));
  process.exit(status.can_build_expander_exec ? 0 : 1);
}

module.exports = {
  checkExpanderRuntime
};
