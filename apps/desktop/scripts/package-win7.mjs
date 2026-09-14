#!/usr/bin/env node
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { readdirSync, statSync } from "node:fs"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const electronVersion =
  process.env.PI_DESKTOP_ELECTRON_VERSION ??
  process.env.OPENCODE_ELECTRON_VERSION ??
  "40.2.0"

const rawDist =
  process.env.PI_DESKTOP_ELECTRON_DIST ?? process.env.OPENCODE_ELECTRON_DIST

const electronDist = rawDist ? normalizeElectronDist(rawDist) : undefined

const isNsis =
  process.argv.includes("--nsis") || process.env.PI_DESKTOP_WIN7_TARGET === "nsis"
const isBoth =
  process.argv.includes("--both") || process.env.PI_DESKTOP_WIN7_TARGET === "both"
const target = isBoth ? "both" : isNsis ? "nsis" : "dir"

const patchScript = path.resolve(desktopDir, "scripts/electron-builder-nsis-patch.cjs")
const existingNodeOptions = process.env.NODE_OPTIONS ?? ""
const nodeOptions = existingNodeOptions
  ? `--require "${patchScript}" ${existingNodeOptions}`
  : `--require "${patchScript}"`

const env = {
  ...process.env,
  NODE_OPTIONS: nodeOptions,
  PI_DESKTOP_WIN7: "1",
  PI_DESKTOP_ELECTRON_VERSION: electronVersion,
  PI_DESKTOP_WIN7_TARGET: target,
  ...(electronDist ? { PI_DESKTOP_ELECTRON_DIST: electronDist } : {}),
}

if (!electronDist) {
  console.warn(
    "PI_DESKTOP_ELECTRON_DIST is not set; packaging with official Electron, not a Win7-patched runtime.",
  )
}

console.log(
  `Packaging experimental Win7 desktop build (target: ${target}) with Electron ${electronVersion}`,
)
if (electronDist) {
  console.log(`Using Electron dist: ${electronDist}`)
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      ...options,
      stdio: "inherit",
      shell: true,
    })
    proc.on("error", reject)
    proc.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Command ${command} ${args.join(" ")} exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

try {
  const builderArgs = ["exec", "electron-builder", "--x64"]
  if (target === "dir") {
    builderArgs.push("--win", "--dir")
  } else if (target === "nsis") {
    builderArgs.push("--win", "nsis")
  } else if (target === "both") {
    builderArgs.push("--win", "nsis", "--dir")
  }
  builderArgs.push("--config", "electron-builder.config.ts")

  await runCommand("pnpm", builderArgs, { cwd: desktopDir, env })

  await applyPiDesktopIcon()
  await verifyWin7Package(target)
  console.log("Win7 packaging completed successfully!")
  process.exit(0)
} catch (error) {
  console.error("Packaging failed:", error)
  process.exit(1)
}

function normalizeElectronDist(input) {
  const dir = path.resolve(input)
  if (!existsSync(path.join(dir, "version"))) {
    throw new Error(`Electron dist is missing version file: ${dir}`)
  }
  if (existsSync(path.join(dir, "electron.exe"))) {
    return dir
  }
  if (
    !existsSync(path.join(dir, "PI-Desktop.exe")) &&
    !existsSync(path.join(dir, "OpenCode.exe"))
  ) {
    throw new Error(
      `Electron dist must contain electron.exe, PI-Desktop.exe, or OpenCode.exe: ${dir}`,
    )
  }

  const staged = mkdtempSync(path.join(tmpdir(), "pi-desktop-win7-electron-"))
  cpSync(dir, staged, { recursive: true })
  const sourceExe = existsSync(path.join(staged, "PI-Desktop.exe"))
    ? path.join(staged, "PI-Desktop.exe")
    : path.join(staged, "OpenCode.exe")
  renameSync(sourceExe, path.join(staged, "electron.exe"))
  return staged
}

