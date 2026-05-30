# NEUTRINO Reverse Engineering Findings

Sources:
- `cdump-neutrino-linux.txt.xz` — Binary Ninja dump of Linux `neutrino` (125k lines)
- `linear-neutrino-server-win.txt` — Binary Ninja dump of Windows `neutrino_server.exe` (186k lines)
- `linear-neutrino-client-win.txt` — Binary Ninja dump of Windows `neutrino_client.exe` (5k lines)
- `NEUTRINOTyouseiSienTool.exe` — C# WPF GUI, decompiled via `ikdasm`/`monodis`

---

## 1. Linux neutrino CLI — Architecture

**Binary:** ELF 64-bit, linked against `libonnxruntime.so.1`, CUDA/cuDNN `.so` libs.

**Entry:** `main` at `0x0040be50`

### Execution Flow

```
main(argc, argv):
  if argc <= 6 → show usage, exit 1

  Params::initialize_params(argv)      -- set up Params struct
  Params::set_option(argc - 6, argv)   -- parse flag options

  trace_neutrino_information           -- -t flag prints version/info
  initialize_device                    -- GPU/CPU setup
  Generator::Generator                  -- LOAD ALL 4 ONNX MODELS

  --- TIMING PHASE (if not --skip-timing) ---
    PhraseData::load(full.lab)
    for each segment:
      Generator::infer_timing → float[]
    write_timing_label(timing.lab)

  --- ACOUSTIC PHASE (if not all skipped) ---
    PhraseData::load(full.lab)
    Params::initialize_acoustic_buffers
    for each segment:
      Generator::infer(flags)           -- ONNX inference
        → output.f0                     (if not --skip-f0)
        → output.melspec                (if not --skip-melspec)
        → output.wav                    (if not --skip-wav)

  trace_inference_speed
  Generator::~Generator                 -- unload models
```

### Params Struct Layout

| Offset | Field | Set by |
|--------|-------|--------|
| `0x340` | output_format_id | `-R` |
| `0x344` | sampling_rate | `-s` (default 48000) |
| `0x368` | bit_depth | `-b` (default 16) |
| `0x3f4` | use_best_gpu | `-m` |
| `0x3f5` | use_single_gpu | `-g` |
| `0x3f6` | skip_timing | `--skip-timing` |
| `0x3f7` | skip_f0 | `--skip-f0` |
| `0x3f8` | skip_melspec | `--skip-melspec` |
| `0x3f9` | skip_wav | `--skip-wav` |
| `0x3fa` | has_support_model | `-S <dir>` |
| `0x3fb` | support_enabled | |
| `0x3fc` | support_gpu_id | |
| `0x400` | num_threads | `-n` (default max) |
| `0x404` | single_phrase_mode | `-p N` / `-i <file>` |
| `0x408` | phrase_number/offset | |
| `0x40c` | style_shift | `-k` (default 0) |
| `0x410` | transpose | `-f` (default 0) |
| `0x414` | extra_rate | `-r` |

### CLI Usage

```
neutrino full.lab timing.lab output.f0 output.melspec output.wav model/dir [options]
  -n i    : threads [max]
  -s i    : sample rate [48000]
  -b i    : bit depth [16]
  -k i    : style shift key [0]
  -f i    : transpose key [0]
  -S name : support model dir [off]
  -p i    : single phrase [off]
  -g i    : use GPU #i [off]
  -m      : use best GPU [off]
  -i file : phrase list file [off]
  -t      : verbose timing info [off]
  -h      : help [off]
  -c name : codec format ("wav" default)
  --skip-timing   : skip timing prediction
  --skip-f0       : skip pitch prediction
  --skip-melspec  : skip melspec prediction
  --skip-wav      : skip waveform prediction
```

### Model Files (loaded by Generator::Generator)

Located in `model/<Name>/`:
- `info.toml` — metadata (version, speaker, top_key, bottom_key, timing/pitch/melspec/vocoder configs)
- `t.bin` — timing ONNX model
- `p.bin` — pitch/f0 ONNX model
- `s.bin` — acoustic/melspec ONNX model
- `v.bin` — vocoder/waveform ONNX model

