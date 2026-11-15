#!/bin/bash
. ~/.kerl/27.2/activate
export "PATH=$HOME/.cargo/bin:$PATH"
bash $HOME/paxiom-ops-wt/hyperbeam/bringup/smoke-test.sh
