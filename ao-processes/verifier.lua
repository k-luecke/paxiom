local json = require('json')

ADMIN = ADMIN or Owner
TRUSTED_SUBMITTERS = TRUSTED_SUBMITTERS or {}
TRUSTED_VERIFIERS = TRUSTED_VERIFIERS or {}

local function isAdmin(msg)
  return ADMIN ~= nil and msg.From == ADMIN
end

local function isTrustedSubmitter(msg)
  return TRUSTED_SUBMITTERS[msg.From] == true
end

local function isTrustedVerifier(msg)
  return TRUSTED_VERIFIERS[msg.From] == true
end

-- Paxiom verified state
State = State or {
  genesis_proven = false,
  genesis_slot = 0,
  genesis_state_root = "",
  latest_proven_slot = 0,
  latest_proven_state_root = "",
  proven_count = 0,
  pending_count = 0,
  rejected_count = 0,
  headers = {}
}

-- Store header pending verification
Handlers.add(
  "store-header",
  function(msg)
    return msg.Action == "StoreHeader"
  end,
  function(msg)
    if not isTrustedSubmitter(msg) then
      ao.send({
        Target = msg.From,
        Action = "HeaderRejected",
        Data = json.encode({ error = "Sender is not an authorized submitter" })
      })
      return
    end

    local ok, header = pcall(json.decode, msg.Data or "{}")
    if not ok or type(header) ~= "table" then
      ao.send({
        Target = msg.From,
        Action = "HeaderRejected",
        Data = json.encode({ error = "Invalid header JSON" })
      })
      return
    end

    if header.slot == nil or header.state_root == nil or tostring(header.state_root) == "" then
      ao.send({
        Target = msg.From,
        Action = "HeaderRejected",
        Data = json.encode({ error = "Header requires slot and state_root" })
      })
      return
    end

    State.pending_count = State.pending_count + 1
    State.headers[tostring(header.slot)] = {
      slot = header.slot,
      state_root = header.state_root,
      status = "pending",
      timestamp = os.time()
    }

    ao.send({
      Target = msg.From,
      Action = "HeaderStored",
      Data = json.encode({
        slot = header.slot,
        status = "pending",
        message = "Header received, awaiting verification"
      })
    })
  end
)

-- Mark header as verified (will be called by WASM verifier process)
Handlers.add(
  "verify-header",
  function(msg)
    return msg.Action == "VerifyHeader"
  end,
  function(msg)
    if not isTrustedVerifier(msg) then
      ao.send({
        Target = msg.From,
        Action = "VerifyResult",
        Data = json.encode({ verified = false, error = "Sender is not an authorized verifier" })
      })
      return
    end

    local ok, data = pcall(json.decode, msg.Data or "{}")
    if not ok or type(data) ~= "table" then
      ao.send({
        Target = msg.From,
        Action = "VerifyResult",
        Data = json.encode({ verified = false, error = "Invalid verification JSON" })
      })
      return
    end

    local slot_key = tostring(data.slot)

    if not State.headers[slot_key] then
      ao.send({
        Target = msg.From,
        Action = "VerifyResult",
        Data = json.encode({
          slot = data.slot,
          verified = false,
          error = "Header not found"
        })
      })
      return
    end

    if data.verified then
      if tonumber(data.slot) <= tonumber(State.latest_proven_slot) then
        ao.send({
          Target = msg.From,
          Action = "VerifyResult",
          Data = json.encode({
            slot = data.slot,
            verified = false,
            error = "Slot must increase monotonically"
          })
        })
        return
      end
      State.headers[slot_key].status = "verified"
      State.latest_proven_slot = data.slot
      State.latest_proven_state_root = State.headers[slot_key].state_root
      State.proven_count = State.proven_count + 1
      State.pending_count = State.pending_count - 1

      if not State.genesis_proven then
        State.genesis_proven = true
        State.genesis_slot = data.slot
        State.genesis_state_root = State.headers[slot_key].state_root
      end
    else
      State.headers[slot_key].status = "rejected"
      State.rejected_count = State.rejected_count + 1
      State.pending_count = State.pending_count - 1
    end

    ao.send({
      Target = msg.From,
      Action = "VerifyResult",
      Data = json.encode({
        slot = data.slot,
        verified = data.verified,
        state_root = State.headers[slot_key].state_root,
        genesis_proven = State.genesis_proven,
        genesis_slot = State.genesis_slot,
        genesis_state_root = State.genesis_state_root
      })
    })
  end
)

Handlers.add(
  "set-trusted-submitter",
  function(msg)
    return msg.Action == "SetTrustedSubmitter"
  end,
  function(msg)
    if not isAdmin(msg) then
      ao.send({ Target = msg.From, Action = "ConfigRejected", Data = "Sender is not admin" })
      return
    end
    local submitter = msg.Submitter or msg.From
    local enabled = msg.Enabled ~= "false"
    TRUSTED_SUBMITTERS[submitter] = enabled
    ao.send({ Target = msg.From, Action = "TrustedSubmitterUpdated", Data = submitter .. " enabled=" .. tostring(enabled) })
  end
)

Handlers.add(
  "set-trusted-verifier",
  function(msg)
    return msg.Action == "SetTrustedVerifier"
  end,
  function(msg)
    if not isAdmin(msg) then
      ao.send({ Target = msg.From, Action = "ConfigRejected", Data = "Sender is not admin" })
      return
    end
    local verifier = msg.Verifier or msg.From
    local enabled = msg.Enabled ~= "false"
    TRUSTED_VERIFIERS[verifier] = enabled
    ao.send({ Target = msg.From, Action = "TrustedVerifierUpdated", Data = verifier .. " enabled=" .. tostring(enabled) })
  end
)

-- Get current proven state
Handlers.add(
  "get-state",
  function(msg)
    return msg.Action == "GetState"
  end,
  function(msg)
    ao.send({
      Target = msg.From,
      Data = json.encode({
        latest_proven_slot = State.latest_proven_slot,
        latest_proven_state_root = State.latest_proven_state_root,
        genesis_proven = State.genesis_proven,
        genesis_slot = State.genesis_slot,
        genesis_state_root = State.genesis_state_root,
        protocol_phase = State.genesis_proven and "GENESIS_PROVEN" or "GENESIS_PENDING",
        proven_count = State.proven_count,
        pending_count = State.pending_count,
        rejected_count = State.rejected_count
      })
    })
  end
)

-- Get specific header status
Handlers.add(
  "get-header",
  function(msg)
    return msg.Action == "GetHeader"
  end,
  function(msg)
    local data = json.decode(msg.Data)
    local header = State.headers[tostring(data.slot)]

    ao.send({
      Target = msg.From,
      Data = json.encode(header or {error = "not found"})
    })
  end
)
