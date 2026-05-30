import { NEngineDaemon } from "./daemon.ts";
import { MetadataStore } from "./store.ts";
import { RenderPipeline } from "./render.ts";
import type { RenderRequest } from "./types.ts";

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const NEUTRINO_ROOT = process.env.NEUTRINO_ROOT;
const NENGINE_PATH = process.env.NENGINE_PATH;
const MODELS_DIR = process.env.MODELS_DIR;
const BINARY_DIR = process.env.BINARY_DIR;
const DB_PATH = process.env.LOAPHUONG_DB ?? `${Bun.env.HOME ?? "/tmp"}/.cache/loaphuong/metadata.db`;

if (!NENGINE_PATH || !MODELS_DIR || !BINARY_DIR) {
	console.error("loaphuong: set NENGINE_PATH, MODELS_DIR, and BINARY_DIR (or NEUTRINO_ROOT)");
	process.exit(1);
}

const daemon = new NEngineDaemon({
	nenginePath: NENGINE_PATH,
	modelsDir: MODELS_DIR,
	binaryDir: BINARY_DIR,
});

const store = new MetadataStore(DB_PATH);
const pipeline = new RenderPipeline(daemon, store);

await daemon.start();
console.error(`[loaphuong] daemon started, models: ${MODELS_DIR}`);

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		try {
			if (url.pathname === "/api/render" && req.method === "POST") {
				return handleRender(req);
			}

			if (url.pathname === "/api/render-stream" && req.method === "POST") {
				return handleRenderStream(req);
			}

			if (url.pathname === "/api/status" && req.method === "GET") {
				return handleStatus();
			}

			if (url.pathname === "/api/voices" && req.method === "GET") {
				return handleVoices();
			}

			return new Response("Not Found", { status: 404 });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return Response.json({ error: msg }, { status: 500 });
		}
	},
});

console.log(`loaphuong running at http://127.0.0.1:${PORT}`);

async function handleRender(req: Request): Promise<Response> {
	const body = (await req.json()) as RenderRequest;
	if (!body.musicxml) {
		return Response.json({ error: "Missing musicxml" }, { status: 400 });
	}
	const result = await pipeline.render(body);
	return Response.json(result);
}

async function handleRenderStream(req: Request): Promise<Response> {
	const body = (await req.json()) as RenderRequest;
	if (!body.musicxml) {
		return Response.json({ error: "Missing musicxml" }, { status: 400 });
	}

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			try {
				send("progress", { step: "phonemes", message: "Running cephome phoneme pipeline..." });
				const result = await pipeline.render(body);
				send("progress", { step: "synthesis", message: "Running NEUTRINO synthesis..." });
				send("complete", { wavPath: result.wavPath, notes: result.notes, phones: result.phones });
			} catch (err) {
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
		ok: true,
		daemon: daemon.state,
		health,
		models: voices.length,
		cached: store.listRenders(5),
	});
}

async function handleVoices(): Promise<Response> {
	const voices = await daemon.scanVoices();
	return Response.json({ voices, count: voices.length });
}