async function applyPiDesktopIcon() {
  const { Data, NtExecutable, NtExecutableResource, Resource } = await import(
    "resedit"
  )
  const exe = path.resolve(desktopDir, "dist/win7/win-unpacked/PI-Desktop.exe")
  const icon = path.resolve(desktopDir, "build/icon.ico")

  if (!existsSync(exe)) {
    throw new Error(`Win7 executable not found: ${exe}`)
  }
  if (!existsSync(icon)) {
    throw new Error(`Win7 icon file not found: ${icon}`)
  }

  const parsed = NtExecutable.from(readFileSync(exe), { ignoreCert: true })
  const resources = NtExecutableResource.from(parsed)
  const icons = Data.IconFile.from(readFileSync(icon)).icons.map(
    (item) => item.data,
  )
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
  if (!groups.length) {
    throw new Error(`Win7 icon patch failed; no icon group found in ${exe}`)
  }

  for (const group of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      group.id,
      group.lang,
      icons,
    )
  }

  resources.outputResource(parsed)
  writeFileSync(exe, Buffer.from(parsed.generate()))
  console.log(`Applied PI-Desktop icon to ${exe}`)
}

async function verifyAppIcon(exe, icon) {
  const { Data, NtExecutable, NtExecutableResource, Resource } = await import(
    "resedit"
  )
  const resources = NtExecutableResource.from(
    NtExecutable.from(readFileSync(exe), { ignoreCert: true }),
  )
  const expected = Data.IconFile.from(readFileSync(icon))
    .icons.map((item) => iconHash(item.data))
    .sort()
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries)

  if (expected.length === 0) {
    throw new Error(
      `Win7 package verification failed; icon file has no entries: ${icon}`,
    )
  }
  if (groups.length === 0) {
    throw new Error(
      "Win7 package verification failed; PI-Desktop.exe has no icon group resources",
    )
  }

  for (const group of groups) {
    const actual = group
      .getIconItemsFromEntries(resources.entries)
      .map(iconHash)
      .sort()
    if (expected.join(",") !== actual.join(",")) {
      throw new Error(
        "Win7 package verification failed; PI-Desktop.exe icon resources do not match build/icon.ico",
      )
    }
  }
}

function iconHash(icon) {
  return createHash("sha256")
    .update(new Uint8Array(icon.isRaw() ? icon.bin : icon.generate()))
    .digest("hex")
}

async function verifyWin7Package(target = "dir") {
  const unpacked = path.resolve(desktopDir, "dist/win7/win-unpacked")
  const exe = path.join(unpacked, "PI-Desktop.exe")
  const required = [
    exe,
    path.join(unpacked, "resources/app.asar"),
    path.join(unpacked, "libEGL.dll"),
    path.join(unpacked, "libGLESv2.dll"),
    path.join(unpacked, "ffmpeg.dll"),
    path.join(unpacked, "version"),
  ]

  for (const file of required) {
    if (!existsSync(file)) {
      throw new Error(
        `Win7 package verification failed; missing required runtime file: ${file}`,
      )
    }
  }

  if (electronDist) {
    const header = await readPeVersions(exe)
    if (header.os !== "5.2" || header.subsystem !== "5.2") {
      throw new Error(
        `Win7 package verification failed; PI-Desktop.exe is PE os=${header.os} subsystem=${header.subsystem}`,
      )
    }

    const imports = await readPeImports(exe)
    for (const item of [
      "GetSystemTimePreciseAsFileTime",
      "CreateFile2",
      "CreatePseudoConsole",
    ]) {
      if (imports.functions.has(item)) {
        throw new Error(
          `Win7 package verification failed; PI-Desktop.exe imports ${item}`,
        )
      }
    }
    for (const item of imports.dlls) {
      if (item.toLowerCase().startsWith("api-ms-win-core-winrt-error")) {
        throw new Error(
          `Win7 package verification failed; PI-Desktop.exe imports ${item}`,
        )
      }
    }
  }

  const iconPath = path.resolve(desktopDir, "build/icon.ico")
  await verifyAppIcon(exe, iconPath)

  if (target === "nsis" || target === "both") {
    const distWin7 = path.resolve(desktopDir, "dist/win7")
    const installerCandidates = existsSync(distWin7)
      ? readdirSync(distWin7).filter(
          (f) =>
            f.endsWith(".exe") &&
            !f.includes("__uninstaller") &&
            (f.startsWith("PI-Desktop-win7-Setup") || f.startsWith("PI-Desktop-Setup")),
        )
      : []

    if (installerCandidates.length === 0) {
      throw new Error(
        "Win7 package verification failed; no NSIS installer (.exe) found in dist/win7",
      )
    }

    for (const installerName of installerCandidates) {
      const installerPath = path.join(distWin7, installerName)
      const stats = statSync(installerPath)
      if (stats.size < 10 * 1024 * 1024) {
        throw new Error(
          `Win7 package verification failed; installer is suspiciously small (${stats.size} bytes): ${installerPath}`,
        )
      }
      await verifyAppIcon(installerPath, iconPath)
      const sizeMb = (stats.size / (1024 * 1024)).toFixed(1)
      console.log(
        `Verified Win7 NSIS installer: ${installerName} (${sizeMb} MB) with brand icon`,
      )
    }
  }

  console.log("Verified Win7 package outputs and Win7 runtime compatibility")
}

