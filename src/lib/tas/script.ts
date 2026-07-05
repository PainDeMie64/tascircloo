export type TasInput = '.' | 'L' | 'R' | 'LR';

export type ScriptEntry = {
	frame: number;
	input: TasInput;
};

const validInputs = new Set<TasInput>(['.', 'L', 'R', 'LR']);

export function inputFromHeld(held: { L: boolean; R: boolean }): TasInput {
	if (held.L && held.R) return 'LR';
	if (held.L) return 'L';
	if (held.R) return 'R';
	return '.';
}

export function parseInput(value: unknown): TasInput {
	const text = String(value || '.').toUpperCase();
	return inputFromHeld({
		L: text.includes('L') || text.includes('<'),
		R: text.includes('R') || text.includes('>')
	});
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
		const frame = Math.max(0, Math.round(Number(entry.frame)));
		const normalized = parseInput(entry.input);
		if (Number.isFinite(frame) && validInputs.has(normalized)) {
			entries.push({ frame, input: normalized });
		}
	}

	entries.sort((a, b) => a.frame - b.frame);

	const compact: ScriptEntry[] = [];
	for (const entry of entries) {
		const last = compact.at(-1);
		if (last && last.frame === entry.frame) {
			compact[compact.length - 1] = entry;
		} else if (!last || last.input !== entry.input) {
			compact.push(entry);
		}
	}

	if (!compact.length || compact[0].frame !== 0) {
		compact.unshift({ frame: 0, input: '.' });
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

export function mutateScript(base: ScriptEntry[], range: number, step: number): ScriptEntry[] {
	const script = normalizeScript(base);
	if (!script.length) return script;

	const inputs: TasInput[] = ['.', 'L', 'R', 'LR'];
	const op = Math.random();

	if (op < 0.62) {
		const i = Math.floor(Math.random() * script.length);
		const shift = (Math.floor(Math.random() * (range * 2 + 1)) - range) * step;
		script[i] = { ...script[i], frame: Math.max(0, script[i].frame + shift) };
	} else if (op < 0.82) {
		const last = Math.max(60, script[script.length - 1].frame + 120);
		script.push({
			frame: Math.floor(Math.random() * last),
			input: inputs[Math.floor(Math.random() * inputs.length)]
		});
	} else if (op < 0.92 && script.length > 1) {
		script.splice(1 + Math.floor(Math.random() * (script.length - 1)), 1);
	} else {
		const i = Math.floor(Math.random() * script.length);
		script[i] = { ...script[i], input: inputs[Math.floor(Math.random() * inputs.length)] };
	}

	return normalizeScript(script);
}
