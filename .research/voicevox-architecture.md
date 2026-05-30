# VOICEVOX Architecture Research

## Overview
VOICEVOX is an open-source Japanese TTS/singing system with a proper HTTP API
architecture. Three-layer design with Engine (Python) → Core (Rust) → Models.

## Three-Layer Architecture

### 1. voicevox_engine (Python FastAPI)
- HTTP server on port 50021
- Routes in `voicevox_engine/app/routers/tts_pipeline.py`
- Manages: TTS pipeline, Singing pipeline, Presets, User dict, Morphing
- Speech → TTS, Singing → SongEngine

### 2. voicevox_core (Rust + ONNX Runtime)
- C-ABI dynamic library (.so / .dll / .dylib)
- ONNX Runtime inference engine
- Python bindings (PyO3)
- Key APIs for singing:
  - `predict_sing_consonant_length_forward()`
  - `predict_sing_f0_forward()`
  - `predict_sing_volume_forward()`
  - `sf_decode_forward()` (vocoder → waveform)

### 3. Voice Models
- Per-speaker ONNX models
- Styles: "talk", "singing_teacher", "frame_decode", "sing"
- Characters have both talk_styles and sing_styles

## Singing Synthesis API Endpoints

### POST /sing_frame_audio_query
```
Request: { score: { notes: [{ key: int, frame_length: int, lyric: str }] } }
Response: FrameAudioQuery { f0, volume, phonemes, ... }
```
Pipeline inside:
1. `_notes_to_keys_and_phonemes()` — lyric→phoneme via mora_kana_to_mora_phonemes
2. `predict_sing_consonant_length_forward()` — consonant duration from core
3. `_calc_phoneme_lengths()` — vowel = note_duration - next_consonant
4. `predict_sing_f0_forward()` — F0 contour from core
5. `predict_sing_volume_forward()` — volume from core

### POST /frame_synthesis
```
Request: FrameAudioQuery
Response: audio/wav binary
```
Pipeline:
1. `_frame_query_to_sf_decoder_feature()` — extract features
2. `safe_sf_decode_forward()` — vocoder inference
3. `raw_wave_to_output_wave()` — post-processing

### POST /sing_frame_f0
Retrieve F0 from score + phonemes (for editing)

### POST /sing_frame_volume
Retrieve volume from score + phonemes + F0 (for editing)

## Score/Note Model (applicable to LOAPHUONG)
```typescript
interface Score {
  notes: Note[];
}
interface Note {
  key: number | null;    // MIDI note number, null for rest
  frame_length: number;  // frames (256-sample frames @ 24kHz)
  lyric: string;         // phoneme text (empty for rest)
}
```

## Key Difference from NEUTRINO
VOICEVOX has a clean REST API architecture. NEUTRINO does not. LOAPHUONG
should emulate the VOICEVOX API pattern but using cephome (Vietnamese phoneme
engine) instead of Japanese mora mapping, and NEUTRINO-style LAB file generation
as intermediate format for the actual synthesis.

## Notable Implementation Patterns
- `_notes_to_keys_and_phonemes()`: Handles rests (lyric="" → pau phoneme)
- `_calc_phoneme_lengths()`: Vowel consumes remainder of note after consonant
- `FrameAudioQuery`: Uses frame-level (not phoneme-level) F0/volume arrays
- `SongEngineManager`: Multi-version engine management with fallback
- Mock engine available for testing without GPU