async function readPeVersions(file) {
  const buffer = readFileSync(file)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const peOffset = view.getUint32(0x3c, true)
  const optionalHeader = peOffset + 24
  return {
    os: `${view.getUint16(optionalHeader + 40, true)}.${view.getUint16(optionalHeader + 42, true)}`,
    subsystem: `${view.getUint16(optionalHeader + 48, true)}.${view.getUint16(optionalHeader + 50, true)}`,
  }
}

async function readPeImports(file) {
  const buffer = readFileSync(file)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const peOffset = view.getUint32(0x3c, true)
  const sections = view.getUint16(peOffset + 6, true)
  const optionalHeader = peOffset + 24
  const optionalHeaderSize = view.getUint16(peOffset + 20, true)
  const magic = view.getUint16(optionalHeader, true)
  const dataDirectories = optionalHeader + (magic === 0x20b ? 112 : 96)
  const importRva = view.getUint32(dataDirectories + 8, true)
  const sectionTable = optionalHeader + optionalHeaderSize
  const dlls = new Set()
  const functions = new Set()

  if (importRva === 0) return { dlls, functions }

  const rvaToOffset = (rva) => {
    for (let i = 0; i < sections; i++) {
      const section = sectionTable + i * 40
      const virtualSize = view.getUint32(section + 8, true)
      const virtualAddress = view.getUint32(section + 12, true)
      const rawSize = view.getUint32(section + 16, true)
      const rawPointer = view.getUint32(section + 20, true)
      const size = Math.max(virtualSize, rawSize)
      if (rva >= virtualAddress && rva < virtualAddress + size) {
        return rawPointer + (rva - virtualAddress)
      }
    }
    throw new Error(`RVA 0x${rva.toString(16)} is outside PE sections`)
  }

  const readString = (offset) => {
    const bytes = []
    for (let i = offset; i < view.byteLength; i++) {
      const byte = view.getUint8(i)
      if (byte === 0) break
      bytes.push(byte)
    }
    return new TextDecoder("ascii").decode(new Uint8Array(bytes))
  }

  for (
    let descriptor = rvaToOffset(importRva);
    descriptor + 20 <= view.byteLength;
    descriptor += 20
  ) {
    const originalFirstThunk = view.getUint32(descriptor, true)
    const nameRva = view.getUint32(descriptor + 12, true)
    const firstThunk = view.getUint32(descriptor + 16, true)
    if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break

    dlls.add(readString(rvaToOffset(nameRva)))
    const thunkOffset = rvaToOffset(originalFirstThunk || firstThunk)
    for (
      let thunk = thunkOffset;
      thunk + 8 <= view.byteLength;
      thunk += 8
    ) {
      const value =
        magic === 0x20b
          ? view.getBigUint64(thunk, true)
          : BigInt(view.getUint32(thunk, true))
      if (value === 0n) break
      const ordinalFlag =
        magic === 0x20b ? 0x8000000000000000n : 0x80000000n
      if ((value & ordinalFlag) !== 0n) continue
      functions.add(readString(rvaToOffset(Number(value)) + 2))
    }
  }

  return { dlls, functions }
}
