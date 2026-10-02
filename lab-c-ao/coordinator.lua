local json = require("json")

Runs = Runs or {}

local function send(to, action, data)
  ao.send({ Target = to, Action = action, Data = json.encode(data) })
end

local function fail(msg, err)
  send(msg.From, "LabCError", { error = err })
end

local function next_shard(run)
  for i = 1, #run.shards do
    local s = run.shards[i]
    if s.status == "ready" then return s end
  end
  return nil
end

local function summarize(run)
  local done, leased, ready, tested = 0, 0, 0, 0
  for _, s in ipairs(run.shards) do
    if s.status == "done" then
      done = done + 1
      tested = tested + (s.end_index - s.start_index)
    elseif s.status == "leased" then leased = leased + 1
    else ready = ready + 1 end
  end
  return {
    run_id = run.run_id,
    target_id = run.target_id,
    candidate_count = run.candidate_count,
    shard_count = #run.shards,
    done = done, leased = leased, ready = ready,
    tested = tested,
    complete = done == #run.shards,
    hit_count = #run.hits
  }
end

Handlers.add("lab-c-create-run",
  function(msg) return msg.Action == "CreateRun" end,
  function(msg)
    local d = json.decode(msg.Data or "{}")
    if type(d.run_id) ~= "string" or d.run_id == "" then return fail(msg, "missing run_id") end
    if Runs[d.run_id] then return fail(msg, "run_id already exists") end
    local n = tonumber(d.candidate_count)
    local z = tonumber(d.shard_size)
    if not n or n < 1 or n % 1 ~= 0 then return fail(msg, "invalid candidate_count") end
    if not z or z < 1 or z % 1 ~= 0 then return fail(msg, "invalid shard_size") end
    if type(d.family_digest) ~= "string" or type(d.kernel_digest) ~= "string" then
      return fail(msg, "digests required")
    end

    local run = {
      run_id=d.run_id, target_id=d.target_id,
      family_digest=d.family_digest, kernel_digest=d.kernel_digest,
      candidate_count=n, shard_size=z, shards={}, hits={}
    }
    local i, sid = 0, 0
    while i < n do
      local e = math.min(i + z, n)
      sid = sid + 1
      table.insert(run.shards, {
        shard_id=sid, start_index=i, end_index=e, status="ready"
      })
      i = e
    end
    Runs[d.run_id] = run
    send(msg.From, "RunCreated", summarize(run))
  end)

Handlers.add("lab-c-lease-shard",
  function(msg) return msg.Action == "LeaseShard" end,
  function(msg)
    local d = json.decode(msg.Data or "{}")
    local run = Runs[d.run_id]
    if not run then return fail(msg, "unknown run") end
    local s = next_shard(run)
    if not s then
      send(msg.From, "NoShard", summarize(run)); return
    end
    s.status = "leased"
    s.worker = msg.From
    send(msg.From, "ShardLease", {
      run_id=run.run_id, target_id=run.target_id,
      family_digest=run.family_digest, kernel_digest=run.kernel_digest,
      shard_id=s.shard_id, start_index=s.start_index, end_index=s.end_index
    })
  end)

Handlers.add("lab-c-submit-shard",
  function(msg) return msg.Action == "SubmitShard" end,
  function(msg)
    local d = json.decode(msg.Data or "{}")
    local run = Runs[d.run_id]
    if not run then return fail(msg, "unknown run") end
    local s = run.shards[tonumber(d.shard_id) or 0]
    if not s then return fail(msg, "unknown shard") end
    if s.status ~= "leased" then return fail(msg, "shard not leased") end
    if s.worker ~= msg.From then return fail(msg, "lease owner mismatch") end
    if d.family_digest ~= run.family_digest or d.kernel_digest ~= run.kernel_digest then
      return fail(msg, "digest mismatch")
    end
    local expected = s.end_index - s.start_index
    if tonumber(d.tested) ~= expected then return fail(msg, "tested count mismatch") end

    -- Never accept plaintext recovered secrets into persistent AO state.
    if d.secret or d.private_key or d.seed or d.mnemonic then
      return fail(msg, "plaintext secret rejected")
    end

    s.status = "done"
    s.result_digest = d.result_digest
    s.worker = nil
    if d.hit_commitment then
      table.insert(run.hits, {
        shard_id=s.shard_id,
        hit_commitment=d.hit_commitment,
        result_digest=d.result_digest
      })
    end
    send(msg.From, "ShardAccepted", summarize(run))
  end)

Handlers.add("lab-c-get-run",
  function(msg) return msg.Action == "GetRun" end,
  function(msg)
    local d = json.decode(msg.Data or "{}")
    local run = Runs[d.run_id]
    if not run then return fail(msg, "unknown run") end
    send(msg.From, "RunState", summarize(run))
  end)
