local json = require('json')

-- Paxiom Price Scanner
-- Watches DEX prices across L2s and detects arb opportunities

State = {
  prices = {},
  opportunities = {},
  opportunity_count = 0,
  last_update = 0
}

-- Receive a price update from an external feeder
Handlers.add(
  "update-price",
  function(msg)
    return msg.Action == "UpdatePrice"
  end,
  function(msg)
    local data = json.decode(msg.Data)
    
    -- data.asset = "ETH", "USDC" etc
    -- data.chain = "arbitrum", "optimism", "base"
    -- data.dex = "uniswap", "camelot" etc
    -- data.price = price as number
    
    local key = data.asset .. ":" .. data.chain
    
    if not State.prices[data.asset] then
      State.prices[data.asset] = {}
    end
    
    State.prices[data.asset][data.chain] = {
      price = data.price,
      dex = data.dex,
      timestamp = data.timestamp or os.time()
    }
    
    State.last_update = os.time()
    
    -- Check for opportunities after every price update
    checkOpportunities(data.asset, msg.From)
  end
)

-- Check if a price discrepancy exists for an asset
function checkOpportunities(asset, sender)
  local chains = State.prices[asset]
  if not chains then return end
  
  local chain_list = {}
  for chain, data in pairs(chains) do
    table.insert(chain_list, {chain = chain, price = data.price, dex = data.dex})
  end
  
  if #chain_list < 2 then return end
  
  -- Find highest and lowest price
  local highest = chain_list[1]
  local lowest = chain_list[1]
  
  for _, entry in ipairs(chain_list) do
    if entry.price > highest.price then highest = entry end
    if entry.price < lowest.price then lowest = entry end
  end
  
  -- Calculate spread
  local spread = (highest.price - lowest.price) / lowest.price
  local spread_pct = spread * 100
  
  -- Minimum threshold: 0.1% spread to be worth pursuing
  if spread_pct >= 0.1 then
    local opportunity = {
      asset = asset,
      buy_chain = lowest.chain,
      buy_dex = lowest.dex,
      buy_price = lowest.price,
      sell_chain = highest.chain,
      sell_dex = highest.dex,
      sell_price = highest.price,
      spread_pct = spread_pct,
      timestamp = os.time()
    }
    
    State.opportunity_count = State.opportunity_count + 1
    State.opportunities[tostring(State.opportunity_count)] = opportunity
    
    -- Alert the sender
    ao.send({
      Target = sender,
      Action = "OpportunityDetected",
      Data = json.encode(opportunity)
    })
    
    print("OPPORTUNITY: " .. asset .. " spread " .. 
          string.format("%.3f", spread_pct) .. "% - buy on " .. 
          lowest.chain .. " sell on " .. highest.chain)
  end
end

-- Get current prices
Handlers.add(
  "get-prices",
  function(msg)
    return msg.Action == "GetPrices"
  end,
  function(msg)
    ao.send({
      Target = msg.From,
      Data = json.encode(State.prices)
    })
  end
)

-- Get detected opportunities
Handlers.add(
  "get-opportunities",
  function(msg)
    return msg.Action == "GetOpportunities"
  end,
  function(msg)
    ao.send({
      Target = msg.From,
      Data = json.encode({
        count = State.opportunity_count,
        opportunities = State.opportunities
      })
    })
  end
)