Support model dir: same structure, loaded via `-S <dir>`. Parses `info.toml` `[speaker]` section for `support`, `name`, `top_key`, `bottom_key`.

---

## 2. Windows neutrino_server.exe — Protocol

**Binary:** PE, same inference pipeline as Linux CLI + TCP server wrapper.

**Server entry:** `sub_14000eee0` (called from `main` when `argc == 1`)

### Server Loop

```
sub_14000eee0():
  WSAStartup(0x202)
  s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP=6)
  bind(s, port 0x3039=12345)           ← HARDCODED PORT
  listen(s, backlog=0x7FFFFFFF)
  print "neutrino server is running on port 12345"

  while (true):
    s_1 = accept(s, NULL, NULL)
    getpeername(s_1) → inet_ntop()

    if peer != "127.0.0.1":             ← IP RESTRICTION: LOOPBACK ONLY
      print "unauthorized access attempt from: " + peer
      closesocket(s_1); continue

    recv(s_1, buf, 8192, 0)            ← 8KB max receive
    if buf is empty:
      print "Error: received an empty command."
      closesocket(s_1); continue

    switch command:
      "shutdown" → exit(0)
      "help"     → send help text
      default    → sub_14000c6b0()     ← run inference

    closesocket(s_1)
```

### Command Parsing (sub_14000c6b0)

Tokenizes command string using regex: `("[^"]*"|\S+)`
→ Respects double-quoted strings with spaces

Parsed tokens populate the same `Params` struct as the CLI:
Token positions 0-5 are positional args: `full.lab timing.lab f0 melspec wav model_dir`
Token 6+ are flags: `-n 4 -s 48000 -f 0 -m -t` etc.

### Response

After inference, server sends response text via `send()`:
- `progress = <value>` — progress percentage during inference
- Path info: `full label path: <path>`, `timing label path: <path>`, etc.
- Status: `    start inference` / `    inference completed.`
- Timing: `inference speed` with elapsed time

---

## 3. Windows neutrino_client.exe — Protocol

**Binary:** Pure TCP client (C++, no inference code). 5k lines decompiled.

### Client Logic

```
main(argc, argv):
  if argc < 2 → print "Usage: <cmd>"; return 1

  WSAStartup(0x202)
  s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP=6)
  connect(s, "127.0.0.1", 12345)         ← HARDCODED IP + PORT

  // Build command string from argv[1..]
  buf = ""
  for i = 1 to argc-1:
    if strchr(argv[i], ' '):              // arg contains spaces?
      buf += '"' + argv[i] + '"'          // quote-wrap
    else:
      buf += argv[i]
    if i < argc-1:
      buf += ' '                          // space separator

  send(s, buf, len(buf), 0)               // one-shot TCP message
  while (count = recv(s, recv_buf, 8192, 0)) > 0:
    cout.write(recv_buf, count)           // stream response to stdout

  if count == 0:  print "Server closed the connection."
  if count == -1: print "Recv failed: " + WSAGetLastError()

  closesocket(s)
  WSACleanup()
```

### Protocol Summary

```
Client                          Server
  │                               │
  │── TCP connect :12345 ────────►│
  │── send(argv[1..]) ──────────►│  ← raw string (CLI args)
  │                               │
  │◄── recv() stream ────────────│  ← progress text
  │◄── recv() stream ────────────│
  │◄── ... ──────────────────────│
  │◄── connection close ─────────│  ← inference complete
```

**No framing, no serialization.** The client literally concatenates CLI arguments into a space-separated string and sends it over TCP. The server tokenizes it back with a regex.

---

## 4. TyouseiSienTool GUI — Command Construction

**Platform:** C# WPF .NET Framework v4.x

**Key class:** `NeutrinoWrapper.GetProcessStartInfo(string command, NeutrinoSettings, NeutrinoArguments, FilePathGroup)`

### Template Engine

Command templates from XML config (`NEUTRINOTyouseiSienTool.xml`):

