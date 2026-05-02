Log = Log or {}
EventCount = EventCount or 0

Handlers.add(
  "AddEvent",
  function(msg) return msg.Action == "AddEvent" end,
  function(msg)
    EventCount = EventCount + 1
    local event = {
      id       = EventCount,
      type     = msg.Eventtype or msg.EventType or "unknown",
      chain    = msg.Chain or "unknown",
      contract = msg.Contract or "",
      txHash   = msg.Txhash or msg.TxHash or "",
      amount   = msg.Amount or "",
      details  = msg.Data or "",
      from     = msg.From
    }
    table.insert(Log, event)
    ao.send({
      Target = msg.From,
      Action = "EventLogged",
      Data   = "Logged: " .. event.type .. " #" .. EventCount
    })
  end
)

Handlers.add(
  "GetLog",
  function(msg) return msg.Action == "GetLog" end,
  function(msg)
    ao.send({
      Target = msg.From,
      Action = "LogResult",
      Data   = require("json").encode(Log)
    })
  end
)

Handlers.add(
  "GetStats",
  function(msg) return msg.Action == "GetStats" end,
  function(msg)
    local stats = { total = EventCount, byType = {} }
    for _, event in ipairs(Log) do
      stats.byType[event.type] = (stats.byType[event.type] or 0) + 1
    end
    ao.send({
      Target = msg.From,
      Action = "StatsResult",
      Data   = require("json").encode(stats)
    })
  end
)

return "PaxiomCompliance loaded. Events: " .. EventCount
