# LOAPHUONG Design Decisions

## Core Insight
CEPHOME already does MusicXML → Vietnamese phoneme LAB files (Sinsy format).
We need to bridge this to an actual SVS backend. Options:

### Option A: NEUTRINO N.Engine (chosen)
- Paradigm: Phoneme-level synthesis via .lab + model
- cephome already generates Sinsy-format .lab files
- We wrap N.Engine binary as a managed daemon
- Pro: Works with existing cephome pipeline
- Pro: NEUTRINO voice models exist
- Con: No native REST API — we build it

### Option B: VOICEVOX Core
- Paradigm: Frame-level ONNX inference
- Would need Vietnamese phoneme → Japanese-style mora mapping
- Pro: Clean API pattern to follow
- Con: No Vietnamese models exist; would need training

## Architecture

```
┌──────────────┐      ┌──────────────────────┐      ┌──────────────┐
│ MuseScore     │      │  LOAPHUONG Backend   │      │  CEPHOME     │
│ (QML+VST3)   │ ──── │  (Bun/TypeScript)    │ ──── │  (MusicXML   │
│              │      │                      │      │  → phonemes) │
└──────────────┘      │  HTTP :3100          │      └──────────────┘
                      │  Daemon manager      │
                      │  Cache layer          │      ┌──────────────┐
                      │  Metadata store       │ ──── │  NEUTRINO    │
                      │  (SQLite via bun)     │      │  N.Engine    │
                      └──────────────────────┘      │  (models)     │
                                                    └──────────────┘
```

## Key Features of LOAPHUONG Backend

### 1. Active Backend (HTTP Server on :3100)
- POST /api/render — Full pipeline: MusicXML → WAV
- POST /api/render-stream — SSE progress
- GET /api/status — Health check
- GET /api/voices — Available voice models

### 2. Managed Daemon
- Spawn/manage N.Engine subprocess
- Health monitoring (process alive, GPU memory)
- Auto-restart on crash
- Graceful shutdown

### 3. Managed Metadata (SQLite)
- Cache renders (avoid re-gen)
- Track model registry (which voices installed)
- Session history
- Job queue for concurrent renders

### 4. NEUTRINO Integration (bridge layer)
- cephome output → N.Engine input format
- File-based IPC (write .lab, trigger N.Engine, read .wav)
- Temp file management

## API Contract (aligned with loaphuong-mscore's render.json)
```typescript
// Input
POST /api/render
{ musicxml: string, voice?: string, options?: {...} }

// Output
{
  success: true,
  wavPath: "/path/to/output.wav",
  notes: 42,
  phones: 284,
  output: {
    format: "cephome-render-v1",
    notes: [...],
    phones: [...],
    audio: { format: "wav", sampleRate: 48000, path: "..." }
  }
}
```

## CEPHOME Integration
- Import cephome's SinsyLabelPipeline for MusicXML → LAB
- Mount cephome as dependency (git submodule or npm workspace)
- cephome's engine/ provides: `SinsyLabelPipeline`, `DomMusicXmlParser`,
  `VocalLineNormalizer`, `VietnameseMoraPlanTranspiler`

## Code Style
Follow cephome conventions (from AGENTS.md):
- Tabs, double quotes, trailing semicolons
- `camelCase` functions, `PascalCase` classes
- Named exports
- No comments unless non-obvious
