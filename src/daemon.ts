import type { DaemonState, VoiceModel } from "./types.ts";

export interface DaemonConfig {
	nenginePath: string;
	modelsDir: string;
	binaryDir: string;
}

export class NEngineDaemon {
	private proc: Bun.Subprocess | null = null;
	private config: DaemonConfig;
	private _state: DaemonState = {
		running: false,
		pid: null,
		model: null,
		startedAt: null,
		memoryMb: 0,
	};

	constructor(config: DaemonConfig) {
		this.config = config;
	}

	get state(): DaemonState {
		return { ...this._state };
	}

	async start(): Promise<void> {
		if (this._state.running) return;

		this._state.running = true;
		this._state.pid = process.pid;
		this._state.startedAt = new Date().toISOString();
	}

	async stop(): Promise<void> {
		if (!this._state.running) return;
		this._state.running = false;
		this._state.pid = null;
		this._state.startedAt = null;
	}

	async runNEngine(
		fullLabPath: string,
		modelPath: string,
		outputDir: string,
		threads = 4,
	): Promise<void> {
		const timingLab = `${outputDir}/timing.lab`;
		const f0Path = `${outputDir}/output.f0`;
		const melspecPath = `${outputDir}/output.melspec`;
		const wavPath = `${outputDir}/output.wav`;

		const proc = Bun.spawn([
			this.config.nenginePath,
			fullLabPath,
			timingLab,
			f0Path,
			melspecPath,
			wavPath,
			`${modelPath}/`,
			"-n", String(threads),
			"-s", "48000",
			"-b", "16",
			"-t",
		], {
			cwd: this.config.binaryDir,
			env: {
				...process.env,
				LD_LIBRARY_PATH: `${this.config.binaryDir}:${process.env.LD_LIBRARY_PATH ?? ""}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`neutrino failed (exit ${exitCode}): ${stderr}`);
		}
	}

	async scanVoices(): Promise<VoiceModel[]> {
		const { readdirSync } = await import("node:fs");
		const { join } = await import("node:path");

		const models: VoiceModel[] = [];
		const dir = this.config.modelsDir;

		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					const modelDir = join(dir, entry.name);
					models.push({
						name: entry.name.toLowerCase(),
						path: modelDir,
						speaker: entry.name,
						version: "unknown",
					});
				}
			}
		} catch {
		}

		return models;
	}

	async healthCheck(): Promise<boolean> {
		const { existsSync } = await import("node:fs");
		return existsSync(this.config.nenginePath);
	}
}
