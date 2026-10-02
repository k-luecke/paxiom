local json = require("json")

Coordinator = Coordinator or nil
WorkerConfig = WorkerConfig or {
  family_digest = nil,
  kernel_digest = nil,
  known_index = nil,
  wasm_path = nil,
  execution_mode = "direct" -- "direct" via runner script or "async" via ExecuteWasmShard message seam
}

local function send(target, action, data)
  ao.send({ Target = target, Action = action, Data = json.encode(data) })
end

local function execute_wasm_kernel(shard)
  local runner_bin = os.getenv("WASM_RUNNER_BIN") or "node"
  local runner_script = os.getenv("WASM_RUNNER_SCRIPT") or "lab-c-ao/wasm_runner.mjs"
  local wasm_path = WorkerConfig.wasm_path or os.getenv("WASM_PATH") or "lab-c-ao/lab_c_ao_worker.wasm"
  local known_index = tonumber(WorkerConfig.known_index or os.getenv("KNOWN_INDEX") or -1)

  local cmd = string.format("%s %s %d %d %d %q %q",
    runner_bin, runner_script,
    shard.start_index, shard.end_index, known_index,
    shard.run_id, wasm_path
  )

  local proc = io.popen(cmd, "r")
  if not proc then
    return nil, "failed to spawn wasm runner"
  end
  local stdout = proc:read("*a")
  local ok, _, exit_code = proc:close()
  if not ok then
    return nil, string.format("wasm runner exited with error (code %s): %s", tostring(exit_code), stdout)
  end

  local parsed_ok, res = pcall(json.decode, stdout)
  if not parsed_ok or type(res) ~= "table" then
    return nil, "invalid json from wasm runner"
  end

  return res
end

Handlers.add("lab-c-worker-configure",
  function(msg) return msg.Action == "ConfigureWorker" end,
  function(msg)
    local d = json.decode(msg.Data or "{}")
    Coordinator = d.coordinator
    WorkerConfig.family_digest = d.family_digest
    WorkerConfig.kernel_digest = d.kernel_digest
    WorkerConfig.known_index = d.known_index
    WorkerConfig.wasm_path = d.wasm_path
    if d.execution_mode then
      WorkerConfig.execution_mode = d.execution_mode
    end
    send(msg.From, "WorkerConfigured", { ok = true })
  end)

Handlers.add("lab-c-worker-start",
  function(msg) return msg.Action == "StartWorker" end,
  function(msg)
    local d = json.decode(msg.Data or "{}")
    if not Coordinator then
      send(msg.From, "WorkerError", { error = "worker not configured" })
      return
    end
    send(Coordinator, "LeaseShard", { run_id = d.run_id })
  end)

Handlers.add("lab-c-worker-lease",
  function(msg) return msg.Action == "ShardLease" end,
  function(msg)
    local d = json.decode(msg.Data or "{}")
    if d.family_digest ~= WorkerConfig.family_digest or
       d.kernel_digest ~= WorkerConfig.kernel_digest then
      send(Coordinator, "WorkerReject", {
        run_id = d.run_id,
        shard_id = d.shard_id,
        error = "digest mismatch"
      })
      return
    end

    if WorkerConfig.execution_mode == "direct" then
      local res, err = execute_wasm_kernel(d)
      if not res then
        send(msg.From, "WorkerError", { error = err, shard_id = d.shard_id })
        return
      end

      -- Quarantine verification: reject any plaintext secret fields
      if res.secret or res.private_key or res.seed or res.mnemonic then
        send(msg.From, "WorkerError", { error = "plaintext secret rejected" })
        return
      end

      local envelope = {
        run_id = d.run_id,
        shard_id = d.shard_id,
        lease_token = d.lease_token,
        family_digest = d.family_digest,
        kernel_digest = d.kernel_digest,
        tested = res.tested,
        result_digest = res.result_digest,
        hit_commitment = res.hit_commitment
      }
      send(Coordinator, "SubmitShard", envelope)
    else
      -- Asynchronous message seam to WASM execution host / sidecar
      send(msg.From, "ExecuteWasmShard", d)
    end
  end)

Handlers.add("lab-c-worker-wasm-result",
  function(msg) return msg.Action == "WasmShardResult" end,
  function(msg)
    local d = json.decode(msg.Data or "{}")
    -- Secret material is never forwarded
    if d.secret or d.private_key or d.seed or d.mnemonic then
      send(msg.From, "WorkerError", { error = "plaintext secret rejected" })
      return
    end
    send(Coordinator, "SubmitShard", {
      run_id = d.run_id,
      shard_id = d.shard_id,
      lease_token = d.lease_token,
      family_digest = d.family_digest,
      kernel_digest = d.kernel_digest,
      tested = d.tested,
      result_digest = d.result_digest,
      hit_commitment = d.hit_commitment
    })
  end)
