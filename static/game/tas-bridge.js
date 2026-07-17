(() => {
	'use strict';

	const W = window;
	const D = document;
	const PARAMS = new URLSearchParams(W.location.search);
	const IS_SIM = PARAMS.get('sim') === '1';
	const SIM_TOKEN = PARAMS.get('token') || '';
	const FPS = 60;
	const DEFAULT_GAMEPLAY_SEED = 0;
	const RealDate = W.Date;
	const realPerformanceNow =
		W.performance && typeof W.performance.now === 'function' ? W.performance.now.bind(W.performance) : null;
	const realDateNow = W.Date && typeof W.Date.now === 'function' ? W.Date.now.bind(W.Date) : () => Date.now();

	const REAL = {
		setTimeout: W.setTimeout.bind(W),
		clearTimeout: W.clearTimeout.bind(W),
		setInterval: W.setInterval.bind(W),
		clearInterval: W.clearInterval.bind(W),
		now: () => (realPerformanceNow ? realPerformanceNow() : realDateNow()),
		raf: W.requestAnimationFrame
			? W.requestAnimationFrame.bind(W)
			: (callback) => W.setTimeout(() => callback(Date.now()), 16)
	};

	const INPUTS = ['.', 'L', 'R', 'LR'];
	const SCRIPT_INPUTS = ['.', 'L', 'R', 'LR', 'U'];
	const LEFT_CODES = new Set([37, 65]);
	const RIGHT_CODES = new Set([39, 68]);
	const UNFREEZE_CODES = new Set([85]);
	const RUN_LOG_LIMIT = 20000;

	const state = {
		installed: false,
		originalInputCheck: null,
		originalInputPressed: null,
		originalPokiInputCheck: null,
		originalPokiInputPressed: null,
		originalCollectCircle: null,
		originalPlayerCreate: null,
		originalSplitSave: null,
		splitSaveTimer: null,
		splitSaveArgs: null,
		virtualEnabled: false,
		playbackMode: false,
		paused: false,
		script: [{ frame: 0, input: '.' }],
		playIndex: 0,
		playLastFrame: -1,
		playLevel: null,
		inputLatchedFrame: null,
		scriptUnfreezeConsumed: false,
		physicsFrozen: true,
		unfreezeStarted: false,
		prestartRemaining: 0,
		prestartElapsed: 0,
		unfreezeSource: 'none',
		freezeLevel: null,
		freezeRoom: null,
		freezeLastFrame: null,
		freezePlayerId: null,
		freezeBigId: null,
		virtual: { L: false, R: false },
		prevVirtual: { L: false, R: false },
		domHeld: { L: false, R: false },
		capture: [],
		captureInputSample: null,
		captureDebug: [],
		lastRecoveredScript: [],
		lastRecoveredDebug: [],
		lastRecoveredReason: '',
		lastRecoveredAt: null,
		lastCaptureInput: null,
		lastFrameSeen: null,
		lastLevelSeen: null,
		consumedInput: '.',
		wallFrame: 0,
		lastDumpText: '',
		lastCP: 0,
		collectedCP: 0,
		cpTimes: [],
		exactCheckpointMode: false,
		lastPlayer: null,
		velocity: { vx: 0, vy: 0, speed: 0 },
		volume: 0.8,
		runLog: [],
		runLogStartedAt: Date.now(),
		runLogReason: 'init',
		runLogLastFrame: null,
		runLogLastLevel: null,
		runLogDropped: 0,
		runLogSequence: 0,
		runLogLastKey: null,
		clockInstalled: false,
		clockBaseMs: 0,
		clockTick: 0,
		pendingRun: null,
		activeRun: null,
		canonicalStage: 'idle',
		runRequestSequence: 0
	};
	let canonicalRetryTimer = null;

	W.__circlooTasBridge = state;

	W.__circlooTasShouldStepPhysics = () => shouldStepPhysics();
	W.__circlooTasShouldFreezeRoomUpdate = () => shouldFreezeRoomUpdate();

	function post(type, payload = {}) {
		if (W.parent && W.parent !== W) {
			W.parent.postMessage({ source: 'circloo-tas-game', type, token: SIM_TOKEN, ...payload }, '*');
		}
	}

	function callGlobal(source, ...args) {
		try {
			if (typeof W.Function !== 'function') return null;
			return W.Function('args', `try { ${source} } catch (error) { return null; }`)(args);
		} catch {
			return null;
		}
	}

	function inputOfHeld(held) {
		if (held.L && held.R) return 'LR';
		if (held.L) return 'L';
		if (held.R) return 'R';
		return '.';
	}

	function deterministicElapsedMs() {
		return (state.clockTick * 1000) / FPS;
	}

	function deterministicDateNow() {
		return state.clockBaseMs + deterministicElapsedMs();
	}

	function resetDeterministicClock() {
		if (!state.clockInstalled) return;
		const startupEpochMs = Number(
			callGlobal('return typeof _zl1 !== "undefined" ? Number(_zl1) / 1000 : null;')
		);
		state.clockBaseMs = Number.isFinite(startupEpochMs) ? startupEpochMs + 1000 : realDateNow();
		state.clockTick = 0;
	}

	function advanceDeterministicClock() {
		state.clockTick++;
		return deterministicElapsedMs();
	}

	function installDeterministicClock() {
		if (IS_SIM || state.clockInstalled) return true;
		const engineState = Number(callGlobal('return typeof _O83 !== "undefined" ? _O83 : null;'));
		if (engineState !== 3) return false;

		state.clockInstalled = true;
		resetDeterministicClock();

		try {
			function DeterministicDate(...args) {
				if (!new.target) return new RealDate(deterministicDateNow()).toString();
				return args.length ? new RealDate(...args) : new RealDate(deterministicDateNow());
			}
			DeterministicDate.UTC = RealDate.UTC;
			DeterministicDate.parse = RealDate.parse;
			DeterministicDate.now = () => Math.floor(deterministicDateNow());
			DeterministicDate.prototype = RealDate.prototype;
			Object.setPrototypeOf(DeterministicDate, RealDate);
			W.Date = DeterministicDate;
		} catch {
			state.clockInstalled = false;
			return false;
		}

		try {
			Object.defineProperty(W.performance, 'now', {
				value: () => deterministicElapsedMs(),
				configurable: true,
				writable: true
			});
		} catch {}

		W.__circlooTasClock = {
			now: deterministicDateNow,
			reset: resetDeterministicClock
		};
		return true;
	}

	function installFixedRaf() {
		if (IS_SIM || W.__circlooTasFixedRaf) return;
		W.__circlooTasFixedRaf = true;

		let nextId = 1;
		const timers = new Map();

		W.requestAnimationFrame = (callback) => {
			const id = nextId++;
			const timer = REAL.setTimeout(() => {
				timers.delete(id);
				callback(state.clockInstalled ? advanceDeterministicClock() : REAL.now());
			}, 1000 / FPS);
			timers.set(id, timer);
			return id;
		};

		W.cancelAnimationFrame = (id) => {
			const timer = timers.get(id);
			if (timer != null) REAL.clearTimeout(timer);
			timers.delete(id);
		};
	}

	function parseInput(value) {
		const text = String(value || '.').toUpperCase();
		return {
			L: text.includes('L') || text.includes('<'),
			R: text.includes('R') || text.includes('>')
		};
	}

	function parseScriptInput(value) {
		const text = String(value || '.').toUpperCase();
		if (text.includes('U')) return 'U';
		return inputOfHeld(parseInput(text));
	}

	function normalizeFrame(frame, input) {
		const n = Math.round(Number(frame));
		if (!Number.isFinite(n)) return Number.NaN;
		return input === 'U' ? Math.min(0, n) : Math.max(0, n);
	}

	function parseScriptText(text) {
		return String(text || '')
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.filter((line) => !line.startsWith('#') && !line.startsWith('//'))
			.map((line) => {
				const parts = line.split(/[\s,]+/);
				return { frame: Number(parts[0]), input: parts[1] || '.' };
			});
	}

	function normalizeScript(input, options = {}) {
		const source = typeof input === 'string' ? parseScriptText(input) : Array.isArray(input) ? input : [];
		const out = [];

		for (const entry of source) {
			const normalized = parseScriptInput(entry.input);
			const frame = normalizeFrame(entry.frame, normalized);
			if (Number.isFinite(frame) && SCRIPT_INPUTS.includes(normalized)) {
				out.push({ frame, input: normalized });
			}
		}

		out.sort((a, b) => a.frame - b.frame || (a.input === 'U' ? -1 : 0) || (b.input === 'U' ? 1 : 0));

		const compact = [];
		for (const entry of out) {
			if (compact.length && compact[compact.length - 1].frame === entry.frame && compact[compact.length - 1].input !== 'U' && entry.input !== 'U') {
				compact[compact.length - 1] = entry;
			} else if (!compact.length || compact[compact.length - 1].input !== entry.input) {
				compact.push(entry);
			}
		}

		return compact;
	}

	function serializeScript(script) {
		return normalizeScript(script)
			.map((entry) => `${entry.frame} ${entry.input}`)
			.join('\n');
	}

	function compactCapturedScript(script) {
		const out = [];
		for (const entry of Array.isArray(script) ? script : []) {
			const input = parseScriptInput(entry.input);
			const frame = normalizeFrame(entry.frame, input);
			if (!Number.isFinite(frame) || !SCRIPT_INPUTS.includes(input)) continue;
			if (out.length && out[out.length - 1].frame === frame && out[out.length - 1].input !== 'U' && input !== 'U') {
				out[out.length - 1] = { frame, input };
			} else if (!out.length || out[out.length - 1].input !== input) {
				out.push({ frame, input });
			}
		}
		if (!out.length) return [];
		return out;
	}

	function serializeCapturedScript(script) {
		return compactCapturedScript(script)
			.map((entry) => `${entry.frame} ${entry.input}`)
			.join('\n');
	}

	function gmObj(id) {
		try {
			if (!W.__circlooTasGetObject && typeof W.Function === 'function') {
				W.__circlooTasGetObject = W.Function(
					'type',
					[
						'try {',
						'  var list = typeof _nf === "function" ? _nf(type) : null;',
						'  if (list) {',
						'    for (var key in list) {',
						'      if (!Object.prototype.hasOwnProperty.call(list, key)) continue;',
						'      if (!/^\\d+$/.test(String(key))) continue;',
						'      var item = list[key];',
						'      if (item && !item._qf && item._rf) return item;',
						'    }',
						'  }',
						'} catch (error) {}',
						'return null;'
					].join('\n')
				);
			}
			if (typeof W.__circlooTasGetObject === 'function') {
				const object = W.__circlooTasGetObject(id);
				if (object) return object;
			}
			if (!W.__circlooTasGetInstance && typeof W.Function === 'function') {
				W.__circlooTasGetInstance = W.Function(
					'id',
					'try { return typeof _id === "function" ? _id(id) : null; } catch (error) { return null; }'
				);
			}
			if (typeof W.__circlooTasGetInstance === 'function') return W.__circlooTasGetInstance(id);
			if (typeof W._id === 'function') return W._id(id);
			if (typeof W._Kd === 'function') return W._Kd(id);
			if (typeof W._He === 'function') return W._He(id);
			return null;
		} catch {
			return null;
		}
	}

	function gmLevel() {
		const candidates = [W.global && W.global._hc, W.global && W.global._Kc, W.global && W.global._Ad];
		for (const candidate of candidates) {
			const n = Number(candidate);
			if (Number.isFinite(n)) return n;
		}
		return null;
	}

	function gmPlayer() {
		return gmObj(20);
	}

	function hasPlayer() {
		return !!gmPlayer();
	}

	function gmBig() {
		return gmObj(1);
	}

	function gameFrame() {
		const player = gmPlayer();
		const candidates = [player && player._hq, player && player._ip, player && player._In];
		for (const candidate of candidates) {
			const n = Number(candidate);
			if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
		}
		return 0;
	}

	function captureFrame() {
		const frame = gameFrame();
		return hasPlayer() ? frame : state.wallFrame;
	}

	function radiusCP() {
		const big = gmBig();
		if (!big) return 0;

		const radius = Number.isFinite(Number(big._Ld))
			? Number(big._Ld)
			: Number.isFinite(Number(big._Ie))
				? Number(big._Ie)
				: Number.isFinite(Number(big._jd))
					? Number(big._jd)
					: 0;
		const step = Number.isFinite(Number(big._Pd)) && Number(big._Pd) > 0
			? Number(big._Pd)
			: Number.isFinite(Number(big._Me)) && Number(big._Me) > 0
				? Number(big._Me)
				: Number.isFinite(Number(big._nd)) && Number(big._nd) > 0
					? Number(big._nd)
					: 200;

		return Math.max(0, Math.floor((radius + 0.01) / step) - 1);
	}

	function currentCP() {
		return Math.max(radiusCP(), state.collectedCP);
	}

	function playerPos() {
		const player = gmPlayer();
		if (!player) return null;
		const x = Number(player.x);
		const y = Number(player.y);
		return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
	}

	function gameReady() {
		return (
			!!D.getElementById('canvas') &&
			(typeof W._J3 === 'function' ||
				typeof W._t4 === 'function' ||
				typeof W._R4 === 'function')
		);
	}

	function unlockAllLevels() {
		return !!callGlobal(
			[
				'if (typeof global === "undefined" || !global) return false;',
				'var maxLevel = Number(global._kc);',
				'if (!Number.isFinite(maxLevel) || maxLevel <= 0) return false;',
				'global._oc = maxLevel;',
				'return true;'
			].join('\n')
		);
	}

	function freezeApplies() {
		return simRoomId() === 5 && simHasPhysicsWorld() && !!gmBig();
	}

	function resetFreeze(level = gmLevel()) {
		state.physicsFrozen = true;
		state.unfreezeStarted = false;
		state.prestartRemaining = 0;
		state.prestartElapsed = 0;
		state.unfreezeSource = 'none';
		state.freezeLevel = level;
		state.freezeRoom = simRoomId();
		state.freezeLastFrame = Number.isFinite(gameFrame()) ? gameFrame() : null;
		state.freezePlayerId = finiteNumber(gmPlayer() && gmPlayer().id);
		state.freezeBigId = finiteNumber(gmBig() && gmBig().id);
		state.scriptUnfreezeConsumed = false;
		setVirtualInput('.');
	}

	function unfreezeEntry() {
		return state.script.find((entry) => entry.input === 'U') || null;
	}

	function beginUnfreeze(frames = 0, source = 'manual') {
		if (state.unfreezeStarted) return;
		state.unfreezeStarted = true;
		state.physicsFrozen = false;
		state.prestartRemaining = Math.max(0, Math.floor(Number(frames) || 0));
		state.prestartElapsed = 0;
		state.unfreezeSource = source;
		updateFreezeHint();
	}

	function requestManualUnfreeze() {
		if (!freezeApplies()) return false;
		if (!hasPlayer()) return false;
		if (state.prestartRemaining > 0) return false;
		beginUnfreeze(0, 'manual');
		return true;
	}

	function maybeConsumeScriptUnfreeze() {
		if (!state.playbackMode || state.paused || state.scriptUnfreezeConsumed) return;
		if (!hasPlayer()) return;
		const entry = unfreezeEntry();
		if (!entry) return;
		state.scriptUnfreezeConsumed = true;
		beginUnfreeze(Math.abs(Math.floor(Number(entry.frame) || 0)), 'script');
		while (state.playIndex < state.script.length && state.script[state.playIndex].input === 'U') {
			state.playIndex++;
		}
	}

	function prestartReady() {
		return freezeApplies() && hasPlayer() && state.unfreezeStarted && state.prestartRemaining <= 0;
	}

	function inputLocked() {
		return freezeApplies() && !prestartReady();
	}

	function syncFreezeLifecycle() {
		const room = simRoomId();
		const level = gmLevel();
		const frame = gameFrame();
		const playerId = finiteNumber(gmPlayer() && gmPlayer().id);
		const bigId = finiteNumber(gmBig() && gmBig().id);
		const roomChanged = state.freezeRoom !== null && room !== state.freezeRoom;
		const levelChanged = state.freezeLevel !== null && level !== state.freezeLevel;
		const frameRewind =
			state.freezeLastFrame !== null &&
			Number.isFinite(frame) &&
			frame < state.freezeLastFrame - 3;
		const playerChanged =
			state.unfreezeStarted &&
			state.freezePlayerId !== null &&
			playerId !== null &&
			playerId !== state.freezePlayerId;
		const bigChanged =
			state.unfreezeStarted &&
			state.freezeBigId !== null &&
			bigId !== null &&
			bigId !== state.freezeBigId;

		if (roomChanged || levelChanged || frameRewind || playerChanged || bigChanged) {
			rememberRecoveredRun('freeze-lifecycle-reset');
			resetFreeze(level);
		} else {
			if (state.freezeRoom === null) state.freezeRoom = room;
			if (state.freezeLevel === null) state.freezeLevel = level;
			if (state.freezePlayerId === null && playerId !== null) state.freezePlayerId = playerId;
			if (state.freezeBigId === null && bigId !== null) state.freezeBigId = bigId;
		}

		if (Number.isFinite(frame)) state.freezeLastFrame = frame;
	}

	function shouldStepPhysics() {
		if (!freezeApplies()) return true;
		syncFreezeLifecycle();
		if (!hasPlayer()) return IS_SIM;
		maybeConsumeScriptUnfreeze();
		if (!state.unfreezeStarted) {
			state.physicsFrozen = true;
			return false;
		}
		state.physicsFrozen = false;
		if (gameFrame() === 0) state.prestartElapsed++;
		if (state.prestartRemaining > 0) state.prestartRemaining--;
		return true;
	}

	function shouldFreezeRoomUpdate() {
		if (!freezeApplies()) return false;
		if (!hasPlayer()) return false;
		syncFreezeLifecycle();
		return !state.unfreezeStarted;
	}

	function freezeSnapshot() {
		return {
			applies: freezeApplies(),
			room: simRoomId(),
			level: gmLevel(),
			lastFrame: state.freezeLastFrame,
			playerId: state.freezePlayerId,
			bigId: state.freezeBigId,
			hasPlayer: hasPlayer(),
			hasBig: !!gmBig(),
			hasPhysicsWorld: simHasPhysicsWorld(),
			physicsFrozen: state.physicsFrozen,
			roomUpdateFrozen: shouldFreezeRoomUpdate(),
			unfreezeStarted: state.unfreezeStarted,
			prestartRemaining: state.prestartRemaining,
			prestartElapsed: state.prestartElapsed,
			unfreezeSource: state.unfreezeSource
		};
	}

	function simRoomId() {
		const id = Number(callGlobal('return typeof _Ux !== "undefined" && _Ux ? _Ux.id : null;'));
		return Number.isFinite(id) ? id : null;
	}

	function simHasPhysicsWorld() {
		return !!callGlobal('return !!(typeof _Ux !== "undefined" && _Ux && _Ux._Xc1);');
	}

	function simRuntimeReady() {
		const engineState = Number(callGlobal('return typeof _O83 !== "undefined" ? _O83 : null;'));
		return engineState === 3 && simRoomId() === 5 && simHasPhysicsWorld() && !!gmObj(4);
	}

	function ensureSimPlayRoom() {
		if (!IS_SIM) return true;
		if (simRoomId() !== 5) {
			callGlobal('if (typeof _v93 === "function") { _v93(5); return true; } return false;');
		}
		if (typeof W.__circlooTasPumpFrame === 'function') {
			for (let i = 0; i < 180; i++) {
				if (simRuntimeReady()) return true;
				W.__circlooTasPumpFrame();
			}
		}
		return simRuntimeReady();
	}

	function setVolume(value) {
		const volume = Math.max(0, Math.min(1, Number(value)));
		state.volume = Number.isFinite(volume) ? volume : state.volume;

		try {
			for (const media of D.querySelectorAll('audio, video')) {
				media.volume = state.volume;
				media.muted = state.volume <= 0;
			}
		} catch {}

		try {
			if (typeof W._Wm === 'function') W._Wm(state.volume);
		} catch {}

		for (const gain of [W._rg1, W._sf1]) {
			try {
				if (gain && gain.gain) gain.gain.value = state.volume;
			} catch {}
		}
	}

	function ensureFreezeHint() {
		if (IS_SIM) return null;
		let hint = D.getElementById('circloo-tas-freeze-hint');
		if (hint) return hint;

		hint = D.createElement('div');
		hint.id = 'circloo-tas-freeze-hint';
		hint.textContent = 'Press U to unfreeze or script it like: "-122 U\n0 L..."';
		Object.assign(hint.style, {
			position: 'fixed',
			left: '50%',
			top: '18px',
			transform: 'translateX(-50%)',
			zIndex: '100000',
			padding: '7px 10px',
			borderRadius: '6px',
			background: 'rgba(15, 18, 24, 0.82)',
			color: '#f4f6fb',
			font: '600 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
			letterSpacing: '0',
			boxShadow: '0 6px 18px rgba(0, 0, 0, 0.28)',
			pointerEvents: 'none',
			userSelect: 'none',
			whiteSpace: 'pre-line',
			display: 'none'
		});
		D.body.appendChild(hint);
		return hint;
	}

	function updateFreezeHint() {
		const hint = ensureFreezeHint();
		if (!hint) return;
		hint.style.display = freezeApplies() && !state.unfreezeStarted ? 'block' : 'none';
	}

	function physicsWrapper() {
		return callGlobal('return typeof _Ux !== "undefined" && _Ux && _Ux._Xc1 ? _Ux._Xc1 : null;');
	}

	function physicsWorld() {
		const wrapper = physicsWrapper();
		return wrapper && wrapper._FB1 ? wrapper._FB1 : wrapper;
	}

	function finiteNumber(value) {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}

	function vec(value) {
		if (!value || typeof value !== 'object') return null;
		const out = {};
		for (const key of ['x', 'y', '_kC', '_7U', '_67']) {
			if (Number.isFinite(Number(value[key]))) out[key] = Number(value[key]);
		}
		return Object.keys(out).length ? out : null;
	}

	function primitiveFields(object, limit = 140) {
		if (!object || typeof object !== 'object') return {};
		const out = {};
		let count = 0;
		for (const key of Object.keys(object).sort()) {
			if (count >= limit) {
				out.__truncated = true;
				break;
			}
			const value = object[key];
			if (value == null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
				out[key] = value;
				count++;
			} else if (Array.isArray(value)) {
				const sample = value.slice(0, 24).map((item) => {
					if (item == null || typeof item === 'number' || typeof item === 'string' || typeof item === 'boolean') return item;
					return typeof item;
				});
				out[key] = { length: value.length, sample };
				count++;
			}
		}
		return out;
	}

	function runtimeSnapshot() {
		return (
			callGlobal(
				[
					'var out = {};',
					'var names = ["_O83","_Q83","_R83","_S83","_T83","_UT","_U83","_mm2","_Z83","__83","_093","_Qm2","_sf1","_Vm2","_Oz2"];',
					'for (var i = 0; i < names.length; i++) {',
					'  try { out[names[i]] = eval(names[i]); } catch (error) {}',
					'}',
					'try { out.gameClock = typeof _GY === "function" ? _GY() : null; } catch (error) {}',
					'try { out.dateNow = Date.now(); } catch (error) {}',
					'try { out.performanceNow = performance && performance.now ? performance.now() : null; } catch (error) {}',
					'if (typeof _cd !== "undefined" && _cd) {',
					'  out._cd = {',
					'    _bs: _cd._bs, _hJ2: _cd._hJ2, _HI2: _cd._HI2, _EI2: _cd._EI2, _FI2: _cd._FI2,',
					'    _gd: _cd._gd, _hd: _cd._hd, _an: _cd._an, _bn: _cd._bn, _ol1: (typeof _ol1 !== "undefined" ? _ol1 : null), _nl1: (typeof _nl1 !== "undefined" ? _nl1 : null)',
					'  };',
					'}',
					'if (typeof _Ux !== "undefined" && _Ux) {',
					'  out._Ux = {',
					'    roomSpeed: (typeof _Ux._Vx === "function" ? _Ux._Vx() : null),',
					'    physicsStep: _Ux._AJ2, physicsPaused: _Ux._C_2, hasPhysics: !!_Ux._Xc1',
					'  };',
					'}',
					'if (typeof global !== "undefined" && global) {',
					'  out.global = { _hc: global._hc, _Kc: global._Kc, _Ad: global._Ad, _mc: global._mc, _jc: global._jc, _Fc: global._Fc, _pc: global._pc };',
					'}',
					'if (typeof _Xx !== "undefined" && _Xx) {',
					'  out._Xx = { fps: _Xx._zY, accumMicros: _Xx._wY, lastClock: _Xx._xY, paused: _Xx._yY, deltaMicros: _Xx._AY };',
					'}',
					'return out;'
				].join('\n')
			) || {}
		);
	}

	function physicsWrapperSnapshot() {
		const wrapper = physicsWrapper();
		if (!wrapper) return null;
		return {
			scale: finiteNumber(wrapper._sd1),
			stepRate: finiteNumber(wrapper._K62),
			paused: !!wrapper._yY,
			velocityIterations: finiteNumber(wrapper._L62),
			positionIterations: finiteNumber(wrapper._L62),
			contactsBuffered: Array.isArray(wrapper._JB1) ? wrapper._JB1.length : null,
			particles: wrapper._N62 ? primitiveFields(wrapper._N62, 40) : null
		};
	}

	function fixtureSnapshot(fixture, index) {
		const filter = typeof fixture._JD1 === 'function' ? fixture._JD1() : null;
		return {
			index,
			type: typeof fixture._bs1 === 'function' ? fixture._bs1() : null,
			density: typeof fixture._MD1 === 'function' ? finiteNumber(fixture._MD1()) : null,
			friction: typeof fixture._ND1 === 'function' ? finiteNumber(fixture._ND1()) : null,
			restitution: typeof fixture._OD1 === 'function' ? finiteNumber(fixture._OD1()) : null,
			sensor: typeof fixture._GD1 === 'function' ? !!fixture._GD1() : null,
			filter: filter
				? {
						categoryBits: finiteNumber(filter._sD1),
						maskBits: finiteNumber(filter._tD1),
						groupIndex: finiteNumber(filter._uD1)
					}
				: null,
			raw: primitiveFields(fixture, 32)
		};
	}

	function bodySnapshot(body, index, scale) {
		const instance = typeof body._bu1 === 'function' ? body._bu1() : null;
		const position = typeof body._Rc1 === 'function' ? body._Rc1() : null;
		const worldCenter = typeof body._wC1 === 'function' ? body._wC1() : null;
		const localCenter = typeof body._xC1 === 'function' ? body._xC1() : null;
		const linearVelocity = typeof body._zC1 === 'function' ? body._zC1() : null;
		const force = body._RB1 || null;
		const sweep = body._HB1 || null;
		const fixtures = [];

		try {
			for (
				let fixture = typeof body._hD1 === 'function' ? body._hD1() : null, fixtureIndex = 0;
				fixture;
				fixture = typeof fixture._kD1 === 'function' ? fixture._kD1() : null, fixtureIndex++
			) {
				fixtures.push(fixtureSnapshot(fixture, fixtureIndex));
			}
		} catch {}

		return {
			index,
			instance: instance
				? {
						id: finiteNumber(instance.id),
						objectIndex: finiteNumber(instance._Ok),
						x: finiteNumber(instance.x),
						y: finiteNumber(instance.y),
						physicsX: finiteNumber(instance._972),
						physicsY: finiteNumber(instance._a72),
						fields: primitiveFields(instance, 90)
					}
				: null,
			type: typeof body._bs1 === 'function' ? body._bs1() : null,
			flags: finiteNumber(body._zB1),
			position: vec(position),
			positionPixels:
				position && Number.isFinite(scale) && scale !== 0
					? { x: finiteNumber(position.x / scale), y: finiteNumber(position.y / scale) }
					: null,
			angle: typeof body._Hq1 === 'function' ? finiteNumber(body._Hq1()) : null,
			worldCenter: vec(worldCenter),
			localCenter: vec(localCenter),
			linearVelocity: vec(linearVelocity),
			angularVelocity: typeof body._BC1 === 'function' ? finiteNumber(body._BC1()) : null,
			linearDamping: typeof body._YC1 === 'function' ? finiteNumber(body._YC1()) : null,
			angularDamping: typeof body._ZC1 === 'function' ? finiteNumber(body._ZC1()) : null,
			gravityScale: typeof body.__C1 === 'function' ? finiteNumber(body.__C1()) : null,
			mass: typeof body._LC1 === 'function' ? finiteNumber(body._LC1()) : null,
			inertia: typeof body._MC1 === 'function' ? finiteNumber(body._MC1()) : null,
			invMass: finiteNumber(body._WB1),
			invI: finiteNumber(body._YB1),
			force: vec(force),
			torque: finiteNumber(body._SB1),
			sleepTime: finiteNumber(body._TB1),
			allowSleep: typeof body._bD1 === 'function' ? !!body._bD1() : null,
			awake: typeof body._cD1 === 'function' ? !!body._cD1() : null,
			active: typeof body._eD1 === 'function' ? !!body._eD1() : null,
			bullet: typeof body._9D1 === 'function' ? !!body._9D1() : null,
			fixedRotation: typeof body._gD1 === 'function' ? !!body._gD1() : null,
			sweep: sweep
				? {
						localCenter: vec(sweep._Nq1),
						c0: vec(sweep._Oq1),
						c: vec(sweep._67),
						a0: finiteNumber(sweep._Qq1),
						a: finiteNumber(sweep._RA),
						alpha0: finiteNumber(sweep._Rq1)
					}
				: null,
			fixtures,
			raw: primitiveFields(body, 80)
		};
	}

	function contactSnapshot(contact, index, bodyIds) {
		let fixtureA = null;
		let fixtureB = null;
		try {
			fixtureA = typeof contact._pC1 === 'function' ? contact._pC1() : contact._2G1 || null;
			fixtureB = typeof contact._rC1 === 'function' ? contact._rC1() : contact._4G1 || null;
		} catch {}
		const bodyA = fixtureA && typeof fixtureA._LD1 === 'function' ? fixtureA._LD1() : null;
		const bodyB = fixtureB && typeof fixtureB._LD1 === 'function' ? fixtureB._LD1() : null;
		return {
			index,
			bodyA: bodyIds.get(bodyA) ?? null,
			bodyB: bodyIds.get(bodyB) ?? null,
			touching: typeof contact.__F1 === 'function' ? !!contact.__F1() : null,
			enabled: typeof contact._0G1 === 'function' ? !!contact._0G1() : null,
			continuous: !!(contact._zB1 & 4),
			flags: finiteNumber(contact._zB1),
			toi: finiteNumber(contact._9G1),
			toiCount: finiteNumber(contact._8G1),
			manifold: {
				pointCount: finiteNumber(contact._Mo1 && contact._Mo1._fA),
				type: finiteNumber(contact._Mo1 && contact._Mo1.type)
			},
			raw: primitiveFields(contact, 48)
		};
	}

	function jointSnapshot(joint, index, bodyIds) {
		let bodyA = null;
		let bodyB = null;
		try {
			bodyA = typeof joint._pG1 === 'function' ? joint._pG1() : joint._eF1 || null;
			bodyB = typeof joint._qG1 === 'function' ? joint._qG1() : joint._cF1 || null;
		} catch {}
		return {
			index,
			type: typeof joint._bs1 === 'function' ? joint._bs1() : finiteNumber(joint._oR1),
			bodyA: bodyIds.get(bodyA) ?? null,
			bodyB: bodyIds.get(bodyB) ?? null,
			anchorA: typeof joint._rG1 === 'function' ? vec(joint._rG1()) : null,
			anchorB: typeof joint._sG1 === 'function' ? vec(joint._sG1()) : null,
			collideConnected: !!joint._iF1,
			raw: primitiveFields(joint, 56)
		};
	}

	function physicsSnapshot() {
		const world = physicsWorld();
		const wrapper = physicsWrapper();
		if (!world) return { wrapper: physicsWrapperSnapshot(), world: null, bodies: [], contacts: [], joints: [] };

		const scale = Number(wrapper && wrapper._sd1);
		const bodies = [];
		const bodyIds = new Map();
		try {
			for (
				let body = typeof world._DF1 === 'function' ? world._DF1() : null, index = 0;
				body;
				body = typeof body._kD1 === 'function' ? body._kD1() : null, index++
			) {
				bodyIds.set(body, index);
				bodies.push(bodySnapshot(body, index, scale));
			}
		} catch {}

		const contacts = [];
		try {
			for (
				let contact = typeof world._jD1 === 'function' ? world._jD1() : world._eC1 && world._eC1._JB1, index = 0;
				contact;
				contact = typeof contact._kD1 === 'function' ? contact._kD1() : contact._LB1 || null, index++
			) {
				contacts.push(contactSnapshot(contact, index, bodyIds));
			}
		} catch {}

		const joints = [];
		try {
			for (
				let joint = typeof world._iD1 === 'function' ? world._iD1() : null, index = 0;
				joint;
				joint = typeof joint._kD1 === 'function' ? joint._kD1() : joint._LB1 || null, index++
			) {
				joints.push(jointSnapshot(joint, index, bodyIds));
			}
		} catch {}

		return {
			wrapper: physicsWrapperSnapshot(),
			world: {
				bodyCount: typeof world._MF1 === 'function' ? finiteNumber(world._MF1()) : bodies.length,
				jointCount: typeof world._NF1 === 'function' ? finiteNumber(world._NF1()) : joints.length,
				allowSleep: typeof world._FF1 === 'function' ? !!world._FF1() : null,
				warmStarting: typeof world._HF1 === 'function' ? !!world._HF1() : null,
				continuousPhysics: typeof world._JF1 === 'function' ? !!world._JF1() : null,
				subStepping: typeof world._LF1 === 'function' ? !!world._LF1() : null,
				flags: finiteNumber(world._zB1),
				gravity: vec(world._IE1),
				proxyCount: typeof world._fu1 === 'function' ? finiteNumber(world._fu1()) : null,
				raw: primitiveFields(world, 60)
			},
			bodies,
			contacts,
			joints
		};
	}

	function frameSnapshot() {
		const player = gmPlayer();
		const big = gmBig();
		const frame = gameFrame();
		const level = gmLevel();
		const activeInput = effectiveInput();
		return {
			sequence: state.runLogSequence++,
			wallFrame: state.wallFrame,
			level,
			frame,
			timeSeconds: frame / FPS,
			cp: currentCP(),
			cpTimes: state.cpTimes.slice(),
			input: {
				active: activeInput,
				virtual: { ...state.virtual },
				prevVirtual: { ...state.prevVirtual },
				domHeld: { ...state.domHeld },
				playbackMode: state.playbackMode,
				playIndex: state.playIndex,
				playLastFrame: state.playLastFrame,
				playLevel: state.playLevel
			},
			freeze: freezeSnapshot(),
			player: player ? primitiveFields(player, 180) : null,
			big: big ? primitiveFields(big, 120) : null,
			runtime: runtimeSnapshot(),
			physics: physicsSnapshot()
		};
	}

	function resetRunLog(reason = 'reset') {
		state.runLog = [];
		state.runLogStartedAt = Date.now();
		state.runLogReason = reason;
		state.runLogLastFrame = null;
		state.runLogLastLevel = null;
		state.runLogDropped = 0;
		state.runLogSequence = 0;
		state.runLogLastKey = null;
	}

	function beginFreshRun(reason = 'run-start') {
		rememberRecoveredRun(reason);
		resetRunLog(reason);
		state.collectedCP = radiusCP();
		state.lastCP = currentCP();
		state.cpTimes = state.cpTimes.slice(0, state.lastCP + 1);
		resetFreeze(gmLevel());
		if (state.playbackMode) {
			resetPlayback(gmLevel());
		}
	}

	function recordRunFrame(reason = 'tick') {
		const level = gmLevel();
		const frame = gameFrame();
		const frameRewind = state.runLogLastFrame !== null && frame < state.runLogLastFrame - 3;
		if (
			((state.runLogLastLevel !== null && level !== state.runLogLastLevel) || frameRewind) &&
			state.runLog.length > 0 &&
			reason === 'tick'
		) {
			beginFreshRun(frameRewind ? 'frame-rewind' : 'level-change');
		}
		state.runLogLastLevel = level;
		state.runLogLastFrame = frame;

		const key =
			frame === 0 && state.unfreezeStarted
				? `${level}:${frame}:prestart:${state.prestartElapsed}`
				: `${level}:${frame}`;
		if (reason === 'tick' && key === state.runLogLastKey && state.runLog.length) {
			const last = state.runLog[state.runLog.length - 1];
			last.monitorTicks = (last.monitorTicks || 1) + 1;
			last.wallFrameEnd = state.wallFrame;
			return;
		}

		if (state.runLog.length >= RUN_LOG_LIMIT) {
			state.runLog.shift();
			state.runLogDropped++;
		}
		const snapshot = frameSnapshot();
		snapshot.reason = reason;
		snapshot.monitorTicks = 1;
		snapshot.wallFrameStart = state.wallFrame;
		snapshot.wallFrameEnd = state.wallFrame;
		state.runLog.push(snapshot);
		state.runLogLastKey = key;
	}

	function dumpRunLog() {
		if (!state.runLog.length) recordRunFrame('manual-dump');
		const now = new Date();
		const level = gmLevel();
		const frame = gameFrame();
		const stamp = now.toISOString().replace(/[:.]/g, '-');
		const payload = {
			format: 'circloo-tas-run-log-v1',
			createdAt: now.toISOString(),
			page: W.location.href,
			userAgent: W.navigator && W.navigator.userAgent,
			fps: FPS,
			reason: state.runLogReason,
			startedAt: new Date(state.runLogStartedAt).toISOString(),
			level,
			frame,
			droppedFrames: state.runLogDropped,
			settings: {
				script: state.script.slice()
			},
			capture: {
				script: currentRunScript(),
				debug: currentRunDebug()
			},
			currentTelemetry: telemetry(),
			frames: state.runLog
		};
		const text = JSON.stringify(payload, null, 2);
		post('RUN_DUMP', {
			filename: `circloo-run-l${level ?? 'x'}-f${frame}-${stamp}.json`,
			text,
			frames: state.runLog.length
		});
	}

	function setVirtualInput(input) {
		state.prevVirtual = { ...state.virtual };
		state.virtual = parseInput(input);
	}

	function resetPlayback(level = gmLevel()) {
		state.playIndex = 0;
		state.playLastFrame = -1;
		state.playLevel = level;
		state.inputLatchedFrame = null;
		state.scriptUnfreezeConsumed = false;
		state.prevVirtual = { L: false, R: false };
		state.virtual = { L: false, R: false };
	}

	function applyPlaybackForFrame(frame) {
		if (!state.playbackMode || state.paused) return;

		const level = gmLevel();
		if (state.playLevel == null || level !== state.playLevel) resetPlayback(level);
		if (!Number.isFinite(frame)) return;
		maybeConsumeScriptUnfreeze();
		if (!prestartReady()) {
			state.prevVirtual = { L: false, R: false };
			state.virtual = { L: false, R: false };
			state.inputLatchedFrame = null;
			return;
		}
		if (state.playLastFrame >= 0 && frame < state.playLastFrame - 1) resetPlayback(level);
		if (state.inputLatchedFrame === frame) return;

		state.prevVirtual = { ...state.virtual };
		let nextVirtual = { ...state.virtual };
		state.playLastFrame = frame;
		while (state.playIndex < state.script.length && state.script[state.playIndex].frame <= frame) {
			if (state.script[state.playIndex].input === 'U') {
				state.playIndex++;
				continue;
			}
			nextVirtual = parseInput(state.script[state.playIndex].input);
			state.playIndex++;
		}
		state.virtual = nextVirtual;
		state.inputLatchedFrame = frame;
	}

	function isVirtualCode(code) {
		const numeric = Number(code);
		return LEFT_CODES.has(numeric) || RIGHT_CODES.has(numeric);
	}

	function virtualCheck(code) {
		const numeric = Number(code);
		applyPlaybackForFrame(gameFrame());
		if (LEFT_CODES.has(numeric)) return state.virtual.L ? 1 : 0;
		if (RIGHT_CODES.has(numeric)) return state.virtual.R ? 1 : 0;
		return 0;
	}

	function virtualPressed(code) {
		const numeric = Number(code);
		applyPlaybackForFrame(gameFrame());
		if (LEFT_CODES.has(numeric)) return state.virtual.L && !state.prevVirtual.L ? 1 : 0;
		if (RIGHT_CODES.has(numeric)) return state.virtual.R && !state.prevVirtual.R ? 1 : 0;
		return 0;
	}

	function sameGameInstance(a, b) {
		if (!a || !b) return false;
		if (a === b) return true;
		const aId = Number(a.id);
		const bId = Number(b.id);
		return Number.isFinite(aId) && Number.isFinite(bId) && aId === bId;
	}

	function shouldUseVirtualInput(self, code) {
		return state.virtualEnabled && state.playbackMode && !state.paused && isVirtualCode(code);
	}

	function shouldCaptureInput(self, code) {
		if (IS_SIM || state.paused || !isVirtualCode(code) || inputLocked()) return false;
		const player = gmPlayer();
		return sameGameInstance(self, player) || sameGameInstance(this, player);
	}

	function gatedNativeInput(self, code, value) {
		if (!isVirtualCode(code) || !inputLocked()) return value;
		const player = gmPlayer();
		if (sameGameInstance(self, player) || sameGameInstance(this, player)) return 0;
		return value;
	}

	function inputCheckGroupDone(code, value) {
		const numeric = Number(code);
		const pressed = Number(value) > 0.5;
		return numeric === 65 || numeric === 68 || ((numeric === 37 || numeric === 39) && pressed);
	}

	function recordCaptureInput(frame, input) {
		if (!hasPlayer()) return;
		if (!Number.isFinite(frame)) return;

		const level = gmLevel();
		if (state.lastLevelSeen !== null && level !== state.lastLevelSeen) resetCapture();
		if (state.lastFrameSeen !== null && frame < state.lastFrameSeen - 3) resetCapture();

		state.lastFrameSeen = frame;
		state.lastLevelSeen = level;
		state.consumedInput = input;

		if (state.lastCaptureInput === null || input !== state.lastCaptureInput) {
			state.capture.push({ frame, input });
			state.lastCaptureInput = input;
		}
	}

	function captureInputCheck(self, code, value) {
		if (!shouldCaptureInput.call(this, self, code)) return;
		const frame = gameFrame();
		const numeric = Number(code);
		const pressed = Number(value) > 0.5;
		const level = gmLevel();

		if (
			!state.captureInputSample ||
			state.captureInputSample.frame !== frame ||
			state.captureInputSample.level !== level
		) {
			state.captureInputSample = {
				frame,
				level,
				L: false,
				R: false,
				seenL: false,
				seenR: false
			};
		}

		const sample = state.captureInputSample;
		if (numeric === 37 || numeric === 65) {
			if (pressed) sample.L = true;
			if (inputCheckGroupDone(numeric, value)) sample.seenL = true;
		}
		if (numeric === 39 || numeric === 68) {
			if (pressed) sample.R = true;
			if (inputCheckGroupDone(numeric, value)) sample.seenR = true;
		}

		pushCaptureDebug({
			wallFrame: state.wallFrame,
			level,
			frame,
			code: numeric,
			value: pressed ? 1 : 0,
			input: inputOfHeld(sample),
			seenL: sample.seenL,
			seenR: sample.seenR
		});

		if (sample.seenL && sample.seenR) {
			recordCaptureInput(frame, inputOfHeld(sample));
		}
	}

	function pushCaptureDebug(event) {
		state.captureDebug.push(event);
		if (state.captureDebug.length > 4000) state.captureDebug.shift();
	}

	function nativeInputHeld(code) {
		if (inputLocked() && isVirtualCode(code)) return false;
		const check = state.originalInputCheck || (typeof W._J3 === 'function' ? W._J3 : null);
		if (typeof check !== 'function') return false;

		try {
			return check.call(W, gmObj(0) || {}, gmObj(0) || {}, code) > 0.5;
		} catch {
			return false;
		}
	}

	function liveHeld() {
		return {
			L: state.domHeld.L || nativeInputHeld(37) || nativeInputHeld(65),
			R: state.domHeld.R || nativeInputHeld(39) || nativeInputHeld(68)
		};
	}

	function liveInput() {
		return inputOfHeld(liveHeld());
	}

	function effectiveInput() {
		if (!state.playbackMode) return state.consumedInput;
		return inputOfHeld(state.virtual);
	}

	function patchInput() {
		if (state.installed || !gameReady()) return false;

		const inputCheckName = typeof W._J3 === 'function' ? '_J3' : typeof W._t4 === 'function' ? '_t4' : null;
		const inputPressedName = typeof W._K3 === 'function' ? '_K3' : typeof W._u4 === 'function' ? '_u4' : null;

		if (inputCheckName) {
			state.originalInputCheck = W[inputCheckName];
			W[inputCheckName] = function patchedInputCheck(self, other, code) {
				if (shouldUseVirtualInput.call(this, self, code)) return virtualCheck(code);
				const nativeValue = state.originalInputCheck.apply(this, arguments);
				const gatedNativeValue = gatedNativeInput.call(this, self, code, nativeValue);
				captureInputCheck.call(this, self, code, gatedNativeValue);
				return gatedNativeValue;
			};
		}

		if (inputPressedName) {
			state.originalInputPressed = W[inputPressedName];
			W[inputPressedName] = function patchedInputPressed(self, other, code) {
				if (shouldUseVirtualInput.call(this, self, code)) return virtualPressed(code);
				const nativeValue = state.originalInputPressed.apply(this, arguments);
				return gatedNativeInput.call(this, self, code, nativeValue);
			};
		}

		if (typeof W._R4 === 'function') {
			state.originalPokiInputCheck = W._R4;
			W._R4 = function patchedPokiInputCheck(self, other, code) {
				if (shouldUseVirtualInput.call(this, self, code)) return virtualCheck(code);
				const nativeValue = state.originalPokiInputCheck.apply(this, arguments);
				const gatedNativeValue = gatedNativeInput.call(this, self, code, nativeValue);
				captureInputCheck.call(this, self, code, gatedNativeValue);
				return gatedNativeValue;
			};
		}

		if (typeof W._S4 === 'function') {
			state.originalPokiInputPressed = W._S4;
			W._S4 = function patchedPokiInputPressed(self, other, code) {
				if (shouldUseVirtualInput.call(this, self, code)) return virtualPressed(code);
				const nativeValue = state.originalPokiInputPressed.apply(this, arguments);
				return gatedNativeInput.call(this, self, code, nativeValue);
			};
		}

		state.installed = true;
		return true;
	}

	function patchCollectCircle() {
		if (state.originalCollectCircle || typeof W._P6 !== 'function') return !!state.originalCollectCircle;

		state.originalCollectCircle = W._P6;
		W._P6 = function patchedCollectCircle(self, other) {
			const big = gmBig();
			const beforeCP = radiusCP();
			const frame = gameFrame();
			const shouldRecord =
				big &&
				!(Number(self && self._ye) > 0.5) &&
				Number.isFinite(frame) &&
				frame > 0;

			const result = state.originalCollectCircle.apply(this, arguments);

			if (shouldRecord) {
				const collectedCP = state.exactCheckpointMode ? state.collectedCP + 1 : beforeCP + 1;
				state.collectedCP = Math.max(state.collectedCP, collectedCP);
				state.lastCP = Math.max(state.lastCP, collectedCP);
				state.cpTimes[collectedCP] = frame;
				post('TELEMETRY', telemetry());
			}

			return result;
		};

		return true;
	}

	function flushSplitSave() {
		state.splitSaveTimer = null;
		const args = state.splitSaveArgs;
		state.splitSaveArgs = null;
		if (!state.originalSplitSave || !args) return;
		try {
			state.originalSplitSave.apply(W, args);
		} catch (error) {
			console.warn('[circloo-tas] Unable to persist checkpoint splits', error);
		}
	}

	function patchSplitSave() {
		if (IS_SIM || state.originalSplitSave) return true;
		if (typeof W._R6 !== 'function') return false;
		state.originalSplitSave = W._R6;
		W._R6 = function (...args) {
			state.splitSaveArgs = args;
			if (state.splitSaveTimer === null) {
				state.splitSaveTimer = REAL.setTimeout(flushSplitSave, 0);
			}
		};
		return true;
	}

	function patchPlayerCreate() {
		if (state.originalPlayerCreate || typeof W._P8 !== 'function') return !!state.originalPlayerCreate;

		state.originalPlayerCreate = W._P8;
		W._P8 = function patchedPlayerCreate(self, other) {
			const result = state.originalPlayerCreate.apply(this, arguments);
			beginFreshRun('player-create');
			resetCapture({ preserve: false });
			return result;
		};

		return true;
	}

	function patchRoomFreezeHooks() {
		return !!callGlobal(
			[
				'if (typeof __11 === "undefined" || !__11 || __11.__circlooTasFreezePatched) return !!(__11 && __11.__circlooTasFreezePatched);',
				'__11.__circlooTasFreezePatched = true;',
				'var manager = __11;',
				'var shouldFreeze = function() {',
				'  return !!(typeof window !== "undefined" && window.__circlooTasShouldFreezeRoomUpdate && window.__circlooTasShouldFreezeRoomUpdate());',
				'};',
				`var skipDraw = ${IS_SIM ? 'true' : 'false'};`,
				'var stepEvents = {};',
				'try { stepEvents[_no2] = true; } catch (error) {}',
				'try { stepEvents[_po2] = true; } catch (error) {}',
				'try { stepEvents[_ro2] = true; } catch (error) {}',
				'if (typeof manager._TO2 === "function") {',
				'  var originalTO2 = manager._TO2;',
				'  manager._TO2 = function() { if (shouldFreeze()) return; return originalTO2.apply(this, arguments); };',
				'}',
				'if (typeof manager._VO2 === "function") {',
				'  var originalVO2 = manager._VO2;',
				'  manager._VO2 = function() { if (shouldFreeze()) return; return originalVO2.apply(this, arguments); };',
				'}',
				'if (typeof manager._Hy === "function") {',
				'  var originalHy = manager._Hy;',
				'  manager._Hy = function(event) {',
				'    try { if (skipDraw && event === _Rt2) return true; } catch (error) {}',
				'    if (shouldFreeze() && stepEvents[event]) return true;',
				'    return originalHy.apply(this, arguments);',
				'  };',
				'}',
				'if (typeof _Q71 !== "undefined" && _Q71 && typeof _Q71._m81 === "function" && !_Q71.__circlooTasFreezePatched) {',
				'  _Q71.__circlooTasFreezePatched = true;',
				'  var originalTimelineStep = _Q71._m81;',
				'  _Q71._m81 = function() { if (shouldFreeze()) return; return originalTimelineStep.apply(this, arguments); };',
				'}',
				'if (skipDraw && typeof _GM2 !== "undefined" && _GM2 && _GM2.prototype && typeof _GM2.prototype._Hy === "function" && !_GM2.__circlooTasDrawPatched) {',
				'  _GM2.__circlooTasDrawPatched = true;',
				'  var originalObjectEvent = _GM2.prototype._Hy;',
				'  _GM2.prototype._Hy = function(event) {',
				'    try { if (event === _Rt2) return true; } catch (error) {}',
				'    return originalObjectEvent.apply(this, arguments);',
				'  };',
				'}',
				'if (skipDraw && typeof _Gx !== "undefined" && _Gx && !_Gx.__circlooTasFastObjectsPatched) {',
				'  _Gx.__circlooTasFastObjectsPatched = true;',
				'  var skipStepIds = [1, 2, 4, 5, 6, 8];',
				'  for (var skipIndex = 0; skipIndex < skipStepIds.length; skipIndex++) {',
				'    var skippedObject = _Gx._qH(skipStepIds[skipIndex]);',
				'    if (skippedObject && skippedObject._Ym2) skippedObject._Ym2[_po2] = false;',
				'  }',
				'  var collectObject = _Gx._qH(21);',
				'  if (collectObject) {',
				'    collectObject._l7 = function(self, other) {',
				'      var player = typeof _id === "function" ? _id(20) : null;',
				'      if (player) {',
				'        var radius = (Number(self._ye || 0) > 0.5 ? 16.8 : 24) + Number(player._jd || 0);',
				'        var dx = Number(self.x || 0) - Number(player.x || 0);',
				'        var dy = Number(self.y || 0) - Number(player.y || 0);',
				'        if (dx * dx + dy * dy < radius * radius && typeof _P6 === "function") _P6(self, other);',
				'      }',
				'      if (Number(self._tq || 0) < 1) self._tq = Number(self._tq || 0) + 0.1;',
				'    };',
				'  }',
				'}',
				'if (skipDraw && typeof _VQ2 === "function" && !_VQ2.__circlooTasInputPatched) {',
				'  var disabledInputUpdate = function() {};',
				'  disabledInputUpdate.__circlooTasInputPatched = true;',
				'  _VQ2 = disabledInputUpdate;',
				'}',
				'if (skipDraw && typeof _yC2 !== "undefined" && _yC2 && _yC2.prototype && typeof _yC2.prototype._HA === "function" && !_yC2.__circlooTasRenderPatched) {',
				'  _yC2.__circlooTasRenderPatched = true;',
				'  _yC2.prototype._HA = function() { return true; };',
				'}',
				'return true;'
			].join('\n')
		);
	}

	function patchGameHooks() {
		const inputPatched = patchInput();
		patchCollectCircle();
		patchSplitSave();
		patchPlayerCreate();
		patchRoomFreezeHooks();
		return inputPatched;
	}

	function recoveredCaptureScript() {
		const script = compactCapturedScript(state.capture);
		if (state.unfreezeStarted) {
			script.unshift({ frame: -Math.max(0, state.prestartElapsed), input: 'U' });
		}
		return compactCapturedScript(script);
	}

	function rememberRecoveredRun(reason = 'capture-reset') {
		const script = recoveredCaptureScript();
		if (!script.length) return;
		const hasUnfreeze = script.some((entry) => entry.input === 'U');
		const lastHasUnfreeze = state.lastRecoveredScript.some((entry) => entry.input === 'U');
		if (!hasUnfreeze && lastHasUnfreeze) return;
		state.lastRecoveredScript = script.map((entry) => ({ ...entry }));
		state.lastRecoveredDebug = state.captureDebug.slice();
		state.lastRecoveredReason = reason;
		state.lastRecoveredAt = Date.now();
	}

	function resetCapture(options = {}) {
		if (options.preserve !== false) rememberRecoveredRun(options.reason || 'capture-reset');
		state.capture = [];
		state.captureInputSample = null;
		state.captureDebug = [];
		state.lastCaptureInput = null;
		state.lastFrameSeen = hasPlayer() ? gameFrame() : null;
		state.lastLevelSeen = gmLevel();
		state.consumedInput = '.';
		state.collectedCP = radiusCP();
		state.lastCP = currentCP();
		state.cpTimes = [];
	}

	function currentRunScript() {
		if (state.playbackMode) {
			const recovered = recoveredCaptureScript();
			if (recovered.length) return recovered;
			if (state.lastRecoveredScript.length) return state.lastRecoveredScript.map((entry) => ({ ...entry }));
			const frame = captureFrame();
			const script = state.script.filter((entry) => entry.frame <= frame);
			return script.length ? script : [{ frame: 0, input: inputOfHeld(state.virtual) }];
		}

		const recovered = recoveredCaptureScript();
		return recovered.length ? recovered : state.lastRecoveredScript.map((entry) => ({ ...entry }));
	}

	function currentRunDebug() {
		return recoveredCaptureScript().length ? state.captureDebug.slice() : state.lastRecoveredDebug.slice();
	}

	function clearRecoveredMemory() {
		state.lastRecoveredScript = [];
		state.lastRecoveredDebug = [];
		state.lastRecoveredReason = '';
		state.lastRecoveredAt = null;
	}

	function updateCheckpointTracking() {
		if (state.exactCheckpointMode) return;
		const cp = currentCP();
		if (cp > state.lastCP) {
			for (let n = state.lastCP + 1; n <= cp; n++) {
				if (state.cpTimes[n] == null) state.cpTimes[n] = gameFrame();
			}
			state.lastCP = cp;
		} else if (cp < state.lastCP) {
			state.lastCP = cp;
			state.collectedCP = cp;
			state.cpTimes = state.cpTimes.slice(0, cp + 1);
		}
	}

	function updateVelocity() {
		const pos = playerPos();
		if (!pos) return;

		const frame = gameFrame();
		if (state.lastPlayer && frame !== state.lastPlayer.frame) {
			const df = Math.max(1, frame - state.lastPlayer.frame);
			state.velocity.vx = ((pos.x - state.lastPlayer.x) / df) * FPS;
			state.velocity.vy = ((pos.y - state.lastPlayer.y) / df) * FPS;
			state.velocity.speed = Math.hypot(state.velocity.vx, state.velocity.vy);
		}
		state.lastPlayer = { ...pos, frame };
	}

	function telemetry() {
		return {
			ready: gameReady(),
			installed: state.installed,
			level: gmLevel(),
			frame: captureFrame(),
			cp: currentCP(),
			cpTimes: state.cpTimes.slice(),
			input: effectiveInput(),
			velocity: { ...state.velocity },
			captured: state.capture.length,
			playbackMode: state.playbackMode,
			paused: state.paused,
			sim: IS_SIM,
			gameplayReady: canonicalGameplayReady(),
			freeze: freezeSnapshot()
		};
	}

	function armReplay(script, options = {}) {
		resetRunLog('replay-armed');
		state.script = normalizeScript(script, options);
		state.virtualEnabled = true;
		state.playbackMode = true;
		state.paused = false;
		resetPlayback();
		resetCapture({ preserve: false });
		state.domHeld = { L: false, R: false };
		setVirtualInput('.');
		post('SCRIPT_NORMALIZED', {
			script: state.script,
			text: options.exact ? serializeCapturedScript(state.script) : serializeScript(state.script)
		});
	}

	function stopReplay() {
		state.virtualEnabled = false;
		state.playbackMode = false;
		state.paused = false;
		resetPlayback();
		state.domHeld = { L: false, R: false };
		setVirtualInput('.');
	}

	function setPaused(paused) {
		state.paused = !!paused;
		state.inputLatchedFrame = null;
		if (state.paused) setVirtualInput('.');
	}

	function seedGameplay(value = DEFAULT_GAMEPLAY_SEED) {
		const seed = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) | 0 : DEFAULT_GAMEPLAY_SEED;
		const seeded = callGlobal(
			'if (typeof _B91 === "function") { _B91(args[0] | 0); return true; } return false;',
			seed
		);
		return seeded ? seed : null;
	}

	function resetGameMakerRuntimeState(resetAllocators) {
		return !!callGlobal(
			[
				'if (typeof _Vm2 !== "undefined") _Vm2 = 0;',
				'if (args[0]) {',
				'  if (typeof _Oz2 !== "undefined") _Oz2 = 100000;',
				'  if (typeof _Sz2 !== "undefined") _Sz2 = 10000000;',
				'}',
				'if (typeof _Ux !== "undefined" && _Ux && _Ux._P41 && _Ux._P41._OH) {',
				'  for (var i = 0; i < _Ux._P41._OH.length; i++) {',
				'    var instance = _Ux._P41._OH[i];',
				'    if (instance) instance._Xm2 = 0;',
				'  }',
				'}',
				'if (typeof _U83 !== "undefined") _U83 = 0;',
				'if (typeof _mm2 !== "undefined") _mm2 = 60;',
				'if (typeof _UT !== "undefined") _UT = 0;',
				'if (typeof _S83 !== "undefined") _S83 = 0;',
				'if (typeof _Z83 !== "undefined") _Z83 = 0;',
				'if (typeof __83 !== "undefined") __83 = 0;',
				'if (typeof _093 !== "undefined") _093 = 0;',
				'if (typeof _Q83 !== "undefined" && typeof _GY === "function") {',
				'  _Q83 = _R83 = _GY();',
				'  _T83 = ~~(_Q83 / 1000000) + 4;',
				'}',
				'if (typeof _cd !== "undefined" && _cd) { _cd._bs = 60; _cd._hJ2 = 60; }',
				'if (typeof _Xx !== "undefined" && _Xx && typeof _Xx._DY === "function") _Xx._DY();',
				'return true;'
			].join('\n'),
			!!resetAllocators
		);
	}

	function startLevelDirect(level) {
		const targetLevel = Math.max(0, Math.floor(Number(level) || 0));
		if (!canonicalGameplayEnvironmentReady()) return false;
		if (!resetGameMakerRuntimeState(true)) return false;
		callGlobal('if (typeof _X32 === "function") _X32(); return true;');
		W._c4({}, {}, targetLevel);
		return true;
	}

	function canonicalGameplayEnvironmentReady() {
		return simRoomId() === 5 && simHasPhysicsWorld() && typeof W._c4 === 'function';
	}

	function currentGameplayLevel() {
		const level = Number(gmLevel());
		return Number.isFinite(level) && level > 0 ? Math.floor(level) : null;
	}

	function canonicalGameplayReady() {
		return canonicalGameplayEnvironmentReady() && currentGameplayLevel() !== null;
	}

	function canonicalRunReady(run) {
		return (
			canonicalGameplayEnvironmentReady() &&
			(!run.followCurrentLevel || currentGameplayLevel() !== null)
		);
	}

	function clearCanonicalRetry() {
		if (canonicalRetryTimer === null) return;
		REAL.clearTimeout(canonicalRetryTimer);
		canonicalRetryTimer = null;
	}

	function scheduleCanonicalRun(delay = 50) {
		if (canonicalRetryTimer !== null) return;
		canonicalRetryTimer = REAL.setTimeout(() => {
			canonicalRetryTimer = null;
			startNextCanonicalRun();
		}, delay);
	}

	function deferCanonicalRunUntilGameplay(run) {
		if (!state.pendingRun) state.pendingRun = run;
		state.activeRun = null;
		state.canonicalStage = 'waiting';
		scheduleCanonicalRun();
	}

	function failCanonicalRun(message) {
		const requestId = state.activeRun && state.activeRun.requestId;
		state.activeRun = null;
		state.canonicalStage = 'idle';
		post('ERROR', { message, requestId });
		if (state.pendingRun) scheduleCanonicalRun(0);
	}

	function startNextCanonicalRun() {
		if (state.activeRun || !state.pendingRun) return;
		if (!canonicalRunReady(state.pendingRun)) {
			state.canonicalStage = 'waiting';
			scheduleCanonicalRun();
			return;
		}
		clearCanonicalRetry();
		state.activeRun = state.pendingRun;
		state.pendingRun = null;
		if (state.activeRun.followCurrentLevel) {
			const currentLevel = currentGameplayLevel();
			if (currentLevel === null) {
				deferCanonicalRunUntilGameplay(state.activeRun);
				return;
			}
			state.activeRun.level = currentLevel;
		}
		state.canonicalStage = 'warmup';
		stopReplay();
		resetRunLog('canonical-run-reset');
		resetCapture({ preserve: false });
		clearRecoveredMemory();
		if (seedGameplay(state.activeRun.seed) === null) {
			failCanonicalRun('Unable to seed the GameMaker runtime');
			return;
		}
		resetDeterministicClock();
		try {
			const previousPlayer = gmPlayer();
			if (!startLevelDirect(state.activeRun.level)) {
				if (!canonicalGameplayEnvironmentReady()) deferCanonicalRunUntilGameplay(state.activeRun);
				else failCanonicalRun('Unable to initialize the deterministic gameplay state');
				return;
			}
			waitForCanonicalPlayer(state.activeRun, 'warmup', previousPlayer);
		} catch (error) {
			failCanonicalRun(String(error && error.message ? error.message : error));
		}
	}

	function requestCanonicalReplay(script, options = {}) {
		const normalized = normalizeScript(script, options);
		const requestId = Number.isFinite(Number(options.requestId))
			? Math.trunc(Number(options.requestId))
			: ++state.runRequestSequence;
		state.runRequestSequence = Math.max(state.runRequestSequence, requestId);
		state.pendingRun = {
			requestId,
			level: options.level == null ? null : Math.max(0, Math.floor(Number(options.level) || 0)),
			followCurrentLevel: options.level == null || !!options.followCurrentLevel,
			seed: Number.isFinite(Number(options.seed)) ? Math.trunc(Number(options.seed)) | 0 : DEFAULT_GAMEPLAY_SEED,
			exact: !!options.exact,
			script: normalized
		};
		startNextCanonicalRun();
		return requestId;
	}

	function cancelCanonicalReplay() {
		clearCanonicalRetry();
		state.pendingRun = null;
		state.activeRun = null;
		state.canonicalStage = 'idle';
		stopReplay();
	}

	function waitForCanonicalPlayer(run, stage, previousPlayer, attempts = 0) {
		if (!state.activeRun || state.activeRun.requestId !== run.requestId || state.canonicalStage !== stage) return;
		if (!canonicalGameplayReady()) {
			deferCanonicalRunUntilGameplay(run);
			return;
		}
		const player = gmPlayer();
		const ready =
			gmLevel() === run.level &&
			!!player &&
			(!previousPlayer || player !== previousPlayer) &&
			radiusCP() === 0 &&
			gameFrame() === 0;
		if (ready) {
			resetFreeze(run.level);
			completeCanonicalStage(run, stage);
			return;
		}
		if (attempts >= 5000) {
			failCanonicalRun(`Timed out constructing deterministic ${stage} state`);
			return;
		}
		REAL.setTimeout(() => waitForCanonicalPlayer(run, stage, previousPlayer, attempts + 1), 1);
	}

	function completeCanonicalStage(run, stage) {
		if (!state.activeRun || state.activeRun.requestId !== run.requestId || state.canonicalStage !== stage) return;

		if (stage === 'warmup') {
			state.canonicalStage = 'between';
			REAL.setTimeout(() => {
				if (!state.activeRun || state.activeRun.requestId !== run.requestId || state.canonicalStage !== 'between') {
					return;
				}
				state.canonicalStage = 'final';
				if (seedGameplay(run.seed) === null) {
					failCanonicalRun('Unable to reseed the GameMaker runtime');
					return;
				}
				resetDeterministicClock();
				try {
					const previousPlayer = gmPlayer();
					if (!startLevelDirect(run.level)) {
						if (!canonicalGameplayEnvironmentReady()) deferCanonicalRunUntilGameplay(run);
						else failCanonicalRun('Unable to construct the canonical gameplay state');
						return;
					}
					waitForCanonicalPlayer(run, 'final', previousPlayer);
				} catch (error) {
					failCanonicalRun(String(error && error.message ? error.message : error));
				}
			}, 0);
			return;
		}

		if (stage !== 'final') return;
		if (state.pendingRun) {
			state.activeRun = null;
			state.canonicalStage = 'idle';
			scheduleCanonicalRun(0);
			return;
		}

		if (!resetGameMakerRuntimeState(false)) {
			failCanonicalRun('Unable to canonicalize the tick-zero runtime state');
			return;
		}
		armReplay(run.script, { exact: run.exact });
		state.activeRun = null;
		state.canonicalStage = 'running';
		post('RUN_READY', {
			requestId: run.requestId,
			seed: run.seed,
			...telemetry()
		});
	}

	function tryStartLevel(level) {
		resetRunLog('start-level');
		ensureSimPlayRoom();
		return startLevelDirect(level);
	}

	function installNoAudio() {
		const noop = function () {};
		try {
			const media = W.HTMLMediaElement && W.HTMLMediaElement.prototype;
			if (media && !media.__circlooTasNoAudio) {
				media.__circlooTasNoAudio = true;
				media.play = function () {
					return Promise.resolve();
				};
				media.pause = noop;
				Object.defineProperty(media, 'muted', { get: () => true, set() {}, configurable: true });
				Object.defineProperty(media, 'volume', { get: () => 0, set() {}, configurable: true });
			}
		} catch {}
		for (const Ctor of [W.AudioBufferSourceNode, W.AudioScheduledSourceNode, W.OscillatorNode]) {
			try {
				if (Ctor && Ctor.prototype && !Ctor.prototype.__circlooTasNoAudio) {
					Ctor.prototype.__circlooTasNoAudio = true;
					if (typeof Ctor.prototype.start === 'function') Ctor.prototype.start = noop;
					if (typeof Ctor.prototype.stop === 'function') Ctor.prototype.stop = noop;
				}
			} catch {}
		}
	}

	function installNoRenderCanvas() {
		const proto = W.CanvasRenderingContext2D && W.CanvasRenderingContext2D.prototype;
		if (!proto || proto.__circlooTasNoRender) return;
		proto.__circlooTasNoRender = true;
		const noop = function () {};
		for (const method of [
			'arc',
			'beginPath',
			'clearRect',
			'clip',
			'closePath',
			'drawImage',
			'fill',
			'fillRect',
			'fillText',
			'lineTo',
			'moveTo',
			'quadraticCurveTo',
			'rect',
			'restore',
			'rotate',
			'save',
			'scale',
			'setTransform',
			'stroke',
			'strokeRect',
			'strokeText',
			'translate'
		]) {
			if (typeof proto[method] === 'function') proto[method] = noop;
		}
		proto.measureText = (text) => ({ width: String(text || '').length * 10 });
		proto.createLinearGradient = proto.createRadialGradient = () => ({ addColorStop() {} });
		proto.createPattern = () => null;
	}

	function installFastClock() {
		let simTime = 0;
		let nextId = 1;
		const timers = new Map();
		const rafs = new Map();
		const RealDate = W.Date;

		function schedule(fn, delay, interval, args) {
			const id = nextId++;
			timers.set(id, { time: simTime + Math.max(0, Number(delay) || 0), interval, fn, args });
			return id;
		}

		W.setTimeout = (fn, delay, ...args) => schedule(fn, delay, 0, args);
		W.setInterval = (fn, delay, ...args) => schedule(fn, delay, Math.max(1, Number(delay) || 1), args);
		W.clearTimeout = (id) => timers.delete(id);
		W.clearInterval = (id) => timers.delete(id);
		W.requestAnimationFrame = (callback) => {
			const id = nextId++;
			rafs.set(id, callback);
			return id;
		};
		W.cancelAnimationFrame = (id) => rafs.delete(id);

		try {
			Object.defineProperty(W.performance, 'now', { value: () => simTime, configurable: true, writable: true });
		} catch {}
		try {
			function SimDate(...args) {
				return args.length ? new RealDate(...args) : new RealDate(Math.floor(simTime));
			}
			SimDate.UTC = RealDate.UTC;
			SimDate.parse = RealDate.parse;
			SimDate.now = () => Math.floor(simTime);
			SimDate.prototype = RealDate.prototype;
			W.Date = SimDate;
		} catch {}

		W.__circlooTasPumpFrame = () => {
			simTime += 1000 / FPS;
			let guard = 0;
			while (guard++ < 20000) {
				let dueId = null;
				let due = null;
				for (const [id, timer] of timers) {
					if (timer.time <= simTime && (!due || timer.time < due.time)) {
						dueId = id;
						due = timer;
					}
				}
				if (!due) break;
				if (due.interval) due.time += due.interval;
				else timers.delete(dueId);
				try {
					typeof due.fn === 'function' ? due.fn(...due.args) : W.eval(String(due.fn));
				} catch (error) {
					post('ERROR', { message: String(error && error.message ? error.message : error) });
				}
			}
			if (IS_SIM) {
				if (!W.__circlooTasDirectStep) {
					W.__circlooTasDirectStep = W.Function(
						'try { if (typeof _O83 !== "undefined" && _O83 === 3 && typeof _d93 === "function") { _d93(); return true; } } catch (error) {} return false;'
					);
				}
				if (W.__circlooTasDirectStep()) return;
			}
			const callbacks = [...rafs.values()];
			rafs.clear();
			for (const callback of callbacks) {
				try {
					callback(simTime);
				} catch (error) {
					post('ERROR', { message: String(error && error.message ? error.message : error) });
				}
			}
		};

		W.__circlooTasPumpMany = (count) => {
			for (let i = 0; i < count; i++) W.__circlooTasPumpFrame();
		};
	}

	function prepareSimTrialLevel(level, seed = DEFAULT_GAMEPLAY_SEED) {
		const targetLevel = Math.max(0, Number(level) || 0);
		const startPlayer = gmPlayer();
		const startPlayerId = finiteNumber(startPlayer && startPlayer.id);
		let stageStartPlayer = startPlayer;
		const debug = {
			prepPumps: 0,
			restartPumps: 0,
			startRadius: radiusCP(),
			startFrame: gameFrame(),
			startPlayerId,
			endRadius: null,
			endFrame: null,
			endPlayerId: null,
			ready: false
		};

		function freshLevelReady() {
			const player = gmPlayer();
			return (
				gmLevel() === targetLevel &&
				!!player &&
				(!stageStartPlayer || player !== stageStartPlayer) &&
				radiusCP() === 0 &&
				gameFrame() === 0
			);
		}

		function allowPrepPump() {
			state.physicsFrozen = false;
			state.unfreezeStarted = true;
			state.prestartRemaining = 0;
			state.prestartElapsed = 0;
			state.unfreezeSource = 'sim-prep';
		}

		seedGameplay(seed);
		tryStartLevel(targetLevel);
		allowPrepPump();
		for (let i = 0; i < 180 && !freshLevelReady(); i++) {
			if (i > 0 && i % 30 === 0) {
				stageStartPlayer = gmPlayer();
				seedGameplay(seed);
				tryStartLevel(targetLevel);
			}
			W.__circlooTasPumpFrame();
			debug.prepPumps++;
			allowPrepPump();
		}

		stageStartPlayer = gmPlayer();
		seedGameplay(seed);
		tryStartLevel(targetLevel);
		allowPrepPump();
		for (let i = 0; i < 180 && !freshLevelReady(); i++) {
			if (i > 0 && i % 30 === 0) {
				stageStartPlayer = gmPlayer();
				seedGameplay(seed);
				tryStartLevel(targetLevel);
			}
			W.__circlooTasPumpFrame();
			debug.restartPumps++;
			allowPrepPump();
		}
		resetFreeze(gmLevel());

		debug.endRadius = radiusCP();
		debug.endFrame = gameFrame();
		debug.endPlayerId = finiteNumber(gmPlayer() && gmPlayer().id);
		debug.ready = freshLevelReady();
		return debug;
	}

	function simTrial(script, options) {
		state.exactCheckpointMode = true;
		const trialStart = REAL.now();
		try {
			state.cpTimes = [];
			state.collectedCP = 0;
			state.lastCP = 0;
			const prepareStart = REAL.now();
			const prepareDebug = prepareSimTrialLevel(options.level, options.seed);
			const prepareMs = REAL.now() - prepareStart;
			state.collectedCP = 0;
			state.lastCP = 0;
			state.cpTimes = [];
			armReplay(script);
			resetFreeze(gmLevel());

			const targetCP = Math.max(1, Math.floor(Number(options.targetCP) || 1));
			const finishCP = Math.max(1, Math.floor(Number(options.finishCP) || 1));
			let score = Infinity;
			let reached = false;
			let frames = 0;
			const pumpStart = REAL.now();
			for (let i = 0; i < options.maxFrames; i++) {
				W.__circlooTasPumpFrame();
				frames++;
				updateCheckpointTracking();

				if (options.target === 'cp' && state.cpTimes[targetCP] != null && state.collectedCP >= targetCP) {
					score = state.cpTimes[targetCP];
					reached = true;
					break;
				}
				if (options.target === 'finish' && state.collectedCP >= finishCP) {
					score = gameFrame();
					reached = true;
					break;
				}
			}
			const pumpMs = REAL.now() - pumpStart;

			return {
				score,
				reached,
				cp: state.collectedCP,
				times: state.cpTimes.slice(),
				debug: {
					trialMs: REAL.now() - trialStart,
					prepareMs,
					pumpMs,
					frames,
					prepPumps: prepareDebug.prepPumps,
					startRadius: prepareDebug.startRadius,
					endRadius: prepareDebug.endRadius,
					endFrame: prepareDebug.endFrame,
					ready: prepareDebug.ready
				}
			};
		} finally {
			stopReplay();
			state.exactCheckpointMode = false;
		}
	}

	W.__circlooTasRunTrial = simTrial;
	W.__circlooTasPatchGameHooks = patchGameHooks;
	W.__circlooTasRequestReplay = requestCanonicalReplay;

	function monitorTick() {
		state.wallFrame++;
		patchGameHooks();
		updateCheckpointTracking();
		updateVelocity();
		updateFreezeHint();
		recordRunFrame();
		post('TELEMETRY', telemetry());
		REAL.raf(monitorTick);
	}

	function handleMessage(event) {
		const message = event.data || {};
		if (message.source !== 'circloo-tas-app') return;

		switch (message.type) {
			case 'SET_SCRIPT':
				state.script = normalizeScript(message.script ?? message.text);
				post('SCRIPT_NORMALIZED', { script: state.script, text: serializeScript(state.script) });
				break;
			case 'ARM_REPLAY':
				requestCanonicalReplay(message.script ?? message.text, {
					exact: !!message.exact,
					level: message.level,
					seed: message.seed,
					requestId: message.requestId
				});
				break;
			case 'RUN_REPLAY':
				requestCanonicalReplay(message.script ?? message.text, {
					exact: !!message.exact,
					level: message.level,
					seed: message.seed,
					requestId: message.requestId
				});
				break;
			case 'PAUSE_REPLAY':
				setPaused(message.paused);
				break;
			case 'STOP_REPLAY':
				cancelCanonicalReplay();
				break;
			case 'CLEAR_CAPTURE':
				resetCapture({ preserve: false });
				clearRecoveredMemory();
				post('CAPTURE_CLEARED');
				break;
			case 'DUMP_CAPTURE': {
				const script = currentRunScript();
				const text = serializeCapturedScript(script);
				state.lastDumpText = text;
				post('CAPTURE_DUMP', {
					script: compactCapturedScript(script),
					text,
					exact: true,
					debug: currentRunDebug()
				});
				break;
			}
			case 'DUMP_RUN':
				dumpRunLog();
				break;
			case 'START_LEVEL':
				tryStartLevel(message.level);
				break;
			case 'SET_VOLUME':
				setVolume(message.volume);
				break;
		}
	}

	function installDomInputCapture() {
		function shouldIgnoreKeyEvent(event) {
			try {
				const target = event.target;
				if (!target || target === W || target === D || target === D.body) return false;
				const tag = String(target.tagName || '').toLowerCase();
				return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
			} catch {
				return false;
			}
		}

		function keyDown(event) {
			if (shouldIgnoreKeyEvent(event)) return;
			if (UNFREEZE_CODES.has(event.keyCode)) {
				if (requestManualUnfreeze()) {
					event.preventDefault?.();
					event.stopPropagation?.();
				}
				return;
			}
			if (LEFT_CODES.has(event.keyCode)) state.domHeld.L = true;
			if (RIGHT_CODES.has(event.keyCode)) state.domHeld.R = true;
		}

		function keyUp(event) {
			if (shouldIgnoreKeyEvent(event)) return;
			if (UNFREEZE_CODES.has(event.keyCode)) return;
			if (LEFT_CODES.has(event.keyCode)) state.domHeld.L = false;
			if (RIGHT_CODES.has(event.keyCode)) state.domHeld.R = false;
		}

		function remapMouseEvent(event) {
			const canvas = D.getElementById('canvas');
			if (!canvas || event.__circlooTasMouseMapped) return;
			const rect = canvas.getBoundingClientRect();
			if (!rect.width || !rect.height) return;

			const localX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
			const localY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
			const pageX = canvas.offsetLeft + localX * (canvas.width / rect.width);
			const pageY = canvas.offsetTop + localY * (canvas.height / rect.height);

			try {
				Object.defineProperty(event, '__circlooTasMouseMapped', { value: true, configurable: true });
				Object.defineProperty(event, 'pageX', { value: pageX, configurable: true });
				Object.defineProperty(event, 'pageY', { value: pageY, configurable: true });
			} catch {}
		}

		function focusGame() {
			try {
				W.focus();
			} catch {}
			try {
				const target = D.getElementById('canvas');
				if (!target) return;
				if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '0');
				try {
					target.focus({ preventScroll: true });
				} catch {
					target.focus();
				}
			} catch {}
		}

		const canvas = D.getElementById('canvas');
		if (canvas) {
			try {
				canvas.tabIndex = 0;
			} catch {}
		}

		function focusGameSoon() {
			focusGame();
			REAL.setTimeout(focusGame, 0);
			REAL.setTimeout(focusGame, 40);
		}

		W.addEventListener('keydown', keyDown, true);
		W.addEventListener('keyup', keyUp, true);
		try {
			if (W.parent && W.parent !== W) {
				W.parent.addEventListener('keydown', keyDown, true);
				W.parent.addEventListener('keyup', keyUp, true);
			}
		} catch {}
		W.addEventListener(
			'blur',
			() => {
				state.domHeld.L = false;
				state.domHeld.R = false;
			},
			true
		);
		for (const type of ['mousemove', 'mousedown', 'mouseup']) {
			W.addEventListener(type, remapMouseEvent, true);
			D.addEventListener(type, remapMouseEvent, true);
			canvas?.addEventListener(type, remapMouseEvent, true);
		}
		for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
			W.addEventListener(type, focusGameSoon, true);
			D.addEventListener(type, focusGameSoon, true);
			canvas?.addEventListener(type, focusGameSoon, true);
		}
	}

	function init() {
		installFixedRaf();
		post('BRIDGE_LOADED', { sim: IS_SIM });
		W.addEventListener('message', handleMessage, true);
		installDomInputCapture();
		resetCapture({ preserve: false });

		const wait = () => {
			if (!gameReady()) return REAL.setTimeout(wait, 50);
			patchGameHooks();
			if (IS_SIM && !ensureSimPlayRoom()) {
				if (typeof W.__circlooTasPumpFrame === 'function') W.__circlooTasPumpFrame();
				return REAL.setTimeout(wait, 0);
			}
			if (!IS_SIM && !installDeterministicClock()) return REAL.setTimeout(wait, 0);
			if (!IS_SIM && !unlockAllLevels()) return REAL.setTimeout(wait, 0);
			patchGameHooks();
			setVolume(state.volume);
			post('GAME_READY', telemetry());
			if (IS_SIM) {
				post('SIM_READY', telemetry());
			} else {
				monitorTick();
			}
		};

		wait();
	}

	if (IS_SIM) {
		installNoAudio();
		installNoRenderCanvas();
		installFastClock();
	}

	init();
})();
