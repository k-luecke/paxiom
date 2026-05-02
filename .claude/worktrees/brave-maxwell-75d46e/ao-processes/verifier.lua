local json = require('json')

-- Paxiom verified state
State = {
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
    local header = json.decode(msg.Data)

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
    local data = json.decode(msg.Data)
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
      State.headers[slot_key].status = "verified"
      State.latest_proven_slot = data.slot
      State.latest_proven_state_root = State.headers[slot_key].state_root
      State.proven_count = State.proven_count + 1
      State.pending_count = State.pending_count - 1
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
        state_root = State.headers[slot_key].state_root
      })
    })
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
