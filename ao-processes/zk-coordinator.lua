local json = require('json')

ADMIN = ADMIN or Owner

State = State or {
  version = 1,
  jobs = {},
  attempts = {},
  receipts = {},
  job_count = 0,
  attempt_count = 0,
  receipt_count = 0,
  rejected_count = 0
}

local function reply(target, action, data)
  ao.send({
    Target = target,
    Action = action,
    Data = json.encode(data)
  })
end

local function decode(data)
  local ok, value = pcall(json.decode, data or "{}")
  if not ok or type(value) ~= "table" then
    return nil, "Invalid JSON"
  end
  return value, nil
end

local function required(tbl, field)
  if tbl[field] == nil or tbl[field] == "" then
    return field .. " is required"
  end
  return nil
end

local function reject(msg, action, err)
  State.rejected_count = State.rejected_count + 1
  reply(msg.From, action, { error = err })
end

Handlers.add(
  "submit-zk-job",
  function(msg)
    return msg.Action == "SubmitZkPredicateJob"
  end,
  function(msg)
    local data, err = decode(msg.Data)
    if err then
      reject(msg, "ZkJobRejected", err)
      return
    end

    for _, field in ipairs({ "kind", "job_id", "predicate", "subject", "block_number", "state_root", "target_proof_system" }) do
      local fieldErr = required(data, field)
      if fieldErr then
        reject(msg, "ZkJobRejected", fieldErr)
        return
      end
    end

    if data.kind ~= "ZK_PREDICATE_JOB" then
      reject(msg, "ZkJobRejected", "kind must be ZK_PREDICATE_JOB")
      return
    end

    local existing = State.jobs[data.job_id]
    if existing == nil then
      State.job_count = State.job_count + 1
    end

    State.jobs[data.job_id] = {
      job = data,
      submitted_by = msg.From,
      status = existing and existing.status or "pending",
      attempts = existing and existing.attempts or 0,
      timestamp = os.time()
    }

    reply(msg.From, "ZkJobAccepted", {
      job_id = data.job_id,
      status = State.jobs[data.job_id].status,
      job_count = State.job_count
    })
  end
)

Handlers.add(
  "assign-zk-job",
  function(msg)
    return msg.Action == "AssignZkPredicateJob"
  end,
  function(msg)
    local jobId = msg["Job-Id"] or msg.JobId
    local worker = msg["Worker-Id"] or msg.WorkerId or msg.From
    local timeoutSeconds = tonumber(msg["Timeout-Seconds"] or msg.TimeoutSeconds or "300")
    if jobId == nil or jobId == "" then
      reject(msg, "ZkJobAssignRejected", "Job-Id is required")
      return
    end
    local record = State.jobs[jobId]
    if record == nil then
      reject(msg, "ZkJobAssignRejected", "Unknown job_id")
      return
    end
    if record.status == "proved" then
      reject(msg, "ZkJobAssignRejected", "Job already proved")
      return
    end

    record.attempts = (record.attempts or 0) + 1
    local attemptId = jobId .. ":" .. tostring(record.attempts)
    State.attempt_count = State.attempt_count + 1
    State.attempts[attemptId] = {
      job_id = jobId,
      attempt = record.attempts,
      worker_id = worker,
      status = "assigned",
      assigned_at = os.time(),
      deadline_at = os.time() + timeoutSeconds
    }
    record.status = "assigned"
    record.active_attempt_id = attemptId

    reply(msg.From, "ZkJobAssigned", {
      job_id = jobId,
      attempt_id = attemptId,
      worker_id = worker,
      deadline_at = State.attempts[attemptId].deadline_at
    })
  end
)

Handlers.add(
  "submit-zk-proof",
  function(msg)
    return msg.Action == "SubmitZkPredicateProof"
  end,
  function(msg)
    local data, err = decode(msg.Data)
    if err then
      reject(msg, "ZkProofRejected", err)
      return
    end

    for _, field in ipairs({ "kind", "job_id", "predicate", "subject", "block_number", "state_root", "proof_system", "proof_hash", "commitment" }) do
      local fieldErr = required(data, field)
      if fieldErr then
        reject(msg, "ZkProofRejected", fieldErr)
        return
      end
    end

    if data.kind ~= "ZK_PREDICATE_PROOF" then
      reject(msg, "ZkProofRejected", "kind must be ZK_PREDICATE_PROOF")
      return
    end

    local job = State.jobs[data.job_id]
    if job == nil then
      reject(msg, "ZkProofRejected", "Unknown job_id")
      return
    end

    local key = tostring(data.block_number) .. ":" .. data.predicate .. ":" .. data.subject .. ":" .. data.job_id
    if State.receipts[key] == nil then
      State.receipt_count = State.receipt_count + 1
    end

    State.receipts[key] = {
      receipt = data,
      submitted_by = msg.From,
      timestamp = os.time()
    }
    State.jobs[data.job_id].status = "proved"
    local active = State.jobs[data.job_id].active_attempt_id
    if active and State.attempts[active] then
      State.attempts[active].status = "proved"
    end

    reply(msg.From, "ZkProofAccepted", {
      key = key,
      job_id = data.job_id,
      commitment = data.commitment,
      receipt_count = State.receipt_count
    })
  end
)

Handlers.add(
  "get-zk-state",
  function(msg)
    return msg.Action == "GetZkState"
  end,
  function(msg)
    reply(msg.From, "ZkState", {
      version = State.version,
      job_count = State.job_count,
      attempt_count = State.attempt_count,
      receipt_count = State.receipt_count,
      rejected_count = State.rejected_count
    })
  end
)

Handlers.add(
  "mark-stale-zk-jobs",
  function(msg)
    return msg.Action == "MarkStaleZkJobs"
  end,
  function(msg)
    local now = os.time()
    local stale = {}
    for attemptId, attempt in pairs(State.attempts) do
      if attempt.status == "assigned" and attempt.deadline_at ~= nil and attempt.deadline_at <= now then
        attempt.status = "stale"
        table.insert(stale, attemptId)
        local record = State.jobs[attempt.job_id]
        if record and record.status ~= "proved" then
          record.status = "pending"
        end
      end
    end
    reply(msg.From, "ZkStaleJobsMarked", {
      stale_attempts = stale,
      count = #stale
    })
  end
)

Handlers.add(
  "get-zk-job",
  function(msg)
    return msg.Action == "GetZkJob"
  end,
  function(msg)
    local jobId = msg["Job-Id"] or msg.JobId
    if jobId == nil or jobId == "" then
      reject(msg, "ZkJobLookupRejected", "Job-Id is required")
      return
    end
    reply(msg.From, "ZkJob", State.jobs[jobId] or { error = "not found" })
  end
)
