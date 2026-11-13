#!/bin/bash
. ~/.kerl/27.2/activate
export "PATH=$HOME/.cargo/bin:$PATH"
cd /home/kyle_w_luecke/HyperBEAM
exec rebar3 shell
