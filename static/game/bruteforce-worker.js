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
	let wasmRuntimeError = null;
	const PROGRESS_INTERVAL_MS = 200;
	const BATCH_BUDGET_MS = 24;
	const POINT_SCORE_TOLERANCE = 1e-9;

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

	function randomMutationCount(maximum, random) {
		const max = Math.max(0, finiteFrame(maximum, 0));
		return max > 0 ? 1 + Math.floor(random() * max) : 0;
	}

	function differentMutationInput(current, inputs, random) {
		const alternatives = inputs.filter((input) => input !== current);
		return alternatives[Math.floor(random() * alternatives.length)] || current;
	}

	function takeRandomMutationIndices(indices, count, random) {
		const available = indices.slice();
		const selected = [];
		while (selected.length < count && available.length) {
			selected.push(available.splice(Math.floor(random() * available.length), 1)[0]);
		}
		return selected;
	}

	function mutateScript(base, settings, random) {
		const script = normalizeScript(base);
		const inputs = ['.', 'L', 'R', 'LR'];
		const bounds = mutationBounds(settings);
		const indices = mutableIndices(script, bounds);
		const limits = {
			add: Math.max(0, finiteFrame(settings && settings.addMaxInputs, 1)),
			remove: Math.max(0, finiteFrame(settings && settings.removeMaxInputs, 1)),
			alter: Math.max(0, finiteFrame(settings && settings.alterMaxInputs, 1))
		};
		const available = [];
		if (limits.add > 0) available.push({ type: 'add', weight: 0.2 });
		if (limits.remove > 0 && indices.length) available.push({ type: 'remove', weight: 0.1 });
		if (limits.alter > 0 && indices.length) available.push({ type: 'alter', weight: 0.7 });
		if (!available.length) return script;

		const totalWeight = available.reduce((total, item) => total + item.weight, 0);
		let choice = random() * totalWeight;
		const operation =
			available.find((item) => ((choice -= item.weight) <= 0))?.type || available[available.length - 1].type;

		if (operation === 'add') {
			for (let count = randomMutationCount(limits.add, random); count > 0; count--) {
				script.push({
					frame: randomFrame(bounds, random),
					input: inputs[Math.floor(random() * inputs.length)]
				});
			}
		} else if (operation === 'remove') {
			const selected = takeRandomMutationIndices(
				indices,
				randomMutationCount(Math.min(limits.remove, indices.length), random),
				random
			);
			for (const index of selected.sort((left, right) => right - left)) script.splice(index, 1);
		} else {
			const timeDifference = Math.max(0, finiteFrame(settings && settings.alterTimeDifference, 8));
			const selected = takeRandomMutationIndices(
				indices,
				randomMutationCount(Math.min(limits.alter, indices.length), random),
				random
			);
			for (const index of selected) {
				const current = script[index];
				const alterTime = timeDifference > 0 && random() < 0.72;
				const alterInput = !alterTime || random() < 0.35;
				let frame = current.frame;
				let input = current.input;
				if (alterTime) {
					const magnitude = 1 + Math.floor(random() * timeDifference);
					frame = clampMutationFrame(frame + (random() < 0.5 ? -magnitude : magnitude), bounds);
				}
				if (alterInput || frame === current.frame) {
					input = differentMutationInput(input, inputs, random);
				}
				script[index] = { frame, input };
			}
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
		const message = String(error && error.message ? error.message : error);
		const stack = String(error && error.stack ? error.stack : '');
		const detail = stack && !stack.includes(message)
			? `${message}\n${stack}`
			: stack || message;
		W.postMessage({
			source: 'circloo-tas-worker',
			type: 'BRUTEFORCE_ERROR',
			error: detail
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
			pointMinFrame: current.settings.pointMinFrame,
			pointMaxFrame,
			minCheckpoint: minimumCheckpoint(current.settings),
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

	function minimumCheckpoint(settings) {
		return Math.max(0, finiteFrame(settings && settings.minCheckpoint, 0));
	}

	function checkpointAtScore(result) {
		const scoreCheckpoint = Number(result && result.scoreCheckpoint);
		return Number.isFinite(scoreCheckpoint)
			? Math.max(0, Math.floor(scoreCheckpoint))
			: Math.max(0, finiteFrame(result && result.cp, 0));
	}

	function conditionsMet(result, settings) {
		return !!(result && result.reached) && checkpointAtScore(result) >= minimumCheckpoint(settings);
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
			} catch (error) {
				wasmRuntimeError = error;
				return Promise.resolve(null);
			}
		}
		if (typeof W.CirclooWasmRuntime.create !== 'function') {
			wasmRuntimeError = new Error('CirclooWasmRuntime.create is unavailable');
			return Promise.resolve(null);
		}
		if (!wasmRuntimePromise) {
			wasmRuntimePromise = W.CirclooWasmRuntime.create(
				`/game/circloo-sim.wasm?v=${encodeURIComponent(workerCacheBust)}`
			).catch((error) => {
				wasmRuntimeError = error;
				return null;
			});
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

	function wasmTrialResult(result, snapshotFrame, checkpointTarget) {
		const checkpointFrames = Array.isArray(result && result.checkpointFrames)
			? result.checkpointFrames.map((frame) => (Number(frame) >= 0 ? Number(frame) : null))
			: [];
		const checkpoint = Math.max(0, finiteFrame(result && result.checkpoint, 0));
		const targetFrame = Number(checkpointFrames[checkpointTarget]);
		const reached = checkpoint >= checkpointTarget && Number.isFinite(targetFrame);
		const frame = finiteFrame(result && result.frame, snapshotFrame);
		const reportedCheckpoint = reached ? checkpointTarget : checkpoint;
		return {
			reached,
			score: reached ? targetFrame : Infinity,
			cp: reportedCheckpoint,
			scoreCheckpoint: reached ? checkpointTarget : 0,
			times: reportedCheckpoint > 0 ? checkpointFrames.slice(0, reportedCheckpoint + 1) : [],
			debug: {
				trialMs: 0,
				prepareMs: 0,
				pumpMs: 0,
				frames: Math.max(0, frame - snapshotFrame),
				prepPumps: 0,
				rewindFrame: snapshotFrame,
				wasm: true,
				physicsBodies: Array.isArray(result && result.bodyStates)
					? result.bodyStates.map((body) => ({ ...body }))
					: [],
				physicsJoints: Array.isArray(result && result.jointStates)
					? result.jointStates.map((joint) => ({ ...joint }))
					: [],
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

	function continuousStateNumberMatches(left, right, exact = false) {
		const a = Number(left);
		const b = Number(right);
		if (Object.is(a, b)) return true;
		if (exact) return false;
		if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
		const tolerance = 2e-12 + 2e-14 * Math.max(Math.abs(a), Math.abs(b));
		return Math.abs(a - b) <= tolerance;
	}

	function exactPhysicsFramesDigest(frames) {
		const scratch = new DataView(new ArrayBuffer(8));
		let hashA = 0x811c9dc5;
		let hashB = 0x9e3779b9;
		const addByte = (value) => {
			const byte = Number(value) & 0xff;
			hashA = Math.imul((hashA ^ byte) >>> 0, 0x01000193) >>> 0;
			hashB = Math.imul((hashB ^ byte) >>> 0, 0x85ebca6b) >>> 0;
		};
		const addInt32 = (value) => {
			scratch.setInt32(0, Number(value) | 0, true);
			for (let index = 0; index < 4; index += 1) addByte(scratch.getUint8(index));
		};
		const addFloat64 = (value) => {
			scratch.setFloat64(0, Number(value), true);
			for (let index = 0; index < 8; index += 1) addByte(scratch.getUint8(index));
		};
		const addFinalState = (state) => {
			for (const key of ['frame', 'checkpoint', 'growthAlarm', 'boundaryRadius']) {
				addInt32(state && state[key]);
			}
			for (const key of ['x', 'y', 'vx', 'vy', 'angle', 'angularVelocity']) {
				addFloat64(state && state[key]);
			}
		};
		const bodyIntegerKeys = ['ordinal', 'instanceId', 'objectIndex', 'type', 'flags'];
		const bodyFloatKeys = [
			'x', 'y', 'vx', 'vy', 'angle', 'angularVelocity', 'sleepTime',
			'mass', 'inverseMass', 'inertia', 'inverseInertia', 'localCenterX', 'localCenterY'
		];
		const jointIntegerKeys = ['type', 'bodyAId', 'bodyBId', 'limitState'];
		const jointFloatKeys = ['impulseX', 'impulseY', 'impulseZ', 'motorImpulse'];
		const values = Array.isArray(frames) ? frames : [];
		addInt32(values.length);
		for (const frame of values) {
			addInt32(frame && frame.frame);
			addInt32(frame && frame.cp);
			addFinalState(frame && frame.finalState);
			const bodies = Array.isArray(frame && frame.physicsBodies) ? frame.physicsBodies : [];
			addInt32(bodies.length);
			for (const body of bodies) {
				for (const key of bodyIntegerKeys) addInt32(body && body[key]);
				for (const key of bodyFloatKeys) addFloat64(body && body[key]);
			}
			const joints = Array.isArray(frame && frame.physicsJoints) ? frame.physicsJoints : [];
			addInt32(joints.length);
			for (const joint of joints) {
				for (const key of jointIntegerKeys) addInt32(joint && joint[key]);
				for (const key of jointFloatKeys) addFloat64(joint && joint[key]);
			}
			const contacts = Array.isArray(frame && frame.physicsContactStates)
				? frame.physicsContactStates
				: [];
			addInt32(contacts.length);
			for (const contact of contacts) {
				for (const key of [
					'bodyAInstanceId', 'fixtureAIndex', 'childA',
					'bodyBInstanceId', 'fixtureBIndex', 'childB',
					'flags', 'toiCount'
				]) addInt32(contact && contact[key]);
				for (const key of ['friction', 'restitution', 'tangentSpeed', 'toi']) {
					addFloat64(contact && contact[key]);
				}
				const points = contact && contact.manifold && Array.isArray(contact.manifold.points)
					? contact.manifold.points
					: [];
				addInt32(points.length);
				for (const point of points) {
					addFloat64(point && point.localPoint && point.localPoint.x);
					addFloat64(point && point.localPoint && point.localPoint.y);
					addFloat64(point && point.normalImpulse);
					addFloat64(point && point.tangentImpulse);
					addInt32(point && point.id);
				}
			}
		}
		return `${hashA.toString(16).padStart(8, '0')}${hashB.toString(16).padStart(8, '0')}`;
	}

	function finalStateMatches(leftResult, rightResult, exact = false) {
		const left = leftResult && leftResult.debug && leftResult.debug.finalState;
		const right = rightResult && rightResult.debug && rightResult.debug.finalState;
		if (!left || !right) return left === right;
		for (const key of ['frame', 'checkpoint', 'growthAlarm', 'boundaryRadius']) {
			if (Number(left[key]) !== Number(right[key])) return false;
		}
		for (const key of ['x', 'y', 'vx', 'vy', 'angle', 'angularVelocity']) {
			if (!continuousStateNumberMatches(left[key], right[key], exact)) return false;
		}
		return true;
	}

	function firstPhysicsBodyMismatch(leftResult, rightResult, exact = false) {
		const left = leftResult && leftResult.debug && leftResult.debug.physicsBodies;
		const right = rightResult && rightResult.debug && rightResult.debug.physicsBodies;
		if (!Array.isArray(left) || !Array.isArray(right)) {
			return left === right ? null : { reason: 'missing-body-state', left, right };
		}
		if (left.length !== right.length) {
			return { reason: 'body-count', leftCount: left.length, rightCount: right.length, leftBodies: left, rightBodies: right };
		}
		for (let index = 0; index < left.length; index += 1) {
			const a = left[index] || {};
			const b = right[index] || {};
			for (const key of ['ordinal', 'instanceId', 'objectIndex', 'type', 'flags']) {
				if (Number(a[key]) !== Number(b[key])) {
					return { reason: key, index, left: a, right: b };
				}
			}
			for (const key of [
				'x',
				'y',
				'vx',
				'vy',
				'angle',
				'angularVelocity',
				'sleepTime',
				'mass',
				'inverseMass',
				'inertia',
				'inverseInertia',
				'localCenterX',
				'localCenterY'
			]) {
				if (!continuousStateNumberMatches(a[key], b[key], exact)) {
					return {
						reason: key,
						index,
						left: a,
						right: b,
						leftNegativeZero: Object.is(Number(a[key]), -0),
						rightNegativeZero: Object.is(Number(b[key]), -0)
					};
				}
			}
		}
		return null;
	}

	function firstPhysicsJointMismatch(leftResult, rightResult, exact = false) {
		const sortJoints = (value) => (Array.isArray(value) ? value.slice() : []).sort((left, right) => {
			for (const key of ['type', 'bodyAId', 'bodyBId', 'limitState', 'impulseX', 'impulseY', 'impulseZ', 'motorImpulse']) {
				const difference = Number(left && left[key]) - Number(right && right[key]);
				if (difference !== 0) return difference;
			}
			return 0;
		});
		const left = sortJoints(leftResult && leftResult.debug && leftResult.debug.physicsJoints);
		const right = sortJoints(rightResult && rightResult.debug && rightResult.debug.physicsJoints);
		if (left.length !== right.length) {
			return { reason: 'joint-count', leftCount: left.length, rightCount: right.length };
		}
		for (let index = 0; index < left.length; index += 1) {
			const a = left[index] || {};
			const b = right[index] || {};
			for (const key of ['type', 'bodyAId', 'bodyBId', 'limitState']) {
				if (Number(a[key]) !== Number(b[key])) {
					return { reason: key, index, left: a, right: b };
				}
			}
			for (const key of ['impulseX', 'impulseY', 'impulseZ', 'motorImpulse']) {
				if (!continuousStateNumberMatches(a[key], b[key], exact)) {
					return { reason: key, index, left: a, right: b };
				}
			}
		}
		return null;
	}

	function fullPhysicsStateMatches(leftResult, rightResult, exact = false) {
		return finalStateMatches(leftResult, rightResult, exact) &&
			!firstPhysicsBodyMismatch(leftResult, rightResult, exact) &&
			!firstPhysicsJointMismatch(leftResult, rightResult, exact);
	}

	async function createWasmSearchOptimizer(base, options, settings) {
		if (typeof W.__circlooTasCaptureWasmRuntimeModel !== 'function') {
			return { optimizer: null, reason: 'wasm-unavailable' };
		}
		const runtime = await loadWasmRuntime();
		if (
			!runtime ||
			!W.CirclooWasmRuntime ||
			typeof W.CirclooWasmRuntime.modelFromInspection !== 'function'
		) {
			const detail = wasmRuntimeError
				? String(wasmRuntimeError && wasmRuntimeError.message ? wasmRuntimeError.message : wasmRuntimeError)
				: '';
			return { optimizer: null, reason: detail ? `wasm-load-failed:${detail}` : 'wasm-load-failed' };
		}

		const pointTarget = options && options.target === 'point';
		const minimumMutationFrame = Math.max(0, finiteFrame(settings && settings.minFrame, 0));
		const prefixThroughFrame = minimumMutationFrame - 1;
		const requestedSnapshotFrame = Number(settings && settings.wasmSnapshotFrame);
		const snapshotFrame = Number.isFinite(requestedSnapshotFrame)
			? Math.max(0, finiteFrame(requestedSnapshotFrame, 0))
			: Math.max(0, prefixThroughFrame);
		const maximumGameFrame = Math.max(
			snapshotFrame,
			finiteFrame(options && options.maxFrames, 1) - 1
		);
		// Capture the complete reusable level model once. Some boundary growth and
		// body-spawn patches occur after a short requested scoring window, but are
		// still needed when a mutation reaches checkpoints on a different schedule.
		// Individual WASM trials continue to stop at maximumGameFrame.
		const modelCaptureEndFrame = Math.max(maximumGameFrame, 899);
		const checkpointTarget = pointTarget ? 32 : targetCheckpoint(options);
		const startedAt = realNow();
		const capture = W.__circlooTasCaptureWasmRuntimeModel(
			normalizeScript(base),
			{
				...options,
				finishCP: checkpointTarget,
				captureReferenceFrames: !!(settings && settings.verifyEveryFrame)
			},
			snapshotFrame,
			modelCaptureEndFrame
		);
		if (!capture || !capture.inspection || !Array.isArray(capture.inspection.bodies)) {
			return { optimizer: null, reason: 'wasm-capture-failed' };
		}

		const model = W.CirclooWasmRuntime.modelFromInspection(capture.inspection, {
			boundaryStates: capture.boundaryStates,
			bodySpawnEvents: capture.bodySpawnEvents,
			bodyDestroyEvents: capture.bodyDestroyEvents,
			bodyUpdateEvents: capture.bodyUpdateEvents,
			jointSpawnEvents: capture.jointSpawnEvents,
			jointDestroyEvents: capture.jointDestroyEvents
		});
		if (Array.isArray(model.unsupportedReasons) && model.unsupportedReasons.length) {
			return {
				optimizer: null,
				reason: `wasm-unsupported:${model.unsupportedReasons.join(',')}`
			};
		}
		const capturedCheckpoint = Array.isArray(capture.times)
			? capture.times.reduce(
					(highest, value, index) =>
						Number.isFinite(Number(value)) ? Math.max(highest, index) : highest,
					Math.max(0, finiteFrame(model.lifecycle.initialCheckpoint, 0))
				)
			: Math.max(0, finiteFrame(model.lifecycle.initialCheckpoint, 0));
		const requiredCheckpoint = pointTarget ? capturedCheckpoint : checkpointTarget;
		const requiredGrowthPatches = Math.max(
			0,
			requiredCheckpoint - model.lifecycle.initialCheckpoint - 1
		);
		const capturedGrowthPatches = (model.growthPatches || []).length;
		const growthModelComplete = capturedGrowthPatches >= requiredGrowthPatches;

		let modelDebug = null;
		try {
			modelDebug = {
				...runtime.loadModel(model),
				growthModelComplete,
				requiredGrowthPatches,
				capturedGrowthPatches,
				bodyUpdateEvents: capture.bodyUpdateEvents,
				frameBodyUpdates: (model.framePatches || []).map((patch) => ({
					frame: patch.frame,
					updates: patch.bodyUpdates || []
				}))
			};
		} catch (error) {
			return {
				optimizer: null,
				reason: `wasm-model-rejected:${String(error && error.message ? error.message : error)}`
			};
		}

		const prefixKey = scriptPrefixKey(base, prefixThroughFrame);
		let baseScript = normalizeScript(base);
		const pointMinFrame = Math.max(0, finiteFrame(options && options.pointMinFrame, 0));
		const pointMaxFrame = Math.max(
			pointMinFrame,
			finiteFrame(options && options.pointMaxFrame, maximumGameFrame)
		);
		const pointX = Number.isFinite(Number(options && options.pointX)) ? Number(options.pointX) : 0;
		const pointY = Number.isFinite(Number(options && options.pointY)) ? Number(options.pointY) : 0;
		const pointMinCheckpoint = Math.max(0, finiteFrame(options && options.minCheckpoint, 0));
		const worldScale = Number(model && model.world && model.world.scale);
		if (pointTarget && (!Number.isFinite(worldScale) || worldScale === 0)) {
			return { optimizer: null, reason: 'wasm-invalid-world-scale' };
		}
		const prefixPointLastFrame = Math.min(snapshotFrame, pointMaxFrame);
		const prefixPointResult =
			pointTarget && pointMinFrame <= prefixPointLastFrame
				? runLocalTrial(baseScript, {
						...options,
						pointMaxFrame: prefixPointLastFrame,
						maxFrames: prefixPointLastFrame + 1
					})
				: null;
		const buildMs = realNow() - startedAt;

		function prefixMatches(candidate) {
			return scriptPrefixKey(candidate, prefixThroughFrame) === prefixKey;
		}

		function incompatiblePrefixResult() {
			return {
				reached: false,
				score: Infinity,
				cp: model.lifecycle.initialCheckpoint,
				scoreCheckpoint: 0,
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

		function createPointTracker() {
			return {
				reached: !!(prefixPointResult && prefixPointResult.reached),
				score:
					prefixPointResult && prefixPointResult.reached
						? Number(prefixPointResult.score)
						: Infinity,
				bestFrame:
					prefixPointResult && Number.isFinite(Number(prefixPointResult.bestFrame))
						? Number(prefixPointResult.bestFrame)
						: null,
				bestPosition:
					prefixPointResult && prefixPointResult.bestPosition
						? {
								x: Number(prefixPointResult.bestPosition.x),
								y: Number(prefixPointResult.bestPosition.y)
							}
						: null,
				scoreCheckpoint:
					prefixPointResult && prefixPointResult.reached
						? checkpointAtScore(prefixPointResult)
						: 0
			};
		}

		function sampleWasmPoint(raw, tracker) {
			const frame = finiteFrame(raw && raw.frame, snapshotFrame);
			const checkpoint = Math.max(0, finiteFrame(raw && raw.checkpoint, 0));
			if (frame < pointMinFrame || frame > pointMaxFrame || checkpoint < pointMinCheckpoint) return;
			const x = Number(raw && raw.x) / worldScale;
			const y = Number(raw && raw.y) / worldScale;
			if (!Number.isFinite(x) || !Number.isFinite(y)) return;
			const distance = Math.hypot(x - pointX, y - pointY);
			if (!Number.isFinite(distance)) return;
			if (
				!tracker.reached ||
				distance < tracker.score ||
				(distance === tracker.score && (tracker.bestFrame === null || frame < tracker.bestFrame))
			) {
				tracker.reached = true;
				tracker.score = distance;
				tracker.bestFrame = frame;
				tracker.bestPosition = { x, y };
				tracker.scoreCheckpoint = checkpoint;
			}
		}

		function pointWasmTrialResult(raw, tracker) {
			const converted = wasmTrialResult(raw, snapshotFrame, 32);
			converted.reached = tracker.reached;
			converted.score = tracker.reached ? tracker.score : Infinity;
			converted.scoreCheckpoint = tracker.reached ? tracker.scoreCheckpoint : 0;
			converted.bestFrame = tracker.bestFrame;
			converted.bestPosition = tracker.bestPosition ? { ...tracker.bestPosition } : null;
			return converted;
		}

		function createSequenceInputState(candidateScript) {
			const unfreeze = normalizeScript(candidateScript).find((entry) => entry.input === 'U');
			const prestartSteps = unfreeze
				? Math.max(1, Math.abs(finiteFrame(unfreeze.frame, 0)))
				: 0;
			const timerStarted =
				!!(model && model.lifecycle && model.lifecycle.initialTimerStarted) || snapshotFrame > 0;
			if (timerStarted) {
				return { frozen: false, prestartRemaining: 0, initialPrestartSteps: prestartSteps };
			}
			if (!unfreeze) {
				return { frozen: true, prestartRemaining: 0, initialPrestartSteps: 0 };
			}
			return {
				frozen: false,
				prestartRemaining: prestartSteps,
				initialPrestartSteps: prestartSteps
			};
		}

		function nextSequenceInput(candidateScript, raw, inputState) {
			if (inputState && inputState.frozen) return 0;
			if (inputState && inputState.prestartRemaining > 0) {
				inputState.prestartRemaining -= 1;
				return 0;
			}
			const frame = finiteFrame(raw && raw.frame, snapshotFrame);
			return inputBits(scriptInputAtFrame(candidateScript, frame));
		}

		function sequenceStepLimit(lastGameFrame, inputState) {
			if (inputState && inputState.frozen) return 0;
			const configuredLimit = Math.max(1, finiteFrame(options && options.maxFrames, 1));
			const simulationLimit = pointTarget
				? Math.max(configuredLimit, pointMaxFrame + 1)
				: configuredLimit;
			const prestartSteps = Math.max(
				0,
				finiteFrame(inputState && inputState.initialPrestartSteps, 0)
			);
			const consumedSteps = snapshotFrame > 0 ? snapshotFrame + prestartSteps : 0;
			const remainingBudget = Math.max(0, simulationLimit - consumedSteps);
			const stepsToRequestedFrame =
				Math.max(0, finiteFrame(lastGameFrame, snapshotFrame) - snapshotFrame) +
				(snapshotFrame === 0 ? prestartSteps : 0);
			return Math.min(remainingBudget, stepsToRequestedFrame);
		}

		function evaluatePointThrough(candidateScript, lastGameFrame, includePhysics = false) {
			const tracker = createPointTracker();
			const inputState = createSequenceInputState(candidateScript);
			const trialStarted = realNow();
			let raw = null;
			try {
				raw = runtime.beginSequence(includePhysics);
				for (let index = 0; index < sequenceStepLimit(lastGameFrame, inputState); index += 1) {
					raw = runtime.stepSequence(
						nextSequenceInput(candidateScript, raw, inputState),
						32,
						includePhysics
					);
					sampleWasmPoint(raw, tracker);
				}
			} finally {
				runtime.endSequence();
			}
			const elapsed = realNow() - trialStarted;
			const converted = pointWasmTrialResult(raw, tracker);
			converted.debug.trialMs = elapsed;
			converted.debug.pumpMs = elapsed;
			return converted;
		}

		function evaluateWasmThrough(candidate, requestedLastGameFrame = maximumGameFrame) {
			const candidateScript = normalizeScript(candidate);
			if (!prefixMatches(candidateScript)) return incompatiblePrefixResult();
			const lastGameFrame = Math.max(
				snapshotFrame,
				Math.min(maximumGameFrame, finiteFrame(requestedLastGameFrame, maximumGameFrame))
			);
			if (pointTarget) return evaluatePointThrough(candidateScript, lastGameFrame, false);
			if (snapshotFrame === 0) {
				const inputState = createSequenceInputState(candidateScript);
				const trialStarted = realNow();
				let raw = null;
				try {
					raw = runtime.beginSequence(false);
					for (let index = 0; index < sequenceStepLimit(lastGameFrame, inputState); index += 1) {
						raw = runtime.stepSequence(
							nextSequenceInput(candidateScript, raw, inputState),
							checkpointTarget,
							false
						);
						if (Math.max(0, finiteFrame(raw && raw.checkpoint, 0)) >= checkpointTarget) break;
					}
				} finally {
					runtime.endSequence();
				}
				const elapsed = realNow() - trialStarted;
				const converted = wasmTrialResult(raw, snapshotFrame, checkpointTarget);
				converted.debug.trialMs = elapsed;
				converted.debug.pumpMs = elapsed;
				return converted;
			}
			const inputs = encodeScriptInputs(
				candidateScript,
				snapshotFrame + 1,
				lastGameFrame
			);
			const trialStarted = realNow();
			const raw = runtime.simulate(inputs, checkpointTarget);
			const elapsed = realNow() - trialStarted;
			const converted = wasmTrialResult(raw, snapshotFrame, checkpointTarget);
			converted.debug.trialMs = elapsed;
			converted.debug.pumpMs = elapsed;
			return converted;
		}

		function evaluate(candidate) {
			return evaluateWasmThrough(candidate, maximumGameFrame);
		}

		function beginFrameSequence(candidate) {
			const candidateScript = normalizeScript(candidate);
			if (!prefixMatches(candidateScript)) return null;
			const inputState = createSequenceInputState(candidateScript);
			const raw = runtime.beginSequence(true);
			const pointTracker = pointTarget ? createPointTracker() : null;
			return {
				candidateScript,
				inputState,
				raw,
				remainingSteps: sequenceStepLimit(maximumGameFrame, inputState),
				pointTracker,
				result: pointTarget
					? pointWasmTrialResult(raw, pointTracker)
					: wasmTrialResult(raw, snapshotFrame, checkpointTarget)
			};
		}

		function stepFrameSequence(sequence) {
			if (!sequence || sequence.remainingSteps <= 0) {
				return sequence && sequence.result;
			}
			const raw = runtime.stepSequence(
				nextSequenceInput(sequence.candidateScript, sequence.raw, sequence.inputState),
				checkpointTarget,
				true
			);
			sequence.raw = raw;
			sequence.remainingSteps -= 1;
			if (pointTarget) {
				sampleWasmPoint(raw, sequence.pointTracker);
				sequence.result = pointWasmTrialResult(raw, sequence.pointTracker);
			} else {
				sequence.result = wasmTrialResult(raw, snapshotFrame, checkpointTarget);
			}
			return sequence.result;
		}

		function endFrameSequence() {
			runtime.endSequence();
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
				modelDebug,
				snapshotStrategy: snapshotFrame === 0 ? 'full-level' : 'mutation-window',
				referenceFrames: Array.isArray(capture.referenceFrames)
					? capture.referenceFrames.filter(
							(frame) => finiteFrame(frame && frame.frame, -1) <= maximumGameFrame
						)
					: [],
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
				debugEvaluateThrough: evaluateWasmThrough,
				beginFrameSequence,
				stepFrameSequence,
				endFrameSequence
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
				const step = Math.max(1, finiteFrame(settings && settings.alterTimeDifference, 1));
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

	function trialResultsMatch(fastResult, exactResult, target) {
		const fast = comparableTrialResult(fastResult);
		const exact = comparableTrialResult(exactResult);
		if (
			fast.reached !== exact.reached ||
			fast.cp !== exact.cp ||
			JSON.stringify(fast.times) !== JSON.stringify(exact.times)
		) {
			return false;
		}
		if (target !== 'point') return fast.score === exact.score;
		if (!fast.reached) return !Number.isFinite(fast.score) && !Number.isFinite(exact.score);
		if (
			!Number.isFinite(fast.score) ||
			!Number.isFinite(exact.score) ||
			Math.abs(fast.score - exact.score) > POINT_SCORE_TOLERANCE
		) {
			return false;
		}
		const fastFrame = Number(fastResult && fastResult.bestFrame);
		const exactFrame = Number(exactResult && exactResult.bestFrame);
		const bestFrameMatches =
			(Number.isFinite(fastFrame) && Number.isFinite(exactFrame) && fastFrame === exactFrame) ||
			(!Number.isFinite(fastFrame) && !Number.isFinite(exactFrame));
		return bestFrameMatches && checkpointAtScore(fastResult) === checkpointAtScore(exactResult);
	}

	function determinismDigestText() {
		if (typeof W.__circlooTasDeterminismDigest !== 'function') return null;
		return JSON.stringify(W.__circlooTasDeterminismDigest());
	}

	function validateSearchOptimizer(optimizer, base, options, settings) {
		if (!optimizer) return { optimizer: null, validated: false, reason: 'unavailable' };
		const validationRuns = [
			{ candidate: normalizeScript(base), required: true },
			...validationCandidates(base, settings).map((candidate) => ({ candidate, required: false }))
		];
		for (const { candidate, required } of validationRuns) {
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
			const strictResultMatches = trialResultsMatch(
				fastResult,
				exactResult,
				options && options.target
			);
			const resultMatches = strictResultMatches || !required;
			if (!required && !strictResultMatches) {
				console.warn('[Circloo TAS] WASM heuristic probe differs from exact replay', {
					candidate,
					fast,
					exact
				});
			}
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
			const built = await createWasmSearchOptimizer(base, options, {
				...settings,
				verifyEveryFrame: !!message.verifyEveryFrame
			});
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
			let frameChecked = 0;
			let firstFrameMismatch = null;
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
				const resultMatches = trialResultsMatch(fastResult, exactResult, options && options.target);
				const bodyMismatch = firstPhysicsBodyMismatch(fastResult, exactResult, true);
				const jointMismatch = firstPhysicsJointMismatch(fastResult, exactResult, true);
				const stateMatches = finalStateMatches(fastResult, exactResult, true) &&
					(message.verifyEveryFrame || (!bodyMismatch && !jointMismatch));
				if (!stateMatches) stateMismatchCount += 1;
				if (!resultMatches || (!message.scoreOnly && !stateMatches)) {
					firstMismatch = {
						index,
						candidate,
						fast,
						exact,
						fastDebug: fastResult.debug,
						fastState: fastResult.debug && fastResult.debug.finalState,
						exactState: exactResult.debug && exactResult.debug.finalState,
						bodyMismatch,
						jointMismatch
					};
					break;
				}
			}

			const finalMismatch = firstMismatch;
			if (
				message.verifyEveryFrame &&
				typeof built.optimizer.beginFrameSequence === 'function' &&
				Array.isArray(built.optimizer.referenceFrames) &&
				candidates.length
			) {
				firstMismatch = null;
				const candidate = normalizeScript(candidates[0]);
				const sequence = built.optimizer.beginFrameSequence(candidate);
				try {
					let fastResult = sequence && sequence.result;
					let comparedReference = false;
					for (const referenceFrame of built.optimizer.referenceFrames) {
						const frame = finiteFrame(referenceFrame && referenceFrame.frame, -1);
						if (frame < built.optimizer.rewindFrame) continue;
						if (comparedReference) {
							fastResult = built.optimizer.stepFrameSequence(sequence);
						}
						comparedReference = true;
						const exactState = referenceFrame && referenceFrame.finalState;
						const exactResult = {
							debug: {
								finalState: exactState,
								physicsBodies: referenceFrame && referenceFrame.physicsBodies,
								physicsJoints: referenceFrame && referenceFrame.physicsJoints
							}
						};
						const bodyMismatch = firstPhysicsBodyMismatch(fastResult, exactResult, true);
						const jointMismatch = firstPhysicsJointMismatch(fastResult, exactResult, true);
						frameChecked += 1;
						if (!finalStateMatches(fastResult, exactResult, true) || bodyMismatch || jointMismatch) {
							firstFrameMismatch = {
								frame,
								fastState: fastResult && fastResult.debug && fastResult.debug.finalState,
								exactState,
								bodyMismatch,
								jointMismatch
							};
							firstMismatch = {
								index: 0,
								candidate,
								frame,
								bodyMismatch,
								jointMismatch
							};
							break;
						}
					}
				} finally {
					built.optimizer.endFrameSequence();
				}
			}
			if (!firstMismatch) firstMismatch = finalMismatch;

			let firstDivergence = null;
			if (
				firstMismatch &&
				!firstFrameMismatch &&
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
					const bodyMismatch = firstPhysicsBodyMismatch(fastResult, exactResult, true);
					const jointMismatch = firstPhysicsJointMismatch(fastResult, exactResult, true);
					if (!finalStateMatches(fastResult, exactResult, true) || bodyMismatch || jointMismatch) {
						firstDivergence = {
							frame,
							fastState: fastResult.debug && fastResult.debug.finalState,
							exactState: exactResult.debug && exactResult.debug.finalState,
							bodyMismatch,
							jointMismatch
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
				frameChecked,
				referenceFrameCount: Array.isArray(built.optimizer.referenceFrames)
					? built.optimizer.referenceFrames.length
					: 0,
				referenceFrameDigest: exactPhysicsFramesDigest(built.optimizer.referenceFrames),
				firstFrameMismatch,
				buildMs: built.optimizer.buildMs,
				modelDebug: built.optimizer.modelDebug,
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
			lastScore: conditionsMet(lastResult, current.settings) ? lastResult.score : Infinity,
			lastReached: conditionsMet(lastResult, current.settings),
			improvements: current.improvements,
			rate: current.trials / elapsedSeconds,
			mode: current.optimizer.mode || 'wasm-runtime',
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
		const candidate = mutateScript(current.best, current.searchSettings, nextRandom);
		let result = current.optimizer.evaluate(candidate);
		current.trials += 1;

		const pointTolerance = current.settings.target === 'point' ? POINT_SCORE_TOLERANCE : 0;
		if (
			conditionsMet(result, current.settings) &&
			result.score < current.bestScore + pointTolerance
		) {
			if (current.optimizer && !current.optimizer.restoreVerifier()) {
				throw new Error('Failed to restore exact verification runtime');
			}
			const verified = trial(candidate);
			current.verified += 1;
			if (conditionsMet(verified, current.settings) && verified.score < current.bestScore) {
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
					if (!optimizerCheck.optimizer) {
						throw new Error(`Custom WASM engine validation failed: ${optimizerCheck.reason || 'unknown'}`);
					}
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
				pointMinFrame: settings.pointMinFrame,
				pointMaxFrame,
				minCheckpoint: minimumCheckpoint(settings),
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
			let wasmBuild = await createWasmSearchOptimizer(base, options, settings);
			if (generation !== startGeneration) return;
			let optimizerCheck = wasmBuild.optimizer
				? validateSearchOptimizer(wasmBuild.optimizer, base, options, settings)
				: { optimizer: null, validated: false, reason: wasmBuild.reason };
			if (!optimizerCheck.optimizer && Math.max(0, finiteFrame(settings.minFrame, 0)) > 0) {
				wasmBuild = await createWasmSearchOptimizer(base, options, {
					...settings,
					wasmSnapshotFrame: 0
				});
				if (generation !== startGeneration) return;
				optimizerCheck = wasmBuild.optimizer
					? validateSearchOptimizer(wasmBuild.optimizer, base, options, settings)
					: { optimizer: null, validated: false, reason: wasmBuild.reason };
			}
			if (generation !== startGeneration) return;
			if (!optimizerCheck.optimizer) {
				throw new Error(`Custom WASM engine unavailable: ${optimizerCheck.reason || 'unknown'}`);
			}
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
				wasmFallbackReason: '',
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
			if (conditionsMet(result, settings)) {
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
	importScripts('/game/html5game_a5/circloo.js?v=7');
	if (typeof W.GameMaker_Init === 'function') W.GameMaker_Init();
	if (typeof W.__circlooTasPatchGameHooks === 'function') W.__circlooTasPatchGameHooks();
})();
