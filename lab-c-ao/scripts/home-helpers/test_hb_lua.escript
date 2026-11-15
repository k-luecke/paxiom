#!/usr/bin/env escript
%% -*- erlang -*-
main(_) ->
    Home = os:getenv("HOME", "."),
    HbRoot = os:getenv("HYPERBEAM_DIR", filename:join(Home, "HyperBEAM")),
    [code:add_pathz(Path) || Path <- filelib:wildcard(filename:join([HbRoot, "_build", "default", "lib", "*", "ebin"]))],
    code:add_pathz(filename:join(HbRoot, "priv")),
    {ok, _} = application:ensure_all_started(hb),
    CoordPath = filename:join([filename:dirname(escript:script_name()), "..", "..", "coordinator.lua"]),
    {ok, Code} = file:read_file(CoordPath),
    io:format("Read coordinator.lua: ~p bytes~n", [byte_size(Code)]),
    Base = #{ <<"module">> => [#{ <<"body">> => Code }] },
    case dev_lua:init(Base, #{}, #{}) of
        {ok, Msg} ->
            io:format("dev_lua:init SUCCEEDED! Keys: ~p~n", [maps:keys(Msg)]);
        Err ->
            io:format("dev_lua:init error: ~p~n", [Err])
    end.
