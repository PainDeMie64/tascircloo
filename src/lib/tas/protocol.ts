import type { ScriptEntry } from './script';

export type Velocity = {
	vx: number;
	vy: number;
	speed: number;
};

export type Telemetry = {
	ready: boolean;
	installed: boolean;
	level: number | null;
	frame: number;
	cp: number;
	cpTimes: number[];
	input: string;
	velocity: Velocity;
	captured: number;
	playbackMode: boolean;
	paused: boolean;
	sim: boolean;
};

export type BruteforceProgress = {
	trials: number;
	bestScore: number;
	bestReached: boolean;
	bestTimes: number[];
	bestScript: ScriptEntry[];
	lastScore: number;
	lastReached: boolean;
	improvements: number;
	error?: string;
};

export type GameMessage =
	| ({ type: 'GAME_READY' | 'SIM_READY' | 'TELEMETRY'; source: 'circloo-tas-game' } & Telemetry)
		| {
				type: 'SCRIPT_NORMALIZED' | 'CAPTURE_DUMP';
				source: 'circloo-tas-game';
				script: ScriptEntry[];
				text: string;
		  }
		| {
				type: 'RUN_DUMP';
				source: 'circloo-tas-game';
				filename: string;
				text: string;
				frames: number;
		  }
	| { type: 'CAPTURE_CLEARED'; source: 'circloo-tas-game' }
	| { type: 'ERROR'; source: 'circloo-tas-game'; message: string };

export type BruteforceWorkerMessage =
	| { type: 'BRUTEFORCE_READY'; source: 'circloo-tas-worker' }
	| ({ type: 'BRUTEFORCE_PROGRESS'; source: 'circloo-tas-worker' } & BruteforceProgress)
	| { type: 'BRUTEFORCE_STOPPED'; source: 'circloo-tas-worker' }
	| { type: 'BRUTEFORCE_ERROR'; source: 'circloo-tas-worker'; error: string };

export type TargetMode = 'cp' | 'finish';

export type BruteforceSettings = {
	level: number;
	target: TargetMode;
	targetCP: number;
	finishCP: number;
	maxFrames: number;
	mutRange: number;
	mutStep: number;
	warmup: number;
	autoUseBest: boolean;
};

export function appMessage(type: string, payload: Record<string, unknown> = {}) {
	return {
		source: 'circloo-tas-app',
		type,
		...payload
	};
}
