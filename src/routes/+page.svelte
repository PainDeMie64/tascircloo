<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ClipboardCopy,
		FileDown,
		Info,
		Maximize2,
		RefreshCcw,
		Volume2,
		VolumeX,
		Zap
	} from '@lucide/svelte';
	import {
		appMessage,
		type BruteforceDebug,
		type BruteforceSettings,
		type BruteforceWorkerMessage,
		type GameMessage,
		type Telemetry
	} from '$lib/tas/protocol';
	import { gameTime, normalizeScript, serializeScript, type ScriptEntry } from '$lib/tas/script';

	const defaultText = '';
	const scriptKey = 'circloo-tas:script';
	const settingsKey = 'circloo-tas:bruteforce-settings';
	const defaultBruteforceSettings = {
		level: 1,
		target: 'cp',
		targetCP: 1,
		finishCP: 7,
		maxFrames: 3600,
		minFrame: 0,
		maxFrame: 0,
		mutRange: 8,
		mutStep: 1,
		warmup: 0,
		autoUseBest: false
	} satisfies BruteforceSettings;

	let iframeEl = $state<HTMLIFrameElement | null>(null);
	let gameShellEl = $state<HTMLDivElement | null>(null);
	let bruteforceWorker: Worker | null = null;
	let gameRevision = $state(0);
	let volume = $state(0.8);
	let scriptText = $state(defaultText);
	let errorText = $state('');
	let toastText = $state('');
	let toastTimer: number | undefined;
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
		sim: false
	});
	let settings = $state<BruteforceSettings>({ ...defaultBruteforceSettings });
	let bruteforce = $state({
		running: false,
		best: [] as ScriptEntry[],
		bestScore: Infinity,
		lastScore: Infinity,
		lastReached: false,
		trials: 0,
		improvements: 0,
		startedAt: 0,
		debug: null as BruteforceDebug | null,
		lastError: ''
	});

	const gameUrl = $derived(`/game/index.html?view=1&rev=${gameRevision}`);
	const parsedScript = $derived(normalizeScript(scriptText));
	const lineCount = $derived(scriptText.trim() ? parsedScript.length : 0);
	const inputLabel = $derived(`${lineCount} ${lineCount === 1 ? 'input' : 'inputs'}`);
	const targetCPNumber = $derived(Math.max(1, Math.floor(Number(settings.targetCP) || 1)));
	const finishCPNumber = $derived(Math.max(1, Math.floor(Number(settings.finishCP) || 1)));
	const scoredCPNumber = $derived(settings.target === 'cp' ? targetCPNumber : finishCPNumber);
	const selectedTargetTime = $derived(telemetry.cpTimes[scoredCPNumber] ?? null);
	const targetLabel = $derived(settings.target === 'cp' ? `Target CP ${targetCPNumber}` : `Finish CP ${finishCPNumber}`);
	const bruteforceTargetLabel = $derived(settings.target === 'cp' ? `scoring CP ${targetCPNumber}` : `scoring finish CP ${finishCPNumber}`);
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
	const bruteforceRate = $derived(
		bruteforce.startedAt ? bruteforce.trials / Math.max(0.001, (performance.now() - bruteforce.startedAt) / 1000) : 0
	);

	function debugMs(value: number | null | undefined) {
		const n = Number(value);
		if (!Number.isFinite(n)) return '--';
		return n >= 10 ? n.toFixed(1) : n.toFixed(2);
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
		for (const delay of [0, 150, 600]) {
			window.setTimeout(() => {
				postToGame('SET_VOLUME', { volume });
				syncReplayFromEditor();
			}, delay);
		}
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

	function syncReplayFromEditor(text = scriptText) {
		const script = normalizeScript(text);
		const hasActiveInput = text.trim() && script.some((entry) => entry.input !== '.');
		if (hasActiveInput) {
			postToGame('ARM_REPLAY', { script });
		} else {
			postToGame('STOP_REPLAY');
		}
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

	function saveSettings() {
		localStorage.setItem(settingsKey, JSON.stringify(settings));
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

	function loadSettings() {
		try {
			const raw = localStorage.getItem(settingsKey);
			if (!raw) return;
			settings = { ...settings, ...JSON.parse(raw) };
		} catch {
			localStorage.removeItem(settingsKey);
		}
	}

	function ensureBruteforceWorker() {
		if (bruteforceWorker) return bruteforceWorker;
		bruteforceWorker = new Worker(`/game/bruteforce-worker.js?sim=1&v=${Date.now()}`);
		bruteforceWorker.addEventListener('message', handleBruteforceMessage);
		bruteforceWorker.addEventListener('error', (event) => {
			bruteforce.running = false;
			bruteforce.lastError = event.message;
			setError(event.message);
		});
		return bruteforceWorker;
	}

	function handleBruteforceMessage(event: MessageEvent<BruteforceWorkerMessage | GameMessage>) {
		const message = event.data;
		if (!message || message.source !== 'circloo-tas-worker') return;

		switch (message.type) {
			case 'BRUTEFORCE_READY':
				if (bruteforce.running) setStatus('Bruteforcing');
				break;
			case 'BRUTEFORCE_PROGRESS': {
				const hadImprovement = message.improvements > bruteforce.improvements;
				bruteforce.trials = message.trials;
				bruteforce.best = message.bestScript;
				bruteforce.bestScore = message.bestScore;
				bruteforce.lastScore = message.lastScore;
				bruteforce.lastReached = message.lastReached;
				bruteforce.improvements = message.improvements;
				bruteforce.debug = message.debug ?? bruteforce.debug;
				bruteforce.lastError = message.error ?? '';
				if (hadImprovement) {
					setStatus(`Improved to ${gameTime(message.bestScore)}`);
					if (settings.autoUseBest) {
						setScriptText(serializeScript(message.bestScript));
					}
				}
				break;
			}
			case 'BRUTEFORCE_STOPPED':
				bruteforce.running = false;
				break;
			case 'BRUTEFORCE_ERROR':
				bruteforce.running = false;
				bruteforce.lastError = message.error;
				setError(message.error);
				break;
		}
	}

	function toggleBruteforce() {
		if (bruteforce.running) {
			stopBruteforce();
			return;
		}

		const base = normalizeScript(scriptText);
		if (!base.length) return setError('No script to bruteforce');

		saveSettings();
		setScriptText(serializeScript(base));
		bruteforce.running = true;
		bruteforce.best = base;
		bruteforce.bestScore = Infinity;
		bruteforce.lastScore = Infinity;
		bruteforce.lastReached = false;
		bruteforce.trials = 0;
		bruteforce.improvements = 0;
		bruteforce.startedAt = performance.now();
		bruteforce.debug = null;
		bruteforce.lastError = '';
		setStatus('Starting bruteforce worker');

		ensureBruteforceWorker().postMessage(
			appMessage('START_BRUTEFORCE', {
				base,
				level: bruteforceLevel(),
				settings: { ...settings }
			})
		);
	}

	function stopBruteforce() {
		bruteforce.running = false;
		bruteforceWorker?.postMessage(appMessage('STOP_BRUTEFORCE'));
	}

	function useBest() {
		if (!bruteforce.best.length) return setError('No bruteforce best script yet');
		setScriptText(serializeScript(bruteforce.best));
		setStatus('Loaded bruteforce best');
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
				syncReplayFromEditor();
				break;
			case 'TELEMETRY':
				telemetry = message;
				break;
				case 'CAPTURE_DUMP':
					void copyRecoveredInputs(message.text);
					break;
				case 'RUN_DUMP':
					downloadTextFile(message.filename, message.text);
					showToast(`Run log saved (${message.frames} frames)`);
					break;
				case 'ERROR':
					setError(message.message);
					break;
		}
	}

	onMount(() => {
		loadSettings();
		scriptText = localStorage.getItem(scriptKey) ?? defaultText;
		syncReplayFromEditor(scriptText);
		window.addEventListener('message', handleGameMessage);
		return () => {
			window.removeEventListener('message', handleGameMessage);
			window.clearTimeout(toastTimer);
			bruteforceWorker?.terminate();
			bruteforceWorker = null;
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
					<strong>{gameTime(selectedTargetTime)}</strong>
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

				<div class="settings-grid">
					<label>
						<span class="setting-label">
							Level
							<span class="info-dot" aria-label="Level number the worker starts for every bruteforce candidate." data-tip="Level number the worker starts for every bruteforce candidate. This is explicit and does not follow the currently visible game level.">
								<Info size={13} />
							</span>
						</span>
						<input type="number" min="0" bind:value={settings.level} onchange={saveSettings} />
					</label>
					<label>
						<span class="setting-label">
							Target
							<span class="info-dot" aria-label="Which result the bruteforce scores: reaching a checkpoint or finishing." data-tip="Which result the bruteforce scores: reaching a checkpoint or finishing.">
								<Info size={13} />
							</span>
						</span>
						<select bind:value={settings.target} onchange={saveSettings}>
							<option value="cp">Checkpoint</option>
							<option value="finish">Finish</option>
						</select>
					</label>
					<label>
						<span class="setting-label">
							CP N
							<span class="info-dot" aria-label="Checkpoint number to score when Target is Checkpoint." data-tip="Checkpoint number to score when Target is Checkpoint.">
								<Info size={13} />
							</span>
						</span>
						<input type="number" min="1" bind:value={settings.targetCP} onchange={saveSettings} disabled={settings.target !== 'cp'} />
					</label>
					<label>
						<span class="setting-label">
							Finish CPs
							<span class="info-dot" aria-label="Checkpoint count required for a candidate to count as finished." data-tip="Checkpoint count required for a candidate to count as finished.">
								<Info size={13} />
							</span>
						</span>
						<input type="number" min="1" bind:value={settings.finishCP} onchange={saveSettings} />
					</label>
					<label>
						<span class="setting-label">
							Max frames
							<span class="info-dot" aria-label="Maximum simulated frames before a candidate is abandoned." data-tip="Maximum simulated frames before a candidate is abandoned.">
								<Info size={13} />
							</span>
						</span>
						<input type="number" min="60" bind:value={settings.maxFrames} onchange={saveSettings} />
					</label>
					<label>
						<span class="setting-label">
							Min Frame
							<span class="info-dot" aria-label="Lowest frame the bruteforce may modify." data-tip="Lowest script frame the bruteforce may add, move, delete, or change. Earlier inputs stay fixed.">
								<Info size={13} />
							</span>
						</span>
						<input type="number" min="0" bind:value={settings.minFrame} onchange={saveSettings} />
					</label>
					<label>
						<span class="setting-label">
							Max Frame
							<span class="info-dot" aria-label="Highest frame the bruteforce may modify." data-tip="Highest script frame the bruteforce may add, move, delete, or change. Set 0 to use Max frames.">
								<Info size={13} />
							</span>
						</span>
						<input type="number" min="0" bind:value={settings.maxFrame} onchange={saveSettings} />
					</label>
					<label>
						<span class="setting-label">
							Mutation
							<span class="info-dot" aria-label="Largest frame offset used when mutating script input changes." data-tip="Largest frame offset used when mutating script input changes.">
								<Info size={13} />
							</span>
						</span>
						<input type="number" min="0" bind:value={settings.mutRange} onchange={saveSettings} />
					</label>
					<label>
						<span class="setting-label">
							Step
							<span class="info-dot" aria-label="Frame granularity for mutations. Higher values search coarser changes." data-tip="Frame granularity for mutations. Higher values search coarser changes.">
								<Info size={13} />
							</span>
						</span>
						<input type="number" min="1" bind:value={settings.mutStep} onchange={saveSettings} />
					</label>
					<label>
						<span class="setting-label">
							Warmup
							<span class="info-dot" aria-label="Legacy setting kept for old saved settings." data-tip="Legacy setting kept for old saved settings. Scripted U inputs now control pre-start physics timing.">
								<Info size={13} />
							</span>
						</span>
						<input type="number" min="0" max="120" bind:value={settings.warmup} onchange={saveSettings} />
					</label>
					<label class="checkline">
						<input type="checkbox" bind:checked={settings.autoUseBest} onchange={saveSettings} />
						<span class="setting-label">
							Auto-load best
							<span class="info-dot" aria-label="Automatically writes each new best script into the editor, which also applies it to replay." data-tip="Automatically writes each new best script into the editor, which also applies it to replay.">
								<Info size={13} />
							</span>
						</span>
					</label>
				</div>

				<div class="bruteforce-stats">
					<span>{bruteforce.trials} trials</span>
					<span>{bruteforceTargetLabel}</span>
					<span>{bruteforceRate.toFixed(1)}/s</span>
					<span>best {gameTime(bruteforce.bestScore)}</span>
					<span>{bruteforce.improvements} improvements</span>
				</div>
				{#if bruteforce.debug}
					<div class="bruteforce-debug" aria-label="Bruteforce performance debug">
						<span>last worker {debugMs(bruteforce.debug.last.workerMs)}ms</span>
						<span>avg worker {debugMs(bruteforce.debug.avg.workerMs)}ms</span>
						<span>trial {debugMs(bruteforce.debug.avg.trialMs)}ms</span>
						<span>prep {debugMs(bruteforce.debug.avg.prepareMs)}ms</span>
						<span>pump {debugMs(bruteforce.debug.avg.pumpMs)}ms</span>
						<span>mutate {debugMs(bruteforce.debug.avg.mutateMs)}ms</span>
						<span>frames {Math.round(bruteforce.debug.avg.frames)}</span>
						<span>prep pumps {Math.round(bruteforce.debug.avg.prepPumps)}</span>
					</div>
				{/if}
				<div class="button-row">
					<button onclick={useBest}>Use Best</button>
					<button onclick={resetBruteforceSettings}><RefreshCcw size={16} />Reset defaults</button>
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
	.bruteforce-stats,
	.bruteforce-debug {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.bruteforce-stats span,
	.bruteforce-debug span {
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

	.bruteforce-debug {
		margin-top: 8px;
		font-size: 0.78rem;
	}

	.bruteforce-debug span {
		min-height: 24px;
		color: #a9a395;
		background: #12140f;
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

	.info-dot {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		border: 1px solid #55594f;
		border-radius: 999px;
		color: #cec6b7;
		font-size: 0.68rem;
		line-height: 1;
		text-transform: none;
		cursor: help;
	}

	.info-dot::after {
		content: attr(data-tip);
		position: absolute;
		left: 50%;
		bottom: calc(100% + 8px);
		z-index: 5;
		width: max-content;
		max-width: 230px;
		padding: 8px 9px;
		border: 1px solid #55594f;
		border-radius: 6px;
		background: #11130f;
		color: #efeadd;
		font-size: 0.74rem;
		font-weight: 500;
		line-height: 1.35;
		text-transform: none;
		white-space: normal;
		box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
		opacity: 0;
		pointer-events: none;
		transform: translate(-50%, 4px);
		transition:
			opacity 120ms ease,
			transform 120ms ease;
	}

	.info-dot:hover::after,
	.info-dot:focus-visible::after {
		opacity: 1;
		transform: translate(-50%, 0);
	}

	.checkline {
		display: flex;
		align-items: center;
		gap: 8px;
		grid-column: span 2;
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
