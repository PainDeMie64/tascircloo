import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [model, simulator, wasmAbi, runtime, bridge, worker, page, protocol, world, contact, html] = await Promise.all([
  readFile('native/circloo-sim/src/runtime_model.h', 'utf8'),
  readFile('native/circloo-sim/src/runtime_simulator.cpp', 'utf8'),
  readFile('native/circloo-sim/src/level1_wasm.cpp', 'utf8'),
  readFile('static/game/circloo-wasm-runtime.js', 'utf8'),
  readFile('static/game/tas-bridge.js', 'utf8'),
  readFile('static/game/bruteforce-worker.js', 'utf8'),
  readFile('src/routes/+page.svelte', 'utf8'),
  readFile('src/lib/tas/protocol.ts', 'utf8'),
  readFile('native/circloo-sim/vendor/box2d-2.3.1/Dynamics/b2World.cpp', 'utf8'),
  readFile('native/circloo-sim/vendor/box2d-2.3.1/Dynamics/Contacts/b2Contact.h', 'utf8'),
  readFile('static/game/index.html', 'utf8')
]);

assert.match(model, /enum class ModelJointType[\s\S]*Revolute = 1[\s\S]*Rope = 10/);
assert.match(model, /bool initial_timer_started = false/);
assert.match(simulator, /world_\.SetPreviousInverseTimeStep\(model\.world\.step_rate\)/);
assert.match(simulator, /world_\.InitializeSnapshotContacts\(\)/);
assert.match(simulator, /RestoreContacts\(\)/);
assert.match(simulator, /state_\.timer_started \|\| \(input & 3U\) != 0U/);
assert.match(simulator, /state_\.frame \+ \(timer_started \? 1 : 0\)/);
assert.match(world, /void b2World::SortContactsDeterministically\(\)/);
assert.match(contact, /void SetCapturedSolverState\(/);
assert.match(wasmAbi, /circloo_model_add_joint\(/);
assert.match(wasmAbi, /circloo_model_add_contact\(/);
assert.match(runtime, /addJoint: requireExport\(exports, 'circloo_model_add_joint'\)/);
assert.match(runtime, /addContact: requireExport\(exports, 'circloo_model_add_contact'\)/);
assert.match(runtime, /playerTriggered: objectIndex === 21/);
assert.match(runtime, /function readResult\(status, includePhysics = true\)/);
assert.match(runtime, /initialTimerStarted: !!player\.timerStarted/);
assert.match(runtime, /lifecycle\.initialTimerStarted \? 1 : 0/);
assert.match(bridge, /const contacts = \[\]/);
assert.match(bridge, /normalImpulse: Number\(point && point\._6w1\)/);
assert.match(bridge, /case 'SET_GAME_SPEED':/);
assert.match(bridge, /function updateReplayScript\(/);
assert.match(bridge, /state\.rafAccumulator \+= elapsed \* \(FPS \/ 1000\) \* state\.gameSpeed/);
assert.match(bridge, /scoreCheckpoint = state\.collectedCP/);
assert.match(bridge, /scoreCheckpoint,/);
assert.match(bridge, /if \(state\.collectedCP < minCheckpoint\) return;/);
assert.match(bridge, /Math\.hypot\(x - pointX, y - pointY\)/);
assert.match(bridge, /timerStarted: !!player\._Pt/);
assert.doesNotMatch(bridge, /pointZ/);
assert.match(worker, /mode: 'wasm-runtime'/);
assert.match(worker, /Custom WASM engine unavailable:/);
assert.match(worker, /current\.optimizer\.evaluate\(candidate\)/);
assert.match(worker, /function evaluatePointThrough\(/);
assert.match(worker, /function createSequenceInputState\(/);
assert.match(worker, /function nextSequenceInput\(/);
assert.match(worker, /Math\.max\(1, Math\.abs\(finiteFrame\(unfreeze\.frame, 0\)\)\)/);
assert.match(worker, /inputState\.prestartRemaining > 0/);
assert.match(worker, /scriptInputAtFrame\(candidateScript, frame\)/);
assert.doesNotMatch(worker, /createSearchOptimizer|forceFullRuntime|point-target-full-runtime|pointZ/);
assert.doesNotMatch(page, /pointZ|>Z</);
assert.doesNotMatch(protocol, /pointZ|POINT_TARGET_PICKED'[\s\S]*z: number/);
assert.match(html, /tas-bridge\.js\?v=72/);

console.log('All-level custom engine support verified');
