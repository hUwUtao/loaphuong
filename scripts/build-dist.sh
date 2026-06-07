#!/usr/bin/env bash
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DIST="/tmp/loaphuong-dist"
DIST_WIN="$DIST/win"
VER="0.1.0"
NAME="loaphuong-v$VER-win64"

echo "=== loaphuong dist builder ==="
echo "src: $SRC"
echo ""

# ── Check tools ──────────────────────────────────────────────
command -v bun >/dev/null 2>&1 || { echo "need bun"; exit 1; }
command -v zip  >/dev/null 2>&1 || { echo "need zip"; exit 1; }

# ── Clean ─────────────────────────────────────────────────────
rm -rf "$DIST"
mkdir -p "$DIST_WIN"

# ── Build backend ─────────────────────────────────────────────
echo ":: building loaphuong.exe ..."
cd "$SRC"
bun run build:win 2>&1 | tail -1
echo "   -> $SRC/loaphuong.exe"

# ── Build VST3 (optional, single-file format) ────────────────
VST3="$DIST_WIN/loaphuong.vst3"

if command -v cargo >/dev/null 2>&1 && rustup target list --installed 2>/dev/null | grep -q x86_64-pc-windows-gnu; then
	echo ":: building VST3 (cross x86_64-pc-windows-gnu) ..."
	cd "$SRC/loaphuong-mscore/vst3"
	if cargo build --package loaphuong --target x86_64-pc-windows-gnu --release --lib 2>&1; then
		if [ -f "target/x86_64-pc-windows-gnu/release/loaphuong.dll" ]; then
			cp "target/x86_64-pc-windows-gnu/release/loaphuong.dll" "$VST3"
			echo "   -> $VST3 ($(du -h "$VST3" | cut -f1))"
		else
			echo "   WARN: DLL not found after build, skipping VST3"
		fi
	else
		echo "   WARN: cargo build failed, skipping VST3"
	fi
else
	echo ":: VST3 cross-compiler not available, skipping"
fi

# ── QML plugin ────────────────────────────────────────────────
echo ":: copying QML plugin ..."
cp "$SRC/loaphuong-mscore/plugin/loaphuong.qml" "$DIST_WIN/"

# ── Backend binary ────────────────────────────────────────────
echo ":: copying backend ..."
cp "$SRC/loaphuong.exe" "$DIST_WIN/"

# ── Install script ────────────────────────────────────────────
echo ":: writing install.bat ..."
cat > "$DIST_WIN/install.bat" << 'INSTALL'
@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM --- Admin check (needed for system-wide VST3 install) ---
>nul 2>&1 net session || (
	echo This script needs admin rights to install VST3 to Program Files.
	echo Right-click install.bat and select "Run as administrator".
	pause
	exit /b 1
)

echo === loaphuong Windows Install ===
echo.

REM --- QML Plugin ---
echo [1/2] Installing QML plugin ...
set QML_DST=%USERPROFILE%\Documents\MuseScore4\Plugins\loaphuong\
if not exist "!QML_DST!" mkdir "!QML_DST!"
copy /y "loaphuong.qml" "!QML_DST!loaphuong.qml"
if errorlevel 1 echo ERROR: QML copy failed & pause & exit /b 1
echo    OK
echo.

REM --- VST3 Plugin (single-file format) ---
echo [2/2] Installing VST3 ...
if exist "loaphuong.vst3" (
	set VST3_DST=C:\Program Files\Common Files\VST3\loaphuong.vst3
	if exist "!VST3_DST!" del /f "!VST3_DST!"
	if not exist "C:\Program Files\Common Files\VST3" mkdir "C:\Program Files\Common Files\VST3"
	copy /y "loaphuong.vst3" "!VST3_DST!"
	if errorlevel 1 echo ERROR: VST3 copy failed & pause & exit /b 1
	echo    OK
) else (
	echo    VST3 not bundled, skipping
)
echo.

echo === Done! ===
echo.
echo Next steps:
echo   1. Place NEUTRINO/ folder next to loaphuong.exe ^(same dir as zip^)
echo   2. Run loaphuong.exe ^(starts backend on :3100^)
echo   3. In MuseScore: Plugins -^> Manage Plugins -^> enable loaphuong
echo   4. Plugins -^> loaphuong -^> Render
echo.
pause
INSTALL

# ── README ────────────────────────────────────────────────────
echo ":: writing README.txt ..."
cat > "$DIST_WIN/README.txt" << 'README'
loaphuong — Vietnamese SVS for MuseScore
=========================================
Version 0.1.0

Files:
  loaphuong.exe          Backend server (standalone, 64-bit)
  loaphuong.qml          MuseScore QML plugin
  loaphuong.vst3         VST3 audio plugin (single-file, renamed .dll)
  install.bat            One-click installer

Requirements:
  Windows 10+ (64-bit)
  NEUTRINO (free, download from studio-neutrino.com)
  MuseScore 4

Install:
  1. Run install.bat (requires admin for system-wide VST3 install)
  2. Download NEUTRINO and place NEUTRINO/ next to loaphuong.exe
     Expected: NEUTRINO/bin/neutrino.exe, NEUTRINO/model/<voices>/
  3. Run loaphuong.exe (starts server on http://127.0.0.1:3100)
  4. In MuseScore: Plugins → Manage Plugins → enable "loaphuong"
  5. Plugins → loaphuong → Render

Website: https://github.com/your-org/loaphuong
README

# ── ZIP ───────────────────────────────────────────────────────
echo ":: packing $NAME.zip ..."
cd "$DIST"
zip -r "$SRC/$NAME.zip" "win/" 2>&1 | tail -1
echo ""
echo "=== done: $SRC/$NAME.zip ==="
ls -lh "$SRC/$NAME.zip"
