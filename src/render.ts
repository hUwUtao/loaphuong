import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { SinsyLabelPipeline, VietnameseMoraPlanTranspiler, formatSimplePhoneGroups, expressionForNote } from "../cephome/engine/vsinsy/index.ts";
import type { PhoneEvent, ScoreNote } from "../cephome/engine/vsinsy/lab/types.ts";
import type { NEngineDaemon } from "./daemon.ts";
import type { MetadataStore } from "./store.ts";
import type { RenderRequest, RenderOutput, RenderResponse, NoteOutput, PhoneOutput } from "./types.ts";

const CACHE_DIR = process.env.CACHE_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"}/.cache/loaphuong`;

function buildOverrideMap(
	reqOverrides?: Record<string, string[]> | string[][],
): Record<string, string[]> | null {
	if (!reqOverrides) return null;
	if (Array.isArray(reqOverrides)) return null; // handled post-parse
	const keys = Object.keys(reqOverrides);
	if (keys.length === 0) return null;
	return reqOverrides;
}

function convertPositionOverrides(
	notes: ScoreNote[],
	overrides: string[][],
): Record<string, string[]> {
	const map: Record<string, string[]> = {};
	let pi = 0;
	for (const note of notes) {
		if (note.isRest) continue; // QML skips rests, align positions
		if (pi >= overrides.length) break;
		const arr = overrides[pi];
		if (arr && arr.length > 0) {
			map[note.id] = arr;
		}
		pi++;
	}
	return map;
}

function distinctPitchedNote(events: PhoneEvent[], index: number, direction: -1 | 1): ScoreNote | null {
	const currentId = events[index]!.note.id;
	for (let cursor = index + direction; cursor >= 0 && cursor < events.length; cursor += direction) {
		const note = events[cursor]!.note;
		if (note.id !== currentId && !note.isRest) return note;
	}
	return null;
}

function toNoteOutput(n: ScoreNote): NoteOutput {
	return {
		id: n.id,
		tick: n.startDiv,
		midi: n.pitch?.midi ?? null,
		pitchName: n.pitch?.name ?? null,
		durationDiv: n.durationDiv,
		lyric: n.lyric,
		verse: null,
		dynamic: n.dynamic,
		isRest: n.isRest,
		tie: n.tie ?? null,
		slur: n.slur ?? null,
	};
}

function toPhoneOutput(e: PhoneEvent, events: PhoneEvent[], index: number): PhoneOutput {
	const prev = distinctPitchedNote(events, index, -1);
	const next = distinctPitchedNote(events, index, 1);
	const expression = expressionForNote(
		e.note, prev, next,
		e.tone, e.phoneIndexInNote, e.phoneCountInNote, e.velocity ?? undefined,
	);
	return {
		startNs: e.start,
		endNs: e.end,
		phoneme: e.phoneme,
		cls: e.cls,
		role: e.role,
		midi: e.note.pitch?.midi ?? null,
		lyric: e.note.lyric ?? null,
		tone: e.tone,
		vowelSign: e.vowelSign,
		ghost: e.ghost ?? false,
		vacuum: e.vacuum ?? false,
		velocity: e.velocity ?? null,
		phoneIndexInNote: e.phoneIndexInNote,
		phoneCountInNote: e.phoneCountInNote,
		expression,
	};
}

export class RenderPipeline {
	private daemon: NEngineDaemon;
	private store: MetadataStore;
	private pipeline: SinsyLabelPipeline;

	constructor(daemon: NEngineDaemon, store: MetadataStore) {
		this.daemon = daemon;
		this.store = store;
		this.pipeline = new SinsyLabelPipeline({
			phraseOverrideOptions: { omitGhost: true },
			quiet: true,
			noSvg: true,
		});
	}

