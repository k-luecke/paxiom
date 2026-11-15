#!/bin/bash
. ~/.kerl/27.2/activate
export "PATH=$HOME/.cargo/bin:$PATH"
cd $HOME/HyperBEAM
exec rebar3 shell
