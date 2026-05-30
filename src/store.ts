import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StoreEntry } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS renders (
  id TEXT PRIMARY KEY,
  musicxml_hash TEXT NOT NULL,
  voice TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  wav_path TEXT,
  phone_count INTEGER DEFAULT 0,
  note_count INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_renders_hash ON renders(musicxml_hash, voice);

CREATE TABLE IF NOT EXISTS models (
  name TEXT PRIMARY KEY,
  speaker TEXT NOT NULL,
  path TEXT NOT NULL,
  version TEXT DEFAULT 'unknown',
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  render_count INTEGER DEFAULT 0,
  last_active TEXT
);
`;

export class MetadataStore {
	private db: Database;

	constructor(dbPath: string) {
		const dir = dirname(dbPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		this.db = new Database(dbPath);
		this.db.exec("PRAGMA journal_mode=WAL");
		this.db.exec("PRAGMA synchronous=NORMAL");
		this.db.exec(SCHEMA);
	}

	close(): void {
		this.db.close();
	}

	cacheRender(entry: StoreEntry): void {
		const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO renders (id, musicxml_hash, voice, created_at, wav_path, phone_count, note_count, duration_ms)
      VALUES ($id, $hash, $voice, $createdAt, $wavPath, $phoneCount, $noteCount, $durationMs)
    `);
		stmt.run({
			$id: entry.id,
			$hash: entry.musicxmlHash,
			$voice: entry.voice,
			$createdAt: entry.createdAt,
			$wavPath: entry.wavPath,
			$phoneCount: entry.phoneCount,
			$noteCount: entry.noteCount,
			$durationMs: entry.durationMs,
		});
	}

	findCached(musicxmlHash: string, voice: string): StoreEntry | null {
		const row = this.db.prepare(`
      SELECT * FROM renders WHERE musicxml_hash = $hash AND voice = $voice
    `).get({ $hash: musicxmlHash, $voice: voice }) as Record<string, unknown> | undefined;
		if (!row) return null;
		return this.rowToEntry(row);
	}

	listRenders(limit = 20): StoreEntry[] {
		const rows = this.db.prepare(`
      SELECT * FROM renders ORDER BY created_at DESC LIMIT $limit
    `).all({ $limit: limit }) as Record<string, unknown>[];
		return rows.map(this.rowToEntry);
	}

	registerModel(name: string, speaker: string, path: string, version: string): void {
		this.db.prepare(`
      INSERT OR REPLACE INTO models (name, speaker, path, version)
      VALUES ($name, $speaker, $path, $version)
    `).run({ $name: name, $speaker: speaker, $path: path, $version: version });
	}

	listModels(): Array<{ name: string; speaker: string; version: string }> {
		return this.db.prepare("SELECT name, speaker, version FROM models ORDER BY name").all() as Array<{
			name: string;
			speaker: string;
			version: string;
		}>;
	}

	private rowToEntry(row: Record<string, unknown>): StoreEntry {
		return {
			id: row.id as string,
			musicxmlHash: row.musicxml_hash as string,
			voice: row.voice as string,
			createdAt: row.created_at as string,
			wavPath: row.wav_path as string | null,
			phoneCount: row.phone_count as number,
			noteCount: row.note_count as number,
			durationMs: row.duration_ms as number,
		};
	}
}
