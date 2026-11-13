#!/usr/bin/env escript
%% -*- erlang -*-
main(_) ->
    [code:add_pathz(Path) || Path <- filelib:wildcard("/home/kyle_w_luecke/HyperBEAM/_build/default/lib/*/ebin")],
    code:add_pathz("/home/kyle_w_luecke/HyperBEAM/priv"),
    {ok, _} = application:ensure_all_started(hb),
    {ok, Code} = file:read_file("/home/kyle_w_luecke/paxiom-lab-c-ao/lab-c-ao/coordinator.lua"),
    io:format("Read coordinator.lua: ~p bytes~n", [byte_size(Code)]),
    Base = #{ <<"module">> => [#{ <<"body">> => Code }] },
    case dev_lua:init(Base, #{}, #{}) of
        {ok, Msg} ->
            io:format("dev_lua:init SUCCEEDED! Keys: ~p~n", [maps:keys(Msg)]);
        Err ->
            io:format("dev_lua:init error: ~p~n", [Err])
    end.
