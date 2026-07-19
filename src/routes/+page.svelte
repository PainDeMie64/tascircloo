<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ClipboardCopy,
		FileDown,
		Maximize2,
		RefreshCcw,
		Volume2,
		VolumeX,
		Zap
	} from '@lucide/svelte';
	import {
		appMessage,
		type BruteforceProgress,
		type BruteforceSettings,
		type BruteforceWorkerMessage,
		type GameMessage,
		type Telemetry
	} from '$lib/tas/protocol';
	import {
		gameTime,
		normalizeScript,
		serializeScript,
		validateNormalizedScript,
		type ScriptEntry
	} from '$lib/tas/script';

	const defaultText = '';
	const scriptKey = 'circloo-tas:script';
	const settingsKey = 'circloo-tas:bruteforce-settings';
	const defaultBruteforceSettings = {
		level: 1,
		target: 'finish',
		targetCP: 1,
		finishCP: 6,
		pointX: 1500,
		pointY: 1670,
		pointZ: 0,
		pointMinFrame: 0,
		pointMaxFrame: 520,
		maxFrames: 520,
		minFrame: 386,
		maxFrame: 520,
		mutRange: 8,
		mutStep: 1,
		warmup: 0,
		autoUseBest: false
	} satisfies BruteforceSettings;

	type BruteforceWorkerSlot = {
		id: number;
		worker: Worker;
		ready: boolean;
		stopped: boolean;
		progress: BruteforceProgress | null;
	};

	let iframeEl = $state<HTMLIFrameElement | null>(null);
	let gameShellEl = $state<HTMLDivElement | null>(null);
	let bruteforceWorkers: BruteforceWorkerSlot[] = [];
	let nextBruteforceWorkerId = 0;
	let bruteforceGeneration = 0;
	let poolForceFullRuntime = false;
	let retiredTrials = 0;
	let gameRevision = $state(0);
	let volume = $state(0.8);
	let scriptText = $state(defaultText);
	let errorText = $state('');
	let toastText = $state('');
	let toastTimer: number | undefined;
	let replayTimer: number | undefined;
	let replayRequestId = 0;
	let telemetry = $state<Telemetry>({
		ready: false,
		installed: false,
		level: null,
		frame: 0,
		cp: 0,
		cpTimes: [],
		input: '.',
		velocity: { vx: 0, vy: 0, speed: 0 },
		captured: 0,
		playbackMode: false,
		paused: false,
		sim: false,
		gameplayReady: false
	});
	let settings = $state<BruteforceSettings>({ ...defaultBruteforceSettings });
	let bruteforce = $state({
		running: false,
		best: [] as ScriptEntry[],
		bestScore: Infinity,
		trials: 0,
		rate: 0,
		workers: 0,
		workerLimit: 1,
		scaling: false,
		lastError: ''
	});
	let pointPicking = $state(false);

	const gameUrl = $derived(`/game/index.html?view=1&rev=${gameRevision}`);
	const parsedScript = $derived(normalizeScript(scriptText));
	const lineCount = $derived(scriptText.trim() ? parsedScript.length : 0);
	const inputLabel = $derived(`${lineCount} ${lineCount === 1 ? 'input' : 'inputs'}`);
	const targetCPNumber = $derived(Math.max(1, Math.floor(Number(settings.targetCP) || 1)));
	const finishCPNumber = $derived(Math.max(1, Math.floor(Number(settings.finishCP) || 1)));
	const pointXNumber = $derived(Number.isFinite(Number(settings.pointX)) ? Number(settings.pointX) : 0);
	const pointYNumber = $derived(Number.isFinite(Number(settings.pointY)) ? Number(settings.pointY) : 0);
	const pointZNumber = $derived(Number.isFinite(Number(settings.pointZ)) ? Number(settings.pointZ) : 0);
	const pointMinFrameNumber = $derived(Math.max(0, Math.floor(Number(settings.pointMinFrame) || 0)));
	const pointMaxFrameNumber = $derived(
		Math.max(pointMinFrameNumber, Math.floor(Number(settings.pointMaxFrame) || pointMinFrameNumber))
	);
	const pointPickAvailable = $derived(
		settings.target === 'point' &&
		telemetry.gameplayReady &&
		telemetry.level === bruteforceLevel()
	);
	const scoredCPNumber = $derived(settings.target === 'cp' ? targetCPNumber : finishCPNumber);
	const selectedTargetTime = $derived(telemetry.cpTimes[scoredCPNumber] ?? null);
	const selectedTargetDisplay = $derived(
		settings.target === 'point' ? 'See red point marker' : gameTime(selectedTargetTime)
	);
	const targetLabel = $derived(
		settings.target === 'cp'
			? `Target CP ${targetCPNumber}`
			: settings.target === 'finish'
				? `Finish CP ${finishCPNumber}`
				: 'Point distance'
	);
	const bruteforceTargetLabel = $derived(
		settings.target === 'cp'
			? `Checkpoint ${targetCPNumber}`
			: settings.target === 'finish'
				? `Finish at CP ${finishCPNumber}`
				: `Point (${formatCoordinate(pointXNumber)}, ${formatCoordinate(pointYNumber)}, ${formatCoordinate(pointZNumber)}) · frames ${pointMinFrameNumber}–${pointMaxFrameNumber}`
	);
	const checkpointRows = $derived(
		Array.from({ length: finishCPNumber }, (_, index) => {
			const cp = index + 1;
			return {
				cp,
				label: cp === finishCPNumber ? `CP ${cp} / Finish` : `CP ${cp}`,
				frame: telemetry.cpTimes[cp] ?? null
			};
		})
	);
	const volumePercent = $derived(Math.round(volume * 100));
	const bruteforceRate = $derived(bruteforce.rate);
	const bruteforceBestLabel = $derived(
		settings.target === 'point'
			? Number.isFinite(bruteforce.bestScore)
				? `${formatDistance(bruteforce.bestScore)} px`
				: '--'
			: gameTime(bruteforce.bestScore)
	);

	function formatCoordinate(value: number) {
		return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '');
	}

	function formatDistance(value: number) {
		if (!Number.isFinite(value)) return '--';
		if (value < 0.001) return value.toExponential(2);
		return value.toFixed(value < 10 ? 4 : 2);
	}

	function postToGame(type: string, payload: Record<string, unknown> = {}) {
		iframeEl?.contentWindow?.postMessage(appMessage(type, payload), window.location.origin);
	}

	function setGameVolume(nextVolume: number) {
		volume = Math.max(0, Math.min(1, Number(nextVolume)));
		postToGame('SET_VOLUME', { volume });
	}

	function handleVolumeInput(event: Event) {
		setGameVolume(Number((event.currentTarget as HTMLInputElement).value));
	}

	function handleGameLoad() {
		telemetry.ready = false;
	}

	async function fullscreenGame() {
		try {
			await gameShellEl?.requestFullscreen();
			setStatus('Game fullscreen requested');
		} catch (error) {
			setError(String(error instanceof Error ? error.message : error));
		}
	}

	function setStatus(message: string) {
		void message;
		errorText = '';
	}

	function setError(message: string) {
		errorText = message;
	}

	function showToast(message: string) {
		toastText = message;
		window.clearTimeout(toastTimer);
		toastTimer = window.setTimeout(() => {
			toastText = '';
		}, 2200);
	}

	function syncReplayFromEditor(text = scriptText, immediate = false) {
		window.clearTimeout(replayTimer);
		const script = normalizeScript(text);
		const hasActiveInput = text.trim() && script.some((entry) => entry.input !== '.');
		if (!hasActiveInput) {
			postToGame('STOP_REPLAY');
			return;
		}
		if (!telemetry.ready) return;

		const requestId = ++replayRequestId;
		const start = () => {
			postToGame('RUN_REPLAY', {
				requestId,
				level: telemetry.gameplayReady ? telemetry.level : null,
				followCurrentLevel: !telemetry.gameplayReady,
				seed: 0,
				script
			});
		};
		if (immediate) start();
		else replayTimer = window.setTimeout(start, 120);
	}

	function setScriptText(nextText: string) {
		scriptText = nextText;
		localStorage.setItem(scriptKey, scriptText);
		syncReplayFromEditor(scriptText);
	}

	function handleScriptInput(event: Event) {
		setScriptText((event.currentTarget as HTMLTextAreaElement).value);
	}

	function recoverInputs() {
		postToGame('DUMP_CAPTURE');
	}

	function dumpRunLog() {
		postToGame('DUMP_RUN');
	}

	async function copyRecoveredInputs(text: string) {
		try {
			await navigator.clipboard.writeText(text.trimEnd() + '\n');
			showToast('Inputs copied');
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	}

	function downloadTextFile(filename: string, text: string) {
		const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		anchor.rel = 'noopener';
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		window.setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	function reloadGame() {
		stopBruteforce();
		gameRevision += 1;
		telemetry.ready = false;
		setStatus('Reloading game runtime');
	}

	function saveSettings(options: { preserveResults?: boolean } | Event = {}) {
		const preserveResults = !(options instanceof Event) && options.preserveResults === true;
		if (settings.target !== 'point') pointPicking = false;
		if (!bruteforce.running && !preserveResults) {
			bruteforce.best = [];
			bruteforce.bestScore = Infinity;
			bruteforce.trials = 0;
			bruteforce.rate = 0;
			bruteforce.workers = 0;
			bruteforce.lastError = '';
		}
		localStorage.setItem(settingsKey, JSON.stringify(settings));
		syncPointTarget();
	}

	function resetBruteforceSettings() {
		settings = { ...defaultBruteforceSettings };
		saveSettings();
		showToast('Bruteforce defaults reset');
	}

	function bruteforceLevel() {
		const level = Math.floor(Number(settings.level));
		return Number.isFinite(level) ? Math.max(0, level) : 1;
	}

	function normalizedBruteforceSettings(
		value: Partial<BruteforceSettings>
	): BruteforceSettings {
		const source = { ...defaultBruteforceSettings, ...value };
		const finite = (candidate: unknown, fallback: number) => {
			return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
		};
		const integer = (candidate: unknown, fallback: number, minimum = 0) =>
			Math.max(minimum, Math.floor(finite(candidate, fallback)));
		const target =
			source.target === 'cp' || source.target === 'finish' || source.target === 'point'
				? source.target
				: defaultBruteforceSettings.target;
		const pointMinFrame = integer(source.pointMinFrame, defaultBruteforceSettings.pointMinFrame);
		return {
			level: integer(source.level, defaultBruteforceSettings.level),
			target,
			targetCP: integer(source.targetCP, defaultBruteforceSettings.targetCP, 1),
			finishCP: integer(source.finishCP, defaultBruteforceSettings.finishCP, 1),
			pointX: finite(source.pointX, defaultBruteforceSettings.pointX),
			pointY: finite(source.pointY, defaultBruteforceSettings.pointY),
			pointZ: finite(source.pointZ, defaultBruteforceSettings.pointZ),
			pointMinFrame,
			pointMaxFrame: Math.max(
				pointMinFrame,
				integer(source.pointMaxFrame, defaultBruteforceSettings.pointMaxFrame)
			),
			maxFrames: integer(source.maxFrames, defaultBruteforceSettings.maxFrames, 1),
			minFrame: integer(source.minFrame, defaultBruteforceSettings.minFrame),
			maxFrame: integer(source.maxFrame, defaultBruteforceSettings.maxFrame),
			mutRange: integer(source.mutRange, defaultBruteforceSettings.mutRange),
			mutStep: integer(source.mutStep, defaultBruteforceSettings.mutStep, 1),
			warmup: Math.min(120, integer(source.warmup, defaultBruteforceSettings.warmup)),
			autoUseBest: source.autoUseBest === true
		};
	}

	function loadSettings() {
		try {
			const raw = localStorage.getItem(settingsKey);
			if (!raw) return;
			const saved = JSON.parse(raw) as Partial<BruteforceSettings>;
			const isLegacyDefault =
				saved.level === 1 &&
				saved.target === 'cp' &&
				saved.targetCP === 1 &&
				saved.finishCP === 7 &&
				saved.maxFrames === 3600 &&
				saved.minFrame === 0 &&
				saved.maxFrame === 0 &&
				saved.mutRange === 8 &&
				saved.mutStep === 1 &&
				saved.warmup === 0 &&
				saved.autoUseBest === false;
			settings = isLegacyDefault
				? { ...defaultBruteforceSettings }
				: normalizedBruteforceSettings(saved);
		} catch {
			localStorage.removeItem(settingsKey);
		}
	}

	function workerCapacity() {
		const concurrency = Math.max(1, Math.floor(Number(navigator.hardwareConcurrency) || 1));
		return concurrency > 1 ? concurrency - 1 : 1;
	}

	function activeWorkerSlots() {
		return bruteforceWorkers.filter((slot) => !slot.stopped);
	}

	function activeTrialCount() {
		return activeWorkerSlots().reduce((total, slot) => total + (slot.progress?.trials ?? 0), 0);
	}

	function aggregateBruteforce(latest: BruteforceProgress) {
		const slots = activeWorkerSlots();
		const reports = slots.flatMap((slot) => (slot.progress ? [slot.progress] : []));
		const previousBest = bruteforce.bestScore;
		const bestReport = reports
			.map((report) => ({ report, script: validateNormalizedScript(report.bestScript) }))
			.filter(
				(candidate): candidate is { report: BruteforceProgress; script: ScriptEntry[] } =>
					candidate.report.bestReached &&
					Number.isFinite(candidate.report.bestScore) &&
					candidate.script !== null &&
					candidate.script.length > 0
			)
			.sort((left, right) => left.report.bestScore - right.report.bestScore)[0];
		const improvedGlobally = !!bestReport && bestReport.report.bestScore < previousBest;

		bruteforce.trials = retiredTrials + reports.reduce((total, report) => total + report.trials, 0);
		bruteforce.rate = reports.reduce((total, report) => total + report.rate, 0);
		bruteforce.workers = slots.length;
		bruteforce.lastError = latest.error ?? '';

		if (bestReport && (improvedGlobally || !Number.isFinite(bruteforce.bestScore))) {
			bruteforce.best = bestReport.script;
			bruteforce.bestScore = bestReport.report.bestScore;
			if (improvedGlobally && Number.isFinite(previousBest)) {
				setStatus(
					settings.target === 'point'
						? `Improved to ${formatDistance(bestReport.report.bestScore)} px`
						: `Improved to ${gameTime(bestReport.report.bestScore)}`
				);
				if (settings.autoUseBest) setScriptText(serializeScript(bestReport.script));
			}
		}
	}

	function retireWorker(slot: BruteforceWorkerSlot, countWork = true) {
		if (slot.stopped) return;
		slot.stopped = true;
		if (countWork && slot.progress) {
			retiredTrials += slot.progress.trials;
		}
		try {
			slot.worker.postMessage(appMessage('STOP_BRUTEFORCE'));
		} catch {}
		slot.worker.terminate();
		bruteforceWorkers = bruteforceWorkers.filter((candidate) => candidate !== slot);
		bruteforce.workers = activeWorkerSlots().length;
	}

	function createBruteforceWorker(base: ScriptEntry[], level: number, workerSettings: BruteforceSettings) {
		const id = nextBruteforceWorkerId++;
		const worker = new Worker(`/game/bruteforce-worker.js?sim=1&v=${Date.now()}-${id}`);
		const slot: BruteforceWorkerSlot = { id, worker, ready: false, stopped: false, progress: null };
		bruteforceWorkers = [...bruteforceWorkers, slot];
		bruteforce.workers = activeWorkerSlots().length;
		worker.addEventListener('message', (event: MessageEvent<BruteforceWorkerMessage>) => {
			handleBruteforceMessage(slot, event);
		});
		worker.addEventListener('error', (event) => {
			if (slot.stopped) return;
			retireWorker(slot);
			bruteforce.lastError = event.message;
			if (!activeWorkerSlots().length) {
				bruteforce.running = false;
				bruteforce.scaling = false;
				setError(event.message);
			}
		});
		worker.postMessage(
			appMessage('START_BRUTEFORCE', {
				base,
				level,
				workerId: id,
				forceFullRuntime: poolForceFullRuntime,
				settings: { ...workerSettings }
			})
		);
		return slot;
	}

	function handleBruteforceMessage(
		slot: BruteforceWorkerSlot,
		event: MessageEvent<BruteforceWorkerMessage>
	) {
		if (slot.stopped) return;
		const message = event.data;
		if (!message || message.source !== 'circloo-tas-worker') return;

		switch (message.type) {
			case 'BRUTEFORCE_READY':
				slot.ready = true;
				if (bruteforce.running) setStatus('Bruteforcing');
				break;
			case 'BRUTEFORCE_PROGRESS':
				slot.progress = message;
				if (message.optimizerFallbackReason && message.optimizerFallbackReason !== 'unavailable') {
					poolForceFullRuntime = true;
				}
				aggregateBruteforce(message);
				break;
			case 'BRUTEFORCE_STOPPED':
				retireWorker(slot);
				if (!activeWorkerSlots().length) {
					bruteforce.running = false;
					bruteforce.scaling = false;
				}
				break;
			case 'BRUTEFORCE_ERROR':
				retireWorker(slot);
				bruteforce.lastError = message.error;
				if (!activeWorkerSlots().length) {
					bruteforce.running = false;
					bruteforce.scaling = false;
					setError(message.error);
				}
				break;
		}
	}

	function waitForPool(milliseconds: number, generation: number) {
		return new Promise<boolean>((resolve) => {
			window.setTimeout(() => resolve(bruteforce.running && generation === bruteforceGeneration), milliseconds);
		});
	}

	async function waitForWorkerProgress(slot: BruteforceWorkerSlot, generation: number) {
		for (let attempt = 0; attempt < 600; attempt += 1) {
			if (!bruteforce.running || generation !== bruteforceGeneration || slot.stopped) return false;
			if (slot.progress && slot.progress.trials > 0) return true;
			if (!(await waitForPool(100, generation))) return false;
		}
		return false;
	}

	async function samplePoolRate(generation: number) {
		const startedAt = performance.now();
		const startedTrials = activeTrialCount();
		if (!(await waitForPool(4000, generation))) return 0;
		const elapsed = Math.max(0.001, (performance.now() - startedAt) / 1000);
		return Math.max(0, activeTrialCount() - startedTrials) / elapsed;
	}

	async function scaleBruteforcePool(
		generation: number,
		initialBase: ScriptEntry[],
		level: number,
		workerSettings: BruteforceSettings
	) {
		bruteforce.scaling = true;
		const first = activeWorkerSlots()[0];
		if (!first || !(await waitForWorkerProgress(first, generation))) {
			bruteforce.scaling = false;
			return;
		}
		let bestRate = await samplePoolRate(generation);
		let bestCount = 1;
		while (
			bruteforce.running &&
			generation === bruteforceGeneration &&
			activeWorkerSlots().length < bruteforce.workerLimit
		) {
			const candidate = createBruteforceWorker(initialBase, level, workerSettings);
			if (!(await waitForWorkerProgress(candidate, generation))) {
				retireWorker(candidate, false);
				break;
			}
			const candidateRate = await samplePoolRate(generation);
			if (candidateRate > bestRate * 1.01) {
				bestRate = candidateRate;
				bestCount = activeWorkerSlots().length;
			}
		}
		const slots = activeWorkerSlots();
		for (let index = slots.length - 1; index >= bestCount; index -= 1) retireWorker(slots[index]);
		if (generation === bruteforceGeneration) bruteforce.scaling = false;
	}

	function toggleBruteforce() {
		if (bruteforce.running) {
			stopBruteforce();
			return;
		}

		const base = normalizeScript(scriptText);
		if (!base.length) return setError('No script to bruteforce');

		settings = normalizedBruteforceSettings(settings);
		saveSettings();
		setScriptText(serializeScript(base));
		bruteforce.running = true;
		bruteforce.best = base;
		bruteforce.bestScore = Infinity;
		bruteforce.trials = 0;
		bruteforce.rate = 0;
		bruteforce.workers = 0;
		bruteforce.workerLimit = workerCapacity();
		bruteforce.scaling = true;
		bruteforce.lastError = '';
		retiredTrials = 0;
		poolForceFullRuntime = false;
		nextBruteforceWorkerId = 0;
		const generation = ++bruteforceGeneration;
		const level = bruteforceLevel();
		const workerSettings = { ...settings };
		setStatus('Starting adaptive bruteforce pool');
		createBruteforceWorker(base, level, workerSettings);
		void scaleBruteforcePool(generation, base, level, workerSettings);
	}

	function stopBruteforce() {
		bruteforceGeneration += 1;
		bruteforce.running = false;
		bruteforce.scaling = false;
		for (const slot of [...bruteforceWorkers]) retireWorker(slot);
		bruteforceWorkers = [];
		bruteforce.workers = 0;
	}

	function useBest() {
		const best = validateNormalizedScript(bruteforce.best);
		if (!best?.length) return setError('No valid bruteforce best script yet');
		setScriptText(serializeScript(best));
		setStatus('Loaded bruteforce best');
	}

	function syncPointTarget() {
		if (!pointPickAvailable && pointPicking) pointPicking = false;
		postToGame('SET_POINT_TARGET', {
			enabled: pointPickAvailable,
			x: pointXNumber,
			y: pointYNumber,
			z: pointZNumber,
			picking: pointPickAvailable && pointPicking
		});
	}

	function togglePointPicking() {
		if (!pointPickAvailable) {
			setError(`Open Level ${bruteforceLevel()} in the game before picking a point`);
			return;
		}
		pointPicking = !pointPicking;
		postToGame(pointPicking ? 'START_POINT_PICK' : 'CANCEL_POINT_PICK', {
			x: pointXNumber,
			y: pointYNumber,
			z: pointZNumber
		});
	}

	function handlePointCoordinateInput() {
		saveSettings();
	}

	function handlePointWindowChange() {
		settings.pointMinFrame = pointMinFrameNumber;
		settings.pointMaxFrame = pointMaxFrameNumber;
		saveSettings();
	}

	function handleGameMessage(event: MessageEvent<GameMessage>) {
		if (event.origin !== window.location.origin) return;
		const message = event.data;
		if (!message || message.source !== 'circloo-tas-game') return;
		if (event.source !== iframeEl?.contentWindow) return;

		switch (message.type) {
			case 'GAME_READY':
				telemetry = message;
				postToGame('SET_VOLUME', { volume });
				syncPointTarget();
				syncReplayFromEditor(scriptText, true);
				break;
			case 'RUN_READY':
				if (message.requestId === replayRequestId) {
					const contextChanged =
						telemetry.level !== message.level ||
						telemetry.gameplayReady !== message.gameplayReady;
					telemetry = message;
					if (contextChanged) syncPointTarget();
					setStatus('Deterministic run ready');
				}
				break;
			case 'TELEMETRY': {
				const contextChanged =
					telemetry.level !== message.level ||
					telemetry.gameplayReady !== message.gameplayReady;
				telemetry = message;
				if (contextChanged) syncPointTarget();
				break;
			}
			case 'POINT_TARGET_PICKED':
				if (!pointPicking || settings.target !== 'point') break;
				if (![message.x, message.y, message.z].every(Number.isFinite)) break;
				settings.pointX = message.x;
				settings.pointY = message.y;
				settings.pointZ = message.z;
				pointPicking = false;
				saveSettings();
				showToast('Point target selected');
				break;
			case 'CAPTURE_DUMP':
				void copyRecoveredInputs(message.text);
				break;
			case 'RUN_DUMP':
				downloadTextFile(message.filename, message.text);
				showToast(`Run log saved (${message.frames} frames)`);
				break;
			case 'ERROR':
				if (message.requestId == null || message.requestId === replayRequestId) {
					setError(message.message);
				}
				break;
		}
	}

	onMount(() => {
		loadSettings();
		scriptText = localStorage.getItem(scriptKey) ?? defaultText;
		window.addEventListener('message', handleGameMessage);
		return () => {
			window.removeEventListener('message', handleGameMessage);
			window.clearTimeout(toastTimer);
			window.clearTimeout(replayTimer);
			bruteforceGeneration += 1;
			for (const slot of bruteforceWorkers) slot.worker.terminate();
			bruteforceWorkers = [];
		};
	});
</script>

<svelte:head>
	<title>CircloO TAS</title>
	<meta name="description" content="A browser TAS tool for CircloO with embedded game, replay, and bruteforce controls." />
</svelte:head>

<main class="workspace">
	<header class="topbar">
		<div>
			<h1>CircloO TAS</h1>
		</div>
	</header>

	<section class="main-grid">
		<aside class="panel cp-panel" aria-label="Checkpoint times">
			<div class="panel-head">
				<h2>CP Times</h2>
			</div>
			<div class="cp-list">
				{#each checkpointRows as row}
					<div class:reached={row.frame != null}>
						<span>{row.label}</span>
						<strong>{gameTime(row.frame)}</strong>
					</div>
				{/each}
			</div>
		</aside>

		<div class="game-column">
			<div class="game-shell" bind:this={gameShellEl}>
				<iframe bind:this={iframeEl} title="CircloO game" src={gameUrl} onload={handleGameLoad}></iframe>
				<div class="game-toolbar" aria-label="Game display controls">
					<div class="volume-control" title={`Volume ${volumePercent}%`}>
						{#if volume <= 0}
							<VolumeX size={16} />
						{:else}
							<Volume2 size={16} />
						{/if}
						<input
							type="range"
							min="0"
							max="1"
							step="0.01"
							value={volume}
							aria-label="Game volume"
							oninput={handleVolumeInput}
						/>
					</div>
					<button class="icon-button" title="Fullscreen game" onclick={fullscreenGame}><Maximize2 size={16} /></button>
				</div>
			</div>
			<div class="telemetry-band">
				<div>
					<span>Level</span>
					<strong>{telemetry.level ?? '--'}</strong>
				</div>
				<div>
					<span>Frame</span>
					<strong>{telemetry.frame}</strong>
				</div>
				<div>
					<span>Time</span>
					<strong>{gameTime(telemetry.frame)}</strong>
				</div>
				<div>
					<span>CP</span>
					<strong>{telemetry.cp}</strong>
				</div>
				<div>
					<span>{targetLabel}</span>
					<strong>{selectedTargetDisplay}</strong>
				</div>
				<div>
					<span>Input</span>
					<strong>{telemetry.input}</strong>
				</div>
				<div>
					<span>Velocity</span>
					<strong>{telemetry.velocity.speed.toFixed(1)}</strong>
				</div>
			</div>
		</div>

		<aside class="tools">
			<button class="restart-button" onclick={reloadGame}><RefreshCcw size={16} />Restart game</button>

			<section class="panel editor-panel">
				<div class="panel-head">
					<h2>Script</h2>
					<span>{inputLabel}</span>
				</div>
					<textarea value={scriptText} spellcheck="false" aria-label="TAS script" oninput={handleScriptInput}></textarea>
					<div class="button-row">
						<button onclick={recoverInputs}><ClipboardCopy size={16} />Recover inputs</button>
						<button onclick={dumpRunLog}><FileDown size={16} />Dump run log</button>
					</div>
				</section>

			<section class="panel bruteforce-panel">
				<div class="panel-head">
					<h2>Bruteforce</h2>
					<button class:primary={!bruteforce.running} class:danger={bruteforce.running} onclick={toggleBruteforce}>
						<Zap size={16} />{bruteforce.running ? 'Bruteforcing' : 'Bruteforce'}
					</button>
				</div>

				<fieldset class="bruteforce-settings" disabled={bruteforce.running}>
					<section class="settings-section" aria-labelledby="general-info-heading">
						<h3 id="general-info-heading">General info</h3>
						<div class="settings-grid">
							<label>
								<span class="setting-label">Level</span>
								<input type="number" min="0" bind:value={settings.level} onchange={saveSettings} />
							</label>
							{#if settings.target !== 'point'}
								<label>
									<span class="setting-label">Max frames</span>
									<input type="number" min="1" bind:value={settings.maxFrames} onchange={saveSettings} />
								</label>
							{/if}
							<label>
								<span class="setting-label">Warmup</span>
								<input type="number" min="0" max="120" bind:value={settings.warmup} onchange={saveSettings} />
							</label>
							<label class="checkline">
								<input
									type="checkbox"
									bind:checked={settings.autoUseBest}
									onchange={() => saveSettings({ preserveResults: true })}
								/>
								<span class="setting-label">Auto-load best</span>
							</label>
						</div>
					</section>

					<section class="settings-section" aria-labelledby="target-heading">
						<h3 id="target-heading">Target</h3>
						<div class="settings-grid">
							<label>
								<span class="setting-label">Type</span>
								<select bind:value={settings.target} onchange={saveSettings}>
									<option value="finish">Finish</option>
									<option value="cp">Checkpoint</option>
									<option value="point">Point</option>
								</select>
							</label>
							{#if settings.target === 'cp'}
								<label>
									<span class="setting-label">Checkpoint</span>
									<input type="number" min="1" bind:value={settings.targetCP} onchange={saveSettings} />
								</label>
							{:else if settings.target === 'finish'}
								<label>
									<span class="setting-label">Finish CPs</span>
									<input type="number" min="1" bind:value={settings.finishCP} onchange={saveSettings} />
								</label>
							{:else}
								<label>
									<span class="setting-label">X</span>
									<input type="number" step="any" bind:value={settings.pointX} oninput={handlePointCoordinateInput} />
								</label>
								<label>
									<span class="setting-label">Y</span>
									<input type="number" step="any" bind:value={settings.pointY} oninput={handlePointCoordinateInput} />
								</label>
								<label>
									<span class="setting-label">Z</span>
									<input type="number" step="any" bind:value={settings.pointZ} oninput={handlePointCoordinateInput} />
								</label>
								<label>
									<span class="setting-label">Min frame</span>
									<input type="number" min="0" bind:value={settings.pointMinFrame} onchange={handlePointWindowChange} />
								</label>
								<label>
									<span class="setting-label">Max frame</span>
									<input type="number" min={pointMinFrameNumber} bind:value={settings.pointMaxFrame} onchange={handlePointWindowChange} />
								</label>
								<div class="point-picker-control">
									<span class="setting-label">Pick in level</span>
									<button class:primary={pointPicking} disabled={!pointPickAvailable} onclick={togglePointPicking}>
										{pointPicking
											? 'Cancel picking'
											: pointPickAvailable
												? 'Pick point'
												: `Open Level ${bruteforceLevel()} to pick`}
									</button>
								</div>
							{/if}
						</div>
					</section>

					<section class="settings-section" aria-labelledby="input-modification-heading">
						<h3 id="input-modification-heading">Input modification</h3>
						<div class="settings-grid">
							<label>
								<span class="setting-label">Modify from</span>
								<input type="number" min="0" bind:value={settings.minFrame} onchange={saveSettings} />
							</label>
							<label>
								<span class="setting-label">Modify through</span>
								<input type="number" min="0" bind:value={settings.maxFrame} onchange={saveSettings} />
							</label>
							<label>
								<span class="setting-label">Mutation</span>
								<input type="number" min="0" bind:value={settings.mutRange} onchange={saveSettings} />
							</label>
							<label>
								<span class="setting-label">Step</span>
								<input type="number" min="1" bind:value={settings.mutStep} onchange={saveSettings} />
							</label>
						</div>
					</section>
				</fieldset>

				<div class="bruteforce-stats">
					<span>{bruteforceRate.toFixed(1)} iterations/s</span>
					<span>{bruteforce.trials} total trials</span>
					<span>best {bruteforceBestLabel}</span>
					<span>{bruteforce.workers} {bruteforce.workers === 1 ? 'worker' : 'workers'}</span>
					<span>{bruteforceTargetLabel}</span>
				</div>
				<div class="button-row">
					<button onclick={useBest}>Use Best</button>
					<button disabled={bruteforce.running} onclick={resetBruteforceSettings}><RefreshCcw size={16} />Reset defaults</button>
				</div>
				{#if bruteforce.lastError}
					<p class="error">{bruteforce.lastError}</p>
				{/if}
			</section>
		</aside>
	</section>

	{#if errorText}
		<div class="error-bar">{errorText}</div>
	{/if}
	{#if toastText}
		<div class="toast" role="status">{toastText}</div>
	{/if}
</main>

<style>
	:global(*) {
		box-sizing: border-box;
	}

	:global(html),
	:global(body) {
		margin: 0;
		min-height: 100%;
		background: #10110f;
		color: #ece8de;
		font-family:
			Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	}

	:global(button),
	:global(input),
	:global(select),
	:global(textarea) {
		font: inherit;
	}

	.workspace {
		min-height: 100vh;
		padding: 14px;
		background:
			linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px),
			linear-gradient(0deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px),
			#10110f;
		background-size: 28px 28px;
	}

	.topbar {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 16px;
		margin: 0 auto 12px;
		max-width: 1600px;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		font-size: 1.45rem;
		line-height: 1.1;
	}

	h2 {
		font-size: 0.86rem;
		text-transform: uppercase;
		color: #d7d0c0;
	}

	.telemetry-band,
	.bruteforce-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.bruteforce-stats span {
		min-height: 28px;
		display: inline-flex;
		align-items: center;
		border: 1px solid #383a34;
		background: #181a16;
		color: #d5d0c4;
		padding: 0 10px;
		border-radius: 6px;
		font-variant-numeric: tabular-nums;
	}

	.main-grid {
		max-width: 1600px;
		margin: 0 auto;
		display: grid;
		grid-template-columns: minmax(150px, 180px) minmax(720px, 1fr) minmax(360px, 410px);
		gap: 12px;
		align-items: start;
	}

	.cp-panel {
		position: sticky;
		top: 14px;
	}

	.cp-list {
		display: grid;
		gap: 6px;
	}

	.cp-list div {
		min-height: 34px;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: center;
		gap: 2px;
		border: 1px solid #343730;
		background: #12140f;
		border-radius: 6px;
		padding: 7px 8px;
	}

	.cp-list div.reached {
		border-color: #536f58;
		background: #172119;
	}

	.cp-list span {
		color: #9d9789;
		font-size: 0.72rem;
		text-transform: uppercase;
	}

	.cp-list strong {
		color: #efeadd;
		font-size: 0.98rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.game-column {
		min-width: 0;
	}

	.game-shell {
		position: relative;
		background: #050505;
		border: 1px solid #3a3c37;
		min-height: 520px;
		aspect-ratio: 16 / 10;
		overflow: hidden;
	}

	iframe {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
		outline: none;
	}

	iframe:focus,
	iframe:focus-visible {
		outline: none;
	}

	.game-toolbar {
		position: absolute;
		top: 10px;
		right: 10px;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px;
		border: 1px solid rgba(255, 255, 255, 0.16);
		border-radius: 8px;
		background: rgba(10, 11, 9, 0.78);
		backdrop-filter: blur(8px);
	}

	.game-shell:fullscreen {
		width: 100vw;
		height: 100vh;
		aspect-ratio: auto;
		border: 0;
	}

	.volume-control {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #efeadd;
	}

	.volume-control input {
		width: 112px;
		padding: 0;
		accent-color: #7fc89d;
	}

	.telemetry-band {
		margin-top: 8px;
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
	}

	.telemetry-band div {
		border: 1px solid #383a34;
		background: #181a16;
		padding: 9px 10px;
		border-radius: 6px;
		min-width: 0;
	}

	.telemetry-band span {
		display: block;
		color: #9d9789;
		font-size: 0.74rem;
		text-transform: uppercase;
	}

	.telemetry-band strong {
		display: block;
		margin-top: 3px;
		font-size: 1rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tools {
		display: grid;
		gap: 10px;
	}

	.panel {
		border: 1px solid #383a34;
		background: rgba(24, 26, 22, 0.96);
		border-radius: 8px;
		padding: 10px;
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 8px;
	}

	.panel-head span {
		color: #9d9789;
		font-size: 0.78rem;
	}

	button {
		min-height: 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 1px solid #4a4d45;
		border-radius: 6px;
		background: #22251f;
		color: #efeadd;
		cursor: pointer;
		padding: 0 10px;
		white-space: nowrap;
	}

	button:hover:not(:disabled) {
		background: #2b2f27;
	}

	button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	button.primary {
		background: #2e5e45;
		border-color: #5da77c;
	}

	button.danger {
		background: #5a2526;
		border-color: #a65354;
	}

	.icon-button {
		width: 32px;
		padding: 0;
	}

	.restart-button {
		width: 100%;
		min-height: 38px;
	}

	.button-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}

	textarea,
	input,
	select {
		width: 100%;
		border: 1px solid #44473f;
		background: #11130f;
		color: #eee8dc;
		border-radius: 6px;
		padding: 8px;
	}

	textarea {
		height: 230px;
		resize: vertical;
		font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
		font-size: 0.9rem;
		line-height: 1.45;
		tab-size: 4;
	}

	.settings-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
	}

	.bruteforce-settings {
		display: grid;
		gap: 10px;
		min-width: 0;
		margin: 0;
		border: 0;
		padding: 0;
	}

	.settings-section {
		border: 1px solid #34372f;
		border-radius: 8px;
		background: #141611;
		padding: 10px;
	}

	.settings-section h3 {
		margin: 0 0 8px;
		font-size: 0.76rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #e4ddcf;
	}

	.point-picker-control {
		display: flex;
		flex-direction: column;
		justify-content: end;
	}

	.point-picker-control button {
		width: 100%;
	}

	label span {
		display: block;
		margin-bottom: 4px;
		color: #9d9789;
		font-size: 0.72rem;
		text-transform: uppercase;
	}

	.setting-label {
		display: flex;
		align-items: center;
		gap: 5px;
	}

	.checkline {
		display: flex;
		align-items: center;
		gap: 8px;
		grid-column: 1 / -1;
		min-height: 34px;
	}

	.checkline input {
		width: 16px;
		height: 16px;
	}

	.checkline span {
		margin: 0;
	}

	.bruteforce-stats {
		margin-top: 8px;
	}

	.error,
	.error-bar {
		color: #ffb1b1;
	}

	.error {
		margin-top: 8px;
		font-size: 0.82rem;
	}

	.error-bar {
		max-width: 1600px;
		margin: 10px auto 0;
		border: 1px solid #a65354;
		background: #3a1718;
		border-radius: 6px;
		padding: 8px 10px;
	}

	.toast {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 10;
		border: 1px solid #5da77c;
		background: #193524;
		color: #e7ffef;
		border-radius: 8px;
		padding: 10px 12px;
		box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
	}

	@media (max-width: 1050px) {
		.topbar {
			align-items: start;
			flex-direction: column;
		}

		.main-grid {
			grid-template-columns: 1fr;
		}

		.cp-panel {
			position: static;
		}

		.cp-list {
			grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		}

		.telemetry-band {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 560px) {
		.workspace {
			padding: 8px;
		}

		.main-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.game-shell {
			min-height: 220px;
		}

		.settings-grid {
			grid-template-columns: 1fr;
		}

		.telemetry-band {
			grid-template-columns: 1fr;
		}
	}
</style>