```xml
<MusicXMLtoLabelExecutionCommand>
  bin\musicXMLtoLabel.exe $MusicXml $FullLabel $MonoLabel
</MusicXMLtoLabelExecutionCommand>
<NeutrinoExecutionCommand>
  bin\neutrino_client.exe $FullLabel $TimingLabel $F0 $MelSpec $Wave
  model\$ModelDir\ ExportPhraseList(-i $PhraseList) SkipTiming(--skip-timing)
  SkipF0(--skip-f0) SkipMelSpec(--skip-melspec) SkipWav(--skip-wav)
  SinglePhrase(-p $PhraseNum) -f $Transpose -n $NumThreads UseGpu(-m) -t
</NeutrinoExecutionCommand>
```

### Substitution Rules

1. **Variable substitution** (`$Name` → value):
   - `$MusicXml`, `$FullLabel`, `$MonoLabel`, `$TimingLabel`: quoted file paths
   - `$F0`, `$MelSpec`, `$Wave`: quoted output paths
   - `$PhraseList`: quoted phrase file path
   - `$ModelDir`: model directory name
   - `$PhraseNum`, `$Transpose`, `$NumThreads`: integer values

2. **Conditional sections** (regex: `(^|\s)(\w+?)\(.*?\)`):
   - `ExportPhraseList(-i $PhraseList)` → removed if `ExportPhraseList == false`
   - `SkipTiming(--skip-timing)` → removed if false, added `--skip-timing` if true
   - `UseGpu(-m)` → removed if false, added `-m` if true
   - `SinglePhrase(-p $PhraseNum)` → removed if `SinglePhrasePrediction == -1`

### NeutrinoArguments Properties

| Property | Type | Default |
|----------|------|---------|
| `ModelDir` | string | user-selected model |
| `Transpose` | int | 0 |
| `ExportPhraseList` | bool | false |
| `SkipTimingPrediction` | bool | false |
| `SkipF0Prediction` | bool | false |
| `SkipMelSpecPrediction` | bool | false |
| `SkipWavPrediction` | bool | false |
| `SinglePhrasePrediction` | int | -1 (disabled) |

### NeutrinoSettings Properties

| Property | Type |
|----------|------|
| `NeutrinoFolderPath` | string |
| `UseGpu` | bool |
| `GpuId` | int |
| `NumThreads` | int |
| `MusicXMLtoLabelExecutionCommand` | string (template) |
| `NeutrinoExecutionCommand` | string (template) |

### Process Flow (ProcessRunWindow)

1. Run `musicXMLtoLabel.exe $MusicXml $FullLabel $MonoLabel` — converts MusicXML to HTK labels
2. Run `neutrino_client.exe` with substituted command — sends to `neutrino_server.exe`

Both run as async processes with stdout/stderr capture, progress reporting, and cancellation.

---

## 5. Key Architectural Insights

### What's Shared

Linux `neutrino`, Windows `neutrino.exe`, and Windows `neutrino_server.exe` all share the **same core inference code**:
- `Params` struct and parsing
- `Generator` class (model loading, ONNX inference)
- `PhraseData` class (label parsing, segment extraction)
- Output writing (timing lab, f0, melspec, wav)

### What's Different

| Aspect | Linux CLI | Windows CLI | Windows Server | Windows Client |
|--------|-----------|-------------|----------------|----------------|
| Entry | `main` | `main` | `sub_14000eee0` loop | `main` |
| Args | `argv` | `argv` | TCP recv → regex tokenize | `argv` joined |
| Output | stdout/stderr | stdout/stderr | `send()` to socket | recv → stdout |
| Lifespan | one-shot | one-shot | infinite loop | one-shot |
| Restriction | none | none | 127.0.0.1 only | hardcoded 127.0.0.1 |

### Implications for Our Linux Backend

- The Linux `neutrino` has **no server mode** — we must manage it as subprocess
- Cold start per request is ~1-2s for ONNX model loading
- We could implement our own keep-warm server using Bun's subprocess pool
- The `neutrino` CLI output (stdout) contains the same progress info as the Windows server's TCP response
- `timing.lab` is an **output** of neutrino (2nd positional arg), not an input
