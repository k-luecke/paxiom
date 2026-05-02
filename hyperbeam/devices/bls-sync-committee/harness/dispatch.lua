-- Lua harness entry-point for ~bls-sync-committee@1.0.
--
-- HyperBEAM hands an inbound message to this function. The harness parses
-- the request shape, calls the bls-device Rust harness (out-of-process via
-- the `bls-device-harness` binary), and shapes the response back into the
-- O-701 / S.02 format.
--
-- The actual cryptographic work lives in the Rust crate. This Lua glue is
-- the integration seam between HyperBEAM's message-passing world and the
-- Rust device implementation.

local json = require("json")

local HARNESS_BIN = os.getenv("BLS_DEVICE_HARNESS")
    or "/usr/local/bin/bls-device-harness"

local function dispatch(msg)
    local body = msg.body or msg.Body or msg.data or msg.Data
    if not body then
        return { status = 400, body = json.encode({ error = "missing body" }) }
    end

    -- Pipe the request JSON to the bls-device harness on stdin; capture
    -- stdout. The harness is built from k-luecke/bls-verifier's bls-device
    -- crate and exposes the same VerifyResponse JSON shape this device
    -- promises in O-701 / S.02.
    local cmd = string.format("%s --json", HARNESS_BIN)
    local proc = io.popen(cmd, "w")
    proc:write(body)
    local ok = proc:close()

    if not ok then
        return {
            status = 502,
            body = json.encode({ error = "bls-device harness failed", harness = HARNESS_BIN })
        }
    end

    -- The harness writes the response to a known temp file (path supplied
    -- via env). Real wiring is filed for follow-up — this stub keeps the
    -- HyperBEAM-facing contract documented.
    return {
        status = 200,
        body = json.encode({
            note = "Lua harness stub — wire bls-device-harness stdout once the harness binary lands",
        })
    }
end

return { dispatch = dispatch }