	async render(req: RenderRequest, runId = "????"): Promise<RenderResponse> {
		const tag = `[run-${runId}]`;
		const voice = req.voice ?? "merrow";
		const xml = req.musicxml ?? "";

		// Resolve overrides: Record<string, string[]> or string[][]
		let overrides: Record<string, string[]> | null = null;
		if (req.phonemeOverrides) {
			if (Array.isArray(req.phonemeOverrides)) {
				// Position-indexed array: need to convert after parsing MusicXML
				const stubPipeline = new SinsyLabelPipeline({
					phraseOverrideOptions: { omitGhost: true },
					quiet: true,
					noSvg: true,
				});
				const stubTrace = stubPipeline.serializeTrace(xml);
				overrides = convertPositionOverrides(stubTrace.score.notes, req.phonemeOverrides);
			} else {
				overrides = buildOverrideMap(req.phonemeOverrides);
			}
		}
		const overrideHash = overrides
			? createHash("sha256").update(JSON.stringify(overrides)).digest("hex").slice(0, 8)
			: "";

		const musicxmlHash = createHash("sha256").update(xml).digest("hex").slice(0, 16)
			+ (overrideHash ? `-ov${overrideHash}` : "");

		const cached = this.store.findCached(musicxmlHash, voice);
		if (cached?.wavPath && existsSync(cached.wavPath)) {
			console.log(`${tag} cache hit voice=${voice} hash=${musicxmlHash}`);
			const cachedOutput = JSON.parse(readFileSync(join(CACHE_DIR, `${cached.id}.json`), "utf8"));
			return {
				success: true,
				wavPath: cached.wavPath,
				notes: cached.noteCount,
				phones: cached.phoneCount,
				output: cachedOutput,
			};
		}

		console.log(`${tag} cache miss voice=${voice} hash=${musicxmlHash}${overrides ? ` overrides=${Object.keys(overrides).length}` : ""}`);

		const renderId = `${musicxmlHash}-${voice}-${Date.now()}`;
		const renderDir = join(CACHE_DIR, renderId);
		mkdirSync(renderDir, { recursive: true });

		const pipeline = overrides
			? new SinsyLabelPipeline({
				phraseOverrideOptions: { omitGhost: true },
				quiet: true,
				noSvg: true,
				phonemeOverrides: overrides,
			})
			: this.pipeline;

		console.log(`${tag} cephome phoneme pipeline...`);
		const trace = pipeline.serializeTrace(xml);
		const fullLabPath = join(renderDir, "render.full.lab");
		const monoLabPath = join(renderDir, "render.mono.lab");
		writeFileSync(fullLabPath, trace.full, "utf8");
		writeFileSync(monoLabPath, trace.mono, "utf8");
		console.log(`${tag} cephome done: ${trace.events.length} phones, ${trace.score.notes.length} notes`);

		const phonemeExport: Record<string, string> = {};
		const ovTranspiler = new VietnameseMoraPlanTranspiler();
		// Only emit for root notes (single/begin) — skip melisma tails (middle/end).
		// After normalization, begin notes have no lyric; look ahead for end note's lyric.
		for (let ni = 0; ni < trace.score.notes.length; ni++) {
			const note = trace.score.notes[ni];
			if (note.isRest) continue;
			if (note.syllabic === "single" && note.lyric) {
				try {
					const plan = ovTranspiler.plan(note.lyric);
					phonemeExport[note.id] = formatSimplePhoneGroups(plan.plan);
				} catch {}
			} else if (note.syllabic === "begin") {
				// Look ahead for the end note's lyric (normalizer consolidates there)
				let lyric = "";
				for (let j = ni; j < trace.score.notes.length; j++) {
					if (trace.score.notes[j].lyric) {
						lyric = trace.score.notes[j].lyric;
						if (trace.score.notes[j].syllabic === "end") break;
					}
					if (trace.score.notes[j].syllabic === "single" || trace.score.notes[j].isRest) break;
				}
				if (lyric) {
					try {
						const plan = ovTranspiler.plan(lyric);
						phonemeExport[note.id] = formatSimplePhoneGroups(plan.plan);
					} catch {}
				}
			}
		}

		const renderOutput: RenderOutput = {
			format: "cephome-render-v1",
			generated: new Date().toISOString(),
			model: voice,
			source: xml,
			notes: trace.score.notes.map(toNoteOutput),
			phones: trace.events.map((e, i) => toPhoneOutput(e, trace.events, i)),
			audio: null,
			phonemeExport,
		};

		console.log(`${tag} neutrino synthesis...`);
		const models = await this.daemon.scanVoices();
		const model = models.find((m) => m.name.toLowerCase() === voice.toLowerCase());
		if (!model) {
			throw new Error(`Voice model "${voice}" not found in ${this.daemon["config"].modelsDir}`);
		}

		await this.daemon.runNEngine(fullLabPath, model.path, renderDir, 4, runId);

		const wavPath = join(renderDir, "output.wav");

		try {
			const linkPath = join(CACHE_DIR, "render.wav");
			if (existsSync(linkPath)) unlinkSync(linkPath);
			try {
				symlinkSync(wavPath, linkPath);
			} catch {
				// Windows: symlink may fail, copy instead
				copyFileSync(wavPath, linkPath);
			}
		} catch (_) {}

		renderOutput.audio = {
			format: "wav",
			sampleRate: 48000,
			path: wavPath,
		};

		const renderJsonPath = join(CACHE_DIR, `${renderId}.json`);
		writeFileSync(renderJsonPath, JSON.stringify(renderOutput, null, 2), "utf8");

		writeFileSync(
			join(CACHE_DIR, "render.json"),
			JSON.stringify(renderOutput, null, 2),
			"utf8",
		);

		this.store.cacheRender({
			id: renderId,
			musicxmlHash,
			voice,
			createdAt: new Date().toISOString(),
			wavPath,
			phoneCount: renderOutput.phones.length,
			noteCount: renderOutput.notes.length,
			durationMs: renderOutput.phones.reduce((sum, p) => sum + (p.endNs - p.startNs), 0) / 1_000_000,
		});

		return {
			success: true,
			wavPath,
			notes: renderOutput.notes.length,
			phones: renderOutput.phones.length,
			output: renderOutput,
		};
	}

