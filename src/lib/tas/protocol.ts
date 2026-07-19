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
	gameplayReady: boolean;
	freeze?: {
		physicsFrozen: boolean;
		unfreezeStarted: boolean;
		prestartRemaining: number;
		prestartElapsed: number;
		unfreezeSource: string;
	};
};

export type BruteforceProgress = {
	workerId: number;
	trials: number;
	rate: number;
	bestScore: number;
	bestReached: boolean;
	bestTimes: number[];
	bestScript: ScriptEntry[];
	lastScore: number;
	lastReached: boolean;
	improvements: number;
	mode: string;
	rewindFrame: number | null;
	snapshotCount: number;
	optimizerBuildMs: number;
	optimizerValidated: boolean;
	optimizerFallbackReason: string;
	verified: number;
	error?: string;
};

export type GameMessage =
	| ({ type: 'GAME_READY' | 'SIM_READY' | 'TELEMETRY'; source: 'circloo-tas-game' } & Telemetry)
	| ({
			type: 'RUN_READY';
			source: 'circloo-tas-game';
			requestId: number;
			seed: number;
	  } & Telemetry)
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
	| {
			type: 'POINT_TARGET_PICKED';
			source: 'circloo-tas-game';
			x: number;
			y: number;
			z: number;
	  }
	| { type: 'ERROR'; source: 'circloo-tas-game'; message: string; requestId?: number | null };

export type BruteforceWorkerMessage =
	| { type: 'BRUTEFORCE_READY'; source: 'circloo-tas-worker' }
	| ({ type: 'BRUTEFORCE_PROGRESS'; source: 'circloo-tas-worker' } & BruteforceProgress)
	| { type: 'BRUTEFORCE_STOPPED'; source: 'circloo-tas-worker' }
	| { type: 'BRUTEFORCE_ERROR'; source: 'circloo-tas-worker'; error: string };

export type TargetMode = 'cp' | 'finish' | 'point';

export type BruteforceSettings = {
	level: number;
	target: TargetMode;
	targetCP: number;
	finishCP: number;
	pointX: number;
	pointY: number;
	pointZ: number;
	pointMinFrame: number;
	pointMaxFrame: number;
	maxFrames: number;
	minFrame: number;
	maxFrame: number;
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
