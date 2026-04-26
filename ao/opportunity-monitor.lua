-- PaxiomOpportunityMonitor
-- Watches for capturable spreads and fires execution signals

-- Configuration
MIN_SPREAD_BPS = MIN_SPREAD_BPS or 60    -- 0.06% minimum
MIN_SPREAD_FLASH = MIN_SPREAD_FLASH or 90 -- 0.09% for flash loan eligible
COOLDOWN_MS = COOLDOWN_MS or 30000        -- 30 seconds between signals
COMPLIANCE_PROCESS = COMPLIANCE_PROCESS or "w_MR7QlkfuRcfd3TQJPD1pzMwU5yEEyLMDjO0Ql8_5I"
ADMIN = ADMIN or Owner
TRUSTED_SCANNERS = TRUSTED_SCANNERS or {}

-- State
LastSignalTime = LastSignalTime or 0
SignalCount = SignalCount or 0
OpportunitiesEvaluated = OpportunitiesEvaluated or 0
OpportunitiesFired = OpportunitiesFired or 0

-- FIX: persist the last opportunity so GetStatus can include it
LastOpportunity = LastOpportunity or nil

local function isAdmin(msg)
  return ADMIN ~= nil and msg.From == ADMIN
end

local function isTrustedScanner(msg)
  return TRUSTED_SCANNERS[msg.From] == true
end

-- Receive opportunity data from scanner
Handlers.add(
  "EvaluateOpportunity",
  function(msg) return msg.Action == "EvaluateOpportunity" end,
  function(msg)
    if not isTrustedScanner(msg) then
      ao.send({
        Target = msg.From,
        Action = "OpportunityRejected",
        Data   = "Sender is not an authorized scanner"
      })
      return
    end

    OpportunitiesEvaluated = OpportunitiesEvaluated + 1

    local spreadBps = tonumber(msg.Spreadbps or "0")
    local asset     = msg.Asset or "unknown"
    local buyChain  = msg.Buychain or "unknown"
    local sellChain = msg.Sellchain or "unknown"
    local buyPrice  = msg.Buyprice or "0"
    local sellPrice = msg.Sellprice or "0"
    local capturable = msg.Capturable == "true"
    local now = msg.Timestamp or os.time() * 1000

    -- Check minimum threshold
    if spreadBps < MIN_SPREAD_BPS then
      ao.send({
        Target = msg.From,
        Action = "OpportunitySkipped",
        Data   = "Spread " .. spreadBps .. "bps below minimum " .. MIN_SPREAD_BPS .. "bps"
      })
      return
    end

    -- Check capturable flag
    if not capturable then
      ao.send({
        Target = msg.From,
        Action = "OpportunitySkipped",
        Data   = "Spread not capturable — direction flipping or closing"
      })
      return
    end

    -- Check cooldown
    if (now - LastSignalTime) < COOLDOWN_MS then
      ao.send({
        Target = msg.From,
        Action = "OpportunitySkipped",
        Data   = "Cooldown active — last signal " .. math.floor((now - LastSignalTime)/1000) .. "s ago"
      })
      return
    end

    -- Opportunity qualifies — fire execution signal
    SignalCount = SignalCount + 1
    OpportunitiesFired = OpportunitiesFired + 1
    LastSignalTime = now

    local isFlashEligible = spreadBps >= MIN_SPREAD_FLASH
    local spreadPct = string.format("%.4f", spreadBps / 100)
    local signalId  = tostring(SignalCount)
    local timestamp = tostring(now)

    -- FIX: save opportunity to state so GetStatus can return it
    LastOpportunity = {
      asset      = asset,
      spreadPct  = spreadPct,
      spreadBps  = spreadBps,
      buyChain   = buyChain,
      sellChain  = sellChain,
      buyPrice   = buyPrice,
      sellPrice  = sellPrice,
      capturable = true,
      signalId   = signalId,
      timestamp  = timestamp
    }

    -- Send execution signal
    ao.send({
      Target = msg.From,
      Action = "ExecutionSignal",
      Signalid      = signalId,
      Asset         = asset,
      Spreadbps     = tostring(spreadBps),
      Buychain      = buyChain,
      Sellchain     = sellChain,
      Buyprice      = buyPrice,
      Sellprice     = sellPrice,
      Flasheligible = tostring(isFlashEligible),
      Data          = "EXECUTE: " .. asset .. " " .. spreadBps .. "bps " .. buyChain .. " -> " .. sellChain
    })

    -- Log to compliance process
    ao.send({
      Target       = COMPLIANCE_PROCESS,
      Action       = "AddEvent",
      Eventtype    = "execution_signal",
      Chain        = buyChain .. "-" .. sellChain,
      Asset        = asset,
      Spreadbps    = tostring(spreadBps),
      Data         = "Execution signal #" .. SignalCount .. ": " .. asset .. " " .. spreadBps .. "bps"
    })
  end
)

-- Update configuration
Handlers.add(
  "SetConfig",
  function(msg) return msg.Action == "SetConfig" end,
  function(msg)
    if not isAdmin(msg) then
      ao.send({
        Target = msg.From,
        Action = "ConfigRejected",
        Data   = "Sender is not admin"
      })
      return
    end
    if msg.Minspreadbps then
      MIN_SPREAD_BPS = tonumber(msg.Minspreadbps)
    end
    if msg.Cooldownms then
      COOLDOWN_MS = tonumber(msg.Cooldownms)
    end
    ao.send({
      Target = msg.From,
      Action = "ConfigUpdated",
      Data   = "MinSpread: " .. MIN_SPREAD_BPS .. "bps Cooldown: " .. COOLDOWN_MS .. "ms"
    })
  end
)

Handlers.add(
  "SetTrustedScanner",
  function(msg) return msg.Action == "SetTrustedScanner" end,
  function(msg)
    if not isAdmin(msg) then
      ao.send({
        Target = msg.From,
        Action = "TrustedScannerRejected",
        Data   = "Sender is not admin"
      })
      return
    end

    local scanner = msg.Scanner or msg.From
    local enabled = msg.Enabled ~= "false"
    TRUSTED_SCANNERS[scanner] = enabled
    ao.send({
      Target = msg.From,
      Action = "TrustedScannerUpdated",
      Data   = scanner .. " enabled=" .. tostring(enabled)
    })
  end
)

-- Status check
Handlers.add(
  "GetStatus",
  function(msg) return msg.Action == "GetStatus" end,
  function(msg)
    ao.send({
      Target = msg.From,
      Action = "StatusResult",
      Data   = require("json").encode({
        signalCount            = SignalCount,
        opportunitiesEvaluated = OpportunitiesEvaluated,
        opportunitiesFired     = OpportunitiesFired,
        minSpreadBps           = MIN_SPREAD_BPS,
        cooldownMs             = COOLDOWN_MS,
        lastSignalTime         = LastSignalTime,
        -- FIX: include latest opportunity so ao-poller can forward real data
        latestOpportunity      = LastOpportunity
      })
    })
  end
)

return "PaxiomOpportunityMonitor loaded. MinSpread: " .. MIN_SPREAD_BPS .. "bps"