	async analyze(xml: string, overrides?: Record<string, string[]> | string[][]): Promise<{ notes: NoteOutput[]; phonemeExport: Record<string, string> }> {
		let resolved: Record<string, string[]> | null = null;
		if (overrides) {
			if (Array.isArray(overrides)) {
				const stubPipeline = new SinsyLabelPipeline({
					phraseOverrideOptions: { omitGhost: true },
					quiet: true,
					noSvg: true,
				});
				const stubTrace = stubPipeline.serializeTrace(xml);
				resolved = convertPositionOverrides(stubTrace.score.notes, overrides);
			} else {
				resolved = overrides;
			}
		}
		const pipeline = resolved
			? new SinsyLabelPipeline({
				phraseOverrideOptions: { omitGhost: true },
				quiet: true,
				noSvg: true,
				phonemeOverrides: resolved,
			})
			: this.pipeline;

		const trace = pipeline.serializeTrace(xml);

		const phonemeExport: Record<string, string> = {};
		const ovTranspiler = new VietnameseMoraPlanTranspiler();
		// Only emit for root notes (single/begin) — skip melisma tails (middle/end).
		for (let ni = 0; ni < trace.score.notes.length; ni++) {
			const note = trace.score.notes[ni];
			if (note.isRest) continue;
			if (note.syllabic === "single" && note.lyric) {
				try {
					const plan = ovTranspiler.plan(note.lyric);
					phonemeExport[note.id] = formatSimplePhoneGroups(plan.plan);
				} catch {}
			} else if (note.syllabic === "begin") {
				let lyric = "";
				for (let j = ni; j < trace.score.notes.length; j++) {
					if (trace.score.notes[j].lyric) {
						lyric = trace.score.notes[j].lyric;
						if (trace.score.notes[j].syllabic === "end") break;
					}
					if (trace.score.notes[j].syllabic === "single" || trace.score.notes[j].isRest) break;
				}
				if (lyric) {
					try {
						const plan = ovTranspiler.plan(lyric);
						phonemeExport[note.id] = formatSimplePhoneGroups(plan.plan);
					} catch {}
				}
			}
		}

		return {
			notes: trace.score.notes.map(toNoteOutput),
			phonemeExport,
		};
	}
}
