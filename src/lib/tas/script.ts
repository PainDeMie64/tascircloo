export type TasInput = '.' | 'L' | 'R' | 'LR' | 'U';

export type ScriptEntry = {
	frame: number;
	input: TasInput;
};

const validInputs = new Set<TasInput>(['.', 'L', 'R', 'LR', 'U']);

export function validateNormalizedScript(value: unknown): ScriptEntry[] | null {
	if (!Array.isArray(value)) return null;

	const entries: ScriptEntry[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') return null;
		const frame = (item as { frame?: unknown }).frame;
		const input = (item as { input?: unknown }).input;
		if (!Number.isInteger(frame) || typeof input !== 'string' || !validInputs.has(input as TasInput)) {
			return null;
		}
		if ((input === 'U' && Number(frame) > 0) || (input !== 'U' && Number(frame) < 0)) return null;
		entries.push({ frame: Number(frame), input: input as TasInput });
	}

	const normalized = normalizeScript(entries);
	if (
		normalized.length !== entries.length ||
		normalized.some(
			(entry, index) => entry.frame !== entries[index].frame || entry.input !== entries[index].input
		)
	) {
		return null;
	}

	return normalized;
}

export function inputFromHeld(held: { L: boolean; R: boolean }): TasInput {
	if (held.L && held.R) return 'LR';
	if (held.L) return 'L';
	if (held.R) return 'R';
	return '.';
}

export function parseInput(value: unknown): TasInput {
	const text = String(value || '.').toUpperCase();
	if (text.includes('U')) return 'U';
	return inputFromHeld({
		L: text.includes('L') || text.includes('<'),
		R: text.includes('R') || text.includes('>')
	});
}

function normalizeFrame(frame: unknown, input: TasInput): number {
	const n = Math.round(Number(frame));
	if (!Number.isFinite(n)) return Number.NaN;
	return input === 'U' ? Math.min(0, n) : Math.max(0, n);
}

export function parseScriptText(text: string): ScriptEntry[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !line.startsWith('#') && !line.startsWith('//'))
		.map((line) => {
			const [frame, input = '.'] = line.split(/[\s,]+/);
			return {
				frame: Number(frame),
				input: parseInput(input)
			};
		});
}

export function normalizeScript(input: string | ScriptEntry[]): ScriptEntry[] {
	const source = typeof input === 'string' ? parseScriptText(input) : input;
	const entries: ScriptEntry[] = [];

	for (const entry of source) {
		const normalized = parseInput(entry.input);
		const frame = normalizeFrame(entry.frame, normalized);
		if (Number.isFinite(frame) && validInputs.has(normalized)) {
			entries.push({ frame, input: normalized });
		}
	}

	entries.sort((a, b) => a.frame - b.frame || (a.input === 'U' ? -1 : 0) || (b.input === 'U' ? 1 : 0));

	const compact: ScriptEntry[] = [];
	for (const entry of entries) {
		const last = compact.at(-1);
		if (last && last.frame === entry.frame && last.input !== 'U' && entry.input !== 'U') {
			compact[compact.length - 1] = entry;
		} else if (!last || last.input !== entry.input) {
			compact.push(entry);
		}
	}

	return compact;
}

export function serializeScript(script: ScriptEntry[]): string {
	return normalizeScript(script)
		.map((entry) => `${entry.frame} ${entry.input}`)
		.join('\n');
}

export function gameTime(frame: number | null | undefined): string {
	if (!Number.isFinite(frame) || frame == null || frame < 0) return '--';
	const totalSeconds = Math.floor(frame / 60);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = String(totalSeconds % 60).padStart(2, '0');
	const centiseconds = String(Math.floor(((frame % 60) / 60) * 100)).padStart(2, '0');
	return `${minutes}:${seconds}.${centiseconds}`;
}

export type MutationFrameBounds = {
	minFrame?: number;
	maxFrame?: number;
	maxFrames?: number;
};

function finiteFrame(value: unknown, fallback: number): number {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) ? n : fallback;
}

function mutationBounds(script: ScriptEntry[], bounds: MutationFrameBounds): { min: number; max: number } {
	const min = Math.max(0, finiteFrame(bounds.minFrame, 0));
	const fallbackMax = Math.max(60, (script.at(-1)?.frame ?? 0) + 120);
	const maxFrames = Math.max(0, finiteFrame(bounds.maxFrames, fallbackMax));
	const configuredMax = Math.max(0, finiteFrame(bounds.maxFrame, 0));
	const max = configuredMax > 0 ? configuredMax : maxFrames;
	return { min, max: Math.max(min, max) };
}

function mutableIndices(script: ScriptEntry[], bounds: { min: number; max: number }): number[] {
	return script
		.map((entry, index) => (entry.input !== 'U' && entry.frame >= bounds.min && entry.frame <= bounds.max ? index : -1))
		.filter((index) => index >= 0);
}

function clampMutationFrame(frame: number, bounds: { min: number; max: number }): number {
	return Math.max(bounds.min, Math.min(bounds.max, Math.round(frame)));
}

function randomFrame(bounds: { min: number; max: number }): number {
	return bounds.min + Math.floor(Math.random() * (bounds.max - bounds.min + 1));
}

function addMutableInput(script: ScriptEntry[], bounds: { min: number; max: number }, inputs: TasInput[]) {
	script.push({
		frame: randomFrame(bounds),
		input: inputs[Math.floor(Math.random() * inputs.length)]
	});
}

export function mutateScript(base: ScriptEntry[], range: number, step: number, frameBounds: MutationFrameBounds = {}): ScriptEntry[] {
	const script = normalizeScript(base);

	const inputs: TasInput[] = ['.', 'L', 'R', 'LR'];
	const bounds = mutationBounds(script, frameBounds);
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
