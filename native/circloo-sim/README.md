# Circloo native simulator

This directory contains the data-driven Box2D simulator used by the bruteforce
worker. The browser bridge captures a GameMaker physics snapshot immediately
before the editable input window, converts it to the generic runtime model, and
loads that model through the Wasm builder ABI.

The runtime model is not tied to a level number. It supports:

- static, kinematic, and dynamic bodies;
- circle, edge, polygon, and chain fixtures;
- fixture material and collision-filter properties;
- revolute and rope joints, including cached solver state;
- deterministic contact ordering and contact warm-start snapshots;
- player input rules;
- collectible checkpoints;
- delayed boundary replacement and body-spawn patches.

Unsupported captured mechanics are rejected before search and retain the
GameMaker full-runtime path.

## Correctness contract

The Level 1 reference fixture is a regression oracle. The native simulator
matches its captured GameMaker state through frame 658 with zero ULP error.

For production search, Wasm is selected only after representative candidates
match GameMaker on reached status, score, checkpoint count, and every
checkpoint frame. Every candidate that could improve the current best is then
replayed in the original GameMaker runtime before it is accepted. Continuous
floating-point tail state is diagnostic rather than an acceptance condition,
because independent GameMaker replays can differ at approximately 1e-13 while
producing identical checkpoint results.

The all-level production classifier currently validates the custom runtime on
all 20 levels: Level 1 selects deterministic rewind and Levels 2 through 20
select Wasm.

## Build and test

Build and run the native oracle:

```sh
./native/circloo-sim/build_native.sh
./native/circloo-sim/build/native/level1_reference_test
```

Build the browser Wasm module:

```sh
./native/circloo-sim/build_wasm.sh
```

`build_wasm.sh` expects a WASI sysroot under
`$CIRCLOO_WASI_ROOT`, defaulting to `/tmp/circloo-wasi-toolchain/root`. It copies
the stripped module to `static/game/circloo-sim.wasm`.

With the Vite application open in a Chromium instance exposing CDP on port
9440, the validation tools can be run as follows:

```sh
CDP_PORT=9440 CANDIDATES=512 SCORE_ONLY=1 \
  node native/circloo-sim/tools/randomized_level1_parity.mjs

CDP_PORT=9440 RUNS=3 TRIALS=2000 \
  node native/circloo-sim/tools/test_repeatability.mjs

CDP_PORT=9440 \
  node native/circloo-sim/tools/test_all_level_checkpoints.mjs
```

The benchmark uses the same UI and adaptive worker pool as production:

```sh
CDP_PORT=9440 DURATION_MS=60000 \
  node native/circloo-sim/tools/benchmark_exact_pool.mjs
```

The vendored Box2D source is version 2.3.1. Its license is preserved under
`vendor/box2d-2.3.1/LICENSE`.
