(() => {
	'use strict';

	const W = window;
	const D = document;
	const PARAMS = new URLSearchParams(W.location.search);
	const IS_SIM = PARAMS.get('sim') === '1';
	const SIM_TOKEN = PARAMS.get('token') || '';
	const FPS = 60;

	const REAL = {
		setTimeout: W.setTimeout.bind(W),
		clearTimeout: W.clearTimeout.bind(W),
		setInterval: W.setInterval.bind(W),
		clearInterval: W.clearInterval.bind(W),
		now: () => (W.performance && typeof W.performance.now === 'function' ? W.performance.now() : Date.now()),
		raf: W.requestAnimationFrame
			? W.requestAnimationFrame.bind(W)
			: (callback) => W.setTimeout(() => callback(Date.now()), 16)
	};

	const INPUTS = ['.', 'L', 'R', 'LR'];
	const LEFT_CODES = new Set([37, 65]);
	const RIGHT_CODES = new Set([39, 68]);
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
		virtual: { L: false, R: false },
		prevVirtual: { L: false, R: false },
		domHeld: { L: false, R: false },
		capture: [],
		lastCaptureInput: null,
		lastFrameSeen: null,
		lastLevelSeen: null,
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
		runLogLastKey: null
	};

	W.__circlooTasBridge = state;

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

	function installFixedRaf() {
		if (IS_SIM || W.__circlooTasFixedRaf) return;
		W.__circlooTasFixedRaf = true;

		let nextId = 1;
		const timers = new Map();

		W.requestAnimationFrame = (callback) => {
			const id = nextId++;
			const timer = REAL.setTimeout(() => {
				timers.delete(id);
				callback(REAL.now());
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

	function normalizeScript(input) {
		const source = typeof input === 'string' ? parseScriptText(input) : Array.isArray(input) ? input : [];
		const out = [];

		for (const entry of source) {
			const frame = Math.max(0, Math.round(Number(entry.frame)));
			const parsed = parseInput(entry.input);
			const normalized = inputOfHeld(parsed);
			if (Number.isFinite(frame) && INPUTS.includes(normalized)) {
				out.push({ frame, input: normalized });
			}
		}

		out.sort((a, b) => a.frame - b.frame);

		const compact = [];
		for (const entry of out) {
			if (compact.length && compact[compact.length - 1].frame === entry.frame) {
				compact[compact.length - 1] = entry;
			} else if (!compact.length || compact[compact.length - 1].input !== entry.input) {
				compact.push(entry);
			}
		}

		if (!compact.length || compact[0].frame !== 0) {
			compact.unshift({ frame: 0, input: '.' });
		}

		return compact;
	}

	function serializeScript(script) {
		return normalizeScript(script)
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
		return frame > 0 ? frame : state.wallFrame;
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
		return {
			sequence: state.runLogSequence++,
			wallFrame: state.wallFrame,
			level,
			frame,
			timeSeconds: frame / FPS,
			cp: currentCP(),
			cpTimes: state.cpTimes.slice(),
			input: {
				active: state.playbackMode ? inputOfHeld(state.virtual) : liveInput(),
				virtual: { ...state.virtual },
				prevVirtual: { ...state.prevVirtual },
				domHeld: { ...state.domHeld },
				playbackMode: state.playbackMode,
				playIndex: state.playIndex,
				playLastFrame: state.playLastFrame,
				playLevel: state.playLevel
			},
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
		resetRunLog(reason);
		state.collectedCP = radiusCP();
		state.lastCP = currentCP();
		state.cpTimes = state.cpTimes.slice(0, state.lastCP + 1);
		if (state.playbackMode) {
			resetPlayback(gmLevel());
			applyPlaybackForFrame(0);
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

		const key = `${level}:${frame}`;
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
		state.prevVirtual = { L: false, R: false };
		state.virtual = { L: false, R: false };
	}

	function applyPlaybackForFrame(frame) {
		if (!state.playbackMode || state.paused) return;

		const level = gmLevel();
		if (state.playLevel == null || level !== state.playLevel) resetPlayback(level);
		if (!Number.isFinite(frame)) return;
		if (state.playLastFrame >= 0 && frame < state.playLastFrame - 1) resetPlayback(level);

		state.playLastFrame = frame;
		while (state.playIndex < state.script.length && state.script[state.playIndex].frame <= frame) {
			setVirtualInput(state.script[state.playIndex].input);
			state.playIndex++;
		}
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
		if (!state.virtualEnabled || !state.playbackMode || state.paused || !isVirtualCode(code)) return false;
		const player = gmPlayer();
		return sameGameInstance(self, player) || sameGameInstance(this, player);
	}

	function nativeInputHeld(code) {
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

	function patchInput() {
		if (state.installed || !gameReady()) return false;

		const inputCheckName = typeof W._J3 === 'function' ? '_J3' : typeof W._t4 === 'function' ? '_t4' : null;
		const inputPressedName = typeof W._K3 === 'function' ? '_K3' : typeof W._u4 === 'function' ? '_u4' : null;

		if (inputCheckName) {
			state.originalInputCheck = W[inputCheckName];
			W[inputCheckName] = function patchedInputCheck(self, other, code) {
				if (shouldUseVirtualInput.call(this, self, code)) return virtualCheck(code);
				return state.originalInputCheck.apply(this, arguments);
			};
		}

		if (inputPressedName) {
			state.originalInputPressed = W[inputPressedName];
			W[inputPressedName] = function patchedInputPressed(self, other, code) {
				if (shouldUseVirtualInput.call(this, self, code)) return virtualPressed(code);
				return state.originalInputPressed.apply(this, arguments);
			};
		}

		if (typeof W._R4 === 'function') {
			state.originalPokiInputCheck = W._R4;
			W._R4 = function patchedPokiInputCheck(self, other, code) {
				if (shouldUseVirtualInput.call(this, self, code)) return virtualCheck(code);
				return state.originalPokiInputCheck.apply(this, arguments);
			};
		}

		if (typeof W._S4 === 'function') {
			state.originalPokiInputPressed = W._S4;
			W._S4 = function patchedPokiInputPressed(self, other, code) {
				if (shouldUseVirtualInput.call(this, self, code)) return virtualPressed(code);
				return state.originalPokiInputPressed.apply(this, arguments);
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

	function patchPlayerCreate() {
		if (state.originalPlayerCreate || typeof W._P8 !== 'function') return !!state.originalPlayerCreate;

		state.originalPlayerCreate = W._P8;
		W._P8 = function patchedPlayerCreate(self, other) {
			const result = state.originalPlayerCreate.apply(this, arguments);
			beginFreshRun('player-create');
			return result;
		};

		return true;
	}

	function patchGameHooks() {
		const inputPatched = patchInput();
		patchCollectCircle();
		patchPlayerCreate();
		return inputPatched;
	}

	function resetCapture() {
		state.capture = [];
		state.lastCaptureInput = null;
		state.lastFrameSeen = captureFrame();
		state.lastLevelSeen = gmLevel();
		state.collectedCP = radiusCP();
		state.lastCP = currentCP();
		state.cpTimes = [];
	}

	function sampleCapture() {
		if (state.playbackMode) return;

		const frame = captureFrame();
		const level = gmLevel();
		if (state.lastLevelSeen !== null && level !== state.lastLevelSeen) resetCapture();
		if (state.lastFrameSeen !== null && frame < state.lastFrameSeen - 3) resetCapture();

		state.lastFrameSeen = frame;
		state.lastLevelSeen = level;

		const input = liveInput();
		if (state.lastCaptureInput === null || input !== state.lastCaptureInput) {
			state.capture.push({ frame, input });
			state.lastCaptureInput = input;
		}
	}

	function currentRunScript() {
		if (state.playbackMode) {
			const frame = captureFrame();
			const script = state.script.filter((entry) => entry.frame <= frame);
			return script.length ? script : [{ frame: 0, input: inputOfHeld(state.virtual) }];
		}

		sampleCapture();
		return state.capture;
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
			input: state.playbackMode ? inputOfHeld(state.virtual) : liveInput(),
			velocity: { ...state.velocity },
			captured: state.capture.length,
			playbackMode: state.playbackMode,
			paused: state.paused,
			sim: IS_SIM
		};
	}

	function armReplay(script) {
		resetRunLog('replay-armed');
		state.script = normalizeScript(script);
		state.virtualEnabled = true;
		state.playbackMode = true;
		state.paused = false;
		resetPlayback();
		setVirtualInput('.');
		post('SCRIPT_NORMALIZED', { script: state.script, text: serializeScript(state.script) });
	}

	function stopReplay() {
		state.virtualEnabled = false;
		state.playbackMode = false;
		state.paused = false;
		resetPlayback();
		setVirtualInput('.');
	}

	function setPaused(paused) {
		state.paused = !!paused;
		if (state.paused) setVirtualInput('.');
	}

	function tryStartLevel(level) {
		resetRunLog('start-level');
		const n = Math.max(0, Number(level) || 0);
		ensureSimPlayRoom();
		callGlobal('if (typeof _X32 === "function") _X32(); return true;');
		try {
			if (typeof W._c4 === 'function') {
				W._c4({}, {}, n);
				return true;
			}
		} catch {}
		try {
			if (typeof W._X4 === 'function') {
				W._X4({}, {}, n);
				return true;
			}
		} catch {}
		try {
			if (typeof W._05 === 'function') {
				W._05({}, {}, n);
				return true;
			}
		} catch {}
		return false;
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

	function simTrial(script, options) {
		state.exactCheckpointMode = true;
		try {
			armReplay(script);
			state.cpTimes = [];
			state.collectedCP = 0;
			state.lastCP = 0;
			tryStartLevel(options.level);
			W.__circlooTasPumpMany(Math.max(0, Number(options.warmup) || 0));
			resetPlayback(gmLevel());
			setVirtualInput('.');
			state.collectedCP = 0;
			state.lastCP = 0;
			state.cpTimes = [];

			const targetCP = Math.max(1, Math.floor(Number(options.targetCP) || 1));
			const finishCP = Math.max(1, Math.floor(Number(options.finishCP) || 1));
			let score = Infinity;
			let reached = false;
			for (let i = 0; i < options.maxFrames; i++) {
				W.__circlooTasPumpFrame();
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

			return { score, reached, cp: state.collectedCP, times: state.cpTimes.slice() };
		} finally {
			stopReplay();
			state.exactCheckpointMode = false;
		}
	}

	W.__circlooTasRunTrial = simTrial;

	function monitorTick() {
		state.wallFrame++;
		patchGameHooks();
		updateCheckpointTracking();
		updateVelocity();
		sampleCapture();
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
				armReplay(message.script ?? message.text);
				break;
			case 'PAUSE_REPLAY':
				setPaused(message.paused);
				break;
			case 'STOP_REPLAY':
				stopReplay();
				break;
			case 'CLEAR_CAPTURE':
				resetCapture();
				post('CAPTURE_CLEARED');
				break;
			case 'DUMP_CAPTURE': {
				const script = currentRunScript();
				const text = serializeScript(script);
				state.lastDumpText = text;
				post('CAPTURE_DUMP', {
					script: normalizeScript(script),
					text
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
			if (LEFT_CODES.has(event.keyCode)) state.domHeld.L = true;
			if (RIGHT_CODES.has(event.keyCode)) state.domHeld.R = true;
		}

		function keyUp(event) {
			if (shouldIgnoreKeyEvent(event)) return;
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
		resetCapture();

		const wait = () => {
			if (!gameReady()) return REAL.setTimeout(wait, 50);
			if (IS_SIM && !ensureSimPlayRoom()) {
				if (typeof W.__circlooTasPumpFrame === 'function') W.__circlooTasPumpFrame();
				return REAL.setTimeout(wait, 0);
			}
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
