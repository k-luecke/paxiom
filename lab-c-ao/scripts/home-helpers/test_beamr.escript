#!/usr/bin/env escript
%% -*- erlang -*-
main(_) ->
    Home = os:getenv("HOME", "."),
    HbRoot = os:getenv("HYPERBEAM_DIR", filename:join(Home, "HyperBEAM")),
    code:add_pathz(filename:join([HbRoot, "_build", "default", "lib", "hb", "ebin"])),
    code:add_pathz(filename:join(HbRoot, "priv")),
    WasmPath = filename:join([filename:dirname(escript:script_name()), "..", "..", "lab_c_ao_worker.wasm"]),
    {ok, WasmBytes} = file:read_file(WasmPath),
    io:format("Read WASM bytes: ~p~n", [byte_size(WasmBytes)]),
    case hb_beamr:start(WasmBytes) of
        {ok, Port, Imports, Exports} ->
            io:format("BEAMR Started! Port: ~p~nExports: ~p~nImports: ~p~n", [Port, Exports, Imports]),
            hb_beamr:stop(Port),
            io:format("PASS: hb_beamr successfully loaded lab_c_ao_worker.wasm!~n");
        Error ->
            io:format("Error: ~p~n", [Error]),
            erlang:halt(1)
    end.
