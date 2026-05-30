import { NEngineDaemon } from "./daemon.ts";
import { MetadataStore } from "./store.ts";
import { RenderPipeline } from "./render.ts";
import type { RenderRequest } from "./types.ts";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

const PORT = parseInt(process.env.PORT ?? "3100", 10);

function detectPaths() {
	if (process.env.NENGINE_PATH && process.env.MODELS_DIR && process.env.BINARY_DIR) {
		return { nenginePath: process.env.NENGINE_PATH, modelsDir: process.env.MODELS_DIR, binaryDir: process.env.BINARY_DIR };
	}

	if (process.env.NEUTRINO_ROOT) {
		const root = process.env.NEUTRINO_ROOT;
		const md = resolve(root, "models");
		const ms = resolve(root, "model");
		return {
			nenginePath: resolve(root, "bin", process.platform === "win32" ? "neutrino.exe" : "neutrino"),
			modelsDir: existsSync(md) ? md : ms,
			binaryDir: resolve(root, "bin"),
		};
	}

	const exeDir = dirname(process.argv[0]);
	const neutrinoRoot = resolve(exeDir, "NEUTRINO");
	const md = resolve(neutrinoRoot, "models");
	const ms = resolve(neutrinoRoot, "model");
	return {
		nenginePath: resolve(neutrinoRoot, "bin", "neutrino.exe"),
		modelsDir: existsSync(md) ? md : ms,
		binaryDir: resolve(neutrinoRoot, "bin"),
	};
}

const config = detectPaths();

if (!existsSync(config.nenginePath)) {
	console.error(`loaphuong: neutrino not found at ${config.nenginePath}`);
	console.error("Set NEUTRINO_ROOT or place NEUTRINO/ alongside this executable");
	process.exit(1);
}

const dbDir = dirname(process.env.LOAPHUONG_DB ?? resolve(dirname(process.argv[0]), "data"));
mkdirSync(dbDir, { recursive: true });
const DB_PATH = process.env.LOAPHUONG_DB ?? resolve(dbDir, "loaphuong.db");

const daemon = new NEngineDaemon(config);
const store = new MetadataStore(DB_PATH);
const pipeline = new RenderPipeline(daemon, store);

await daemon.start();

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		try {
			if (url.pathname === "/api/render" && req.method === "POST") return handleRender(req);
			if (url.pathname === "/api/render-stream" && req.method === "POST") return handleRenderStream(req);
			if (url.pathname === "/api/phonemes" && req.method === "POST") return handlePhonemes(req);
			if (url.pathname === "/api/status" && req.method === "GET") return handleStatus();
			if (url.pathname === "/api/voices" && req.method === "GET") return handleVoices();
			return new Response("Not Found", { status: 404 });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return Response.json({ error: msg }, { status: 500 });
		}
	},
});

console.log(`loaphuong at http://127.0.0.1:${PORT} (models: ${config.modelsDir})`);

function genRunId(): string {
	return randomBytes(4).toString("hex");
}

async function resolveMusicXml(body: RenderRequest): Promise<string> {
	if (body.musicxml) return body.musicxml;
	if (body.scorePath) return await Bun.file(body.scorePath).text();
	throw new Error("Missing musicxml");
}

async function handleRender(req: Request): Promise<Response> {
	const body = (await req.json()) as RenderRequest;
	try {
		body.musicxml = await resolveMusicXml(body);
	} catch {
		return Response.json({ error: "Missing musicxml" }, { status: 400 });
	}
	const runId = genRunId();
	const tag = `[run-${runId}]`;
	const voice = body.voice ?? "merrow";
	console.log(`${tag} render voice=${voice} mxml=${body.musicxml.length}B`);
	const t = performance.now();
	try {
		const result = await pipeline.render(body, runId);
		console.log(`${tag} done voice=${voice} notes=${result.notes} phones=${result.phones} cache=${result.success} ${(performance.now() - t).toFixed(0)}ms`);
		return Response.json(result);
	} catch (err) {
		console.error(`${tag} FAILED voice=${voice}`, err);
		throw err;
	}
}

async function handlePhonemes(req: Request): Promise<Response> {
	const body = (await req.json()) as { musicxml?: string; scorePath?: string; phonemeOverrides?: Record<string, string[]> };
	let xml: string;
	try {
		xml = await resolveMusicXml(body);
	} catch {
		return Response.json({ error: "Missing musicxml" }, { status: 400 });
	}
	const result = await pipeline.analyze(xml, body.phonemeOverrides);
	return Response.json(result);
}

async function handleRenderStream(req: Request): Promise<Response> {
	const body = (await req.json()) as RenderRequest;
	try {
		body.musicxml = await resolveMusicXml(body);
	} catch {
		return Response.json({ error: "Missing musicxml" }, { status: 400 });
	}
	const runId = genRunId();
	const tag = `[run-${runId}]`;
	const voice = body.voice ?? "merrow";
	console.log(`${tag} render-stream voice=${voice} mxml=${body.musicxml.length}B`);
	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};
		try {
			send("progress", { step: "phonemes", message: "Running cephome phoneme pipeline..." });
			const t = performance.now();
			const result = await pipeline.render(body, runId);
			send("progress", { step: "synthesis", message: "Running NEUTRINO synthesis..." });
			send("complete", { wavPath: result.wavPath, notes: result.notes, phones: result.phones });
			console.log(`${tag} done voice=${voice} notes=${result.notes} phones=${result.phones} ${(performance.now() - t).toFixed(0)}ms`);
		} catch (err) {
			console.error(`${tag} FAILED voice=${voice}`, err);
			send("error", { message: err instanceof Error ? err.message : String(err) });
		} finally {
				controller.close();
			}
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
		},
	});
}

async function handleStatus(): Promise<Response> {
	const health = await daemon.healthCheck();
	const voices = await daemon.scanVoices();
	return Response.json({
		ok: true, daemon: daemon.state, health,
		models: voices.length, cached: store.listRenders(5),
	});
}

async function handleVoices(): Promise<Response> {
	const voices = await daemon.scanVoices();
	return Response.json({ voices, count: voices.length });
}
