local json = require("json")

Runs = Runs or {}

local DEFAULT_LEASE_MS = 120000

local function now_ms(msg)
  return tonumber(msg.Timestamp or msg.timestamp) or 0
end

local function send(to, action, data)
  ao.send({ Target = to, Action = action, Data = json.encode(data) })
end

local function fail(msg, err)
  send(msg.From, "LabCError", { error = err })
end

local function requeue_expired(run, now)
  local n = 0
  for _, s in ipairs(run.shards) do
    if s.status == "leased" and s.lease_expires_ms and now >= s.lease_expires_ms then
      s.status = "ready"
      s.worker = nil
      s.lease_expires_ms = nil
      s.lease_token = nil
      s.attempts = (s.attempts or 1)
      n = n + 1
    end
  end
  return n
end

local function next_shard(run)
  for _, s in ipairs(run.shards) do
    if s.status == "ready" then return s end
  end
  return nil
end

local function summarize(run)
  local done, leased, ready, tested, attempts = 0, 0, 0, 0, 0
  for _, s in ipairs(run.shards) do
    attempts = attempts + (s.attempts or 0)
    if s.status == "done" then
      done = done + 1
      tested = tested + (s.end_index - s.start_index)
    elseif s.status == "leased" then leased = leased + 1
    else ready = ready + 1 end
  end
  return {
    run_id=run.run_id, target_id=run.target_id,
    candidate_count=run.candidate_count, shard_count=#run.shards,
    done=done, leased=leased, ready=ready, tested=tested,
    complete=(done == #run.shards), hit_count=#run.hits,
    lease_attempts=attempts
  }
end

Handlers.add("lab-c-create-run",
  function(msg) return msg.Action == "CreateRun" end,
  function(msg)
    local d = json.decode(msg.Data or "{}")
    if type(d.run_id) ~= "string" or d.run_id == "" then return fail(msg, "missing run_id") end
    if Runs[d.run_id] then return fail(msg, "run_id already exists") end
    local n, z = tonumber(d.candidate_count), tonumber(d.shard_size)
    local lease_ms = tonumber(d.lease_ms) or DEFAULT_LEASE_MS
    if not n or n < 1 or n % 1 ~= 0 then return fail(msg, "invalid candidate_count") end
    if not z or z < 1 or z % 1 ~= 0 then return fail(msg, "invalid shard_size") end
    if lease_ms < 1000 then return fail(msg, "lease_ms too small") end
    if type(d.family_digest) ~= "string" or type(d.kernel_digest) ~= "string" then
      return fail(msg, "digests required")
    end
    local run = {
      run_id=d.run_id, target_id=d.target_id,
      family_digest=d.family_digest, kernel_digest=d.kernel_digest,
      candidate_count=n, shard_size=z, lease_ms=lease_ms, shards={}, hits={}
    }
    local i, sid = 0, 0
    while i < n do
      local e = math.min(i + z, n); sid = sid + 1
      table.insert(run.shards, {shard_id=sid,start_index=i,end_index=e,status="ready",attempts=0})
      i = e
    end
    Runs[d.run_id] = run
    send(msg.From, "RunCreated", summarize(run))
  end)

Handlers.add("lab-c-lease-shard",
  function(msg) return msg.Action == "LeaseShard" end,
  function(msg)
    local d, now = json.decode(msg.Data or "{}"), now_ms(msg)
    local run = Runs[d.run_id]
    if not run then return fail(msg, "unknown run") end
    requeue_expired(run, now)
    local s = next_shard(run)
    if not s then send(msg.From, "NoShard", summarize(run)); return end
    s.status, s.worker = "leased", msg.From
    s.attempts = (s.attempts or 0) + 1
    s.lease_expires_ms = now + run.lease_ms
    -- Token changes on every lease; stale workers cannot complete a re-leased shard.
    s.lease_token = table.concat({run.run_id,tostring(s.shard_id),tostring(s.attempts),tostring(s.lease_expires_ms)},":")
    send(msg.From, "ShardLease", {
      run_id=run.run_id,target_id=run.target_id,
      family_digest=run.family_digest,kernel_digest=run.kernel_digest,
      shard_id=s.shard_id,start_index=s.start_index,end_index=s.end_index,
      lease_token=s.lease_token,lease_expires_ms=s.lease_expires_ms
    })
  end)

Handlers.add("lab-c-submit-shard",
  function(msg) return msg.Action == "SubmitShard" end,
  function(msg)
    local d, now = json.decode(msg.Data or "{}"), now_ms(msg)
    local run = Runs[d.run_id]
    if not run then return fail(msg, "unknown run") end
    requeue_expired(run, now)
    local s = run.shards[tonumber(d.shard_id) or 0]
    if not s then return fail(msg, "unknown shard") end
    if s.status ~= "leased" then return fail(msg, "shard not leased") end
    if s.worker ~= msg.From then return fail(msg, "lease owner mismatch") end
    if d.lease_token ~= s.lease_token then return fail(msg, "stale lease token") end
    if d.family_digest ~= run.family_digest or d.kernel_digest ~= run.kernel_digest then
      return fail(msg, "digest mismatch")
    end
    local expected = s.end_index - s.start_index
    if tonumber(d.tested) ~= expected then return fail(msg, "tested count mismatch") end
    if d.secret or d.private_key or d.seed or d.mnemonic then
      return fail(msg, "plaintext secret rejected")
    end
    if type(d.result_digest) ~= "string" or d.result_digest == "" then
      return fail(msg, "result_digest required")
    end

    s.status, s.result_digest = "done", d.result_digest
    s.worker, s.lease_expires_ms, s.lease_token = nil, nil, nil
    if d.hit_commitment then
      table.insert(run.hits,{shard_id=s.shard_id,hit_commitment=d.hit_commitment,result_digest=d.result_digest})
    end
    send(msg.From, "ShardAccepted", summarize(run))
  end)

Handlers.add("lab-c-requeue-expired",
  function(msg) return msg.Action == "RequeueExpired" end,
  function(msg)
    local d, now = json.decode(msg.Data or "{}"), now_ms(msg)
    local run = Runs[d.run_id]
    if not run then return fail(msg, "unknown run") end
    local n = requeue_expired(run, now)
    send(msg.From, "ExpiredRequeued", {count=n,state=summarize(run)})
  end)

Handlers.add("lab-c-get-run",
  function(msg) return msg.Action == "GetRun" end,
  function(msg)
    local d = json.decode(msg.Data or "{}")
    local run = Runs[d.run_id]
    if not run then return fail(msg, "unknown run") end
    requeue_expired(run, now_ms(msg))
    send(msg.From, "RunState", summarize(run))
  end)
