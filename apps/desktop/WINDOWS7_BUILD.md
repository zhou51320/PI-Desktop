# Windows 7 Desktop Build

This document describes the supported Windows 7 package path for PI-Desktop. It builds PI-Desktop from the current source tree and packages it with a verified prebuilt Windows 7-compatible Electron runtime while retaining PI-Desktop's original brand application icon.

## Runtime

Use the `e3kskoy7wqk/Electron-for-windows-7` release asset:

- Release: `v40.2.0`
- Asset: `dist.zip`
- URL: `https://github.com/e3kskoy7wqk/Electron-for-windows-7/releases/download/v40.2.0/dist.zip`
- SHA-256: `ed4ebb022624ae38f764fcfc1dc1ce30fe2145298975d4c90e8d95412deeadea`

The extracted archive is a standard Electron distribution directory containing `electron.exe`, `ffmpeg.dll`, `version`, `locales/`, and other runtime files patched for Windows 7 (lowered PE OS/subsystem version 5.2 and removed Windows 8/10-only API imports).

## Icon Preservation

Packaged executables on Windows 7 retain PI-Desktop's original brand icon:
1. `apps/desktop/build/icon.ico` is generated from the canonical brand artwork `apps/desktop/build/icon_1024.png` across standard Windows icon sizes (16, 24, 32, 48, 64, 128, 256).
2. Because Electron Builder's executable editing and signing is disabled (`signAndEditExecutable: false`) to avoid corrupting the patched PE headers, the packager (`scripts/package-win7.mjs`) directly patches the PE icon group resources in `dist/win7/win-unpacked/PI-Desktop.exe` using `resedit`.
3. The packaging pipeline automatically verifies that all icon item hashes in `PI-Desktop.exe` match `apps/desktop/build/icon.ico` bit-for-bit.

## CI Build

The GitHub Actions workflow is:

```text
.github/workflows/win7-desktop-prebuilt.yml
```

On push or manual dispatch (`workflow_dispatch`), it:

1. Checks out the PI-Desktop source repository.
2. Sets up Node.js 22 and pnpm.
3. Installs dependencies (`pnpm install --frozen-lockfile`).
4. Downloads and verifies the Win7 Electron runtime release archive (`dist.zip`) against its SHA-256 checksum.
5. Builds Win7 desktop assets via `pnpm run build:win7`.
6. Packages the Win7 desktop build with `PI_DESKTOP_ELECTRON_DIST`.
7. Generates PE and runtime provenance reports (`prebuilt-runtime.md` and `prebuilt-runtime-comparison.md`).
8. Uploads `pi-desktop-win7-prebuilt-electron` artifact.

## Local Build

### 1. Download & Extract the Prebuilt Runtime

```bash
mkdir -p /tmp/electron-win7
curl -L -o /tmp/electron-win7.zip "https://github.com/e3kskoy7wqk/Electron-for-windows-7/releases/download/v40.2.0/dist.zip"
echo "ed4ebb022624ae38f764fcfc1dc1ce30fe2145298975d4c90e8d95412deeadea  /tmp/electron-win7.zip" | sha256sum --check -
unzip -q /tmp/electron-win7.zip -d /tmp/electron-win7
```

### 2. Build & Package

From the repository root:

```bash
# Build desktop assets
pnpm run build:win7

# Option A: Package Win7 unpacked portable folder
PI_DESKTOP_ELECTRON_DIST=/tmp/electron-win7 pnpm run package:win7

# Option B: Package Win7 NSIS installer (.exe installer wizard)
PI_DESKTOP_ELECTRON_DIST=/tmp/electron-win7 pnpm run package:win7:nsis

# Option C: Package both portable folder and NSIS installer
PI_DESKTOP_WIN7_TARGET=both PI_DESKTOP_ELECTRON_DIST=/tmp/electron-win7 pnpm run package:win7
```

Outputs are generated in `apps/desktop/dist/win7`:
- Portable folder: `apps/desktop/dist/win7/win-unpacked/`
- NSIS installer: `apps/desktop/dist/win7/PI-Desktop-win7-Setup-<version>-x64.exe`

### 3. NSIS Installer Architecture & Wine-Free Extraction

Electron-builder usually invokes Wine on Linux to extract the uninstaller binary from the NSIS setup executable. In this workflow:
- The `afterPack` hook injects the multi-resolution PI-Desktop brand icon into `PI-Desktop.exe` before NSIS compression, guaranteeing both the installed app and the installer itself display the PI-Desktop icon.
- A built-in pure JavaScript binary uninstaller extractor (`UninstallerReader`) is enabled automatically on Linux/macOS, completely eliminating the need for Wine or Windows emulation during packaging.

### 4. Runtime Provenance Inspection

To inspect the packaged binary or compare against the upstream distribution:

```bash
# Generate report for runtime
pnpm --filter @pi-desktop/desktop run report:win7-runtime /tmp/electron-win7 --out dist/win7/prebuilt-runtime

# Compare packaged build against upstream runtime
pnpm --filter @pi-desktop/desktop run report:win7-runtime apps/desktop/dist/win7/win-unpacked --compare /tmp/electron-win7 --out dist/win7/prebuilt-runtime-comparison
```

This verifies that PE OS/subsystem versions remain 5.2, verifies required DLLs (`ffmpeg.dll`, `libEGL.dll`, `libGLESv2.dll`), and reports any risky imports.

### 5. Backend Host Core Service (`host-core`)

PI-Desktop requires the native Rust backend service `pi-desktop-host-core.exe` located at `<resources>/bin/pi-desktop-host-core.exe`:
- **Role**: Manages local SQLite storage, session persistence, settings, and workspace data.
- **Compilation**: Built with MSVC on Windows (`cargo build --release -p host-core`) or via the GitHub Actions Windows runner (`.github/workflows/win7-desktop-prebuilt.yml`).
- If missing, the app will report `HOST_UNAVAILABLE` on startup.

### 6. Using Electron's Node.js in Windows 7 System Environment

PI-Desktop packages a wrapper script `node.cmd` inside the application directory (`win-unpacked` or installation directory):
```cmd
@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0PI-Desktop.exe" %*
```
Adding the installation directory to Windows 7 `PATH` enables running `node -v` or any Node.js CLI script directly using Electron's embedded Node runtime without needing an external Node.js installation.
