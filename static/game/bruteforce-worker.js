(() => {
	'use strict';

	const W = self;
	W.window = W;
	W.globalThis = W;
	const workerCacheBust = (() => {
		try {
			return new URLSearchParams(W.location.search).get('v') || String(Date.now());
		} catch {
			return String(Date.now());
		}
	})();
	const realSetTimeout = W.setTimeout.bind(W);
	const realPerformanceNow =
		W.performance && typeof W.performance.now === 'function' ? W.performance.now.bind(W.performance) : null;
	const realDateNow = W.Date && typeof W.Date.now === 'function' ? W.Date.now.bind(W.Date) : () => 0;

	function realNow() {
		return realPerformanceNow ? realPerformanceNow() : realDateNow();
	}

	let runtimeReady = false;
	let pendingStart = null;
	let running = false;
	let current = null;

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

	function randomFrame(bounds) {
		return bounds.min + Math.floor(Math.random() * (bounds.max - bounds.min + 1));
	}

	function addMutableInput(script, bounds, inputs) {
		script.push({ frame: randomFrame(bounds), input: inputs[Math.floor(Math.random() * inputs.length)] });
	}

	function mutateScript(base, range, step, settings) {
		const script = normalizeScript(base);
		const inputs = ['.', 'L', 'R', 'LR'];
		const bounds = mutationBounds(settings);
		const indices = mutableIndices(script, bounds);
		const op = Math.random();
		if (op < 0.62 && indices.length) {
			const i = indices[Math.floor(Math.random() * indices.length)];
			const shift = (Math.floor(Math.random() * (range * 2 + 1)) - range) * step;
			script[i] = { ...script[i], frame: clampMutationFrame(script[i].frame + shift, bounds) };
		} else if (op < 0.82) {
			addMutableInput(script, bounds, inputs);
		} else if (op < 0.92 && indices.length) {
			script.splice(indices[Math.floor(Math.random() * indices.length)], 1);
		} else if (indices.length) {
			const i = indices[Math.floor(Math.random() * indices.length)];
			script[i] = { ...script[i], input: inputs[Math.floor(Math.random() * inputs.length)] };
		} else {
			addMutableInput(script, bounds, inputs);
		}
		return normalizeScript(script);
	}

	function postError(error) {
		W.postMessage({
			source: 'circloo-tas-worker',
			type: 'BRUTEFORCE_ERROR',
			error: String(error && error.stack ? error.stack : error)
		});
	}

	function trial(script) {
		if (typeof W.__circlooTasRunTrial !== 'function') throw new Error('Worker game runtime is not ready');
		return W.__circlooTasRunTrial(script, {
			level: current.level,
			target: current.settings.target,
			targetCP: current.settings.targetCP,
			finishCP: current.settings.finishCP,
			maxFrames: current.settings.maxFrames,
			warmup: current.settings.warmup
		});
	}

	function emptyDebugStats() {
		return {
			workerMs: 0,
			mutateMs: 0,
			trialMs: 0,
			prepareMs: 0,
			pumpMs: 0,
			frames: 0,
			prepPumps: 0
		};
	}

	function recordDebug(sample) {
		if (!current.debugTotals) current.debugTotals = emptyDebugStats();
		current.debugCount = (current.debugCount || 0) + 1;
		for (const key of Object.keys(current.debugTotals)) current.debugTotals[key] += Number(sample[key]) || 0;
		current.debugLast = sample;
	}

	function debugPayload() {
		const count = Math.max(1, current.debugCount || 0);
		const avg = emptyDebugStats();
		for (const key of Object.keys(avg)) avg[key] = ((current.debugTotals && current.debugTotals[key]) || 0) / count;
		return {
			last: current.debugLast || emptyDebugStats(),
			avg
		};
	}

	function postProgress(lastResult) {
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
			debug: debugPayload()
		});
	}

	function runOne() {
		if (!running || !current) return;
		try {
			const workerStart = realNow();
			const mutateStart = realNow();
			const candidate = mutateScript(current.best, Math.max(0, current.settings.mutRange), Math.max(1, current.settings.mutStep), current.settings);
			const mutateMs = realNow() - mutateStart;
			const trialStart = realNow();
			const result = trial(candidate);
			const trialMs = realNow() - trialStart;
			recordDebug({
				workerMs: realNow() - workerStart,
				mutateMs,
				trialMs,
				prepareMs: result.debug && result.debug.prepareMs,
				pumpMs: result.debug && result.debug.pumpMs,
				frames: result.debug && result.debug.frames,
				prepPumps: result.debug && result.debug.prepPumps
			});
			current.trials += 1;
			if (result.reached && result.score < current.bestScore) {
				current.best = normalizeScript(candidate);
				current.bestScore = result.score;
				current.bestReached = result.reached;
				current.bestTimes = result.times || [];
				current.improvements += 1;
			}
			postProgress(result);
			realSetTimeout(runOne, 0);
		} catch (error) {
			running = false;
			postError(error);
		}
	}

	function startBruteforce(message) {
		if (!runtimeReady) {
			pendingStart = message;
			return;
		}
		try {
			const base = normalizeScript(message.base || []);
			const requestedLevel = Number(message.level);
			current = {
				settings: message.settings || {},
				level: Number.isFinite(requestedLevel) ? Math.max(0, requestedLevel) : 1,
				best: base,
				bestScore: Infinity,
				bestReached: false,
				bestTimes: [],
				trials: 0,
				improvements: 0,
				debugLast: emptyDebugStats(),
				debugTotals: emptyDebugStats(),
				debugCount: 0
			};
			running = true;
			const workerStart = realNow();
			const trialStart = realNow();
			const result = trial(base);
			const trialMs = realNow() - trialStart;
			recordDebug({
				workerMs: realNow() - workerStart,
				mutateMs: 0,
				trialMs,
				prepareMs: result.debug && result.debug.prepareMs,
				pumpMs: result.debug && result.debug.pumpMs,
				frames: result.debug && result.debug.frames,
				prepPumps: result.debug && result.debug.prepPumps
			});
			current.trials = 1;
			if (result.reached) {
				current.bestScore = result.score;
				current.bestReached = true;
				current.bestTimes = result.times || [];
			}
			postProgress(result);
			realSetTimeout(runOne, 0);
		} catch (error) {
			running = false;
			postError(error);
		}
	}

	W.addEventListener('message', (event) => {
		const message = event.data || {};
		if (message.source !== 'circloo-tas-app') return;
		if (message.type === 'START_BRUTEFORCE') startBruteforce(message);
		if (message.type === 'STOP_BRUTEFORCE') {
			running = false;
			pendingStart = null;
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
