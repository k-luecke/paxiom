local json = require('json')

-- This process is an authenticated registry, not an SP1 verifier. A trusted
-- off-process verifier must verify the SP1 proof and submit the public values.
-- The submitting AO identity is the security boundary.

RecursiveCheckpoint = RecursiveCheckpoint or {
  version = 1,
  configured = false,
  verifier_authority = nil,
  update_vkey = nil,
  accumulator_vkey = nil,
  sync_committee_root = nil,
  genesis_validators_root = nil,
  fork_version = nil,
  latest_commit_id = nil,
  latest = nil,
  commit_count = 0,
  by_commit_id = {}
}

local function send(target, action, value)
  ao.send({ Target = target, Action = action, Data = json.encode(value) })
end

local function fail(msg, reason)
  send(msg.From, 'CheckpointRejected', { error = reason })
end

local function is_hex(value, digits)
  return type(value) == 'string'
    and #value == digits + 2
    and string.sub(value, 1, 2) == '0x'
    and string.match(string.sub(value, 3), '^[0-9a-f]+$') ~= nil
end

local function is_ao_id(value)
  return type(value) == 'string'
    and #value == 43
    and string.match(value, '^[A-Za-z0-9_-]+$') ~= nil
end

local function is_decimal(value)
  return type(value) == 'string'
    and (value == '0' or string.match(value, '^[1-9][0-9]*$') ~= nil)
end

local function decimal_greater(left, right)
  return #left > #right or (#left == #right and left > right)
end

local function configured_anchors_match(value)
  return value.updateVkey == RecursiveCheckpoint.update_vkey
    and value.accumulatorVkey == RecursiveCheckpoint.accumulator_vkey
    and value.syncCommitteeRoot == RecursiveCheckpoint.sync_committee_root
    and value.genesisValidatorsRoot == RecursiveCheckpoint.genesis_validators_root
    and value.forkVersion == RecursiveCheckpoint.fork_version
end

local function validate_checkpoint(value)
  if type(value) ~= 'table' then return false, 'checkpoint must be an object' end
  if value.kind ~= 'paxiom-sp1-recursive-checkpoint' or value.version ~= 1 then
    return false, 'unsupported checkpoint kind or version'
  end
  if not is_decimal(value.startSlot) or not is_decimal(value.endSlot)
    or not is_decimal(value.updateCount) then
    return false, 'slots and update count must be canonical decimal strings'
  end
  if not decimal_greater(value.endSlot, value.startSlot) then
    return false, 'endSlot must be greater than startSlot'
  end
  if not decimal_greater(value.updateCount, '1') then
    return false, 'recursive checkpoint must contain at least two updates'
  end
  if not is_hex(value.startBeaconRoot, 64) or not is_hex(value.endBeaconRoot, 64)
    or not is_hex(value.syncCommitteeRoot, 64)
    or not is_hex(value.genesisValidatorsRoot, 64)
    or not is_hex(value.updateChainRoot, 64)
    or not is_hex(value.updateVkey, 64)
    or not is_hex(value.accumulatorVkey, 64)
    or not is_hex(value.publicValuesSha256, 64)
    or not is_hex(value.forkVersion, 8) then
    return false, 'malformed root, vkey, digest, or fork version'
  end
  if not is_ao_id(value.proofRef) then return false, 'proofRef must be an Arweave transaction id' end
  if value.previousCommitId ~= nil and not is_ao_id(value.previousCommitId) then
    return false, 'previousCommitId must be an AO message id or null'
  end
  if not configured_anchors_match(value) then return false, 'configured anchor changed' end
  return true, nil
end

Handlers.add('configure-recursive-checkpoint',
  function(msg) return msg.Action == 'ConfigureRecursiveCheckpoint' end,
  function(msg)
    if msg.From ~= Owner then return fail(msg, 'only the process owner may configure') end
    if RecursiveCheckpoint.configured then return fail(msg, 'configuration is immutable') end
    local ok, value = pcall(json.decode, msg.Data or '')
    if not ok or type(value) ~= 'table' then return fail(msg, 'invalid JSON configuration') end
    if not is_ao_id(value.verifierAuthority)
      or not is_hex(value.updateVkey, 64)
      or not is_hex(value.accumulatorVkey, 64)
      or not is_hex(value.syncCommitteeRoot, 64)
      or not is_hex(value.genesisValidatorsRoot, 64)
      or not is_hex(value.forkVersion, 8) then
      return fail(msg, 'malformed configuration')
    end
    RecursiveCheckpoint.verifier_authority = value.verifierAuthority
    RecursiveCheckpoint.update_vkey = value.updateVkey
    RecursiveCheckpoint.accumulator_vkey = value.accumulatorVkey
    RecursiveCheckpoint.sync_committee_root = value.syncCommitteeRoot
    RecursiveCheckpoint.genesis_validators_root = value.genesisValidatorsRoot
    RecursiveCheckpoint.fork_version = value.forkVersion
    RecursiveCheckpoint.configured = true
    send(msg.From, 'RecursiveCheckpointConfigured', { configured = true })
  end
)

