export interface RenderRequest {
	musicxml?: string;
	scorePath?: string;
	voice?: string;
	phonemeOverrides?: Record<string, string[]> | string[][];
	options?: Record<string, unknown>;
}

export interface NoteOutput {
	id: number | string;
	tick: number;
	midi: number | null;
	pitchName: string | null;
	durationDiv: number;
	lyric: string | null;
	verse: string | null;
	dynamic: string | null;
	isRest: boolean;
	tie: string | null;
	slur: string | null;
}

export interface PhoneOutput {
	startNs: number;
	endNs: number;
	phoneme: string;
	cls: string;
	role: string;
	midi: number | null;
	lyric: string | null;
	tone: number;
	vowelSign: number | null;
	ghost: boolean;
	vacuum: boolean;
	velocity: number | null;
	phoneIndexInNote: number;
	phoneCountInNote: number;
	expression: PhoneExpression;
}

export interface PhoneExpression {
	energy: number;
	vibratoRateHz: number;
	vibratoDepthCents: number;
	vibratoStartRatio: number;
	pitchDeltaFromPrev: number;
	pitchDeltaToNext: number;
	tonalPitchOffset: number;
	toneMelodyRelation: string;
}

export interface AudioOutput {
	format: string;
	sampleRate: number;
	path: string;
}

export interface RenderOutput {
	format: string;
	generated: string;
	model: string;
	source: string;
	notes: NoteOutput[];
	phones: PhoneOutput[];
	audio: AudioOutput | null;
	phonemeExport?: Record<string, string>;
}

export interface RenderResponse {
	success: boolean;
	wavPath: string;
	notes: number;
	phones: number;
	output: RenderOutput;
}

export interface DaemonState {
	running: boolean;
	pid: number | null;
	model: string | null;
	startedAt: string | null;
	memoryMb: number;
}

export interface VoiceModel {
	name: string;
	path: string;
	speaker: string;
	version: string;
}

export interface StoreEntry {
	id: string;
	musicxmlHash: string;
	voice: string;
	createdAt: string;
	wavPath: string | null;
	phoneCount: number;
	noteCount: number;
	durationMs: number;
}
