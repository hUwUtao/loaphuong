# NEUTRINO SVS Architecture Research

## Overview
NEUTRINO (by STUDIO NEUTRINO / SHACHI) is a singing voice synthesis (SVS) system
for Japanese, using deep learning models. Version Muon v3.x series (2026).

## Distribution Channels
1. **Windows** — standalone GUI app (Electron wrapper)
2. **macOS** — standalone GUI
3. **Online** — Google Colab notebook (Ubuntu/Linux)
   - Colab URL: studio-neutrino.com/561/
   - Contains: musicXMLtoLabel (Sinsy), N.Engine (CUDA binary), voice models
   - Folder structure: `NEUTRINO/score/`, `NEUTRINO/model/`, `NEUTRINO/output/`
4. **Linux** — manual install from online bundle
   - Requires: Ubuntu 20.04+, gcc, NVIDIA GPU, CUDA 12.3+
   - Entry: `Run.sh`

## Pipeline (from Colab notebook analysis)
```
MusicXML (score/musicxml) 
    → musicXMLtoLabel (Sinsy-based) 
    → .lab file (HTK-style phoneme timing) 
    → N.Engine (CUDA binary, runs on GPU) 
    → output.wav
```

## Components
- **N.Engine**: Core inference binary. Takes .lab + voice model → .wav
- **musicXMLtoLabel**: Converts MusicXML to Sinsy/HTK-style full-context .lab
- **Voice Models**: Per-character ONNX/CUDA models (~1-5GB each)
  - Characters: Merrow, Reina, NAKUMO, Soma, Runo, Kotonoha Akane/Aoi,
    Yogatari Tobari, Tohoku Itako/Zunko/Kiritan, Zundamon, Shikoku Metan,
    Oedo Chanko, No.7, Yoko, JSUT

## Key Insight for LOAPHUONG
NEUTRINO has NO REST API — it's a GUI or Colab notebook. The core binary
(N.Engine) is CLI-only. Our wrapper provides the REST API that NEUTRINO lacks,
using cephome for the MusicXML→LAB (Vietnamese phoneme) step.

## LAB File Format (HTK/Sinsy style)
```
start_ns end_ns phoneme_context
```
Full-context format includes positional/linguistic features separated by
slashes (/A:, /B:, /E:, etc).

## Input/Output Contract
- Input: .lab file (phoneme timing with context features)
- Output: .wav file (48kHz, mono, float32)
- GPU Memory: ~4-8GB for synthesis
- Speed: ~5-10s per phrase on GPU, ~60s on CPU
