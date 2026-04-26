local json = require('json')

ADMIN = ADMIN or Owner

State = State or {
  version = 1,
  chain = "ethereum",
  genesis = nil,
  latest = nil,
  segments = {},
  facts = {},
  pending_facts = 0,
  rejected_count = 0
}

local function isAdmin(msg)
  return ADMIN ~= nil and msg.From == ADMIN
end

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

local function isHexRoot(value)
  return type(value) == "string" and string.match(value, "^0x[%da-fA-F]+$") and string.len(value) == 66
end

local function requireField(tbl, field)
  if tbl[field] == nil or tbl[field] == "" then
    return field .. " is required"
  end
  return nil
end

local function countTable(tbl)
  local count = 0
  for _ in pairs(tbl) do
    count = count + 1
  end
  return count
end

Handlers.add(
  "initialize-genesis",
  function(msg)
    return msg.Action == "InitializeGenesis"
  end,
  function(msg)
    if not isAdmin(msg) then
      reply(msg.From, "GenesisRejected", { error = "Sender is not admin" })
      return
    end
    if State.genesis ~= nil then
      reply(msg.From, "GenesisRejected", { error = "Genesis already initialized" })
      return
    end

    local data, err = decode(msg.Data)
    if err then
      reply(msg.From, "GenesisRejected", { error = err })
      return
    end
    if data.chain ~= nil and data.chain ~= "ethereum" then
      reply(msg.From, "GenesisRejected", { error = "Unsupported chain" })
      return
    end
    if not isHexRoot(data.state_root) then
      reply(msg.From, "GenesisRejected", { error = "state_root must be a 32-byte hex root" })
      return
    end
    if type(data.commitment) ~= "string" or data.commitment == "" then
      reply(msg.From, "GenesisRejected", { error = "commitment is required" })
      return
    end

    State.genesis = {
      chain = "ethereum",
      slot = 0,
      state_root = data.state_root,
      commitment = data.commitment
    }
    State.latest = {
      slot = 0,
      state_root = data.state_root,
      commitment = data.commitment
    }

    reply(msg.From, "GenesisInitialized", State.genesis)
  end
)

Handlers.add(
  "submit-segment-proof",
  function(msg)
    return msg.Action == "SubmitSegmentProof"
  end,
  function(msg)
    if State.genesis == nil or State.latest == nil then
      reply(msg.From, "SegmentRejected", { error = "Genesis not initialized" })
      return
    end

    local data, err = decode(msg.Data)
    if err then
      reply(msg.From, "SegmentRejected", { error = err })
      return
    end

    for _, field in ipairs({ "from_slot", "to_slot", "from_state_root", "to_state_root", "proof_system", "proof_hash", "commitment" }) do
      local fieldErr = requireField(data, field)
      if fieldErr then
        State.rejected_count = State.rejected_count + 1
        reply(msg.From, "SegmentRejected", { error = fieldErr })
        return
      end
    end

    if tonumber(data.from_slot) ~= tonumber(State.latest.slot) then
      State.rejected_count = State.rejected_count + 1
      reply(msg.From, "SegmentRejected", { error = "Segment must start at latest slot" })
      return
    end
    if tonumber(data.to_slot) <= tonumber(data.from_slot) then
      State.rejected_count = State.rejected_count + 1
      reply(msg.From, "SegmentRejected", { error = "to_slot must be greater than from_slot" })
      return
    end
    if data.from_state_root ~= State.latest.state_root then
      State.rejected_count = State.rejected_count + 1
      reply(msg.From, "SegmentRejected", { error = "Segment must start at latest state root" })
      return
    end
    if not isHexRoot(data.from_state_root) or not isHexRoot(data.to_state_root) then
      State.rejected_count = State.rejected_count + 1
      reply(msg.From, "SegmentRejected", { error = "State roots must be 32-byte hex roots" })
      return
    end

    local segment = {
      from_slot = tonumber(data.from_slot),
      to_slot = tonumber(data.to_slot),
      from_state_root = data.from_state_root,
      to_state_root = data.to_state_root,
      proof_system = data.proof_system,
      proof_hash = data.proof_hash,
      commitment = data.commitment,
      submitted_by = msg.From,
      timestamp = os.time()
    }

    table.insert(State.segments, segment)
    State.latest = {
      slot = segment.to_slot,
      state_root = segment.to_state_root,
      commitment = segment.commitment
    }

    reply(msg.From, "SegmentAccepted", {
      latest_slot = State.latest.slot,
      latest_state_root = State.latest.state_root,
      latest_commitment = State.latest.commitment,
      segment_count = #State.segments
    })
  end
)

Handlers.add(
  "submit-fact-proof",
  function(msg)
    return msg.Action == "SubmitFactProof"
  end,
  function(msg)
    if State.latest == nil then
      reply(msg.From, "FactRejected", { error = "Corpus not initialized" })
      return
    end

    local data, err = decode(msg.Data)
    if err then
      reply(msg.From, "FactRejected", { error = err })
      return
    end

    for _, field in ipairs({ "slot", "state_root", "predicate", "subject", "value", "corpus_commitment", "proof_hash", "commitment" }) do
      local fieldErr = requireField(data, field)
      if fieldErr then
        State.rejected_count = State.rejected_count + 1
        reply(msg.From, "FactRejected", { error = fieldErr })
        return
      end
    end

    if data.corpus_commitment ~= State.latest.commitment then
      State.rejected_count = State.rejected_count + 1
      reply(msg.From, "FactRejected", { error = "Fact must bind to latest corpus commitment" })
      return
    end
    if tonumber(data.slot) > tonumber(State.latest.slot) then
      State.rejected_count = State.rejected_count + 1
      reply(msg.From, "FactRejected", { error = "Fact slot exceeds latest proven slot" })
      return
    end
    if not isHexRoot(data.state_root) then
      State.rejected_count = State.rejected_count + 1
      reply(msg.From, "FactRejected", { error = "state_root must be a 32-byte hex root" })
      return
    end

    local key = tostring(data.slot) .. ":" .. data.predicate .. ":" .. data.subject
    State.facts[key] = {
      slot = tonumber(data.slot),
      state_root = data.state_root,
      predicate = data.predicate,
      subject = data.subject,
      value = data.value,
      corpus_commitment = data.corpus_commitment,
      proof_hash = data.proof_hash,
      commitment = data.commitment,
      submitted_by = msg.From,
      timestamp = os.time()
    }

    reply(msg.From, "FactAccepted", {
      key = key,
      commitment = data.commitment,
      latest_slot = State.latest.slot
    })
  end
)

Handlers.add(
  "get-corpus-state",
  function(msg)
    return msg.Action == "GetCorpusState"
  end,
  function(msg)
    reply(msg.From, "CorpusState", {
      version = State.version,
      chain = State.chain,
      genesis = State.genesis,
      latest = State.latest,
      segment_count = #State.segments,
      fact_count = countTable(State.facts),
      rejected_count = State.rejected_count
    })
  end
)

Handlers.add(
  "get-fact",
  function(msg)
    return msg.Action == "GetFact"
  end,
  function(msg)
    local data, err = decode(msg.Data)
    if err then
      reply(msg.From, "FactResult", { error = err })
      return
    end
    local key = tostring(data.slot) .. ":" .. tostring(data.predicate) .. ":" .. tostring(data.subject)
    reply(msg.From, "FactResult", State.facts[key] or { error = "not found", key = key })
  end
)
