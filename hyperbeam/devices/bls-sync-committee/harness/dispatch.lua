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

local function shell_quote(s)
    return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
end

local function read_all(path)
    local f = io.open(path, "r")
    if not f then return "" end
    local body = f:read("*a")
    f:close()
    return body
end

local function write_all(path, body)
    local f = assert(io.open(path, "w"))
    f:write(body)
    f:close()
end

local function remove(path)
    if path then os.remove(path) end
end

local function dispatch(msg)
    local body = msg.body or msg.Body or msg.data or msg.Data
    if not body then
        return { status = 400, body = json.encode({ error = "missing body" }) }
    end

    if type(body) ~= "string" then
        body = json.encode(body)
    end

    -- Lua's standard io.popen is one-directional. Use temp files so the
    -- HyperBEAM device can feed stdin to the Rust harness and return its
    -- stdout verbatim. The Rust process owns BLS verification, x402 truth
    -- fields, platform signature evidence, and AO mock/durable status.
    local req_path = os.tmpname()
    local err_path = os.tmpname()
    write_all(req_path, body)

    local cmd = table.concat({
        shell_quote(HARNESS_BIN),
        "--json",
        "<",
        shell_quote(req_path),
        "2>",
        shell_quote(err_path),
    }, " ")
    local proc = io.popen(cmd, "r")
    local stdout = proc:read("*a")
    local ok, why, code = proc:close()
    local stderr = read_all(err_path)
    remove(req_path)
    remove(err_path)

    if not ok then
        return {
            status = 502,
            body = json.encode({
                error = "bls-device harness failed",
                harness = HARNESS_BIN,
                reason = why,
                code = code,
                detail = stderr,
            })
        }
    end

    return {
        status = 200,
        body = stdout
    }
end

return { dispatch = dispatch }
