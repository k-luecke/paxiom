local json = require("json")

Coordinator = Coordinator or nil
WorkerConfig = WorkerConfig or {
  family_digest = nil,
  kernel_digest = nil
}

local function send(target, action, data)
  ao.send({Target=target,Action=action,Data=json.encode(data)})
end

Handlers.add("lab-c-worker-configure",
  function(msg) return msg.Action == "ConfigureWorker" end,
  function(msg)
    local d=json.decode(msg.Data or "{}")
    Coordinator=d.coordinator
    WorkerConfig.family_digest=d.family_digest
    WorkerConfig.kernel_digest=d.kernel_digest
    send(msg.From,"WorkerConfigured",{ok=true})
  end)

Handlers.add("lab-c-worker-start",
  function(msg) return msg.Action == "StartWorker" end,
  function(msg)
    local d=json.decode(msg.Data or "{}")
    if not Coordinator then
      send(msg.From,"WorkerError",{error="worker not configured"}); return
    end
    send(Coordinator,"LeaseShard",{run_id=d.run_id})
  end)

-- Transport glue only. The Rust/WASM adapter should replace this handler's
-- synthetic execution path and return exactly the same result envelope.
Handlers.add("lab-c-worker-lease",
  function(msg) return msg.Action == "ShardLease" end,
  function(msg)
    local d=json.decode(msg.Data or "{}")
    if d.family_digest ~= WorkerConfig.family_digest or
       d.kernel_digest ~= WorkerConfig.kernel_digest then
      send(Coordinator,"WorkerReject",{run_id=d.run_id,shard_id=d.shard_id,error="digest mismatch"})
      return
    end
    send(msg.From,"ExecuteWasmShard",d)
  end)

Handlers.add("lab-c-worker-wasm-result",
  function(msg) return msg.Action == "WasmShardResult" end,
  function(msg)
    local d=json.decode(msg.Data or "{}")
    -- Secret material is never forwarded.
    if d.secret or d.private_key or d.seed or d.mnemonic then
      send(msg.From,"WorkerError",{error="plaintext secret rejected"}); return
    end
    send(Coordinator,"SubmitShard",d)
  end)
