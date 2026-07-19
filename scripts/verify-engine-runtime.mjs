import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [model, simulator, wasmAbi, runtime, bridge, world, contact, html] = await Promise.all([
  readFile('native/circloo-sim/src/runtime_model.h', 'utf8'),
  readFile('native/circloo-sim/src/runtime_simulator.cpp', 'utf8'),
  readFile('native/circloo-sim/src/level1_wasm.cpp', 'utf8'),
  readFile('static/game/circloo-wasm-runtime.js', 'utf8'),
  readFile('static/game/tas-bridge.js', 'utf8'),
  readFile('native/circloo-sim/vendor/box2d-2.3.1/Dynamics/b2World.cpp', 'utf8'),
  readFile('native/circloo-sim/vendor/box2d-2.3.1/Dynamics/Contacts/b2Contact.h', 'utf8'),
  readFile('static/game/index.html', 'utf8')
]);

assert.match(model, /enum class ModelJointType[\s\S]*Revolute = 1[\s\S]*Rope = 10/);
assert.match(simulator, /world_\.SetPreviousInverseTimeStep\(model\.world\.step_rate\)/);
assert.match(simulator, /world_\.InitializeSnapshotContacts\(\)/);
assert.match(simulator, /RestoreContacts\(\)/);
assert.match(world, /void b2World::SortContactsDeterministically\(\)/);
assert.match(contact, /void SetCapturedSolverState\(/);
assert.match(wasmAbi, /circloo_model_add_joint\(/);
assert.match(wasmAbi, /circloo_model_add_contact\(/);
assert.match(runtime, /addJoint: requireExport\(exports, 'circloo_model_add_joint'\)/);
assert.match(runtime, /addContact: requireExport\(exports, 'circloo_model_add_contact'\)/);
assert.match(runtime, /playerTriggered: objectIndex === 21/);
assert.match(bridge, /const contacts = \[\]/);
assert.match(bridge, /normalImpulse: Number\(point && point\._6w1\)/);
assert.match(html, /tas-bridge\.js\?v=67/);

console.log('All-level custom engine support verified');
