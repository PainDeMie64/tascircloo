(() => {
	'use strict';

	const W = window;
	const D = document;
	const PARAMS = new URLSearchParams(W.location.search);
	const IS_SIM = PARAMS.get('sim') === '1';
	const SIM_TOKEN = PARAMS.get('token') || '';
	const FPS = 60;
	const DEFAULT_GAMEPLAY_SEED = 0;
	// GameMaker removes the previous room after the next one starts. Keep the two
	// deterministic construction stages in separate ID ranges so old cleanup
	// cannot clear a newly registered instance that reused the same ID.
	const WARMUP_INSTANCE_BASE = 1000000;
	const FINAL_INSTANCE_BASE = 2000000;
	const WARMUP_TILE_BASE = 20000000;
	const FINAL_TILE_BASE = 30000000;
	const RETRY_INSTANCE_STRIDE = 100000;
	const RETRY_TILE_STRIDE = 1000000;
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
		runRequestSequence: 0,
		pointTarget: { enabled: false, picking: false, x: 0, y: 0, z: 0 },
		pointMarker: null
	};
	let canonicalRetryTimer = null;

	W.__circlooTasBridge = state;

	W.__circlooTasShouldStepPhysics = () => shouldStepPhysics();
	W.__circlooTasShouldFreezeRoomUpdate = () => shouldFreezeRoomUpdate();

	const SIM_POST_TYPES = new Set(['BRIDGE_LOADED', 'GAME_READY', 'SIM_READY', 'ERROR']);

	function post(type, payload = {}) {
		if (IS_SIM && !SIM_POST_TYPES.has(type)) return;
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

	function viewTransform() {
		const builtIn = callGlobal('return typeof _cd !== "undefined" ? _cd : null;');
		if (!builtIn) return null;
		const index = Math.max(0, Math.floor(Number(builtIn._BC2) || 0));
		const numberAt = (value, fallback = 0) => {
			const candidate = Array.isArray(value) ? Number(value[index]) : Number(value);
			return Number.isFinite(candidate) ? candidate : fallback;
		};
		const viewWidth = numberAt(builtIn._9f);
		const viewHeight = numberAt(builtIn._af);
		const portWidth = numberAt(builtIn._df);
		const portHeight = numberAt(builtIn._ef);
		if (viewWidth <= 0 || viewHeight <= 0 || portWidth <= 0 || portHeight <= 0) return null;
		return {
			viewX: numberAt(builtIn._Hf),
			viewY: numberAt(builtIn._Jf),
			viewWidth,
			viewHeight,
			portX: numberAt(builtIn._1J2),
			portY: numberAt(builtIn._2J2),
			portWidth,
			portHeight
		};
	}

	function ensurePointMarker() {
		if (IS_SIM) return null;
		if (state.pointMarker?.isConnected) return state.pointMarker;
		const marker = D.createElement('div');
		marker.id = 'circloo-tas-point-target';
		marker.setAttribute('aria-label', 'Bruteforce point target');
		Object.assign(marker.style, {
			position: 'fixed',
			left: '0',
			top: '0',
			width: '18px',
			height: '18px',
			transform: 'translate(-50%, -50%)',
			borderRadius: '999px',
			background: '#ff2323',
			border: '2px solid #ffffff',
			boxShadow: '0 0 0 2px rgba(0,0,0,0.8), 0 0 14px 5px rgba(255,35,35,0.85)',
			zIndex: '100001',
			pointerEvents: 'none',
			display: 'none'
		});
		D.body.appendChild(marker);
		state.pointMarker = marker;
		return marker;
	}

	function updatePointMarker() {
		if (!state.pointTarget.enabled && !state.pointMarker) return;
		const marker = ensurePointMarker();
		if (!marker) return;
		if (!state.pointTarget.enabled) {
			marker.style.display = 'none';
			return;
		}
		const canvas = D.getElementById('canvas');
		const transform = viewTransform();
		if (!canvas || !transform) {
			marker.style.display = 'none';
			return;
		}
		const rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) {
			marker.style.display = 'none';
			return;
		}
		const canvasX =
			transform.portX +
			((state.pointTarget.x - transform.viewX) / transform.viewWidth) * transform.portWidth;
		const canvasY =
			transform.portY +
			((state.pointTarget.y - transform.viewY) / transform.viewHeight) * transform.portHeight;
		const visible =
			canvasX >= transform.portX &&
			canvasX <= transform.portX + transform.portWidth &&
			canvasY >= transform.portY &&
			canvasY <= transform.portY + transform.portHeight;
		marker.style.display = visible ? 'block' : 'none';
		if (!visible) return;
		marker.style.left = `${rect.left + (canvasX / canvas.width) * rect.width}px`;
		marker.style.top = `${rect.top + (canvasY / canvas.height) * rect.height}px`;
	}

	function setPointTarget(message) {
		state.pointTarget.enabled = !!message.enabled;
		state.pointTarget.picking = !!message.picking && state.pointTarget.enabled;
		for (const key of ['x', 'y', 'z']) {
			const value = Number(message[key]);
			if (Number.isFinite(value)) state.pointTarget[key] = value;
		}
		const canvas = D.getElementById('canvas');
		if (canvas) canvas.style.cursor = state.pointTarget.picking ? 'crosshair' : '';
		updatePointMarker();
	}

	function pointFromPointer(event) {
		const canvas = D.getElementById('canvas');
		const transform = viewTransform();
		if (!canvas || !transform) return null;
		const rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		const canvasX = ((event.clientX - rect.left) / rect.width) * canvas.width;
		const canvasY = ((event.clientY - rect.top) / rect.height) * canvas.height;
		if (
			canvasX < transform.portX ||
			canvasX > transform.portX + transform.portWidth ||
			canvasY < transform.portY ||
			canvasY > transform.portY + transform.portHeight
		) {
			return null;
		}
		return {
			x: transform.viewX + ((canvasX - transform.portX) / transform.portWidth) * transform.viewWidth,
			y: transform.viewY + ((canvasY - transform.portY) / transform.portHeight) * transform.viewHeight,
			z: 0
		};
	}

	function installPointPicker() {
		if (IS_SIM) return;
		const canvas = D.getElementById('canvas');
		if (!canvas || canvas.__circlooTasPointPickerInstalled) return;
		canvas.__circlooTasPointPickerInstalled = true;
		canvas.addEventListener(
			'pointerdown',
			(event) => {
				if (!state.pointTarget.picking) return;
				const point = pointFromPointer(event);
				if (!point) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				setPointTarget({ enabled: true, picking: false, ...point });
				post('POINT_TARGET_PICKED', point);
			},
			true
		);
	}

	function physicsWrapper() {
		return callGlobal('return typeof _Ux !== "undefined" && _Ux && _Ux._Xc1 ? _Ux._Xc1 : null;');
	}

	function physicsWorld() {
		const wrapper = physicsWrapper();
		return wrapper && wrapper._FB1 ? wrapper._FB1 : wrapper;
	}

	function bootstrapCanonicalPhysics() {
		const wrapper = physicsWrapper();
		const step = Number(callGlobal('return typeof _Ux !== "undefined" && _Ux ? _Ux._AJ2 : null;'));
		if (!wrapper || typeof wrapper._nG !== 'function' || !Number.isFinite(step) || step <= 0) return false;
		wrapper._nG(step);
		return true;
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

	// This digest only decides whether rewind is safe. Accepted improvements are
	// still verified by an independently rebuilt full runtime before use.
	function normalizeDeterminismValue(value) {
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) return value;
			const normalized = Number(value.toPrecision(13));
			return Object.is(normalized, -0) ? 0 : normalized;
		}
		if (Array.isArray(value)) return value.map(normalizeDeterminismValue);
		if (value && typeof value === 'object') {
			const normalized = {};
			for (const key of Object.keys(value).sort()) normalized[key] = normalizeDeterminismValue(value[key]);
			return normalized;
		}
		return value;
	}

	function determinismDigest() {
		const physics = physicsSnapshot();
		const bodyKeys = new Map();
		for (const body of physics.bodies || []) {
			const instanceId = finiteNumber(body.instance && body.instance.id);
			bodyKeys.set(body.index, instanceId == null ? `body:${body.index}` : `instance:${instanceId}`);
		}
		const bodies = (physics.bodies || [])
			.map((body) => ({
				key: bodyKeys.get(body.index),
				instance: body.instance
					? {
						id: body.instance.id,
						objectIndex: body.instance.objectIndex,
						x: body.instance.x,
						y: body.instance.y,
						physicsX: body.instance.physicsX,
						physicsY: body.instance.physicsY
					}
					: null,
				type: body.type,
				flags: body.flags,
				position: body.position,
				angle: body.angle,
				worldCenter: body.worldCenter,
				localCenter: body.localCenter,
				linearVelocity: body.linearVelocity,
				angularVelocity: body.angularVelocity,
				linearDamping: body.linearDamping,
				angularDamping: body.angularDamping,
				gravityScale: body.gravityScale,
				mass: body.mass,
				inertia: body.inertia,
				invMass: body.invMass,
				invI: body.invI,
				force: body.force,
				torque: body.torque,
				sleepTime: body.sleepTime,
				allowSleep: body.allowSleep,
				awake: body.awake,
				active: body.active,
				bullet: body.bullet,
				fixedRotation: body.fixedRotation,
				sweep: body.sweep,
				fixtures: body.fixtures.map((fixture) => ({
					type: fixture.type,
					density: fixture.density,
					friction: fixture.friction,
					restitution: fixture.restitution,
					sensor: fixture.sensor,
					filter: fixture.filter
				}))
			}))
			.sort((left, right) => left.key.localeCompare(right.key));
		const contacts = (physics.contacts || [])
			.map((contact) => {
				const pair = [bodyKeys.get(contact.bodyA) ?? null, bodyKeys.get(contact.bodyB) ?? null].sort();
				return {
					bodyA: pair[0],
					bodyB: pair[1],
					touching: contact.touching,
					enabled: contact.enabled,
					continuous: contact.continuous,
					flags: contact.flags,
					toi: contact.toi,
					toiCount: contact.toiCount,
					manifold: contact.manifold
				};
			})
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
		const joints = (physics.joints || [])
			.map((joint) => ({
				type: joint.type,
				bodyA: bodyKeys.get(joint.bodyA) ?? null,
				bodyB: bodyKeys.get(joint.bodyB) ?? null,
				anchorA: joint.anchorA,
				anchorB: joint.anchorB,
				collideConnected: joint.collideConnected
			}))
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
		const player = gmPlayer();
		const big = gmBig();
		const rng =
			callGlobal(
				[
					'var out = {};',
					'try { out.seed = _A91; } catch (error) {}',
					'try { out.index = _z91; } catch (error) {}',
					'try { out.words = _y91.slice(0); } catch (error) {}',
					'return out;'
				].join('\n')
			) || {};
		return normalizeDeterminismValue({
			level: gmLevel(),
			frame: gameFrame(),
			cp: state.collectedCP,
			cpTimes: state.cpTimes.slice(),
			player: player
				? {
					id: finiteNumber(player.id),
					objectIndex: finiteNumber(player._Ok),
					x: finiteNumber(player.x),
					y: finiteNumber(player.y),
					physicsX: finiteNumber(player._972),
					physicsY: finiteNumber(player._a72),
					frame: finiteNumber(player._hq),
					radius: finiteNumber(player._jd)
				}
				: null,
			big: big
				? {
					id: finiteNumber(big.id),
					x: finiteNumber(big.x),
					y: finiteNumber(big.y),
					radius: finiteNumber(big._jd),
					radiusStep: finiteNumber(big._nd),
					maxRadius: finiteNumber(big._eq),
					triggerCount: finiteNumber(big._dq),
					expanding: !!big._en
				}
				: null,
			rng,
			physics: {
				wrapper: physics.wrapper
					? {
						scale: physics.wrapper.scale,
						stepRate: physics.wrapper.stepRate,
						paused: physics.wrapper.paused,
						velocityIterations: physics.wrapper.velocityIterations,
						positionIterations: physics.wrapper.positionIterations,
						contactsBuffered: physics.wrapper.contactsBuffered
					}
					: null,
				world: physics.world
					? {
						bodyCount: physics.world.bodyCount,
						jointCount: physics.world.jointCount,
						allowSleep: physics.world.allowSleep,
						warmStarting: physics.world.warmStarting,
						continuousPhysics: physics.world.continuousPhysics,
						subStepping: physics.world.subStepping,
						flags: physics.world.flags,
						gravity: physics.world.gravity,
						proxyCount: physics.world.proxyCount
					}
					: null,
				bodies,
				contacts,
				joints
			}
		});
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
				if (!IS_SIM) post('TELEMETRY', telemetry());
			}

			return result;
		};

		return true;
	}

	function patchPlayerCreate() {
		if (state.originalPlayerCreate || typeof W._P8 !== 'function') return !!state.originalPlayerCreate;

		state.originalPlayerCreate = W._P8;
		W._P8 = function patchedPlayerCreate(self, other) {
			const result = state.originalPlayerCreate.apply(this, arguments);
			if (!IS_SIM) {
				beginFreshRun('player-create');
				resetCapture({ preserve: false });
			}
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
		if (!IS_SIM) resetRunLog('replay-armed');
		state.script = options.normalized ? script : normalizeScript(script, options);
		state.virtualEnabled = true;
		state.playbackMode = true;
		state.paused = false;
		resetPlayback();
		if (!IS_SIM) resetCapture({ preserve: false });
		state.domHeld = { L: false, R: false };
		setVirtualInput('.');
		if (!IS_SIM) {
			post('SCRIPT_NORMALIZED', {
				script: state.script,
				text: options.exact ? serializeCapturedScript(state.script) : serializeScript(state.script)
			});
		}
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

	function resetGameMakerRuntimeState(allocatorBase = null) {
		return !!callGlobal(
			[
				'if (typeof _Vm2 !== "undefined") _Vm2 = 0;',
				'if (args[0] != null) {',
				'  if (typeof _Oz2 !== "undefined") _Oz2 = args[0];',
				'  if (typeof _Sz2 !== "undefined") _Sz2 = args[1];',
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
			allocatorBase && allocatorBase.instances,
			allocatorBase && allocatorBase.tiles
		);
	}

	function startLevelDirect(level, allocatorBase = null) {
		const targetLevel = Math.max(0, Math.floor(Number(level) || 0));
		if (!canonicalGameplayEnvironmentReady()) return false;
		if (!resetGameMakerRuntimeState(allocatorBase)) return false;
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
			if (
				!startLevelDirect(state.activeRun.level, {
					instances: WARMUP_INSTANCE_BASE,
					tiles: WARMUP_TILE_BASE
				})
			) {
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
					if (
						!startLevelDirect(run.level, {
							instances: FINAL_INSTANCE_BASE,
							tiles: FINAL_TILE_BASE
						})
					) {
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

		if (!bootstrapCanonicalPhysics()) {
			failCanonicalRun('Unable to bootstrap the canonical physics state');
			return;
		}
		if (!resetGameMakerRuntimeState()) {
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

	function tryStartLevel(level, allocatorBase = null) {
		if (!IS_SIM) resetRunLog('start-level');
		ensureSimPlayRoom();
		return startLevelDirect(level, allocatorBase);
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
		let nextTimerTime = Infinity;
		const timers = new Map();
		const rafs = new Map();
		const RealDate = W.Date;
		const directStep = W.Function(
			'try { if (typeof _O83 !== "undefined" && _O83 === 3 && typeof _d93 === "function") { _d93(); return true; } } catch (error) {} return false;'
		);

		function recomputeNextTimerTime() {
			nextTimerTime = Infinity;
			for (const timer of timers.values()) {
				if (timer.time < nextTimerTime) nextTimerTime = timer.time;
			}
		}

		function schedule(fn, delay, interval, args) {
			const id = nextId++;
			const timer = { time: simTime + Math.max(0, Number(delay) || 0), interval, fn, args };
			timers.set(id, timer);
			if (timer.time < nextTimerTime) nextTimerTime = timer.time;
			return id;
		}

		function clearTimer(id) {
			const timer = timers.get(id);
			if (!timer) return;
			timers.delete(id);
			if (timer.time <= nextTimerTime) recomputeNextTimerTime();
		}

		W.setTimeout = (fn, delay, ...args) => schedule(fn, delay, 0, args);
		W.setInterval = (fn, delay, ...args) => schedule(fn, delay, Math.max(1, Number(delay) || 1), args);
		W.clearTimeout = clearTimer;
		W.clearInterval = clearTimer;
		W.requestAnimationFrame = (callback) => {
			const id = nextId++;
			rafs.set(id, callback);
			return id;
		};
		W.cancelAnimationFrame = (id) => rafs.delete(id);
		W.__circlooTasCaptureFastClock = () => ({
			simTime,
			nextId,
			timers: [...timers.entries()].map(([id, timer]) => [id, { ...timer, args: timer.args.slice() }]),
			rafs: [...rafs.entries()]
		});
		W.__circlooTasRestoreFastClock = (snapshot) => {
			if (!snapshot) return false;
			simTime = Number(snapshot.simTime) || 0;
			nextId = Math.max(1, Math.floor(Number(snapshot.nextId) || 1));
			timers.clear();
			for (const [id, timer] of snapshot.timers || []) {
				timers.set(id, { ...timer, args: Array.isArray(timer.args) ? timer.args.slice() : [] });
			}
			recomputeNextTimerTime();
			rafs.clear();
			for (const [id, callback] of snapshot.rafs || []) rafs.set(id, callback);
			return true;
		};

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
			if (nextTimerTime <= simTime) {
				let guard = 0;
				while (guard++ < 20000 && nextTimerTime <= simTime) {
					let dueId = null;
					let due = null;
					for (const [id, timer] of timers) {
						if (timer.time <= simTime && (!due || timer.time < due.time || (timer.time === due.time && id < dueId))) {
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
					recomputeNextTimerTime();
				}
			}
			if (IS_SIM && directStep()) return;
			if (!rafs.size) return;
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

		function stageAllocator(instances, tiles, attempt) {
			return {
				instances: instances + attempt * RETRY_INSTANCE_STRIDE,
				tiles: tiles + attempt * RETRY_TILE_STRIDE
			};
		}

		let prepAttempt = 0;
		seedGameplay(seed);
		tryStartLevel(targetLevel, stageAllocator(WARMUP_INSTANCE_BASE, WARMUP_TILE_BASE, prepAttempt));
		allowPrepPump();
		for (let i = 0; i < 180 && !freshLevelReady(); i++) {
			if (i > 0 && i % 30 === 0) {
				stageStartPlayer = gmPlayer();
				seedGameplay(seed);
				prepAttempt++;
				tryStartLevel(targetLevel, stageAllocator(WARMUP_INSTANCE_BASE, WARMUP_TILE_BASE, prepAttempt));
			}
			W.__circlooTasPumpFrame();
			debug.prepPumps++;
			allowPrepPump();
		}

		stageStartPlayer = gmPlayer();
		let restartAttempt = 0;
		seedGameplay(seed);
		tryStartLevel(targetLevel, stageAllocator(FINAL_INSTANCE_BASE, FINAL_TILE_BASE, restartAttempt));
		allowPrepPump();
		for (let i = 0; i < 180 && !freshLevelReady(); i++) {
			if (i > 0 && i % 30 === 0) {
				stageStartPlayer = gmPlayer();
				seedGameplay(seed);
				restartAttempt++;
				tryStartLevel(targetLevel, stageAllocator(FINAL_INSTANCE_BASE, FINAL_TILE_BASE, restartAttempt));
			}
			W.__circlooTasPumpFrame();
			debug.restartPumps++;
			allowPrepPump();
		}
		const bootstrapped = freshLevelReady() && bootstrapCanonicalPhysics();
		resetFreeze(gmLevel());

		debug.endRadius = radiusCP();
		debug.endFrame = gameFrame();
		debug.endPlayerId = finiteNumber(gmPlayer() && gmPlayer().id);
		debug.ready = freshLevelReady() && bootstrapped;
		return debug;
	}

	function isGameMakerInstance(value) {
		return (
			value &&
			typeof value === 'object' &&
			Number.isFinite(Number(value.id)) &&
			Number.isFinite(Number(value._Ok)) &&
			value._W41
		);
	}

	function isExternalSimulationObject(value) {
		if (!value || typeof value !== 'object') return false;
		const name = String(value.constructor && value.constructor.name ? value.constructor.name : '');
		return /^(Window|Document|HTML|Canvas|Audio|Image|Node|EventTarget)/.test(name);
	}

	// Snapshot capture walks the GameMaker/Box2D graph iteratively. A compiled
	// clone factory records the graph shape once, then creates a fresh isolated
	// runtime graph for each candidate without repeating reflection.
	function cloneSimulationGraph(root, options = {}) {
		const map = new Map();
		const pairs = [];
		const pending = [];

		function allocate(value) {
			if (value === null || typeof value !== 'object') return value;
			if (map.has(value)) return map.get(value);

			if (options.proxyGameMakerInstances && isGameMakerInstance(value)) {
				const proxy = Object.freeze({ id: Number(value.id), _Ok: Number(value._Ok) });
				map.set(value, proxy);
				return proxy;
			}

			if (isExternalSimulationObject(value)) return value;

			let output;
			let terminal = false;
			if (Array.isArray(value)) output = new Array(value.length);
			else if (value instanceof ArrayBuffer) {
				output = value.slice(0);
				terminal = true;
			}
			else if (value instanceof DataView) {
				const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
				output = new DataView(buffer);
				terminal = true;
			} else if (ArrayBuffer.isView(value)) {
				output = new value.constructor(value);
				terminal = true;
			} else if (value instanceof Date) {
				output = new Date(value.getTime());
				terminal = true;
			}
			else if (value instanceof Map) output = new Map();
			else if (value instanceof Set) output = new Set();
			else output = Object.create(Object.getPrototypeOf(value));

			map.set(value, output);
			pairs.push([value, output]);
			if (!terminal) pending.push([value, output]);
			return output;
		}

		const clonedRoot = allocate(root);
		while (pending.length) {
			const [source, target] = pending.pop();
			if (source instanceof Map) {
				for (const [key, item] of source) target.set(allocate(key), allocate(item));
				continue;
			}
			if (source instanceof Set) {
				for (const item of source) target.add(allocate(item));
				continue;
			}
			for (const key of Reflect.ownKeys(source)) {
				if (Array.isArray(source) && key === 'length') continue;
				const descriptor = Object.getOwnPropertyDescriptor(source, key);
				if (!descriptor) continue;
				if ('value' in descriptor) descriptor.value = allocate(descriptor.value);
				try {
					Object.defineProperty(target, key, descriptor);
				} catch {
					try {
						target[key] = descriptor.value;
					} catch {}
				}
			}
		}

		return { root: clonedRoot, map, pairs };
	}

	function buildSimulationCloneFactory(root, options = {}) {
		const nodeIndices = new Map();
		const inlineValues = new Map();
		const nodes = [];
		const pending = [];

		function encoded(value) {
			if (value === null || typeof value !== 'object') return { value };
			if (nodeIndices.has(value)) return { ref: nodeIndices.get(value) };
			if (inlineValues.has(value)) return { value: inlineValues.get(value) };

			if (options.proxyGameMakerInstances && isGameMakerInstance(value)) {
				const proxy = Object.freeze({ id: Number(value.id), _Ok: Number(value._Ok) });
				inlineValues.set(value, proxy);
				return { value: proxy };
			}
			if (isExternalSimulationObject(value)) return { value };

			const index = nodes.length;
			nodeIndices.set(value, index);
			nodes.push(null);

			let type = 'object';
			if (Array.isArray(value)) type = 'array';
			else if (value instanceof ArrayBuffer) type = 'array-buffer';
			else if (value instanceof DataView) type = 'data-view';
			else if (ArrayBuffer.isView(value)) type = 'typed-array';
			else if (value instanceof Date) type = 'date';
			else if (value instanceof Map) type = 'map';
			else if (value instanceof Set) type = 'set';

			const spec = {
				type,
				source: value,
				prototype: Object.getPrototypeOf(value),
				length: Array.isArray(value) ? value.length : 0,
				properties: [],
				entries: []
			};
			nodes[index] = spec;
			pending.push({ source: value, spec });

			return { ref: index };
		}

		const encodedRoot = encoded(root);
		while (pending.length) {
			const { source, spec } = pending.pop();
			if (spec.type === 'map') {
				for (const [key, item] of source) spec.entries.push([encoded(key), encoded(item)]);
			} else if (spec.type === 'set') {
				for (const item of source) spec.entries.push(encoded(item));
			}

			const typedLength = ArrayBuffer.isView(source) && !(source instanceof DataView) ? source.length : -1;
			for (const key of Reflect.ownKeys(source)) {
				if (spec.type === 'array' && key === 'length') continue;
				if (
					spec.type === 'typed-array' &&
					typeof key === 'string' &&
					/^\d+$/.test(key) &&
					Number(key) < typedLength
				) {
					continue;
				}
				const descriptor = Object.getOwnPropertyDescriptor(source, key);
				if (!descriptor) continue;
				const data = 'value' in descriptor;
				spec.properties.push({
					key,
					data,
					encoded: data ? encoded(descriptor.value) : null,
					descriptor,
					fast:
						data &&
						descriptor.writable === true &&
						descriptor.enumerable === true &&
						descriptor.configurable === true
				});
			}
		}

		function resolved(token, outputs) {
			return Object.prototype.hasOwnProperty.call(token, 'ref') ? outputs[token.ref] : token.value;
		}

		return function cloneCompiledSimulationGraph() {
			const outputs = new Array(nodes.length);
			for (let index = 0; index < nodes.length; index++) {
				const spec = nodes[index];
				switch (spec.type) {
					case 'array':
						outputs[index] = new Array(spec.length);
						break;
					case 'array-buffer':
						outputs[index] = spec.source.slice(0);
						break;
					case 'data-view': {
						const buffer = spec.source.buffer.slice(
							spec.source.byteOffset,
							spec.source.byteOffset + spec.source.byteLength
						);
						outputs[index] = new DataView(buffer);
						break;
					}
					case 'typed-array':
						outputs[index] = new spec.source.constructor(spec.source);
						break;
					case 'date':
						outputs[index] = new Date(spec.source.getTime());
						break;
					case 'map':
						outputs[index] = new Map();
						break;
					case 'set':
						outputs[index] = new Set();
						break;
					default:
						outputs[index] = Object.create(spec.prototype);
				}
			}

			for (let index = 0; index < nodes.length; index++) {
				const spec = nodes[index];
				const output = outputs[index];
				if (spec.type === 'map') {
					for (const [key, item] of spec.entries) output.set(resolved(key, outputs), resolved(item, outputs));
				} else if (spec.type === 'set') {
					for (const item of spec.entries) output.add(resolved(item, outputs));
				}

				for (const property of spec.properties) {
					if (property.fast) {
						try {
							output[property.key] = resolved(property.encoded, outputs);
							continue;
						} catch {}
					}
					const descriptor = { ...property.descriptor };
					if (property.data) descriptor.value = resolved(property.encoded, outputs);
					try {
						Object.defineProperty(output, property.key, descriptor);
					} catch {
						if (property.data) {
							try {
								output[property.key] = descriptor.value;
							} catch {}
						}
					}
				}
			}

			return resolved(encodedRoot, outputs);
		};
	}

	function buildSimulationRestorer(workingGraph) {
		const plans = [];

		function workingValue(value) {
			return value && typeof value === 'object' && workingGraph.map.has(value)
				? workingGraph.map.get(value)
				: value;
		}

		for (const [source, target] of workingGraph.pairs) {
			if (source instanceof Map) {
				plans.push({ type: 'map', source, target });
				continue;
			}
			if (source instanceof Set) {
				plans.push({ type: 'set', source, target });
				continue;
			}
			if (source instanceof DataView) {
				plans.push({ type: 'data-view', source, target });
				continue;
			}
			if (ArrayBuffer.isView(source)) {
				plans.push({ type: 'view', source, target });
				continue;
			}

			const keys = [];
			const values = [];
			for (const key of Reflect.ownKeys(source)) {
				if (Array.isArray(source) && key === 'length') continue;
				const descriptor = Object.getOwnPropertyDescriptor(source, key);
				if (!descriptor || !('value' in descriptor) || descriptor.writable === false) continue;
				keys.push(key);
				values.push(workingValue(descriptor.value));
			}
			plans.push({
				type: Array.isArray(source) ? 'array' : 'object',
				source,
				target,
				keys,
				keySet: new Set(keys),
				values
			});
		}

		return function restoreSimulationGraph() {
			for (const plan of plans) {
				if (plan.type === 'map') {
					plan.target.clear();
					for (const [key, value] of plan.source) {
						plan.target.set(workingValue(key), workingValue(value));
					}
					continue;
				}
				if (plan.type === 'set') {
					plan.target.clear();
					for (const value of plan.source) plan.target.add(workingValue(value));
					continue;
				}
				if (plan.type === 'view') {
					plan.target.set(plan.source);
					continue;
				}
				if (plan.type === 'data-view') {
					new Uint8Array(plan.target.buffer, plan.target.byteOffset, plan.target.byteLength).set(
						new Uint8Array(plan.source.buffer, plan.source.byteOffset, plan.source.byteLength)
					);
					continue;
				}
				if (plan.type === 'array') plan.target.length = plan.source.length;
				for (const key of Reflect.ownKeys(plan.target)) {
					if ((plan.type === 'array' && key === 'length') || plan.keySet.has(key)) continue;
					const descriptor = Object.getOwnPropertyDescriptor(plan.target, key);
					if (descriptor && descriptor.configurable) {
						try {
							delete plan.target[key];
						} catch {}
					}
				}
				for (let index = 0; index < plan.keys.length; index++) {
					plan.target[plan.keys[index]] = plan.values[index];
				}
			}
		};
	}

	function captureRuntimeScalars() {
		const out = {};
		for (const name of Object.getOwnPropertyNames(W)) {
			if (!/^_[A-Za-z0-9_$]+$/.test(name)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(W, name);
			if (!descriptor || !('value' in descriptor) || descriptor.writable === false) continue;
			const value = descriptor.value;
			if (
				value == null ||
				typeof value === 'number' ||
				typeof value === 'string' ||
				typeof value === 'boolean'
			) {
				out[name] = value;
			}
		}
		return out;
	}

	function restoreRuntimeScalars(values) {
		for (const [name, value] of Object.entries(values || {})) {
			const descriptor = Object.getOwnPropertyDescriptor(W, name);
			if (!descriptor || !('value' in descriptor) || descriptor.writable === false) continue;
			try {
				W[name] = value;
			} catch {}
		}
		return true;
	}

	function installRuntimeRoot(root) {
		return !!callGlobal(
			[
				'var root = args[0];',
				'if (!root) return false;',
				'if (typeof _Ux !== "undefined") _Ux = root.room;',
				'if (typeof _cd !== "undefined") _cd = root.builtins;',
				'if (typeof global !== "undefined") global = root.gameGlobal;',
				'if (typeof _Xx !== "undefined") _Xx = root.runner;',
				'if (typeof _Gx !== "undefined") _Gx = root.objects;',
				'if (typeof __11 !== "undefined") __11 = root.instances;',
				'if (typeof _ZG !== "undefined") _ZG = root.input;',
				'if (typeof _OE !== "undefined") _OE = root.particles;',
				'if (typeof _Q71 !== "undefined") _Q71 = root.timeline;',
				'if (typeof _yU !== "undefined") _yU = root.sequence;',
				'if (typeof _H31 !== "undefined") _H31 = root.roomQueue;',
				'if (typeof _iz2 !== "undefined") _iz2 = root.particleInstances;',
				'return true;'
			].join('\n'),
			root
		);
	}

	function captureReplaySimulationState() {
		return {
			playLevel: state.playLevel,
			scriptUnfreezeConsumed: state.scriptUnfreezeConsumed,
			physicsFrozen: state.physicsFrozen,
			unfreezeStarted: state.unfreezeStarted,
			prestartRemaining: state.prestartRemaining,
			prestartElapsed: state.prestartElapsed,
			unfreezeSource: state.unfreezeSource,
			freezeLevel: state.freezeLevel,
			freezeRoom: state.freezeRoom,
			freezeLastFrame: state.freezeLastFrame,
			freezePlayerId: state.freezePlayerId,
			freezeBigId: state.freezeBigId,
			lastFrameSeen: state.lastFrameSeen,
			lastLevelSeen: state.lastLevelSeen,
			lastCP: state.lastCP,
			collectedCP: state.collectedCP,
			cpTimes: state.cpTimes.slice()
		};
	}

	function restoreReplaySimulationState(snapshot, script, frame, alreadyNormalized = false) {
		const normalized = alreadyNormalized ? script : normalizeScript(script);
		state.script = normalized;
		state.virtualEnabled = true;
		state.playbackMode = true;
		state.paused = false;
		state.playLevel = snapshot.playLevel;
		state.scriptUnfreezeConsumed = snapshot.scriptUnfreezeConsumed;
		state.physicsFrozen = snapshot.physicsFrozen;
		state.unfreezeStarted = snapshot.unfreezeStarted;
		state.prestartRemaining = snapshot.prestartRemaining;
		state.prestartElapsed = snapshot.prestartElapsed;
		state.unfreezeSource = snapshot.unfreezeSource;
		state.freezeLevel = snapshot.freezeLevel;
		state.freezeRoom = snapshot.freezeRoom;
		state.freezeLastFrame = snapshot.freezeLastFrame;
		state.freezePlayerId = snapshot.freezePlayerId;
		state.freezeBigId = snapshot.freezeBigId;
		state.lastFrameSeen = snapshot.lastFrameSeen;
		state.lastLevelSeen = snapshot.lastLevelSeen;
		state.lastCP = snapshot.lastCP;
		state.collectedCP = snapshot.collectedCP;
		state.cpTimes = snapshot.cpTimes.slice();
		state.exactCheckpointMode = true;
		state.capture = [];
		state.captureInputSample = null;
		state.captureDebug = [];
		state.lastCaptureInput = null;
		state.lastPlayer = null;
		state.consumedInput = inputAtFrame(normalized, frame - 1);
		state.virtual = parseInput(state.consumedInput);
		state.prevVirtual = parseInput(inputAtFrame(normalized, frame - 2));
		state.domHeld = { L: false, R: false };
		state.playLastFrame = frame - 1;
		state.inputLatchedFrame = frame > 0 ? frame - 1 : null;
		state.playIndex = 0;
		while (
			state.playIndex < normalized.length &&
			(normalized[state.playIndex].input === 'U' || normalized[state.playIndex].frame < frame)
		) {
			state.playIndex++;
		}
	}

	function earliestNormalizedInputDifference(left, right) {
		let leftIndex = 0;
		let rightIndex = 0;
		let leftInput = '.';
		let rightInput = '.';
		while (leftIndex < left.length || rightIndex < right.length) {
			while (leftIndex < left.length && left[leftIndex].input === 'U') leftIndex++;
			while (rightIndex < right.length && right[rightIndex].input === 'U') rightIndex++;
			const leftFrame = leftIndex < left.length ? left[leftIndex].frame : Infinity;
			const rightFrame = rightIndex < right.length ? right[rightIndex].frame : Infinity;
			const frame = Math.min(leftFrame, rightFrame);
			if (!Number.isFinite(frame)) break;
			while (leftIndex < left.length && left[leftIndex].frame <= frame) {
				if (left[leftIndex].input !== 'U') leftInput = left[leftIndex].input;
				leftIndex++;
			}
			while (rightIndex < right.length && right[rightIndex].frame <= frame) {
				if (right[rightIndex].input !== 'U') rightInput = right[rightIndex].input;
				rightIndex++;
			}
			if (leftInput !== rightInput) return frame;
		}
		return Infinity;
	}

	function earliestInputDifference(leftScript, rightScript) {
		return earliestNormalizedInputDifference(normalizeScript(leftScript), normalizeScript(rightScript));
	}

	function inputAtFrame(script, frame) {
		let input = '.';
		for (const entry of script) {
			if (entry.input !== 'U' && entry.frame <= frame) input = entry.input;
		}
		return input;
	}

	function scriptPrefixKey(script, frame) {
		return normalizeScript(script)
			.filter((entry) => entry.input === 'U' || entry.frame < frame)
			.map((entry) => `${entry.frame}:${entry.input}`)
			.join('|');
	}

	function createLevelOneFinishOptimizer(script, options = {}) {
		if (!IS_SIM) return null;
		const level = Math.max(0, Math.floor(Number(options.level) || 0));
		const finishCP = Math.max(1, Math.floor(Number(options.finishCP) || 1));
		if (level !== 1 || options.target !== 'finish' || finishCP !== 6) return null;

		const normalized = normalizeScript(script);
		const prefixCP = finishCP - 1;
		const maxFrames = Math.max(1, Math.floor(Number(options.maxFrames) || 1));
		const seed = Number.isFinite(Number(options.seed)) ? Math.trunc(Number(options.seed)) | 0 : DEFAULT_GAMEPLAY_SEED;
		state.exactCheckpointMode = true;

		try {
			state.cpTimes = [];
			state.collectedCP = 0;
			state.lastCP = 0;
			const prepareDebug = prepareSimTrialLevel(level, seed);
			if (!prepareDebug.ready) return null;

			state.collectedCP = 0;
			state.lastCP = 0;
			state.cpTimes = [];
			armReplay(normalized);
			resetFreeze(gmLevel());

			let resumeFrame = null;
			let resumeTarget = null;
			for (let index = 0; index < maxFrames; index++) {
				W.__circlooTasPumpFrame();
				if (state.cpTimes[prefixCP] != null && resumeTarget === null) {
					resumeTarget = state.cpTimes[prefixCP] + 10;
				}
				if (
					resumeTarget !== null &&
					gameFrame() >= resumeTarget &&
					state.collectedCP >= prefixCP &&
					radiusCP() >= prefixCP
				) {
					resumeFrame = gameFrame();
					break;
				}
			}

			if (resumeFrame === null || resumeFrame >= maxFrames) return null;
			const wrapper = physicsWrapper();
			const liveWorld = physicsWorld();
			const livePlayer = gmPlayer();
			const liveBody = livePlayer && livePlayer._Xd1 && livePlayer._Xd1._932;
			if (!wrapper || !liveWorld || !liveBody) return null;

			const circleData =
				callGlobal(
					[
						'var out = [];',
						'var object = typeof _Gx !== "undefined" && _Gx ? _Gx._qH(21) : null;',
						'var list = object && object._Ln2 ? object._Ln2._OH : null;',
						'if (!list) return out;',
						'for (var i = 0; i < list.length; i++) {',
						'  var circle = list[i];',
						'  if (circle && !circle._qf && circle._rf && !(Number(circle._ye) > 0.5)) {',
						'    out.push({ x: Number(circle.x), y: Number(circle.y) });',
						'  }',
						'}',
						'return out;'
					].join('\n')
				) || [];
			if (!circleData.length) return null;

			const templateGraph = cloneSimulationGraph(liveWorld, { proxyGameMakerInstances: true });
			const templateBody = templateGraph.map.get(liveBody);
			if (!templateBody) return null;

			// GameMaker's listener only copies contact data back to instances. The
			// solver itself is unaffected, and prospective bests are fully replayed
			// in the original runtime before they can be accepted.
			const noContactListener = {
				_6E1() {},
				_7E1() {},
				_8E1() {},
				_aE1() {}
			};
			if (templateGraph.root._eC1) templateGraph.root._eC1._0F1 = noContactListener;

			const workingGraph = cloneSimulationGraph(templateGraph.root);
			const workingBody = workingGraph.map.get(templateBody);
			if (!workingBody) return null;
			const restore = buildSimulationRestorer(workingGraph);
			const world = workingGraph.root;
			const scale = Number(wrapper._sd1);
			const stepRate = Number(wrapper._K62);
			const iterations = Number(wrapper._L62);
			const roomSpeed = Number(callGlobal('return typeof _Ux !== "undefined" && _Ux ? _Ux._AJ2 : null;'));
			const inputScale = Number(livePlayer._Ot) || 1;
			const extraInput = !!callGlobal('return !!(typeof global !== "undefined" && global && global._Fc);');
			const collectRadius = 24 + (Number(livePlayer._jd) || 0);
			if (![scale, stepRate, iterations, roomSpeed, collectRadius].every(Number.isFinite)) return null;

			const prefixTimes = state.cpTimes.slice(0, prefixCP + 1);
			const prefixKey = scriptPrefixKey(normalized, resumeFrame);
			const initialInput = inputAtFrame(normalized, resumeFrame - 1);
			const velocityPrototype = Object.getPrototypeOf(workingBody._zC1());

			function setHorizontalVelocity(value) {
				const current = workingBody._zC1();
				const velocity = Object.create(velocityPrototype);
				velocity.x = value;
				velocity.y = current.y;
				workingBody._yC1(velocity);
				workingBody._pd1(true);
			}

			function nudgeHorizontalVelocity(amount) {
				const current = workingBody._zC1();
				setHorizontalVelocity(((current.x / scale / roomSpeed) + amount) * scale * roomSpeed);
			}

			function applyInput(input) {
				if (input.includes('L')) nudgeHorizontalVelocity(-0.52 * inputScale);
				if (input.includes('R')) nudgeHorizontalVelocity(0.52 * inputScale);
				if (extraInput && input.includes('L')) nudgeHorizontalVelocity(-0.01);
				if (extraInput && input.includes('R')) nudgeHorizontalVelocity(0.01);
			}

			function evaluate(candidate) {
				const candidateScript = normalizeScript(candidate);
				if (scriptPrefixKey(candidateScript, resumeFrame) !== prefixKey) {
					return { reached: false, score: Infinity, cp: prefixCP, times: prefixTimes.slice(), incompatiblePrefix: true };
				}

				const restoreStart = REAL.now();
				restore();
				const restoreMs = REAL.now() - restoreStart;
				let frame = resumeFrame;
				let input = initialInput;
				let entryIndex = 0;
				while (
					entryIndex < candidateScript.length &&
					(candidateScript[entryIndex].input === 'U' || candidateScript[entryIndex].frame < resumeFrame)
				) {
					entryIndex++;
				}

				const pumpStart = REAL.now();
				while (frame < maxFrames) {
					while (
						entryIndex < candidateScript.length &&
						candidateScript[entryIndex].frame <= frame
					) {
						if (candidateScript[entryIndex].input !== 'U') input = candidateScript[entryIndex].input;
						entryIndex++;
					}
					applyInput(input);
					frame++;

					const position = workingBody._Rc1();
					const playerX = position.x / scale;
					const playerY = position.y / scale;
					for (const circle of circleData) {
						const dx = playerX - circle.x;
						const dy = playerY - circle.y;
						if (dx * dx + dy * dy < collectRadius * collectRadius) {
							const times = prefixTimes.slice();
							times[finishCP] = frame;
							return {
								reached: true,
								score: frame,
								cp: finishCP,
								times,
								debug: {
									trialMs: restoreMs + (REAL.now() - pumpStart),
									prepareMs: restoreMs,
									pumpMs: REAL.now() - pumpStart,
									frames: frame - resumeFrame,
									prepPumps: 0,
									resumeFrame,
									fast: true
								}
							};
						}
					}

					world._jF1(1 / stepRate, iterations, iterations);
					world._nF1();
				}

				return {
					reached: false,
					score: Infinity,
					cp: prefixCP,
					times: prefixTimes.slice(),
					debug: {
						trialMs: restoreMs + (REAL.now() - pumpStart),
						prepareMs: restoreMs,
						pumpMs: REAL.now() - pumpStart,
						frames: frame - resumeFrame,
						prepPumps: 0,
						resumeFrame,
						fast: true
					}
				};
			}

			return {
				level,
				finishCP,
				resumeFrame,
				prefixTimes,
				prefixKey,
				evaluate,
				prefixMatches(candidate) {
					return scriptPrefixKey(candidate, resumeFrame) === prefixKey;
				}
			};
		} finally {
			stopReplay();
			state.exactCheckpointMode = false;
		}
	}

	function createLevelOneAdaptiveFinishOptimizer(script, options = {}) {
		if (!IS_SIM) return null;
		const level = Math.max(0, Math.floor(Number(options.level) || 0));
		const finishCP = Math.max(1, Math.floor(Number(options.finishCP) || 1));
		if (level !== 1 || options.target !== 'finish' || finishCP !== 6) return null;

		const prefixCP = finishCP - 1;
		const maxFrames = Math.max(1, Math.floor(Number(options.maxFrames) || 1));
		const seed = Number.isFinite(Number(options.seed))
			? Math.trunc(Number(options.seed)) | 0
			: DEFAULT_GAMEPLAY_SEED;
		const snapshotStride = Math.max(4, Math.floor(Number(options.fastSnapshotStride) || 8));
		let baseScript = normalizeScript(script);
		let snapshots = [];
		let baseResult = null;
		let resumeFrame = null;
		let lastRewindFrame = null;
		let buildMs = 0;

		function captureFinishCircles() {
			return (
				callGlobal(
					[
						'var out = [];',
						'var object = typeof _Gx !== "undefined" && _Gx ? _Gx._qH(21) : null;',
						'var list = object && object._Ln2 ? object._Ln2._OH : null;',
						'if (!list) return out;',
						'for (var i = 0; i < list.length; i++) {',
						'  var circle = list[i];',
						'  if (circle && !circle._qf && circle._rf && !(Number(circle._ye) > 0.5)) {',
						'    out.push({ x: Number(circle.x), y: Number(circle.y) });',
						'  }',
						'}',
						'return out;'
					].join('\n')
				) || []
			);
		}

		function captureSuffixSnapshot(frame, prefixTimes) {
			const wrapper = physicsWrapper();
			const liveWorld = physicsWorld();
			const livePlayer = gmPlayer();
			const liveBody = livePlayer && livePlayer._Xd1 && livePlayer._Xd1._932;
			if (!wrapper || !liveWorld || !livePlayer || !liveBody) return null;

			const templateGraph = cloneSimulationGraph(liveWorld, { proxyGameMakerInstances: true });
			const templateBody = templateGraph.map.get(liveBody);
			if (!templateBody) return null;
			const noContactListener = { _6E1() {}, _7E1() {}, _8E1() {}, _aE1() {} };
			if (templateGraph.root._eC1) templateGraph.root._eC1._0F1 = noContactListener;

			return {
				frame,
				templateRoot: templateGraph.root,
				templateBody,
				prefixKey: scriptPrefixKey(baseScript, frame),
				prefixTimes: prefixTimes.slice(),
				initialInput: inputAtFrame(baseScript, frame - 1),
				circleData: captureFinishCircles(),
				scale: Number(wrapper._sd1),
				stepRate: Number(wrapper._K62),
				iterations: Number(wrapper._L62),
				roomSpeed: Number(callGlobal('return typeof _Ux !== "undefined" && _Ux ? _Ux._AJ2 : null;')),
				inputScale: Number(livePlayer._Ot) || 1,
				extraInput: !!callGlobal('return !!(typeof global !== "undefined" && global && global._Fc);'),
				collectRadius: 24 + (Number(livePlayer._jd) || 0)
			};
		}

		function rebuild(nextBaseScript) {
			const started = REAL.now();
			baseScript = normalizeScript(nextBaseScript);
			const nextSnapshots = [];
			state.exactCheckpointMode = true;
			try {
				state.cpTimes = [];
				state.collectedCP = 0;
				state.lastCP = 0;
				const prepared = prepareSimTrialLevel(level, seed);
				if (!prepared.ready) return false;

				state.cpTimes = [];
				state.collectedCP = 0;
				state.lastCP = 0;
				armReplay(baseScript);
				resetFreeze(gmLevel());
				let suffixStart = null;
				let reached = false;
				let score = Infinity;
				const baseInputFrames = new Set(
					baseScript.filter((entry) => entry.input !== 'U').map((entry) => entry.frame)
				);

				for (let index = 0; index < maxFrames; index++) {
					const frame = gameFrame();
					if (
						suffixStart !== null &&
						(frame === suffixStart || (frame - suffixStart) % snapshotStride === 0 || baseInputFrames.has(frame))
					) {
						const snapshot = captureSuffixSnapshot(frame, state.cpTimes.slice(0, prefixCP + 1));
						if (snapshot) nextSnapshots.push(snapshot);
					}

					W.__circlooTasPumpFrame();
					if (
						suffixStart === null &&
						state.cpTimes[prefixCP] != null &&
						gameFrame() >= state.cpTimes[prefixCP] + 10 &&
						state.collectedCP >= prefixCP &&
						radiusCP() >= prefixCP
					) {
						suffixStart = gameFrame();
					}
					if (state.collectedCP >= finishCP) {
						reached = true;
						score = gameFrame();
						break;
					}
				}

				if (suffixStart === null || !nextSnapshots.length) return false;
				snapshots = nextSnapshots.sort((left, right) => left.frame - right.frame);
				resumeFrame = snapshots[0].frame;
				baseResult = {
					reached,
					score,
					cp: state.collectedCP,
					times: state.cpTimes.slice(),
					debug: {
						trialMs: 0,
						prepareMs: 0,
						pumpMs: 0,
						frames: 0,
						prepPumps: prepared.prepPumps,
						rewindFrame: score,
						fast: true
					}
				};
				lastRewindFrame = resumeFrame;
				buildMs = REAL.now() - started;
				return true;
			} finally {
				stopReplay();
				state.exactCheckpointMode = false;
			}
		}

		function chooseSnapshot(differenceFrame) {
			let selected = snapshots[0];
			for (const snapshot of snapshots) {
				if (snapshot.frame > differenceFrame) break;
				selected = snapshot;
			}
			return selected;
		}

		function evaluate(candidate) {
			const candidateScript = normalizeScript(candidate);
			const differenceFrame = earliestInputDifference(baseScript, candidateScript);
			if (!Number.isFinite(differenceFrame) || (baseResult.reached && differenceFrame >= baseResult.score)) {
				lastRewindFrame = baseResult.reached ? baseResult.score : resumeFrame;
				return {
					...baseResult,
					times: baseResult.times.slice(),
					debug: { ...baseResult.debug, rewindFrame: lastRewindFrame, differenceFrame, frames: 0 }
				};
			}
			if (differenceFrame < resumeFrame) {
				return {
					reached: false,
					score: Infinity,
					cp: prefixCP,
					times: [],
					incompatiblePrefix: true,
					debug: { rewindFrame: resumeFrame, differenceFrame, frames: 0, fast: true }
				};
			}

			const snapshot = chooseSnapshot(differenceFrame);
			if (scriptPrefixKey(candidateScript, snapshot.frame) !== snapshot.prefixKey) {
				return {
					reached: false,
					score: Infinity,
					cp: prefixCP,
					times: snapshot.prefixTimes.slice(),
					incompatiblePrefix: true,
					debug: { rewindFrame: snapshot.frame, differenceFrame, frames: 0, fast: true }
				};
			}

			lastRewindFrame = snapshot.frame;
			const restoreStart = REAL.now();
			const workingGraph = cloneSimulationGraph(snapshot.templateRoot);
			const workingBody = workingGraph.map.get(snapshot.templateBody);
			const workingWorld = workingGraph.root;
			if (!workingBody || !workingWorld) {
				return {
					reached: false,
					score: Infinity,
					cp: prefixCP,
					times: snapshot.prefixTimes.slice(),
					debug: { rewindFrame: snapshot.frame, differenceFrame, frames: 0, fast: true }
				};
			}
			const restoreMs = REAL.now() - restoreStart;
			let frame = snapshot.frame;
			let input = snapshot.initialInput;
			let entryIndex = 0;
			while (
				entryIndex < candidateScript.length &&
				(candidateScript[entryIndex].input === 'U' || candidateScript[entryIndex].frame < snapshot.frame)
			) {
				entryIndex++;
			}
			const velocityPrototype = Object.getPrototypeOf(workingBody._zC1());
			const setHorizontalVelocity = (value) => {
				const current = workingBody._zC1();
				const velocity = Object.create(velocityPrototype);
				velocity.x = value;
				velocity.y = current.y;
				workingBody._yC1(velocity);
				workingBody._pd1(true);
			};
			const nudgeHorizontalVelocity = (amount) => {
				const current = workingBody._zC1();
				setHorizontalVelocity(
					((current.x / snapshot.scale / snapshot.roomSpeed) + amount) *
						snapshot.scale *
						snapshot.roomSpeed
				);
			};
			const applyInput = (nextInput) => {
				if (nextInput.includes('L')) nudgeHorizontalVelocity(-0.52 * snapshot.inputScale);
				if (nextInput.includes('R')) nudgeHorizontalVelocity(0.52 * snapshot.inputScale);
				if (snapshot.extraInput && nextInput.includes('L')) nudgeHorizontalVelocity(-0.01);
				if (snapshot.extraInput && nextInput.includes('R')) nudgeHorizontalVelocity(0.01);
			};

			const pumpStart = REAL.now();
			while (frame < maxFrames) {
				while (entryIndex < candidateScript.length && candidateScript[entryIndex].frame <= frame) {
					if (candidateScript[entryIndex].input !== 'U') input = candidateScript[entryIndex].input;
					entryIndex++;
				}
				applyInput(input);
				frame++;
				const position = workingBody._Rc1();
				const playerX = position.x / snapshot.scale;
				const playerY = position.y / snapshot.scale;
				for (const circle of snapshot.circleData) {
					const dx = playerX - circle.x;
					const dy = playerY - circle.y;
					if (dx * dx + dy * dy < snapshot.collectRadius * snapshot.collectRadius) {
						const times = snapshot.prefixTimes.slice();
						times[finishCP] = frame;
						return {
							reached: true,
							score: frame,
							cp: finishCP,
							times,
							debug: {
								trialMs: restoreMs + (REAL.now() - pumpStart),
								prepareMs: restoreMs,
								pumpMs: REAL.now() - pumpStart,
								frames: frame - snapshot.frame,
								prepPumps: 0,
								rewindFrame: snapshot.frame,
								differenceFrame,
								fast: true
							}
						};
					}
				}
				workingWorld._jF1(1 / snapshot.stepRate, snapshot.iterations, snapshot.iterations);
				workingWorld._nF1();
			}

			return {
				reached: false,
				score: Infinity,
				cp: prefixCP,
				times: snapshot.prefixTimes.slice(),
				debug: {
					trialMs: restoreMs + (REAL.now() - pumpStart),
					prepareMs: restoreMs,
					pumpMs: REAL.now() - pumpStart,
					frames: frame - snapshot.frame,
					prepPumps: 0,
					rewindFrame: snapshot.frame,
					differenceFrame,
					fast: true
				}
			};
		}

		if (!rebuild(baseScript)) return null;
		return {
			level,
			finishCP,
			get resumeFrame() {
				return resumeFrame;
			},
			get lastRewindFrame() {
				return lastRewindFrame;
			},
			get snapshotCount() {
				return snapshots.length;
			},
			get buildMs() {
				return buildMs;
			},
			evaluate,
			rebuild,
			prefixMatches(candidate) {
				return earliestInputDifference(baseScript, candidate) >= resumeFrame;
			}
		};
	}

	function createLevelOneFinishSevenOptimizer(script, options = {}) {
		if (!IS_SIM) return null;
		const level = Math.max(0, Math.floor(Number(options.level) || 0));
		const finishCP = Math.max(1, Math.floor(Number(options.finishCP) || 1));
		const minFrame = Math.max(0, Math.floor(Number(options.minFrame) || 0));
		if (level !== 1 || options.target !== 'finish' || finishCP !== 7 || minFrame < 1) return null;

		const maxFrames = Math.max(1, Math.floor(Number(options.maxFrames) || 1));
		const seed = Number.isFinite(Number(options.seed))
			? Math.trunc(Number(options.seed)) | 0
			: DEFAULT_GAMEPLAY_SEED;
		const snapshotStride = Math.max(4, Math.floor(Number(options.fastSnapshotStride) || 8));
		let baseScript = normalizeScript(script);
		let snapshots = [];
		let baseResult = null;
		let lastRewindFrame = minFrame;
		let buildMs = 0;

		function activeFinishCircles() {
			return (
				callGlobal(
					[
						'var out = [];',
						'var types = [21, 22, 23, 24];',
						'for (var t = 0; t < types.length; t++) {',
						'  var object = typeof _Gx !== "undefined" && _Gx ? _Gx._qH(types[t]) : null;',
						'  var list = object && object._Ln2 ? object._Ln2._OH : null;',
						'  if (!list) continue;',
						'  for (var i = 0; i < list.length; i++) {',
						'    var circle = list[i];',
						'    if (!circle || circle._qf || !circle._rf || Number(circle._ye) > 0.5) continue;',
						'    out.push({ id: Number(circle.id), x: Number(circle.x), y: Number(circle.y) });',
						'  }',
						'}',
						'return out;'
					].join('\n')
				) || []
			);
		}

		function findPlayerBody(world, playerId) {
			for (
				let body = world && typeof world._DF1 === 'function' ? world._DF1() : null;
				body;
				body = typeof body._kD1 === 'function' ? body._kD1() : null
			) {
				const instance = typeof body._bu1 === 'function' ? body._bu1() : null;
				if (Number(instance && instance.id) === playerId) return body;
			}
			return null;
		}

		function captureSnapshot(frame) {
			const wrapper = physicsWrapper();
			const liveWorld = physicsWorld();
			const player = gmPlayer();
			const big = gmBig();
			const liveBody = player && player._Xd1 && player._Xd1._932;
			if (!wrapper || !liveWorld || !player || !big || !liveBody) return null;

			const templateGraph = cloneSimulationGraph(liveWorld, { proxyGameMakerInstances: true });
			const templateBody = templateGraph.map.get(liveBody);
			if (!templateBody) return null;
			const noContactListener = { _6E1() {}, _7E1() {}, _8E1() {}, _aE1() {} };
			if (templateGraph.root._eC1) templateGraph.root._eC1._0F1 = noContactListener;

			return {
				frame,
				cloneWorld: buildSimulationCloneFactory(templateGraph.root),
				playerId: Number(player.id),
				prefixKey: scriptPrefixKey(baseScript, frame),
				prefixTimes: state.cpTimes.slice(),
				prefixCP: state.collectedCP,
				initialInput: inputAtFrame(baseScript, frame - 1),
				circles: activeFinishCircles(),
				bigRadius: Number(big._jd),
				bigMaxRadius: Number(big._eq),
				growthAlarm:
					Array.isArray(big._md) && Number.isFinite(Number(big._md[0])) ? Number(big._md[0]) : -1,
				scale: Number(wrapper._sd1),
				stepRate: Number(wrapper._K62),
				iterations: Number(wrapper._L62),
				roomSpeed: Number(callGlobal('return typeof _Ux !== "undefined" && _Ux ? _Ux._AJ2 : null;')),
				inputScale: Number(player._Ot) || 1,
				extraInput: !!callGlobal('return !!(typeof global !== "undefined" && global && global._Fc);'),
				collectRadius: 24 + (Number(player._jd) || 0)
			};
		}

		function rebuild(nextBaseScript) {
			const started = REAL.now();
			baseScript = normalizeScript(nextBaseScript);
			const inputFrames = new Set(
				baseScript
					.filter((entry) => entry.input !== 'U' && entry.frame >= minFrame)
					.map((entry) => entry.frame)
			);
			const nextSnapshots = [];
			state.exactCheckpointMode = true;
			try {
				state.cpTimes = [];
				state.collectedCP = 0;
				state.lastCP = 0;
				const prepared = prepareSimTrialLevel(level, seed);
				if (!prepared.ready) return false;

				state.cpTimes = [];
				state.collectedCP = 0;
				state.lastCP = 0;
				armReplay(baseScript, { normalized: true });
				resetFreeze(gmLevel());
				let reached = false;
				let score = Infinity;

				for (let index = 0; index < maxFrames; index++) {
					const frame = gameFrame();
					if (
						frame >= minFrame &&
						(frame === minFrame || (frame - minFrame) % snapshotStride === 0 || inputFrames.has(frame))
					) {
						const snapshot = captureSnapshot(frame);
						if (snapshot) nextSnapshots.push(snapshot);
					}

					W.__circlooTasPumpFrame();
					if (state.collectedCP >= finishCP) {
						reached = true;
						score = gameFrame();
						break;
					}
				}

				if (!nextSnapshots.length || nextSnapshots[0].frame !== minFrame) return false;
				snapshots = nextSnapshots;
				baseResult = {
					reached,
					score,
					cp: state.collectedCP,
					times: state.cpTimes.slice(),
					debug: {
						trialMs: 0,
						prepareMs: 0,
						pumpMs: 0,
						frames: 0,
						prepPumps: prepared.prepPumps,
						rewindFrame: reached ? score : minFrame,
						fast: true,
						compact: true
					}
				};
				lastRewindFrame = minFrame;
				buildMs = REAL.now() - started;
				return true;
			} finally {
				stopReplay();
				state.exactCheckpointMode = false;
			}
		}

		function chooseSnapshot(candidateScript, differenceFrame) {
			let selected = snapshots[0];
			for (const snapshot of snapshots) {
				if (snapshot.frame > differenceFrame) break;
				if (scriptPrefixKey(candidateScript, snapshot.frame) !== snapshot.prefixKey) break;
				selected = snapshot;
			}
			return selected;
		}

		function evaluate(candidate) {
			const candidateScript = normalizeScript(candidate);
			const differenceFrame = earliestNormalizedInputDifference(baseScript, candidateScript);
			if (!Number.isFinite(differenceFrame) || (baseResult.reached && differenceFrame >= baseResult.score)) {
				lastRewindFrame = baseResult.reached ? baseResult.score : minFrame;
				return {
					...baseResult,
					times: baseResult.times.slice(),
					debug: { ...baseResult.debug, rewindFrame: lastRewindFrame, differenceFrame, frames: 0 }
				};
			}
			if (differenceFrame < minFrame) {
				return {
					reached: false,
					score: Infinity,
					cp: 0,
					times: [],
					incompatiblePrefix: true,
					debug: { rewindFrame: minFrame, differenceFrame, frames: 0, fast: true, compact: true }
				};
			}

			const snapshot = chooseSnapshot(candidateScript, differenceFrame);
			lastRewindFrame = snapshot.frame;
			const restoreStart = REAL.now();
			const world = snapshot.cloneWorld();
			const body = findPlayerBody(world, snapshot.playerId);
			if (!world || !body) {
				return {
					reached: false,
					score: Infinity,
					cp: snapshot.prefixCP,
					times: snapshot.prefixTimes.slice(),
					debug: { rewindFrame: snapshot.frame, differenceFrame, frames: 0, fast: true, compact: true }
				};
			}
			const restoreMs = REAL.now() - restoreStart;

			let frame = snapshot.frame;
			let input = snapshot.initialInput;
			let entryIndex = 0;
			let cp = snapshot.prefixCP;
			const times = snapshot.prefixTimes.slice();
			let bigRadius = snapshot.bigRadius;
			let growthAlarm = snapshot.growthAlarm;
			const circles = snapshot.circles.map((circle) => ({ ...circle }));
			while (
				entryIndex < candidateScript.length &&
				(candidateScript[entryIndex].input === 'U' || candidateScript[entryIndex].frame < frame)
			) {
				entryIndex++;
			}

			const velocityPrototype = Object.getPrototypeOf(body._zC1());
			const nudgeHorizontalVelocity = (amount) => {
				const current = body._zC1();
				const velocity = Object.create(velocityPrototype);
				velocity.x =
					((current.x / snapshot.scale / snapshot.roomSpeed) + amount) *
					snapshot.scale *
					snapshot.roomSpeed;
				velocity.y = current.y;
				body._yC1(velocity);
				body._pd1(true);
			};
			const applyInput = (nextInput) => {
				if (nextInput.includes('L')) nudgeHorizontalVelocity(-0.52 * snapshot.inputScale);
				if (nextInput.includes('R')) nudgeHorizontalVelocity(0.52 * snapshot.inputScale);
				if (snapshot.extraInput && nextInput.includes('L')) nudgeHorizontalVelocity(-0.01);
				if (snapshot.extraInput && nextInput.includes('R')) nudgeHorizontalVelocity(0.01);
			};

			const pumpStart = REAL.now();
			while (frame < maxFrames) {
				while (entryIndex < candidateScript.length && candidateScript[entryIndex].frame <= frame) {
					if (candidateScript[entryIndex].input !== 'U') input = candidateScript[entryIndex].input;
					entryIndex++;
				}

				if (growthAlarm > 0) {
					growthAlarm -= 1;
					if (growthAlarm === 0) {
						bigRadius = Math.min(snapshot.bigMaxRadius, bigRadius + 200);
						growthAlarm = -1;
					}
				}

				applyInput(input);
				frame++;
				const position = body._Rc1();
				const playerX = position.x / snapshot.scale;
				const playerY = position.y / snapshot.scale;
				for (let circleIndex = 0; circleIndex < circles.length; circleIndex++) {
					const circle = circles[circleIndex];
					const dx = playerX - circle.x;
					const dy = playerY - circle.y;
					if (dx * dx + dy * dy >= snapshot.collectRadius * snapshot.collectRadius) continue;

					circles.splice(circleIndex, 1);
					cp += 1;
					times[cp] = frame;
					if (bigRadius < snapshot.bigMaxRadius) growthAlarm = 10;
					else if (cp >= finishCP) {
						return {
							reached: true,
							score: frame,
							cp,
							times,
							debug: {
								trialMs: restoreMs + (REAL.now() - pumpStart),
								prepareMs: restoreMs,
								pumpMs: REAL.now() - pumpStart,
								frames: frame - snapshot.frame,
								prepPumps: 0,
								rewindFrame: snapshot.frame,
								differenceFrame,
								fast: true,
								compact: true
							}
						};
					}
					break;
				}

				world._jF1(1 / snapshot.stepRate, snapshot.iterations, snapshot.iterations);
				world._nF1();
			}

			return {
				reached: false,
				score: Infinity,
				cp,
				times,
				debug: {
					trialMs: restoreMs + (REAL.now() - pumpStart),
					prepareMs: restoreMs,
					pumpMs: REAL.now() - pumpStart,
					frames: frame - snapshot.frame,
					prepPumps: 0,
					rewindFrame: snapshot.frame,
					differenceFrame,
					fast: true,
					compact: true
				}
			};
		}

		if (!rebuild(baseScript)) return null;
		return {
			level,
			finishCP,
			get resumeFrame() {
				return minFrame;
			},
			get rewindFrame() {
				return lastRewindFrame;
			},
			get snapshotCount() {
				return snapshots.length;
			},
			get buildMs() {
				return buildMs;
			},
			evaluate,
			rebuild,
			prefixMatches(candidate) {
				return earliestInputDifference(baseScript, candidate) >= minFrame;
			}
		};
	}

	function createDynamicTargetOptimizer(script, options = {}) {
		if (!IS_SIM) return null;
		const level = Math.max(0, Math.floor(Number(options.level) || 0));
		const target = options.target === 'cp' ? 'cp' : options.target === 'finish' ? 'finish' : null;
		const targetCP = Math.max(1, Math.floor(Number(options.targetCP) || 1));
		const finishCP = Math.max(1, Math.floor(Number(options.finishCP) || 1));
		if (level < 1 || level > 20 || !target) return null;

		const maxFrames = Math.max(1, Math.floor(Number(options.maxFrames) || 1));
		const minFrame = Math.max(0, Math.floor(Number(options.minFrame) || 0));
		const configuredMaxFrame = Math.max(0, Math.floor(Number(options.maxFrame) || 0));
		const maxMutationFrame = configuredMaxFrame > 0 ? configuredMaxFrame : maxFrames;
		const snapshotStride = Math.max(8, Math.floor(Number(options.snapshotStride) || 32));
		const seed = Number.isFinite(Number(options.seed))
			? Math.trunc(Number(options.seed)) | 0
			: DEFAULT_GAMEPLAY_SEED;
		let baseScript = normalizeScript(script);
		let snapshots = [];
		let baseResult = null;
		let lastRewindFrame = 0;
		let buildMs = 0;
		let verifierRoot = null;
		let verifierScalars = null;
		let verifierClock = null;

		function targetReached() {
			return target === 'cp'
				? state.collectedCP >= targetCP && state.cpTimes[targetCP] != null
				: state.collectedCP >= finishCP;
		}

		function targetScore() {
			return target === 'cp' ? Number(state.cpTimes[targetCP]) : gameFrame();
		}

		function runtimeRoot() {
			return callGlobal(
				[
					'return {',
					'  room: _Ux, builtins: _cd, gameGlobal: global, runner: _Xx, objects: _Gx, instances: __11,',
					'  input: (typeof _ZG !== "undefined" ? _ZG : null),',
					'  particles: (typeof _OE !== "undefined" ? _OE : null),',
					'  timeline: (typeof _Q71 !== "undefined" ? _Q71 : null),',
					'  sequence: (typeof _yU !== "undefined" ? _yU : null),',
					'  roomQueue: (typeof _H31 !== "undefined" ? _H31 : null),',
					'  particleInstances: (typeof _iz2 !== "undefined" ? _iz2 : null)',
					'};'
				].join('\n')
			);
		}

		function captureSnapshot(frame) {
			const templateGraph = cloneSimulationGraph(runtimeRoot(), { proxyGameMakerInstances: false });
			return {
				frame,
				templateRoot: templateGraph.root,
				cloneRuntimeRoot: buildSimulationCloneFactory(templateGraph.root, { proxyGameMakerInstances: false }),
				scalars: captureRuntimeScalars(),
				replay: captureReplaySimulationState(),
				clock:
					typeof W.__circlooTasCaptureFastClock === 'function'
						? W.__circlooTasCaptureFastClock()
						: null
			};
		}

		function snapshotFramesFor(nextBase) {
			const frames = new Set([0, minFrame]);
			for (let frame = minFrame; frame <= maxMutationFrame && frame < maxFrames; frame += snapshotStride) {
				frames.add(frame);
			}
			for (const entry of nextBase) {
				if (entry.input !== 'U' && entry.frame >= minFrame && entry.frame <= maxMutationFrame) {
					frames.add(entry.frame);
				}
			}
			return frames;
		}

		function rebuild(nextBaseScript) {
			const started = REAL.now();
			baseScript = normalizeScript(nextBaseScript);
			const wantedFrames = snapshotFramesFor(baseScript);
			const capturedFrames = new Set();
			const nextSnapshots = [];
			state.exactCheckpointMode = true;
			try {
				state.cpTimes = [];
				state.collectedCP = 0;
				state.lastCP = 0;
				const prepared = prepareSimTrialLevel(level, seed);
				if (!prepared.ready) return false;

				state.cpTimes = [];
				state.collectedCP = 0;
				state.lastCP = 0;
				armReplay(baseScript, { normalized: true });
				resetFreeze(gmLevel());
				let reached = false;
				let score = Infinity;
				for (let index = 0; index < maxFrames; index++) {
					const frame = gameFrame();
					if (wantedFrames.has(frame) && !capturedFrames.has(frame)) {
						capturedFrames.add(frame);
						nextSnapshots.push(captureSnapshot(frame));
					}
					W.__circlooTasPumpFrame();
					if (!reached && targetReached()) {
						reached = true;
						score = targetScore();
						break;
					}
				}

				if (!nextSnapshots.length || nextSnapshots[0].frame !== 0) return false;
				snapshots = nextSnapshots.sort((left, right) => left.frame - right.frame);
				baseResult = {
					reached,
					score,
					cp: state.collectedCP,
					times: state.cpTimes.slice(),
					debug: {
						trialMs: 0,
						prepareMs: 0,
						pumpMs: 0,
						frames: score === Infinity ? maxFrames : score,
						prepPumps: prepared.prepPumps,
						rewindFrame: 0,
						fast: true
					}
				};
				verifierRoot = runtimeRoot();
				verifierScalars = captureRuntimeScalars();
				verifierClock =
					typeof W.__circlooTasCaptureFastClock === 'function'
						? W.__circlooTasCaptureFastClock()
						: null;
				lastRewindFrame = 0;
				buildMs = REAL.now() - started;
				return true;
			} finally {
				stopReplay();
				state.exactCheckpointMode = false;
			}
		}

		function chooseSnapshot(differenceFrame) {
			let selected = snapshots[0];
			for (const snapshot of snapshots) {
				if (snapshot.frame > differenceFrame) break;
				selected = snapshot;
			}
			return selected;
		}

		function evaluate(candidate) {
			const candidateScript = normalizeScript(candidate);
			const differenceFrame = earliestNormalizedInputDifference(baseScript, candidateScript);
			if (!Number.isFinite(differenceFrame)) {
				lastRewindFrame = baseResult && Number.isFinite(baseResult.score) ? baseResult.score : 0;
				return {
					...baseResult,
					times: baseResult.times.slice(),
					debug: { ...baseResult.debug, rewindFrame: lastRewindFrame, frames: 0 }
				};
			}

			const restored = restoreCandidate(candidateScript, differenceFrame, true);
			const snapshot = restored.snapshot;
			const restoreMs = restored.restoreMs;
			const pumpStart = REAL.now();
			let frames = 0;
			let reached = targetReached();
			let score = reached ? targetScore() : Infinity;
			const maxPumps = Math.max(0, maxFrames - snapshot.frame);
			while (!reached && frames < maxPumps) {
				W.__circlooTasPumpFrame();
				frames++;
				if (targetReached()) {
					reached = true;
					score = targetScore();
				}
			}
			const pumpMs = REAL.now() - pumpStart;
			return {
				reached,
				score,
				cp: state.collectedCP,
				times: state.cpTimes.slice(),
				debug: {
					trialMs: restoreMs + pumpMs,
					prepareMs: restoreMs,
					pumpMs,
					frames,
					prepPumps: 0,
					rewindFrame: snapshot.frame,
					differenceFrame,
					fast: true
				}
			};
		}

		function restoreCandidate(
			candidateScript,
			differenceFrame = earliestNormalizedInputDifference(baseScript, candidateScript),
			alreadyNormalized = false
		) {
			const normalizedCandidate = alreadyNormalized ? candidateScript : normalizeScript(candidateScript);
			const snapshot = chooseSnapshot(Number.isFinite(differenceFrame) ? differenceFrame : 0);
			lastRewindFrame = snapshot.frame;
			const restoreStart = REAL.now();
			const workingRoot = snapshot.cloneRuntimeRoot();
			installRuntimeRoot(workingRoot);
			restoreRuntimeScalars(snapshot.scalars);
			if (snapshot.clock && typeof W.__circlooTasRestoreFastClock === 'function') {
				W.__circlooTasRestoreFastClock(snapshot.clock);
			}
			restoreReplaySimulationState(snapshot.replay, normalizedCandidate, snapshot.frame, true);
			return {
				snapshot,
				restoreMs: REAL.now() - restoreStart,
				frame: gameFrame(),
				cp: state.collectedCP,
				room: simRoomId(),
				hasPlayer: !!gmPlayer(),
				hasPhysics: simHasPhysicsWorld()
			};
		}

		function restoreVerifier() {
			if (!verifierRoot) return false;
			installRuntimeRoot(verifierRoot);
			restoreRuntimeScalars(verifierScalars);
			if (verifierClock && typeof W.__circlooTasRestoreFastClock === 'function') {
				W.__circlooTasRestoreFastClock(verifierClock);
			}
			stopReplay();
			state.exactCheckpointMode = false;
			return true;
		}

		if (!rebuild(baseScript)) return null;
		return {
			level,
			target,
			targetCP,
			finishCP,
			get resumeFrame() {
				return lastRewindFrame;
			},
			get rewindFrame() {
				return lastRewindFrame;
			},
			get snapshotCount() {
				return snapshots.length;
			},
			get buildMs() {
				return buildMs;
			},
			evaluate,
			restoreCandidate,
			restoreVerifier,
			rebuild
		};
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
			armReplay(script, { normalized: true });
			resetFreeze(gmLevel());

			const targetCP = Math.max(1, Math.floor(Number(options.targetCP) || 1));
			const finishCP = Math.max(1, Math.floor(Number(options.finishCP) || 1));
			const pointX = Number.isFinite(Number(options.pointX)) ? Number(options.pointX) : 0;
			const pointY = Number.isFinite(Number(options.pointY)) ? Number(options.pointY) : 0;
			const pointZ = Number.isFinite(Number(options.pointZ)) ? Number(options.pointZ) : 0;
			const pointMinFrame = Math.max(0, Math.floor(Number(options.pointMinFrame) || 0));
			const pointMaxFrame = Math.max(
				pointMinFrame,
				Math.floor(Number(options.pointMaxFrame) || pointMinFrame)
			);
			const configuredMaxFrames = Math.max(1, Math.floor(Number(options.maxFrames) || 1));
			const simulationLimit =
				options.target === 'point' ? Math.max(configuredMaxFrames, pointMaxFrame + 1) : configuredMaxFrames;
			let score = Infinity;
			let reached = false;
			let frames = 0;
			let bestPointFrame = null;
			let bestPointPosition = null;
			const samplePoint = () => {
				if (options.target !== 'point') return;
				const frame = gameFrame();
				if (frame < pointMinFrame || frame > pointMaxFrame) return;
				const player = gmPlayer();
				const x = Number(player && player.x);
				const y = Number(player && player.y);
				if (!Number.isFinite(x) || !Number.isFinite(y)) return;
				const distance = Math.hypot(x - pointX, y - pointY, pointZ);
				if (!Number.isFinite(distance)) return;
				reached = true;
				if (distance < score || (distance === score && (bestPointFrame === null || frame < bestPointFrame))) {
					score = distance;
					bestPointFrame = frame;
					bestPointPosition = { x, y, z: 0 };
				}
			};
			samplePoint();
			const pumpStart = REAL.now();
			for (let i = 0; i < simulationLimit; i++) {
				W.__circlooTasPumpFrame();
				frames++;
				updateCheckpointTracking();
				samplePoint();

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
				if (options.target === 'point' && gameFrame() >= pointMaxFrame) break;
			}
			const pumpMs = REAL.now() - pumpStart;
			const finalPlayer = gmPlayer();
			const finalBody = finalPlayer && finalPlayer._Xd1 && finalPlayer._Xd1._932;
			const finalBig = gmBig();
			const finalPosition = finalBody && typeof finalBody._Rc1 === 'function' ? finalBody._Rc1() : null;
			const finalVelocity = finalBody && typeof finalBody._zC1 === 'function' ? finalBody._zC1() : null;

			return {
				score,
				reached,
				cp: state.collectedCP,
				times: state.cpTimes.slice(),
				bestFrame: bestPointFrame,
				bestPosition: bestPointPosition,
				debug: {
					trialMs: REAL.now() - trialStart,
					prepareMs,
					pumpMs,
					frames,
					prepPumps: prepareDebug.prepPumps,
					startRadius: prepareDebug.startRadius,
					endRadius: prepareDebug.endRadius,
					endFrame: prepareDebug.endFrame,
					ready: prepareDebug.ready,
					finalState: {
						frame: gameFrame(),
						checkpoint: state.collectedCP,
						growthAlarm: Array.isArray(finalBig && finalBig._md) ? Number(finalBig._md[0]) : -1,
						boundaryRadius: Number(finalBig && finalBig._jd),
						x: Number(finalPosition && finalPosition.x),
						y: Number(finalPosition && finalPosition.y),
						vx: Number(finalVelocity && finalVelocity.x),
						vy: Number(finalVelocity && finalVelocity.y),
						angle: Number(finalBody && typeof finalBody._Hq1 === 'function' ? finalBody._Hq1() : NaN),
						angularVelocity: Number(finalBody && typeof finalBody._BC1 === 'function' ? finalBody._BC1() : NaN)
					}
				}
			};
		} finally {
			stopReplay();
			state.exactCheckpointMode = false;
		}
	}

	function inspectCompactPhysics(script, options = {}, targetFrame = 0) {
		if (!IS_SIM) return null;
		const normalized = normalizeScript(script);
		state.exactCheckpointMode = true;
		try {
			state.cpTimes = [];
			state.collectedCP = 0;
			state.lastCP = 0;
			const prepared = prepareSimTrialLevel(options.level, options.seed);
			if (!prepared.ready) return { prepared };
			state.cpTimes = [];
			state.collectedCP = 0;
			state.lastCP = 0;
			armReplay(normalized, { normalized: true });
			resetFreeze(gmLevel());
			let snapshotPumps = 0;
			const maximumSnapshotPumps = Math.max(240, Math.max(0, targetFrame) * 2 + 240);
			while (gameFrame() < targetFrame && snapshotPumps < maximumSnapshotPumps) {
				W.__circlooTasPumpFrame();
				snapshotPumps++;
			}
			if (gameFrame() < targetFrame) {
				return {
					prepared: {
						...prepared,
						ready: false,
						reason: 'snapshot-frame-unreachable',
						targetFrame,
						actualFrame: gameFrame(),
						pumps: snapshotPumps
					}
				};
			}

			function serial(value, depth = 0, seen = new Set()) {
				if (value == null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
				if (typeof value === 'function') return `[fn:${value.name || 'anonymous'}]`;
				if (depth >= 3 || seen.has(value)) return `[${value.constructor && value.constructor.name || typeof value}]`;
				seen.add(value);
				if (Array.isArray(value)) return value.slice(0, 32).map((item) => serial(item, depth + 1, seen));
				const out = { __class: value.constructor && value.constructor.name || '' };
				for (const key of Reflect.ownKeys(value).slice(0, 96)) {
					if (typeof key !== 'string') continue;
					let item;
					try { item = value[key]; } catch { continue; }
					if (typeof item === 'function') continue;
					out[key] = serial(item, depth + 1, seen);
				}
				return out;
			}

			function exactShape(shape) {
				if (!shape) return null;
				const type = Number(shape._461);
				let vertices = [];
				if (type === 1) {
					vertices = [vec(shape._Gs1), vec(shape._Hs1)].filter(Boolean);
				} else if (Array.isArray(shape._Ts1)) {
					vertices = shape._Ts1
						.slice(0, Math.max(0, Number(shape._Us1) || shape._Ts1.length))
						.map(vec);
				}
				return {
					type,
					radius: Number(shape._as1),
					center: vec(shape._ts1),
					vertices,
					vertexCount: Number(shape._Us1),
					previousVertex: vec(type === 1 ? shape._Fs1 : shape._Vs1),
					nextVertex: vec(type === 1 ? shape._Is1 : shape._Ws1),
					hasPreviousVertex: !!(type === 1 ? shape._Js1 : shape._Xs1),
					hasNextVertex: !!(type === 1 ? shape._Ks1 : shape._Ys1)
				};
			}

			const wrapper = physicsWrapper();
			const world = physicsWorld();
			const bodies = [];
			const bodyIds = new Map();
			for (
				let body = world && typeof world._DF1 === 'function' ? world._DF1() : null, bodyIndex = 0;
				body;
				body = typeof body._kD1 === 'function' ? body._kD1() : null, bodyIndex++
			) {
				bodyIds.set(body, bodyIndex);
				const fixtures = [];
				for (
					let fixture = typeof body._hD1 === 'function' ? body._hD1() : null;
					fixture;
					fixture = typeof fixture._kD1 === 'function' ? fixture._kD1() : null
				) {
					const shape =
						typeof fixture._ED1 === 'function'
							? fixture._ED1()
							: fixture._zD1 || fixture._7D1 || fixture._3D1 || null;
					fixtures.push({
						fixtureClass: fixture.constructor && fixture.constructor.name,
						shapeClass: shape && shape.constructor && shape.constructor.name,
						shape: exactShape(shape),
						density: typeof fixture._MD1 === 'function' ? Number(fixture._MD1()) : Number(fixture._iC1),
						friction: typeof fixture._ND1 === 'function' ? Number(fixture._ND1()) : Number(fixture._CD1),
						restitution: typeof fixture._OD1 === 'function' ? Number(fixture._OD1()) : Number(fixture._DD1),
						sensor: typeof fixture._GD1 === 'function' ? !!fixture._GD1() : !!fixture._BD1,
						filter: (() => {
							const filter = typeof fixture._JD1 === 'function' ? fixture._JD1() : fixture._AD1;
							return filter
								? {
									categoryBits: Number(filter._sD1),
									maskBits: Number(filter._tD1),
									groupIndex: Number(filter._uD1)
								}
								: null;
						})(),
						fixture: serial(fixture)
					});
				}
				const user = typeof body._bu1 === 'function' ? body._bu1() : null;
				bodies.push({
					bodyIndex,
					bodyClass: body.constructor && body.constructor.name,
					userId: Number(user && user.id),
					objectIndex: Number(user && user._Ok),
					type: typeof body._bs1 === 'function' ? body._bs1() : null,
					position: vec(typeof body._Rc1 === 'function' ? body._Rc1() : null),
					angle: typeof body._Hq1 === 'function' ? body._Hq1() : null,
					linearVelocity: vec(typeof body._zC1 === 'function' ? body._zC1() : null),
					angularVelocity: typeof body._BC1 === 'function' ? body._BC1() : null,
					linearDamping: typeof body._YC1 === 'function' ? Number(body._YC1()) : Number(body._OB1),
					angularDamping: typeof body._ZC1 === 'function' ? Number(body._ZC1()) : Number(body._PB1),
					gravityScale: typeof body.__C1 === 'function' ? Number(body.__C1()) : Number(body._QB1),
					sleepTime: Number(body._TB1) || 0,
					allowSleep: typeof body._bD1 === 'function' ? !!body._bD1() : true,
					awake: typeof body._cD1 === 'function' ? !!body._cD1() : true,
					active: typeof body._eD1 === 'function' ? !!body._eD1() : true,
					bullet: typeof body._9D1 === 'function' ? !!body._9D1() : false,
					fixedRotation: typeof body._gD1 === 'function' ? !!body._gD1() : false,
					body: serial(body),
					fixtures
				});
			}
			const joints = [];
			for (
				let joint = world && typeof world._iD1 === 'function' ? world._iD1() : null, jointIndex = 0;
				joint;
				joint = typeof joint._kD1 === 'function' ? joint._kD1() : joint._LB1 || null, jointIndex++
			) {
				joints.push(jointSnapshot(joint, jointIndex, bodyIds));
			}
			return {
				frame: gameFrame(),
				cp: state.collectedCP,
				times: state.cpTimes.slice(),
				collectibles:
					callGlobal(
						[
							'var out = []; var types = [21,22,23,24];',
							'for (var t = 0; t < types.length; t++) {',
							' var object = _Gx && _Gx._qH(types[t]);',
							' var list = object && object._Ln2 ? object._Ln2._OH : null;',
							' if (!list) continue;',
							' for (var i = 0; i < list.length; i++) {',
							'  var circle = list[i]; if (!circle) continue;',
							'  out.push({type:types[t],id:Number(circle.id),objectIndex:Number(circle._Ok),x:Number(circle.x),y:Number(circle.y),',
							'   physicsX:Number(circle._972),physicsY:Number(circle._a72),radius:Number(circle._jd),',
							'   collected:!!circle._qf,active:!!circle._rf,excluded:Number(circle._ye)>0.5,',
							'   fields:(function(){var fields={}; var names=["_jd","_nd","_od","_pd","_qf","_rf","_sf","_tf","_uf","_vf","_wf","_xf","_yf","_zf","_Af","_Bf","_Cf","_Df","_Ef","_Ff","_Gf","_Hf","_If","_Jf","_Kf","_Lf","_Mf","_Nf","_Of","_Pf","_Qf","_Rf","_Sf","_Tf","_Uf","_Vf","_Wf","_Xf","_Yf","_Zf","__f","_0f","_1f","_2f","_3f","_4f","_5f","_6f","_7f","_8f","_9f","_ye","_Ot","_hq"]; for(var n=0;n<names.length;n++){var key=names[n];var value=circle[key];if(value==null||typeof value==="number"||typeof value==="string"||typeof value==="boolean")fields[key]=value;}return fields;})()});',
							' }',
							'} return out;'
						].join('\n')
					) || [],
				wrapper: {
					scale: Number(wrapper && wrapper._sd1),
					stepRate: Number(wrapper && wrapper._K62),
					roomSpeed: Number(callGlobal('return typeof _Ux !== "undefined" && _Ux ? _Ux._AJ2 : 60;')),
					velocityIterations: Number(wrapper && wrapper._L62),
					positionIterations: Number(wrapper && wrapper._L62),
					raw: serial(wrapper)
				},
				world: world
					? {
						gravity: vec(world._IE1),
						allowSleep: typeof world._FF1 === 'function' ? !!world._FF1() : true,
						warmStarting: typeof world._HF1 === 'function' ? !!world._HF1() : true,
						continuousPhysics: typeof world._JF1 === 'function' ? !!world._JF1() : true,
						subStepping: typeof world._LF1 === 'function' ? !!world._LF1() : false,
						bodyCount: bodies.length,
						jointCount: joints.length
					}
					: null,
				joints,
				player: (() => {
					const player = gmPlayer();
					return player
						? {
							id: Number(player.id),
							objectIndex: Number(player._Ok),
							x: Number(player.x),
							y: Number(player.y),
							radius: Number(player._jd),
							inputScale: Number(player._Ot) || 1,
							extraInput: !!callGlobal('return !!(typeof global !== "undefined" && global && global._Fc);'),
							fields: serial(player)
						}
						: null;
				})(),
				big: (() => {
					const big = gmBig();
					return big
						? {
							id: Number(big.id),
							objectIndex: Number(big._Ok),
							x: Number(big.x),
							y: Number(big.y),
							radius: Number(big._jd),
							radiusStep: Number(big._nd),
							maxRadius: Number(big._eq),
							growthAlarm: Array.isArray(big._md) ? Number(big._md[0]) : -1,
							fields: serial(big)
						}
						: null;
				})(),
				bodies
			};
		} finally {
			stopReplay();
			state.exactCheckpointMode = false;
		}
	}

	function traceCompactPhysics(script, options = {}, startFrame = 0, endFrame = 0) {
		if (!IS_SIM) return null;
		const normalized = normalizeScript(script);
		const boundaryOnly = !!options.boundaryOnly;
		const solverEvents = [];
		const solverStartFrame = Math.floor(Number(options.solverStartFrame ?? 307));
		const solverEndFrame = Math.floor(Number(options.solverEndFrame ?? 310));
		const solverChildren = new Set(
			(Array.isArray(options.solverChildren) ? options.solverChildren : [92])
				.map((value) => Math.floor(Number(value)))
				.filter(Number.isFinite)
		);
		const solverPrototype =
			!boundaryOnly && W.b2 && W.b2.ContactSolver ? W.b2.ContactSolver.prototype : null;
		const originalInitializeVelocity = solverPrototype && solverPrototype._YM1;
		const originalSolveVelocity = solverPrototype && solverPrototype._mN1;
		state.exactCheckpointMode = true;
		try {
			state.cpTimes = [];
			state.collectedCP = 0;
			state.lastCP = 0;
			const prepared = prepareSimTrialLevel(options.level, options.seed);
			if (!prepared.ready) return { prepared };
			state.cpTimes = [];
			state.collectedCP = 0;
			state.lastCP = 0;
			armReplay(normalized, { normalized: true });
			resetFreeze(gmLevel());

			const captureSolverConstraint = (solver, phase) => {
				const frame = gameFrame();
				if (
					frame < solverStartFrame ||
					frame > solverEndFrame ||
					!solver ||
					!Array.isArray(solver._PM1)
				) return;
				for (const constraint of solver._PM1) {
					if (!constraint || !(constraint._cw1 > 0)) continue;
					const contact = solver._VM1 && solver._VM1[constraint._HM1];
					const childA = Number(contact && contact._LL1);
					const childB = Number(contact && contact._ML1);
					if (!solverChildren.has(childA) && !solverChildren.has(childB)) continue;
					const point = constraint._aw1 && constraint._aw1[0];
					const velocityA = solver._UM1 && solver._UM1[constraint._Gu1];
					const velocityB = solver._UM1 && solver._UM1[constraint._Hu1];
					solverEvents.push({
						frame,
						phase,
						childA,
						childB,
						normal: vec(constraint._ms1),
						rA: vec(point && point._Wv1),
						rB: vec(point && point._Xv1),
						normalMass: Number(point && point._tM1),
						tangentMass: Number(point && point._uM1),
						velocityBias: Number(point && point._vM1),
						normalImpulse: Number(point && point._6w1),
						tangentImpulse: Number(point && point._7w1),
						vA: vec(velocityA && velocityA._3B),
						wA: Number(velocityA && velocityA._77),
						vB: vec(velocityB && velocityB._3B),
						wB: Number(velocityB && velocityB._77)
					});
				}
			};

			if (solverPrototype && typeof originalInitializeVelocity === 'function') {
				solverPrototype._YM1 = function tracedInitializeVelocity() {
					const result = originalInitializeVelocity.apply(this, arguments);
					captureSolverConstraint(this, 'initialize');
					return result;
				};
			}
			if (solverPrototype && typeof originalSolveVelocity === 'function') {
				solverPrototype._mN1 = function tracedSolveVelocity() {
					captureSolverConstraint(this, 'solve-before');
					const result = originalSolveVelocity.apply(this, arguments);
					captureSolverConstraint(this, 'solve-after');
					return result;
				};
			}

			let traceStartPumps = 0;
			const maximumTraceStartPumps = Math.max(240, Math.max(0, startFrame) * 2 + 240);
			while (gameFrame() < startFrame && traceStartPumps < maximumTraceStartPumps) {
				W.__circlooTasPumpFrame();
				traceStartPumps++;
			}
			if (gameFrame() < startFrame) {
				return {
					prepared: {
						...prepared,
						ready: false,
						reason: 'trace-start-frame-unreachable',
						targetFrame: startFrame,
						actualFrame: gameFrame(),
						pumps: traceStartPumps
					},
					times: state.cpTimes.slice(),
					frames: [],
					boundaryStates: [],
					solverEvents: []
				};
			}
			const frames = [];
			const boundaryStates = [];
			let lastBoundaryRadius = null;
			const maxSteps = Math.max(1, endFrame - startFrame + 2);
			for (let step = 0; step < maxSteps && gameFrame() <= endFrame; step++) {
				const player = gmPlayer();
				const body = player && player._Xd1 && player._Xd1._932;
				const big = gmBig();
				const boundaryRadius = Number(big && big._jd);
				if (Number.isFinite(boundaryRadius) && boundaryRadius !== lastBoundaryRadius) {
					const boundaryBody = big && big._Xd1 && big._Xd1._932;
					const boundaryFixture = boundaryBody && typeof boundaryBody._hD1 === 'function' ? boundaryBody._hD1() : null;
					const boundaryShape = boundaryFixture && typeof boundaryFixture._ED1 === 'function'
						? boundaryFixture._ED1()
						: boundaryFixture && (boundaryFixture._zD1 || boundaryFixture._7D1 || boundaryFixture._3D1);
					const filter = boundaryFixture && (typeof boundaryFixture._JD1 === 'function' ? boundaryFixture._JD1() : boundaryFixture._AD1);
					const staticCircles = [];
					const liveWorld = physicsWorld();
					for (
						let staticBody = liveWorld && typeof liveWorld._DF1 === 'function' ? liveWorld._DF1() : null;
						staticBody;
						staticBody = typeof staticBody._kD1 === 'function' ? staticBody._kD1() : null
					) {
						if (typeof staticBody._bs1 === 'function' && Number(staticBody._bs1()) !== 0) continue;
						const staticUser = typeof staticBody._bu1 === 'function' ? staticBody._bu1() : null;
						if (!staticUser || Number(staticUser.id) === Number(big && big.id)) continue;
						const staticFixture = typeof staticBody._hD1 === 'function' ? staticBody._hD1() : null;
						const staticShape = staticFixture && typeof staticFixture._ED1 === 'function'
							? staticFixture._ED1()
							: staticFixture && (staticFixture._zD1 || staticFixture._7D1 || staticFixture._3D1);
						if (!staticShape || Number(staticShape._461) !== 0) continue;
						const staticFilter = typeof staticFixture._JD1 === 'function' ? staticFixture._JD1() : staticFixture._AD1;
						staticCircles.push({
							id: Number(staticUser.id),
							objectIndex: Number(staticUser._Ok),
							position: vec(typeof staticBody._Rc1 === 'function' ? staticBody._Rc1() : null),
							angle: Number(typeof staticBody._Hq1 === 'function' ? staticBody._Hq1() : 0),
							radius: Number(staticShape._as1),
							friction: Number(typeof staticFixture._ND1 === 'function' ? staticFixture._ND1() : staticFixture._CD1),
							restitution: Number(typeof staticFixture._OD1 === 'function' ? staticFixture._OD1() : staticFixture._DD1),
							filter: staticFilter ? { categoryBits: Number(staticFilter._sD1), maskBits: Number(staticFilter._tD1), groupIndex: Number(staticFilter._uD1) } : null
						});
					}
					staticCircles.sort((left, right) => left.id - right.id);
					boundaryStates.push({
						frame: gameFrame(),
						radius: boundaryRadius,
						bodyPosition: vec(boundaryBody && typeof boundaryBody._Rc1 === 'function' ? boundaryBody._Rc1() : null),
						bodyAngle: Number(boundaryBody && typeof boundaryBody._Hq1 === 'function' ? boundaryBody._Hq1() : 0),
						shapeRadius: Number(boundaryShape && boundaryShape._as1),
						vertexCount: Number(boundaryShape && boundaryShape._Us1),
						vertices: Array.isArray(boundaryShape && boundaryShape._Ts1)
							? boundaryShape._Ts1.slice(0, Math.max(0, Number(boundaryShape._Us1) || boundaryShape._Ts1.length)).map(vec)
							: [],
						friction: Number(boundaryFixture && (typeof boundaryFixture._ND1 === 'function' ? boundaryFixture._ND1() : boundaryFixture._CD1)),
						restitution: Number(boundaryFixture && (typeof boundaryFixture._OD1 === 'function' ? boundaryFixture._OD1() : boundaryFixture._DD1)),
						filter: filter ? { categoryBits: Number(filter._sD1), maskBits: Number(filter._tD1), groupIndex: Number(filter._uD1) } : null,
						staticCircles
					});
					lastBoundaryRadius = boundaryRadius;
				}
				if (boundaryOnly) {
					if (state.collectedCP >= Math.max(1, Math.floor(Number(options.finishCP) || 7))) break;
					W.__circlooTasPumpFrame();
					continue;
				}
				const contacts = [];
				const world = physicsWorld();
				for (let contact = world && world._eC1 ? world._eC1._JB1 : null; contact; contact = contact._LB1) {
					const fixtureA = typeof contact._pC1 === 'function' ? contact._pC1() : contact._2G1;
					const fixtureB = typeof contact._rC1 === 'function' ? contact._rC1() : contact._4G1;
					const bodyA = fixtureA && typeof fixtureA._LD1 === 'function' ? fixtureA._LD1() : null;
					const bodyB = fixtureB && typeof fixtureB._LD1 === 'function' ? fixtureB._LD1() : null;
					const userA = bodyA && typeof bodyA._bu1 === 'function' ? bodyA._bu1() : null;
					const userB = bodyB && typeof bodyB._bu1 === 'function' ? bodyB._bu1() : null;
					const manifold = typeof contact._OL1 === 'function' ? contact._OL1() : contact._IL1;
					const manifoldPoints = [];
					const manifoldCount = Math.max(0, Number(manifold && manifold._cw1) || 0);
					for (let pointIndex = 0; pointIndex < manifoldCount; pointIndex++) {
						const point = manifold._aw1 && manifold._aw1[pointIndex];
						manifoldPoints.push({
							localPoint: vec(point && point._5w1),
							normalImpulse: Number(point && point._6w1),
							tangentImpulse: Number(point && point._7w1),
							id: Number(point && point.id && typeof point.id._qH === 'function' ? point.id._qH() : 0)
						});
					}
					contacts.push({
						a: Number(userA && userA.id),
						b: Number(userB && userB.id),
						childA: Number(typeof contact._tF1 === 'function' ? contact._tF1() : contact._LL1),
						childB: Number(typeof contact._vF1 === 'function' ? contact._vF1() : contact._ML1),
						flags: Number(contact._zB1),
						toiCount: Number(contact._8G1),
						toi: Number(contact._9G1),
						friction: Number(contact._CD1),
						restitution: Number(contact._DD1),
						manifold: {
							type: Number(manifold && manifold.type),
							localNormal: vec(manifold && manifold._bw1),
							localPoint: vec(manifold && manifold._5w1),
							points: manifoldPoints
						}
					});
				}
				frames.push({
					frame: gameFrame(),
					cp: state.collectedCP,
					input: effectiveInput(),
					contacts,
					instancePosition: player ? { x: Number(player.x), y: Number(player.y) } : null,
					playerRadius: Number(player && player._jd),
					collectibles:
						callGlobal(
							[
								'var out = []; var object = _Gx && _Gx._qH(21);',
								'var list = object && object._Ln2 ? object._Ln2._OH : null;',
								'if (list) for (var i = 0; i < list.length; i++) {',
								' var item = list[i]; if (!item) continue;',
								' out.push({id:Number(item.id),x:Number(item.x),y:Number(item.y),',
								'  collected:!!item._qf,active:!!item._rf,fade:Number(item._tq),excluded:Number(item._ye)>0.5});',
								'} return out;'
							].join('\n')
						) || [],
					position: vec(body && body._Rc1()),
					linearVelocity: vec(body && body._zC1()),
					angle: body && body._Hq1(),
					angularVelocity: body && body._BC1(),
					bigRadius: Number(big && big._jd),
					alarm: Array.isArray(big && big._md) ? Number(big._md[0]) : -1
				});
				if (state.collectedCP >= Math.max(1, Math.floor(Number(options.finishCP) || 7))) break;
				W.__circlooTasPumpFrame();
			}
			return { prepared, times: state.cpTimes.slice(), frames, boundaryStates, solverEvents, solverProbe: { b2: !!W.b2, keys: W.b2 ? Object.keys(W.b2).filter((key) => key.toLowerCase().includes('contact')).slice(0, 30) : [], contactSolver: !!(W.b2 && W.b2.ContactSolver), contactSolverType: typeof (W.b2 && W.b2.ContactSolver), contactSolverKeys: W.b2 && W.b2.ContactSolver ? Object.keys(W.b2.ContactSolver).slice(0, 30) : [], methods: solverPrototype ? Object.getOwnPropertyNames(solverPrototype) : [] } };
		} finally {
			if (solverPrototype && originalInitializeVelocity) solverPrototype._YM1 = originalInitializeVelocity;
			if (solverPrototype && originalSolveVelocity) solverPrototype._mN1 = originalSolveVelocity;
			stopReplay();
			state.exactCheckpointMode = false;
		}
	}

	function captureWasmRuntimeModel(script, options = {}, snapshotFrame = 0, endFrame = 0) {
		if (!IS_SIM) return null;
		const normalized = normalizeScript(script);
		const inspection = inspectCompactPhysics(normalized, options, snapshotFrame);
		if (!inspection || (inspection.prepared && !inspection.prepared.ready)) {
			return { inspection, boundaryStates: [], times: [] };
		}
		const trace = traceCompactPhysics(
			normalized,
			{
				...options,
				boundaryOnly: true,
				solverStartFrame: endFrame + 1,
				solverEndFrame: endFrame + 1,
				solverChildren: []
			},
			snapshotFrame,
			endFrame
		);
		return {
			inspection,
			boundaryStates: trace && Array.isArray(trace.boundaryStates) ? trace.boundaryStates : [],
			times: trace && Array.isArray(trace.times) ? trace.times : []
		};
	}

	W.__circlooTasRunTrial = simTrial;
	W.__circlooTasInspectCompactPhysics = inspectCompactPhysics;
	W.__circlooTasTraceCompactPhysics = traceCompactPhysics;
	W.__circlooTasCaptureWasmRuntimeModel = captureWasmRuntimeModel;
	W.__circlooTasDeterminismDigest = determinismDigest;
	W.__circlooTasCreateFinishOptimizer = createLevelOneFinishOptimizer;
	W.__circlooTasCreateAdaptiveFinishOptimizer = createLevelOneAdaptiveFinishOptimizer;
	W.__circlooTasCreateFinishSevenOptimizer = createLevelOneFinishSevenOptimizer;
	W.__circlooTasCreateDynamicFinishOptimizer = createDynamicTargetOptimizer;
	W.__circlooTasPatchGameHooks = patchGameHooks;
	W.__circlooTasRequestReplay = requestCanonicalReplay;

	function monitorTick() {
		state.wallFrame++;
		patchGameHooks();
		updateCheckpointTracking();
		updateVelocity();
		updateFreezeHint();
		installPointPicker();
		updatePointMarker();
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
			case 'SET_POINT_TARGET':
				setPointTarget(message);
				break;
			case 'START_POINT_PICK':
				setPointTarget({ ...message, enabled: true, picking: true });
				break;
			case 'CANCEL_POINT_PICK':
				setPointTarget({ ...state.pointTarget, picking: false });
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
		if (!IS_SIM) {
			installDomInputCapture();
			installPointPicker();
			resetCapture({ preserve: false });
		}

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
