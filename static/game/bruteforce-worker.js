(() => {
	'use strict';

	const W = self;
	W.window = W;
	W.globalThis = W;
	const workerParams = (() => {
		try {
			return new URLSearchParams(W.location.search);
		} catch {
			return new URLSearchParams();
		}
	})();
	const workerCacheBust = workerParams.get('v') || String(Date.now());
	const debugWasmParity = workerParams.get('debugWasm') === '1';
	const realSetTimeout = W.setTimeout.bind(W);
	const realClearTimeout = W.clearTimeout.bind(W);
	const realPerformanceNow =
		W.performance && typeof W.performance.now === 'function' ? W.performance.now.bind(W.performance) : null;
	const realDateNow = W.Date && typeof W.Date.now === 'function' ? W.Date.now.bind(W.Date) : () => 0;

	function realNow() {
		return realPerformanceNow ? realPerformanceNow() : realDateNow();
	}

	let runtimeReady = false;
	let pendingStart = null;
	let pendingTrial = null;
	let running = false;
	let current = null;
	let startGeneration = 0;
	let wasmRuntimePromise = null;
	const PROGRESS_INTERVAL_MS = 200;
	const BATCH_BUDGET_MS = 24;

	const noop = function () {};

	function makeEventTarget() {
		const listeners = new Map();
		return {
			addEventListener(type, listener) {
				if (!listeners.has(type)) listeners.set(type, new Set());
				listeners.get(type).add(listener);
			},
			removeEventListener(type, listener) {
				listeners.get(type)?.delete(listener);
			},
			dispatchEvent(event) {
				for (const listener of listeners.get(event.type) || []) {
					try {
						listener.call(this, event);
					} catch (error) {
						postError(error);
					}
				}
				return true;
			}
		};
	}

	class FakeCanvasContext {
		constructor(canvas) {
			this.canvas = canvas;
			this.globalAlpha = 1;
			this.fillStyle = '#000';
			this.strokeStyle = '#000';
			this.lineWidth = 1;
			this.font = '10px sans-serif';
			this.textAlign = 'left';
			this.textBaseline = 'alphabetic';
		}
		arc() {}
		beginPath() {}
		clearRect() {}
		clip() {}
		closePath() {}
		drawImage() {}
		fill() {}
		fillRect() {}
		fillText() {}
		getImageData() {
			return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
		}
		lineTo() {}
		measureText(text) {
			return { width: String(text || '').length * 10 };
		}
		moveTo() {}
		putImageData() {}
		quadraticCurveTo() {}
		rect() {}
		restore() {}
		rotate() {}
		save() {}
		scale() {}
		setTransform() {}
		stroke() {}
		strokeRect() {}
		strokeText() {}
		translate() {}
		createImageData(width, height) {
			return { data: new Uint8ClampedArray(Math.max(1, width * height * 4)), width, height };
		}
		createLinearGradient() {
			return { addColorStop() {} };
		}
		createRadialGradient() {
			return { addColorStop() {} };
		}
		createPattern() {
			return null;
		}
	}

	function makeContext(canvas) {
		return new Proxy(new FakeCanvasContext(canvas), {
			get(target, prop) {
				if (prop in target) return target[prop];
				return noop;
			}
		});
	}

	class FakeElement {
		constructor(tagName = 'div', id = '') {
			Object.assign(this, makeEventTarget());
			this.tagName = tagName.toUpperCase();
			this.nodeName = this.tagName;
			this.id = id;
			this.children = [];
			this.childNodes = this.children;
			this.parentNode = null;
			this.style = {};
			this.attributes = new Map();
			this.innerHTML = '';
			this.textContent = '';
			this.offsetLeft = 0;
			this.offsetTop = 0;
			this.offsetWidth = 960;
			this.offsetHeight = 600;
			this.clientWidth = 960;
			this.clientHeight = 600;
		}
		appendChild(child) {
			return this.insertBefore(child, null);
		}
		insertBefore(child) {
			child.parentNode = this;
			this.children.push(child);
			if (child.tagName === 'SCRIPT' && typeof child.onload === 'function') setTimeout(() => child.onload(), 0);
			return child;
		}
		removeChild(child) {
			this.children = this.children.filter((item) => item !== child);
			this.childNodes = this.children;
			child.parentNode = null;
			return child;
		}
		setAttribute(name, value) {
			this.attributes.set(String(name), String(value));
			if (name === 'id') this.id = String(value);
		}
		getAttribute(name) {
			return this.attributes.get(String(name)) ?? null;
		}
		hasAttribute(name) {
			return this.attributes.has(String(name));
		}
		focus() {}
		blur() {}
		getBoundingClientRect() {
			return { left: 0, top: 0, right: this.offsetWidth, bottom: this.offsetHeight, width: this.offsetWidth, height: this.offsetHeight };
		}
	}

	class FakeCanvas extends FakeElement {
		constructor(id = 'canvas') {
			super('canvas', id);
			this.width = 960;
			this.height = 600;
			this.offsetWidth = 960;
			this.offsetHeight = 600;
			this.clientWidth = 960;
			this.clientHeight = 600;
			this.complete = true;
			this._context = makeContext(this);
		}
		getContext() {
			return this._context;
		}
		toDataURL() {
			return 'data:image/png;base64,';
		}
	}

	class FakeImage {
		constructor() {
			Object.assign(this, makeEventTarget());
			this.complete = false;
			this.width = 64;
			this.height = 64;
			this.naturalWidth = 64;
			this.naturalHeight = 64;
			this.onload = null;
			this.onerror = null;
		}
		set src(value) {
			this._src = String(value || '');
			this.complete = true;
			setTimeout(() => {
				if (typeof this.onload === 'function') this.onload({ target: this });
				this.dispatchEvent({ type: 'load', target: this });
			}, 0);
		}
		get src() {
			return this._src || '';
		}
	}

	class FakeAudio extends FakeImage {
		canPlayType() {
			return '';
		}
		load() {}
		play() {
			return Promise.resolve();
		}
		pause() {}
	}

	class FakeXMLHttpRequest {
		constructor() {
			this.readyState = 0;
			this.status = 200;
			this.responseType = '';
			this.responseText = '';
			this.response = '';
			this.onreadystatechange = null;
			this.onload = null;
			this.onerror = null;
		}
		open(method, url) {
			this.method = method;
			this.url = url;
			this.readyState = 1;
		}
		setRequestHeader() {}
		send() {
			setTimeout(() => {
				this.readyState = 4;
				this.status = 200;
				this.response = this.responseType === 'arraybuffer' ? new ArrayBuffer(0) : '';
				this.responseText = '';
				if (typeof this.onreadystatechange === 'function') this.onreadystatechange({ target: this });
				if (typeof this.onload === 'function') this.onload({ target: this });
			}, 0);
		}
		abort() {}
		getResponseHeader() {
			return null;
		}
	}

	function installEnvironment() {
		const canvas = new FakeCanvas('canvas');
		const root = new FakeElement('div', 'gm4html5_div_id');
		const body = new FakeElement('body', 'body');
		const head = new FakeElement('head', 'head');
		const documentElement = new FakeElement('html', 'html');
		root.appendChild(canvas);
		body.appendChild(root);

		const ids = new Map([
			['canvas', canvas],
			['gm4html5_div_id', root],
			['body', body],
			['head', head]
		]);

		const document = {
			...makeEventTarget(),
			body,
			head,
			documentElement,
			domain: 'localhost',
			URL: 'https://localhost/game/index.html',
			hidden: false,
			createElement(tag) {
				const lower = String(tag || 'div').toLowerCase();
				return lower === 'canvas' ? new FakeCanvas() : new FakeElement(lower);
			},
			getElementById(id) {
				return ids.get(String(id)) || null;
			},
			getElementsByTagName(tag) {
				const lower = String(tag || '').toLowerCase();
				if (lower === 'head') return [head];
				if (lower === 'body') return [body];
				if (lower === 'canvas') return [canvas];
				return [];
			},
			querySelector() {
				return null;
			},
			querySelectorAll() {
				return [];
			},
			defaultView: W,
			_1s2: null,
			_2s2: head
		};
		document._1s2 = {
			getComputedStyle() {
				return { getPropertyValue: () => '16px' };
			}
		};

		W.document = document;
		W.canvas = canvas;
		W.HTMLCanvasElement = FakeCanvas;
		W.CanvasRenderingContext2D = FakeCanvasContext;
		W.Image = FakeImage;
		W.Audio = FakeAudio;
		W.HTMLMediaElement = FakeAudio;
		W.XMLHttpRequest = FakeXMLHttpRequest;
		W.XDomainRequest = FakeXMLHttpRequest;
		try {
			if (!W.localStorage) {
				Object.defineProperty(W, 'localStorage', {
					value: { getItem: () => null, setItem: noop, removeItem: noop },
					configurable: true
				});
			}
		} catch {}
		try {
			if (!W.screen) {
				Object.defineProperty(W, 'screen', {
					value: { width: 960, height: 600, availWidth: 960, availHeight: 600 },
					configurable: true
				});
			}
		} catch {}
		W.alert = noop;
		W.prompt = () => '';
		W.confirm = () => false;
		W.focus = noop;
		W.open = () => null;
		W.parent = {
			postMessage(message) {
				if (message && message.source === 'circloo-tas-game' && message.type === 'SIM_READY') {
					runtimeReady = true;
					W.postMessage({ source: 'circloo-tas-worker', type: 'BRUTEFORCE_READY' });
					if (pendingStart) {
						const next = pendingStart;
						pendingStart = null;
						startBruteforce(next);
					}
					if (pendingTrial) {
						const next = pendingTrial;
						pendingTrial = null;
						runTrialRequest(next);
					}
				}
				W.postMessage(message);
			}
		};
	}

	function inputFromHeld(held) {
		if (held.L && held.R) return 'LR';
		if (held.L) return 'L';
		if (held.R) return 'R';
		return '.';
	}

	function parseInput(value) {
		const text = String(value || '.').toUpperCase();
		if (text.includes('U')) return 'U';
		return inputFromHeld({
			L: text.includes('L') || text.includes('<'),
			R: text.includes('R') || text.includes('>')
		});
	}

	function normalizeFrame(frame, input) {
		const n = Math.round(Number(frame));
		if (!Number.isFinite(n)) return Number.NaN;
		return input === 'U' ? Math.min(0, n) : Math.max(0, n);
	}

	function normalizeScript(input) {
		const source = Array.isArray(input) ? input : [];
		const entries = [];
		for (const entry of source) {
			const normalized = parseInput(entry.input);
			const frame = normalizeFrame(entry.frame, normalized);
			if (Number.isFinite(frame) && ['.', 'L', 'R', 'LR', 'U'].includes(normalized)) entries.push({ frame, input: normalized });
		}
		entries.sort((a, b) => a.frame - b.frame || (a.input === 'U' ? -1 : 0) || (b.input === 'U' ? 1 : 0));
		const compact = [];
		for (const entry of entries) {
			const last = compact[compact.length - 1];
			if (last && last.frame === entry.frame && last.input !== 'U' && entry.input !== 'U') compact[compact.length - 1] = entry;
			else if (!last || last.input !== entry.input) compact.push(entry);
		}
		return compact;
	}

	function finiteFrame(value, fallback) {
		const n = Math.floor(Number(value));
		return Number.isFinite(n) ? n : fallback;
	}


	function mutationBounds(settings) {
		const min = Math.max(0, finiteFrame(settings && settings.minFrame, 0));
		const maxFrames = Math.max(0, finiteFrame(settings && settings.maxFrames, 0));
		const configuredMax = Math.max(0, finiteFrame(settings && settings.maxFrame, 0));
		const max = configuredMax > 0 ? configuredMax : maxFrames;
		return { min, max: Math.max(min, max) };
	}

	function mutableIndices(script, bounds) {
		return script
			.map((entry, index) => (entry.input !== 'U' && entry.frame >= bounds.min && entry.frame <= bounds.max ? index : -1))
			.filter((index) => index >= 0);
	}

	function clampMutationFrame(frame, bounds) {
		return Math.max(bounds.min, Math.min(bounds.max, Math.round(Number(frame)) || bounds.min));
	}

	function randomFrame(bounds, random) {
		return bounds.min + Math.floor(random() * (bounds.max - bounds.min + 1));
	}

	function addMutableInput(script, bounds, inputs, random) {
		script.push({ frame: randomFrame(bounds, random), input: inputs[Math.floor(random() * inputs.length)] });
	}

	function mutateScript(base, range, step, settings, random) {
		const script = normalizeScript(base);
		const inputs = ['.', 'L', 'R', 'LR'];
		const bounds = mutationBounds(settings);
		const indices = mutableIndices(script, bounds);
		const op = random();
		if (op < 0.62 && indices.length) {
			const i = indices[Math.floor(random() * indices.length)];
			const shift = (Math.floor(random() * (range * 2 + 1)) - range) * step;
			script[i] = { ...script[i], frame: clampMutationFrame(script[i].frame + shift, bounds) };
		} else if (op < 0.82) {
			addMutableInput(script, bounds, inputs, random);
		} else if (op < 0.92 && indices.length) {
			script.splice(indices[Math.floor(random() * indices.length)], 1);
		} else if (indices.length) {
			const i = indices[Math.floor(random() * indices.length)];
			script[i] = { ...script[i], input: inputs[Math.floor(random() * inputs.length)] };
		} else {
			addMutableInput(script, bounds, inputs, random);
		}
		return normalizeScript(script);
	}

	function scriptSeed(script) {
		let hash = 0x811c9dc5;
		for (const entry of script) {
			const text = `${entry.frame}:${entry.input};`;
			for (let index = 0; index < text.length; index++) {
				hash ^= text.charCodeAt(index);
				hash = Math.imul(hash, 0x01000193);
			}
		}
		return hash >>> 0 || 0x6d2b79f5;
	}

	function mixedWorkerSeed(seed, workerId) {
		let value = (seed ^ Math.imul((Math.max(0, finiteFrame(workerId, 0)) + 1) >>> 0, 0x9e3779b1)) >>> 0;
		value ^= value >>> 16;
		value = Math.imul(value, 0x7feb352d);
		value ^= value >>> 15;
		value = Math.imul(value, 0x846ca68b);
		value ^= value >>> 16;
		return value >>> 0 || 0x6d2b79f5;
	}

	function nextRandom() {
		let value = current.rngState >>> 0;
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		current.rngState = value >>> 0;
		return current.rngState / 0x100000000;
	}

	function postError(error) {
		W.postMessage({
			source: 'circloo-tas-worker',
			type: 'BRUTEFORCE_ERROR',
			error: String(error && error.stack ? error.stack : error)
		});
	}

	function trialOptions() {
		const pointMaxFrame = Math.max(
			0,
			finiteFrame(current.settings.pointMaxFrame, finiteFrame(current.settings.maxFrames, 1) - 1)
		);
		return {
			level: current.level,
			target: current.settings.target,
			targetCP: current.settings.targetCP,
			finishCP: current.settings.finishCP,
			pointX: current.settings.pointX,
			pointY: current.settings.pointY,
			pointZ: current.settings.pointZ,
			pointMinFrame: current.settings.pointMinFrame,
			pointMaxFrame,
			maxFrames:
				current.settings.target === 'point'
					? Math.max(finiteFrame(current.settings.maxFrames, 1), pointMaxFrame + 1)
					: current.settings.maxFrames,
			warmup: current.settings.warmup,
			seed: 0
		};
	}

	function runLocalTrial(script, options) {
		if (typeof W.__circlooTasRunTrial !== 'function') throw new Error('Worker game runtime is not ready');
		return W.__circlooTasRunTrial(script, options);
	}

	function trial(script) {
		return runLocalTrial(script, trialOptions());
	}

	function scriptInputAtFrame(script, frame) {
		let input = '.';
		for (const entry of script) {
			if (entry.input !== 'U' && entry.frame <= frame) input = entry.input;
		}
		return input;
	}

	function inputBits(input) {
		let bits = 0;
		if (String(input).includes('L')) bits |= 1;
		if (String(input).includes('R')) bits |= 2;
		return bits;
	}

	function scriptPrefixKey(script, throughFrame) {
		return normalizeScript(script)
			.filter((entry) => entry.frame <= throughFrame)
			.map((entry) => `${entry.frame}:${entry.input}`)
			.join('|');
	}

	function encodeScriptInputs(script, firstFrame, lastFrame) {
		if (lastFrame < firstFrame) return new Uint8Array(0);
		const normalized = normalizeScript(script);
		const inputs = new Uint8Array(lastFrame - firstFrame + 1);
		let active = '.';
		let entryIndex = 0;
		const firstSourceFrame = firstFrame - 1;
		while (entryIndex < normalized.length && normalized[entryIndex].frame <= firstSourceFrame) {
			if (normalized[entryIndex].input !== 'U') active = normalized[entryIndex].input;
			entryIndex += 1;
		}
		for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
			const sourceFrame = frame - 1;
			while (entryIndex < normalized.length && normalized[entryIndex].frame <= sourceFrame) {
				if (normalized[entryIndex].input !== 'U') active = normalized[entryIndex].input;
				entryIndex += 1;
			}
			inputs[frame - firstFrame] = inputBits(active);
		}
		return inputs;
	}

	function loadWasmRuntime() {
		if (!W.CirclooWasmRuntime) {
			try {
				importScripts(`/game/circloo-wasm-runtime.js?v=${encodeURIComponent(workerCacheBust)}`);
			} catch {
				return Promise.resolve(null);
			}
		}
		if (typeof W.CirclooWasmRuntime.create !== 'function') {
			return Promise.resolve(null);
		}
		if (!wasmRuntimePromise) {
			wasmRuntimePromise = W.CirclooWasmRuntime.create(
				`/game/circloo-sim.wasm?v=${encodeURIComponent(workerCacheBust)}`
			).catch(() => null);
		}
		return wasmRuntimePromise;
	}

	function targetCheckpoint(options) {
		return Math.max(
			1,
			finiteFrame(
				options && options.target === 'cp' ? options.targetCP : options && options.finishCP,
				1
			)
		);
	}

	function wasmTrialResult(result, snapshotFrame, target) {
		const checkpointFrames = Array.isArray(result && result.checkpointFrames)
			? result.checkpointFrames.map((frame) => (Number(frame) >= 0 ? Number(frame) : null))
			: [];
		const checkpoint = Math.max(0, finiteFrame(result && result.checkpoint, 0));
		const reached = !!(result && result.reached);
		const frame = finiteFrame(result && result.frame, snapshotFrame);
		const score = reached
			? target === 'cp'
				? Number(checkpointFrames[checkpoint])
				: frame
			: Infinity;
		return {
			reached,
			score,
			cp: checkpoint,
			times: checkpoint > 0 ? checkpointFrames.slice(0, checkpoint + 1) : [],
			debug: {
				trialMs: 0,
				prepareMs: 0,
				pumpMs: 0,
				frames: Math.max(0, frame - snapshotFrame),
				prepPumps: 0,
				rewindFrame: snapshotFrame,
				wasm: true,
				finalState: {
					frame,
					checkpoint,
					growthAlarm: finiteFrame(result && result.growthAlarm, -1),
					boundaryRadius: finiteFrame(result && result.boundaryRadiusPixels, 0),
					x: Number(result && result.x),
					y: Number(result && result.y),
					vx: Number(result && result.vx),
					vy: Number(result && result.vy),
					angle: Number(result && result.angle),
					angularVelocity: Number(result && result.angularVelocity)
				}
			}
		};
	}

	function finalStateSignature(result) {
		const finalState = result && result.debug && result.debug.finalState;
		if (!finalState) return null;
		return JSON.stringify({
			times: Array.isArray(result.times) ? result.times : [],
			frame: Number(finalState.frame),
			checkpoint: Number(finalState.checkpoint),
			growthAlarm: Number(finalState.growthAlarm),
			boundaryRadius: Number(finalState.boundaryRadius),
			x: Number(finalState.x),
			y: Number(finalState.y),
			vx: Number(finalState.vx),
			vy: Number(finalState.vy),
			angle: Number(finalState.angle),
			angularVelocity: Number(finalState.angularVelocity)
		});
	}

	function continuousStateNumberMatches(left, right) {
		const a = Number(left);
		const b = Number(right);
		if (Object.is(a, b)) return true;
		if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
		const tolerance = 2e-12 + 2e-14 * Math.max(Math.abs(a), Math.abs(b));
		return Math.abs(a - b) <= tolerance;
	}

	function finalStateMatches(leftResult, rightResult) {
		const left = leftResult && leftResult.debug && leftResult.debug.finalState;
		const right = rightResult && rightResult.debug && rightResult.debug.finalState;
		if (!left || !right) return left === right;
		for (const key of ['frame', 'checkpoint', 'growthAlarm', 'boundaryRadius']) {
			if (Number(left[key]) !== Number(right[key])) return false;
		}
		for (const key of ['x', 'y', 'vx', 'vy', 'angle', 'angularVelocity']) {
			if (!continuousStateNumberMatches(left[key], right[key])) return false;
		}
		return true;
	}

	async function createWasmSearchOptimizer(base, options, settings) {
		if (options && options.target === 'point') {
			return { optimizer: null, reason: 'point-target-full-runtime' };
		}
		if (typeof W.__circlooTasCaptureWasmRuntimeModel !== 'function') {
			return { optimizer: null, reason: 'wasm-unavailable' };
		}
		const runtime = await loadWasmRuntime();
		if (
			!runtime ||
			!W.CirclooWasmRuntime ||
			typeof W.CirclooWasmRuntime.modelFromInspection !== 'function'
		) return { optimizer: null, reason: 'wasm-load-failed' };

		const minimumMutationFrame = Math.max(0, finiteFrame(settings && settings.minFrame, 0));
		if (minimumMutationFrame < 1) {
			return { optimizer: null, reason: 'wasm-requires-prior-frame' };
		}
		const snapshotFrame = minimumMutationFrame - 1;
		const maximumGameFrame = Math.max(
			snapshotFrame,
			finiteFrame(options && options.maxFrames, 1) - 1
		);
		const checkpointTarget = targetCheckpoint(options);
		const startedAt = realNow();
		const capture = W.__circlooTasCaptureWasmRuntimeModel(
			normalizeScript(base),
			{ ...options, finishCP: checkpointTarget },
			snapshotFrame,
			maximumGameFrame
		);
		if (!capture || !capture.inspection || !Array.isArray(capture.inspection.bodies)) {
			return { optimizer: null, reason: 'wasm-capture-failed' };
		}

		const model = W.CirclooWasmRuntime.modelFromInspection(capture.inspection, {
			boundaryStates: capture.boundaryStates
		});
		if (Array.isArray(model.unsupportedReasons) && model.unsupportedReasons.length) {
			return {
				optimizer: null,
				reason: `wasm-unsupported:${model.unsupportedReasons.join(',')}`
			};
		}
		if (model.lifecycle.initialCheckpoint >= checkpointTarget) {
			return { optimizer: null, reason: 'target-before-mutation-window' };
		}
		const requiredGrowthPatches = Math.max(
			0,
			checkpointTarget - model.lifecycle.initialCheckpoint - 1
		);
		if ((model.growthPatches || []).length < requiredGrowthPatches) {
			return { optimizer: null, reason: 'wasm-incomplete-growth-model' };
		}

		try {
			runtime.loadModel(model);
		} catch (error) {
			return {
				optimizer: null,
				reason: `wasm-model-rejected:${String(error && error.message ? error.message : error)}`
			};
		}

		const prefixKey = scriptPrefixKey(base, snapshotFrame);
		let baseScript = normalizeScript(base);
		const buildMs = realNow() - startedAt;

		function prefixMatches(candidate) {
			return scriptPrefixKey(candidate, snapshotFrame) === prefixKey;
		}

		function evaluateWasmThrough(candidate, requestedLastGameFrame = maximumGameFrame) {
			const candidateScript = normalizeScript(candidate);
			if (!prefixMatches(candidateScript)) {
				return {
					reached: false,
					score: Infinity,
					cp: model.lifecycle.initialCheckpoint,
					times:
						model.lifecycle.initialCheckpoint > 0
							? (model.lifecycle.checkpointFrames || []).slice(
									0,
									model.lifecycle.initialCheckpoint + 1
								)
							: [],
					debug: {
						trialMs: 0,
						prepareMs: 0,
						pumpMs: 0,
						frames: 0,
						prepPumps: 0,
						rewindFrame: snapshotFrame,
						wasm: true,
						incompatiblePrefix: true
					}
				};
			}
			const lastGameFrame = Math.max(
				snapshotFrame,
				Math.min(maximumGameFrame, finiteFrame(requestedLastGameFrame, maximumGameFrame))
			);
			const inputs = encodeScriptInputs(
				candidateScript,
				snapshotFrame + 1,
				lastGameFrame
			);
			const trialStarted = realNow();
			const raw = runtime.simulate(inputs, checkpointTarget);
			const elapsed = realNow() - trialStarted;
			const converted = wasmTrialResult(raw, snapshotFrame, options.target);
			converted.debug.trialMs = elapsed;
			converted.debug.pumpMs = elapsed;
			return converted;
		}

		function evaluate(candidate) {
			return evaluateWasmThrough(candidate, maximumGameFrame);
		}

		return {
			optimizer: {
				mode: 'wasm-runtime',
				get rewindFrame() {
					return snapshotFrame;
				},
				get snapshotCount() {
					return 1;
				},
				get buildMs() {
					return buildMs;
				},
				stateBacked() {
					return false;
				},
				scoreOnlyValidation: true,
				evaluate,
				restoreVerifier() {
					return true;
				},
				rebuild(nextBase) {
					if (!prefixMatches(nextBase)) return false;
					baseScript = normalizeScript(nextBase);
					return !!baseScript;
				},
				prefixMatches,
				validationSignature: finalStateSignature,
				debugEvaluateThrough: evaluateWasmThrough
			},
			reason: ''
		};
	}

	function nextProbeInput(input) {
		if (input === 'L') return 'R';
		if (input === 'R') return 'L';
		if (input === 'LR') return '.';
		return 'R';
	}

	function validationCandidates(base, settings) {
		const bounds = mutationBounds(settings);
		const mutable = base
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => entry.input !== 'U' && entry.frame >= bounds.min && entry.frame <= bounds.max);
		const selected = [];
		if (mutable.length) {
			selected.push(mutable[0]);
			if (mutable.length > 1) selected.push(mutable[mutable.length - 1]);
		}
		const candidates = [];
		for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
			const { entry, index } = selected[selectedIndex];
			const candidate = base.map((item) => ({ ...item }));
			if (selectedIndex === 0 || entry.frame === 0) {
				candidate[index].input = nextProbeInput(entry.input);
			} else {
				const step = Math.max(1, finiteFrame(settings && settings.mutStep, 1));
				const forward = Math.min(bounds.max, entry.frame + step);
				const backward = Math.max(bounds.min, entry.frame - step);
				if (forward !== entry.frame) candidate[index].frame = forward;
				else if (backward !== entry.frame) candidate[index].frame = backward;
				else candidate[index].input = nextProbeInput(entry.input);
			}
			const normalized = normalizeScript(candidate);
			if (JSON.stringify(normalized) !== JSON.stringify(base)) candidates.push(normalized);
		}
		if (!candidates.length) {
			const frame = bounds.min;
			const candidate = normalizeScript([
				...base.map((entry) => ({ ...entry })),
				{ frame, input: nextProbeInput(scriptInputAtFrame(base, frame)) }
			]);
			if (JSON.stringify(candidate) !== JSON.stringify(base)) candidates.push(candidate);
		}
		return candidates.slice(0, 2);
	}

	function comparableTrialResult(result) {
		return {
			reached: !!(result && result.reached),
			score: Number(result && result.score),
			cp: Number(result && result.cp),
			times: Array.isArray(result && result.times) ? result.times.slice() : []
		};
	}

	function determinismDigestText() {
		if (typeof W.__circlooTasDeterminismDigest !== 'function') return null;
		return JSON.stringify(W.__circlooTasDeterminismDigest());
	}

	function validateSearchOptimizer(optimizer, base, options, settings) {
		if (!optimizer) return { optimizer: null, validated: false, reason: 'unavailable' };
		for (const candidate of validationCandidates(base, settings)) {
			const stateBacked = optimizer.stateBacked(candidate);
			const fastResult = optimizer.evaluate(candidate);
			const fast = comparableTrialResult(fastResult);
			const fastSignature =
				typeof optimizer.validationSignature === 'function'
					? optimizer.validationSignature(fastResult)
					: null;
			const fastDigest = stateBacked ? determinismDigestText() : null;
			if (!optimizer.restoreVerifier()) {
				return { optimizer: null, validated: false, reason: 'restore-failed' };
			}
			const exactResult = runLocalTrial(candidate, options);
			const exact = comparableTrialResult(exactResult);
			const resultMatches = JSON.stringify(fast) === JSON.stringify(exact);
			const stateMatches = !stateBacked || (fastDigest !== null && fastDigest === determinismDigestText());
			const signatureMatches =
				optimizer.scoreOnlyValidation ||
				fastSignature === null ||
				finalStateMatches(fastResult, exactResult);
			if (!resultMatches || !stateMatches || !signatureMatches) {
				const mismatchType = resultMatches
					? signatureMatches
						? 'state-mismatch'
						: 'wasm-final-state-mismatch'
					: 'score-mismatch';
				console.warn('[Circloo TAS] Optimizer validation failed', mismatchType, {
					candidate,
					fast,
					exact,
					fastFinalState: fastResult.debug && fastResult.debug.finalState,
					exactFinalState: exactResult.debug && exactResult.debug.finalState
				});
				return {
					optimizer: null,
					validated: false,
					reason: mismatchType
				};
			}
		}
		if (!optimizer.rebuild(base)) {
			return { optimizer: null, validated: false, reason: 'rebuild-failed' };
		}
		return { optimizer, validated: true, reason: '' };
	}
	function createSearchOptimizer(base, options, settings) {
		if (options && options.target === 'point') return null;
		const finishSeven =
			typeof W.__circlooTasCreateFinishSevenOptimizer === 'function'
				? W.__circlooTasCreateFinishSevenOptimizer(base, options)
				: null;
		const suffix =
			!finishSeven &&
			typeof W.__circlooTasCreateAdaptiveFinishOptimizer === 'function'
				? W.__circlooTasCreateAdaptiveFinishOptimizer(base, options)
				: null;
		const minimumMutationFrame = Math.max(0, finiteFrame(settings && settings.minFrame, 0));
		const dynamic =
			(!finishSeven || minimumMutationFrame < finishSeven.resumeFrame) &&
			(!suffix || minimumMutationFrame < suffix.resumeFrame) &&
			typeof W.__circlooTasCreateDynamicFinishOptimizer === 'function'
				? W.__circlooTasCreateDynamicFinishOptimizer(base, options)
				: null;
		if (!finishSeven && !suffix && !dynamic) return null;

		let lastRewindFrame = finishSeven
			? finishSeven.resumeFrame
			: suffix
				? suffix.resumeFrame
				: dynamic
					? dynamic.rewindFrame
					: null;
		return {
			get rewindFrame() {
				return lastRewindFrame;
			},
			get snapshotCount() {
				return (
					(finishSeven ? finishSeven.snapshotCount : 0) +
					(suffix ? suffix.snapshotCount : 0) +
					(dynamic ? dynamic.snapshotCount : 0)
				);
			},
			get buildMs() {
				return (
					(finishSeven ? finishSeven.buildMs : 0) +
					(suffix ? suffix.buildMs : 0) +
					(dynamic ? dynamic.buildMs : 0)
				);
			},
			stateBacked(candidate) {
				return (
					!!dynamic &&
					(!finishSeven || !finishSeven.prefixMatches(candidate)) &&
					(!suffix || !suffix.prefixMatches(candidate))
				);
			},
			evaluate(candidate) {
				let result;
				if (finishSeven && finishSeven.prefixMatches(candidate)) result = finishSeven.evaluate(candidate);
				else if (suffix && suffix.prefixMatches(candidate)) result = suffix.evaluate(candidate);
				else if (dynamic) result = dynamic.evaluate(candidate);
				else if (finishSeven) result = finishSeven.evaluate(candidate);
				else result = suffix.evaluate(candidate);
				if (result && result.debug && Number.isFinite(Number(result.debug.rewindFrame))) {
					lastRewindFrame = Number(result.debug.rewindFrame);
				}
				return result;
			},
			restoreVerifier() {
				return dynamic && typeof dynamic.restoreVerifier === 'function'
					? dynamic.restoreVerifier()
					: true;
			},
			rebuild(nextBase) {
				let rebuilt = true;
				if (finishSeven) rebuilt = finishSeven.rebuild(nextBase) && rebuilt;
				if (suffix) rebuilt = suffix.rebuild(nextBase) && rebuilt;
				if (dynamic) rebuilt = dynamic.rebuild(nextBase) && rebuilt;
				return rebuilt;
			}
		};
	}

	function runTrialRequest(message) {
		if (!runtimeReady) {
			pendingTrial = message;
			return;
		}
		try {
			const result = runLocalTrial(normalizeScript(message.script || []), message.options || {});
			W.postMessage({ source: 'circloo-tas-worker', type: 'TRIAL_RESULT', result });
		} catch (error) {
			postError(error);
		}
	}

	function inspectCompactRequest(message) {
		if (!runtimeReady) {
			pendingTrial = message;
			return;
		}
		try {
			const result = W.__circlooTasInspectCompactPhysics(
				normalizeScript(message.script || []),
				message.options || {},
				finiteFrame(message.frame, 0)
			);
			W.postMessage({ source: 'circloo-tas-worker', type: 'COMPACT_INSPECTION', result });
		} catch (error) {
			postError(error);
		}
	}

	function traceCompactRequest(message) {
		if (!runtimeReady) {
			pendingTrial = message;
			return;
		}
		try {
			const result = W.__circlooTasTraceCompactPhysics(
				normalizeScript(message.script || []),
				message.options || {},
				finiteFrame(message.startFrame, 0),
				finiteFrame(message.endFrame, 0)
			);
			W.postMessage({ source: 'circloo-tas-worker', type: 'COMPACT_TRACE', result });
		} catch (error) {
			postError(error);
		}
	}

	async function runWasmParityRequest(message) {
		if (!debugWasmParity) {
			postError(new Error('Wasm parity requests require debugWasm=1'));
			return;
		}
		if (!runtimeReady) {
			pendingTrial = message;
			return;
		}
		try {
			const base = normalizeScript(message.base || []);
			const options = message.options || {};
			const settings = message.settings || {};
			const candidates = Array.isArray(message.candidates) ? message.candidates : [];
			const built = await createWasmSearchOptimizer(base, options, settings);
			if (!built.optimizer) {
				W.postMessage({
					source: 'circloo-tas-worker',
					type: 'WASM_PARITY_RESULT',
					validated: false,
					reason: built.reason || 'unavailable',
					checked: 0,
					firstMismatch: null
				});
				return;
			}

			let firstMismatch = null;
			let checked = 0;
			let stateMismatchCount = 0;
			for (let index = 0; index < candidates.length; index += 1) {
				const candidate = normalizeScript(candidates[index]);
				const fastResult = message.scoreOnly && typeof built.optimizer.debugEvaluateThrough === 'function'
					? built.optimizer.debugEvaluateThrough(
						candidate,
						Math.max(built.optimizer.rewindFrame, finiteFrame(options.maxFrames, 1) - 1)
					)
					: built.optimizer.evaluate(candidate);
				const exactResult = runLocalTrial(candidate, options);
				const fast = comparableTrialResult(fastResult);
				const exact = comparableTrialResult(exactResult);
				checked += 1;
				const resultMatches = JSON.stringify(fast) === JSON.stringify(exact);
				const stateMatches = finalStateMatches(fastResult, exactResult);
				if (!stateMatches) stateMismatchCount += 1;
				if (!resultMatches || (!message.scoreOnly && !stateMatches)) {
					firstMismatch = {
						index,
						candidate,
						fast,
						exact,
						fastDebug: fastResult.debug,
						fastState: fastResult.debug && fastResult.debug.finalState,
						exactState: exactResult.debug && exactResult.debug.finalState
					};
					break;
				}
			}

			let firstDivergence = null;
			if (
				firstMismatch &&
				message.findFirstDivergence &&
				typeof built.optimizer.debugEvaluateThrough === 'function'
			) {
				const firstFrame = Math.max(
					built.optimizer.rewindFrame + 1,
					finiteFrame(message.divergenceStartFrame, built.optimizer.rewindFrame + 1)
				);
				const lastFrame = Math.max(
					firstFrame,
					finiteFrame(message.divergenceEndFrame, finiteFrame(options.maxFrames, 1) - 1)
				);
				for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
					const fastResult = built.optimizer.debugEvaluateThrough(firstMismatch.candidate, frame);
					const exactResult = runLocalTrial(firstMismatch.candidate, {
						...options,
						maxFrames: frame + 1
					});
					if (!finalStateMatches(fastResult, exactResult)) {
						firstDivergence = {
							frame,
							fastState: fastResult.debug && fastResult.debug.finalState,
							exactState: exactResult.debug && exactResult.debug.finalState
						};
						break;
					}
				}
			}

			W.postMessage({
				source: 'circloo-tas-worker',
				type: 'WASM_PARITY_RESULT',
				validated: !firstMismatch,
				reason: firstMismatch ? 'mismatch' : '',
				checked,
				stateMismatchCount,
				buildMs: built.optimizer.buildMs,
				firstMismatch,
				firstDivergence
			});
		} catch (error) {
			postError(error);
		}
	}

	function postProgress(lastResult, force = false) {
		const now = realNow();
		if (!force && now - current.lastProgressAt < PROGRESS_INTERVAL_MS) return;
		current.lastProgressAt = now;
		const elapsedSeconds = Math.max(0.001, (now - current.startedAt) / 1000);
		W.postMessage({
			source: 'circloo-tas-worker',
			type: 'BRUTEFORCE_PROGRESS',
			trials: current.trials,
			bestScore: current.bestScore,
			bestReached: current.bestReached,
			bestTimes: current.bestTimes,
			bestScript: current.best,
			lastScore: lastResult.score,
			lastReached: lastResult.reached,
			improvements: current.improvements,
			rate: current.trials / elapsedSeconds,
			mode: current.optimizer
				? current.optimizer.mode || 'deterministic-rewind'
				: 'full-runtime',
			rewindFrame: current.optimizer ? current.optimizer.rewindFrame : null,
			snapshotCount: current.optimizer ? current.optimizer.snapshotCount : 0,
			optimizerBuildMs: current.optimizer ? current.optimizer.buildMs : 0,
			verified: current.verified,
			workerId: current.workerId,
			optimizerValidated: current.optimizerValidated,
			optimizerFallbackReason: current.optimizerFallbackReason
			,wasmFallbackReason: current.wasmFallbackReason || ''
		});
	}

	function runOne() {
		if (!running || !current) return;
		const candidate = mutateScript(
			current.best,
			Math.max(0, current.settings.mutRange),
			Math.max(1, current.settings.mutStep),
			current.searchSettings,
			nextRandom
		);
		let result = current.optimizer ? current.optimizer.evaluate(candidate) : trial(candidate);
		current.trials += 1;

		if (result.reached && result.score < current.bestScore) {
			if (current.optimizer && !current.optimizer.restoreVerifier()) {
				throw new Error('Failed to restore exact verification runtime');
			}
			const verified = trial(candidate);
			current.verified += 1;
			if (verified.reached && verified.score < current.bestScore) {
				if (current.optimizer) {
					if (!current.optimizer.rebuild(candidate)) {
						throw new Error('Failed to rebuild deterministic rewind snapshots');
					}
					const optimizerCheck = validateSearchOptimizer(
						current.optimizer,
						candidate,
						trialOptions(),
						current.settings
					);
					current.optimizer = optimizerCheck.optimizer;
					current.optimizerValidated = optimizerCheck.validated;
					current.optimizerFallbackReason = optimizerCheck.reason;
				}
				current.best = candidate;
				current.bestScore = verified.score;
				current.bestReached = true;
				current.bestTimes = verified.times || [];
				current.improvements += 1;
				result = verified;
			}
		}

		if (current.maxTrials && current.trials >= current.maxTrials) {
			postProgress(result, true);
			running = false;
			W.postMessage({ source: 'circloo-tas-worker', type: 'BRUTEFORCE_STOPPED' });
			return;
		}
		postProgress(result);
	}

	function runBatch() {
		if (!running || !current) return;
		try {
			const deadline = realNow() + BATCH_BUDGET_MS;
			do {
				runOne();
			} while (running && current && realNow() < deadline);
			realSetTimeout(runBatch, 0);
		} catch (error) {
			running = false;
			postError(error);
		}
	}

	async function startBruteforce(message) {
		if (!runtimeReady) {
			pendingStart = message;
			return;
		}
		const generation = ++startGeneration;
		try {
			const base = normalizeScript(message.base || []);
			const requestedLevel = Number(message.level);
			const settings = message.settings || {};
			const level = Number.isFinite(requestedLevel) ? Math.max(0, requestedLevel) : 1;
			const pointMaxFrame = Math.max(
				0,
				finiteFrame(settings.pointMaxFrame, finiteFrame(settings.maxFrames, 1) - 1)
			);
			const options = {
				level,
				target: settings.target,
				targetCP: settings.targetCP,
				finishCP: settings.finishCP,
				pointX: settings.pointX,
				pointY: settings.pointY,
				pointZ: settings.pointZ,
				pointMinFrame: settings.pointMinFrame,
				pointMaxFrame,
				maxFrames:
					settings.target === 'point'
						? Math.max(finiteFrame(settings.maxFrames, 1), pointMaxFrame + 1)
						: settings.maxFrames,
				warmup: settings.warmup,
				seed: 0,
				minFrame: settings.minFrame,
				maxFrame: settings.maxFrame,
				snapshotStride: 32
			};
			const workerId = Math.max(0, finiteFrame(message.workerId, 0));
			const startedAt = realNow();
			const baseResult = runLocalTrial(base, options);
			let optimizerCheck;
			let wasmFallbackReason = '';
			if (message.forceFullRuntime) {
				optimizerCheck = { optimizer: null, validated: false, reason: 'pool-fallback' };
			} else {
				const wasmBuild = await createWasmSearchOptimizer(base, options, settings);
				if (generation !== startGeneration) return;
				optimizerCheck = wasmBuild.optimizer
					? validateSearchOptimizer(wasmBuild.optimizer, base, options, settings)
					: { optimizer: null, validated: false, reason: wasmBuild.reason };
				wasmFallbackReason = optimizerCheck.optimizer ? '' : optimizerCheck.reason;
				if (!optimizerCheck.optimizer) {
					const fallback = createSearchOptimizer(base, options, settings);
					const fallbackCheck = validateSearchOptimizer(fallback, base, options, settings);
					if (fallbackCheck.optimizer) optimizerCheck = fallbackCheck;
					else if (!optimizerCheck.reason || optimizerCheck.reason === 'unavailable') {
						optimizerCheck = fallbackCheck;
					}
				}
			}
			if (generation !== startGeneration) return;
			const optimizer = optimizerCheck.optimizer;
			const searchSettings = { ...settings };

			current = {
				settings,
				searchSettings,
				level,
				workerId,
				optimizer,
				optimizerValidated: optimizerCheck.validated,
				optimizerFallbackReason: optimizerCheck.reason,
				wasmFallbackReason,
				best: base,
				bestScore: Infinity,
				bestReached: false,
				bestTimes: [],
				trials: 0,
				improvements: 0,
				rngState: mixedWorkerSeed(scriptSeed(base), workerId),
				verified: 0,
				startedAt,
				lastProgressAt: 0,
				maxTrials: Math.max(0, finiteFrame(message.maxTrials, 0))
			};
			running = true;
			const result = baseResult;
			if (!running || !current) return;
			current.trials = 1;
			current.verified = 1;
			if (result.reached) {
				current.bestScore = result.score;
				current.bestReached = true;
				current.bestTimes = result.times || [];
			}
			postProgress(result, true);
			realSetTimeout(runBatch, 0);
		} catch (error) {
			if (generation !== startGeneration) return;
			running = false;
			postError(error);
		}
	}

	W.addEventListener('message', (event) => {
		const message = event.data || {};
		if (message.source !== 'circloo-tas-app') return;
		if (message.type === 'START_BRUTEFORCE') void startBruteforce(message);
		if (message.type === 'RUN_TRIAL') runTrialRequest(message);
		if (message.type === 'INSPECT_COMPACT') inspectCompactRequest(message);
		if (message.type === 'TRACE_COMPACT') traceCompactRequest(message);
		if (message.type === 'RUN_WASM_PARITY') void runWasmParityRequest(message);
		if (message.type === 'STOP_BRUTEFORCE') {
			startGeneration += 1;
			running = false;
			pendingStart = null;
			pendingTrial = null;
			W.postMessage({ source: 'circloo-tas-worker', type: 'BRUTEFORCE_STOPPED' });
		}
	});

	installEnvironment();
	importScripts(`/game/tas-bridge.js?v=${encodeURIComponent(workerCacheBust)}`);
	importScripts('/game/html5game_a5/tph_html5fixes3.js?v=1');
	importScripts('/game/html5game_a5/uph_quickTextRender.js?v=1');
	importScripts('/game/html5game_a5/vph_HTML5Link.js?v=1');
	W.drawCanvasTextFast = noop;
	importScripts('/game/html5game_a5/circloo.js?v=6');
	if (typeof W.GameMaker_Init === 'function') W.GameMaker_Init();
	if (typeof W.__circlooTasPatchGameHooks === 'function') W.__circlooTasPatchGameHooks();
})();
