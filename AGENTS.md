# loaphuong: NEUTRINO SVS Wrapper Backend

Vietnamese singing voice synthesis backend. Embeds cephome engine (MusicXML→phonemes)
directly, bridges to NEUTRINO N.Engine (phonemes→WAV) via a managed REST API daemon.

## Architecture

```
MuseScore QML          LOAPHUONG Backend (:3100)
  │                        │
  │ POST /api/render       │
  ├───────────────────────►│  ┌─────────────────────┐
  │                        │  │ Direct Import       │
  │                        │  │ SinsyLabelPipeline  │
  │                        │  │ (cephome submodule) │
  │                        │  ├─── MusicXML→.lab   │
  │                        │  └─────────────────────┘
  │                        │  ┌─────────────────────┐
  │                        │  │ Daemon Manager      │
  │                        │  │ ├── neutrino (CPU)  │
  │                        │  │ ├── Voice models    │
  │                        │  │ └── Temp files      │
  │                        │  └─────────────────────┘
  │                        │         │
  │                        │  full.lab → neutrino → .wav
  │◄───────────────────────┤
  │   wav path + render.json
```

## Repo Structure

```
loaphuong/
├── src/
│   ├── index.ts        HTTP server (Bun.serve)
│   ├── render.ts       Render pipeline (cephome → neutrino, direct import)
│   ├── daemon.ts       neutrino subprocess manager
│   ├── store.ts        SQLite metadata cache
│   └── types.ts        Shared type definitions
├── cephome/            Git submodule — cephome engine (engine/vsinsy/)
├── .research/          Architecture research notes
├── AGENTS.md           This file
├── package.json
└── tsconfig.json
```

## NEUTRINO Linux Binaries

Extracted from `NEUTRINO-online-v3.2.2.zip` → `NEUTRINO_online/online/NEUTRINO/`:

| Binary | Path | Description |
|---|---|---|
| `neutrino` | `bin/neutrino` | Synthesis engine (ELF 64-bit, no server mode) |
| Libraries | `bin/*.so` | CUDA/cuDNN/ONNX runtime libs |

### Neutrino CLI

```
neutrino full.lab timing.lab output.f0 output.melspec output.wav model/ModelDir/ [options]
```

| Flag | Default | Description |
|---|---|---|
| `-n` | max | parallel threads |
| `-s` | 48000 | sampling rate |
| `-b` | 16 | bit depth |
| `-k` | 0 | style shift (key) |
| `-f` | 0 | transpose (key) |
| `-m` | off | use best GPU |
| `-g` | off | use single GPU |
| `-t` | off | view timing info |
| `-p` | off | single phrase prediction |
| `--skip-timing` | off | skip timing prediction |
| `--skip-f0` | off | skip pitch prediction |
| `--skip-melspec` | off | skip melspec prediction |
| `--skip-wav` | off | skip waveform prediction |

### Voice Models (v3.2.2)

Available in `model/`:

| Model | Gender | Type | Range |
|---|---|---|---|
| **MERROW** | Female | standard | A3–E5 |
| **NAKUMO** | Male | standard | A2–B4 |
| **REINA** | Female | standard | F3–C5 |
| **RUNO** | Male | standard | G2–A4 |
| **SOMA** | Male | standard | C3–C5 |

Each model dir contains: `info.toml`, `p.bin`, `s.bin`, `t.bin`, `v.bin`

### LD_LIBRARY_PATH

Must include NEUTRINO `bin/` dir for `.so` loading.

## Pipeline

```
MusicXML (from MuseScore)
     │
     ▼
SinsyLabelPipeline (cephome, direct import)
     │                      (Vietnamese phoneme pipeline)
     ▼
full.lab (full-context HTK label) + mono.lab
     │
     ▼
neutrino full.lab timing.lab output.f0 output.melspec output.wav model/MERROW/
     │                  ▲
     │   timing.lab is written by neutrino (intermediate output)
     ▼
output.wav
```

Note: The timing lab (2nd positional arg) is **output** of neutrino,
not input. Neutrino reads `full.lab` and generates timing predictions.

## Dependencies

- **cephome** at `cephome/engine/` — git submodule, Vietnamese phoneme pipeline
- **NEUTRINO v3.2.2 Linux** — on-demand, set env vars to point to installation
- **Bun** runtime
- No GPU required (CPU mode works via ONNX Runtime)

## Environment

| Variable | Required | Description |
|---|---|---|
| `NENGINE_PATH` | yes | Path to `neutrino` binary |
| `MODELS_DIR` | yes | NEUTRINO voice model directory |
| `BINARY_DIR` | yes | NEUTRINO bin dir (for LD_LIBRARY_PATH) |
| `PORT` | no (:3100) | HTTP server port |
| `CACHE_DIR` | no (~/.cache/loaphuong) | Render cache |
| `LOAPHUONG_DB` | no (~/.cache/loaphuong/metadata.db) | SQLite DB path |

Shorthand: set `NEUTRINO_ROOT` to the NEUTRINO directory root (must contain `bin/` and `model/`), and the individual paths derive from it.

## API

### POST /api/render
Full pipeline: MusicXML → phonemes → WAV

```json
{ "musicxml": "<score-partwise>...", "voice": "merrow" }
```

### GET /api/status
Health check + daemon status.

### GET /api/voices
List available NEUTRINO voice models.

### POST /api/render-stream
SSE endpoint for progress events during render.

## Code Style

Match cephome conventions:
- Tabs, double quotes, trailing semicolons
- `camelCase` functions/vars, `PascalCase` classes
- Named exports
- No comments unless non-obvious