Handlers.add('commit-recursive-checkpoint',
  function(msg) return msg.Action == 'CommitRecursiveCheckpoint' end,
  function(msg)
    if not RecursiveCheckpoint.configured then return fail(msg, 'registry is not configured') end
    if msg.From ~= RecursiveCheckpoint.verifier_authority then return fail(msg, 'unauthorized verifier authority') end
    if not is_ao_id(msg.Id) then return fail(msg, 'missing authenticated AO message id') end
    if RecursiveCheckpoint.by_commit_id[msg.Id] ~= nil then return fail(msg, 'duplicate commit id') end

    local ok, value = pcall(json.decode, msg.Data or '')
    if not ok then return fail(msg, 'invalid checkpoint JSON') end
    local valid, reason = validate_checkpoint(value)
    if not valid then return fail(msg, reason) end
    if value.previousCommitId ~= RecursiveCheckpoint.latest_commit_id then
      return fail(msg, 'checkpoint does not extend the current AO commit head')
    end

    -- Lua numbers cannot safely represent arbitrary u64s. Lexicographic compare
    -- equal-length canonical decimal strings, then length, without conversion.
    if RecursiveCheckpoint.latest ~= nil then
      local prior = RecursiveCheckpoint.latest
      local count_increases = decimal_greater(value.updateCount, prior.updateCount)
      local slot_increases = decimal_greater(value.endSlot, prior.endSlot)
      if not count_increases or not slot_increases then return fail(msg, 'checkpoint is not monotonic') end
      if value.startSlot ~= prior.startSlot or value.startBeaconRoot ~= prior.startBeaconRoot then
        return fail(msg, 'checkpoint start anchor changed')
      end
    end

    value.commit_id = msg.Id
    RecursiveCheckpoint.latest = value
    RecursiveCheckpoint.latest_commit_id = msg.Id
    RecursiveCheckpoint.commit_count = RecursiveCheckpoint.commit_count + 1
    RecursiveCheckpoint.by_commit_id[msg.Id] = value
    send(msg.From, 'RecursiveCheckpointCommitted', {
      commit_id = msg.Id,
      endSlot = value.endSlot,
      updateCount = value.updateCount,
      proofRef = value.proofRef
    })
  end
)

Handlers.add('recursive-checkpoint-info',
  function(msg) return msg.Action == 'Info' or msg.Action == 'RecursiveCheckpointInfo' end,
  function(msg)
    send(msg.From, 'RecursiveCheckpointInfo', {
      role = 'authenticated-index-only',
      verifies_sp1_in_lua = false,
      configured = RecursiveCheckpoint.configured,
      verifier_authority = RecursiveCheckpoint.verifier_authority,
      update_vkey = RecursiveCheckpoint.update_vkey,
      accumulator_vkey = RecursiveCheckpoint.accumulator_vkey,
      sync_committee_root = RecursiveCheckpoint.sync_committee_root,
      genesis_validators_root = RecursiveCheckpoint.genesis_validators_root,
      fork_version = RecursiveCheckpoint.fork_version,
      latest_commit_id = RecursiveCheckpoint.latest_commit_id,
      commit_count = RecursiveCheckpoint.commit_count
    })
  end
)

Handlers.add('get-recursive-checkpoint',
  function(msg) return msg.Action == 'GetRecursiveCheckpoint' end,
  function(msg)
    local commit_id = msg['Commit-Id']
    if commit_id == nil or commit_id == '' then
      send(msg.From, 'RecursiveCheckpoint', RecursiveCheckpoint.latest or { error = 'no checkpoints' })
    else
      send(msg.From, 'RecursiveCheckpoint', RecursiveCheckpoint.by_commit_id[commit_id] or { error = 'not found' })
    end
  end
)
