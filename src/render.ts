import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SinsyLabelPipeline } from "./cephome/engine/vsinsy/index.ts";
import type { PhoneEvent, ScoreNote } from "./cephome/engine/vsinsy/lab/types.ts";
import type { NEngineDaemon } from "./daemon.ts";
import type { MetadataStore } from "./store.ts";
import type { RenderRequest, RenderOutput, RenderResponse, NoteOutput, PhoneOutput } from "./types.ts";

const CACHE_DIR = process.env.CACHE_DIR ?? `${Bun.env.HOME ?? "/tmp"}/.cache/loaphuong`;

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

function toPhoneOutput(e: PhoneEvent): PhoneOutput {
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
		expression: {
			energy: 70,
			vibratoRateHz: 0,
			vibratoDepthCents: 0,
			vibratoStartRatio: 0,
			pitchDeltaFromPrev: 0,
			pitchDeltaToNext: 0,
			tonalPitchOffset: 0,
			toneMelodyRelation: "level",
		},
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

	async render(req: RenderRequest): Promise<RenderResponse> {
		const voice = req.voice ?? "merrow";
		const musicxmlHash = createHash("sha256").update(req.musicxml).digest("hex").slice(0, 16);

		// Check cache
		const cached = this.store.findCached(musicxmlHash, voice);
		if (cached?.wavPath && existsSync(cached.wavPath)) {
			const cachedOutput = JSON.parse(readFileSync(join(CACHE_DIR, `${cached.id}.json`), "utf8"));
			return {
				success: true,
				wavPath: cached.wavPath,
				notes: cached.noteCount,
				phones: cached.phoneCount,
				output: cachedOutput,
			};
		}

		const renderId = `${musicxmlHash}-${voice}-${Date.now()}`;
		const renderDir = join(CACHE_DIR, renderId);
		mkdirSync(renderDir, { recursive: true });

		// Step 1: Run cephome phoneme pipeline directly
		const trace = this.pipeline.serializeTrace(req.musicxml);
		const fullLabPath = join(renderDir, "render.full.lab");
		const monoLabPath = join(renderDir, "render.mono.lab");
		writeFileSync(fullLabPath, trace.full, "utf8");
		writeFileSync(monoLabPath, trace.mono, "utf8");

		const renderOutput: RenderOutput = {
			format: "cephome-render-v1",
			generated: new Date().toISOString(),
			model: voice,
			source: req.musicxml,
			notes: trace.score.notes.map(toNoteOutput),
			phones: trace.events.map(toPhoneOutput),
			audio: null,
		};

		// Step 2: Run neutrino with the generated full-context .lab file
		const models = await this.daemon.scanVoices();
		const model = models.find((m) => m.name === voice);
		if (!model) {
			throw new Error(`Voice model "${voice}" not found in ${this.daemon["config"].modelsDir}`);
		}

		await this.daemon.runNEngine(fullLabPath, model.path, renderDir);

		const wavPath = join(renderDir, "output.wav");

		// Step 3: Write render.json and cache metadata
		renderOutput.audio = {
			format: "wav",
			sampleRate: 48000,
			path: wavPath,
		};

		const renderJsonPath = join(CACHE_DIR, `${renderId}.json`);
		writeFileSync(renderJsonPath, JSON.stringify(renderOutput, null, 2), "utf8");

		// Signal VST3
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
}
