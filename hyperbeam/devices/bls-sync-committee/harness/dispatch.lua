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

-- Single-quote-escape a string for safe POSIX-shell interpolation.
local function shell_quote(s)
    return "'" .. (s:gsub("'", "'\\''")) .. "'"
end

local function dispatch(msg)
    local body = msg.body or msg.Body or msg.data or msg.Data
    if not body then
        return { status = 400, body = json.encode({ error = "missing body" }) }
    end

    -- Lua's io.popen is unidirectional, so we round-trip through a temp file
    -- on stdin and capture the harness's stdout via popen("r"). The harness
    -- is built from k-luecke/bls-verifier's bls-device crate and writes a
    -- VerifyResponse JSON document to stdout per O-701 / S.02.
    local input_path = os.tmpname()
    local input_file, open_err = io.open(input_path, "w")
    if not input_file then
        return {
            status = 500,
            body = json.encode({ error = "tmp write failed", detail = open_err })
        }
    end
    input_file:write(body)
    input_file:close()

    local cmd = string.format("%s --json < %s", shell_quote(HARNESS_BIN), shell_quote(input_path))
    local proc = io.popen(cmd, "r")
    if not proc then
        os.remove(input_path)
        return {
            status = 502,
            body = json.encode({ error = "bls-device harness failed to spawn", harness = HARNESS_BIN })
        }
    end

    local stdout = proc:read("*a") or ""
    local ok, _, exit_code = proc:close()
    os.remove(input_path)

    if not ok then
        return {
            status = 502,
            body = json.encode({
                error = "bls-device harness exited non-zero",
                harness = HARNESS_BIN,
                exit_code = exit_code,
            })
        }
    end

    -- Fail closed if the harness produced no parseable JSON or no boolean
    -- `verified` field. Returning a synthesised "ok" body would let
    -- downstream consumers treat unverified data as verified.
    local parsed_ok, parsed = pcall(json.decode, stdout)
    if not parsed_ok or type(parsed) ~= "table" or type(parsed.verified) ~= "boolean" then
        return {
            status = 502,
            body = json.encode({
                error = "harness verdict missing or malformed",
                harness = HARNESS_BIN,
            })
        }
    end

    return { status = 200, body = stdout }
end

return { dispatch = dispatch }
