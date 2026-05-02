#!/usr/bin/env bash
set -euo pipefail

if [ -n "${PAXIOM_ROOT:-}" ]; then
  ROOT="$PAXIOM_ROOT"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

MPIROOT="${PAXIOM_MPI_ROOT:-$ROOT/.paxiom-runtime/mpi}"
MPIPREFIX="$MPIROOT/usr"
GOROOT_LOCAL="${PAXIOM_GO_ROOT:-$ROOT/.paxiom-runtime/go}"

export PATH="$ROOT/sdk:$MPIROOT/usr/bin:$PATH"
if [ -x "$GOROOT_LOCAL/bin/go" ]; then
  export GOROOT="$GOROOT_LOCAL"
  export PATH="$GOROOT_LOCAL/bin:$PATH"
fi
export PKG_CONFIG_PATH="$MPIROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$MPIROOT/usr/lib/x86_64-linux-gnu/openmpi/lib/pkgconfig:$MPIROOT/usr/lib/x86_64-linux-gnu/mpich/lib/pkgconfig:$MPIROOT/usr/lib/x86_64-linux-gnu/pmix2/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
export PKG_CONFIG_SYSROOT_DIR="$MPIROOT"
export LD_LIBRARY_PATH="$MPIROOT/usr/lib/x86_64-linux-gnu:$MPIROOT/usr/lib/x86_64-linux-gnu/openmpi/lib:$MPIROOT/usr/lib/x86_64-linux-gnu/mpich/lib:$MPIROOT/usr/lib/x86_64-linux-gnu/pmix2/lib:${LD_LIBRARY_PATH:-}"
export OPAL_PREFIX="$MPIPREFIX"
export OPAL_DATA_PATH="$MPIPREFIX/share/openmpi"
export OMPI_MCA_opal_prefix="$MPIPREFIX"

if [ -d "$MPIROOT/usr/lib/llvm-18/lib" ]; then
  export LIBCLANG_PATH="$MPIROOT/usr/lib/llvm-18/lib"
  export LD_LIBRARY_PATH="$MPIROOT/usr/lib/llvm-18/lib:$LD_LIBRARY_PATH"
fi

if [ -d "$MPIROOT/usr/lib/x86_64-linux-gnu/openmpi/include" ]; then
  export BINDGEN_EXTRA_CLANG_ARGS="-I$MPIROOT/usr/lib/llvm-18/lib/clang/18/include -I/usr/lib/gcc/x86_64-linux-gnu/13/include -I/usr/include/x86_64-linux-gnu -I/usr/include -I$MPIROOT/usr/lib/x86_64-linux-gnu/openmpi/include -I$MPIROOT/usr/lib/x86_64-linux-gnu/openmpi/include/openmpi ${BINDGEN_EXTRA_CLANG_ARGS:-}"
  export RUSTFLAGS="${RUSTFLAGS:-} -L native=$MPIROOT/usr/lib/x86_64-linux-gnu/openmpi/lib -L native=$MPIROOT/usr/lib/x86_64-linux-gnu -l dylib=mpi -C link-arg=-Wl,-rpath,$MPIROOT/usr/lib/x86_64-linux-gnu/openmpi/lib -C link-arg=-Wl,-rpath,$MPIROOT/usr/lib/x86_64-linux-gnu"
elif [ -d "$MPIROOT/usr/lib/x86_64-linux-gnu/mpich/include" ]; then
  export BINDGEN_EXTRA_CLANG_ARGS="-I$MPIROOT/usr/lib/llvm-18/lib/clang/18/include -I/usr/lib/gcc/x86_64-linux-gnu/13/include -I/usr/include/x86_64-linux-gnu -I/usr/include -I$MPIROOT/usr/lib/x86_64-linux-gnu/mpich/include ${BINDGEN_EXTRA_CLANG_ARGS:-}"
  export RUSTFLAGS="${RUSTFLAGS:-} -L native=$MPIROOT/usr/lib/x86_64-linux-gnu/mpich/lib -L native=$MPIROOT/usr/lib/x86_64-linux-gnu -l dylib=mpich -C link-arg=-Wl,-rpath,$MPIROOT/usr/lib/x86_64-linux-gnu/mpich/lib -C link-arg=-Wl,-rpath,$MPIROOT/usr/lib/x86_64-linux-gnu"
fi

if [ ! -x "$MPIROOT/usr/bin/mpiexec" ] && [ -x "$MPIROOT/usr/bin/mpiexec.mpich" ]; then
  mkdir -p "$MPIROOT/usr/bin"
  ln -sf mpiexec.mpich "$MPIROOT/usr/bin/mpiexec"
fi

if [ ! -x "$MPIROOT/usr/bin/mpicc" ] && [ -x "$MPIROOT/usr/bin/mpicc.mpich" ]; then
  mkdir -p "$MPIROOT/usr/bin"
  ln -sf mpicc.mpich "$MPIROOT/usr/bin/mpicc"
fi
