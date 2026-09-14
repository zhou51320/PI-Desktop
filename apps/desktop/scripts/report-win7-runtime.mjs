#!/usr/bin/env node
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

const riskyFunctions = new Set([
  "AdjustWindowRectExForDpi",
  "CreateFile2",
  "CreatePseudoConsole",
  "DiscardVirtualMemory",
  "GetDpiForWindow",
  "GetSystemTimePreciseAsFileTime",
  "GetThreadDescription",
  "PrefetchVirtualMemory",
  "SetThreadDescription",
])

const args = parseArgs()
const primary = await inspectRuntime(args.input)
const comparison = args.compare ? await inspectRuntime(args.compare) : undefined
const report = {
  generated_at: new Date().toISOString(),
  primary,
  comparison,
  differences: comparison ? compareRuntimes(primary, comparison) : undefined,
}

mkdirSync(path.dirname(args.out), { recursive: true })
writeFileSync(`${args.out}.json`, `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(`${args.out}.md`, renderMarkdown(report))

console.log(`Wrote ${args.out}.json`)
console.log(`Wrote ${args.out}.md`)

function parseArgs() {
  const raw = process.argv.slice(2)
  const inputArg = raw.find((item) => !item.startsWith("--"))
  const compareIndex = raw.indexOf("--compare")
  const outIndex = raw.indexOf("--out")
  const input = path.resolve(
    inputArg ??
      process.env.PI_DESKTOP_ELECTRON_DIST ??
      process.env.OPENCODE_ELECTRON_DIST ??
      "dist/win7/win-unpacked",
  )
  const compare = compareIndex >= 0 ? raw[compareIndex + 1] : undefined
  const out = path.resolve(
    outIndex >= 0 ? raw[outIndex + 1] : "dist/win7/runtime-provenance",
  )

  if (!existsSync(input)) throw new Error(`Runtime directory not found: ${input}`)
  if (compareIndex >= 0 && !compare) throw new Error("--compare requires a directory")
  if (outIndex >= 0 && !raw[outIndex + 1]) throw new Error("--out requires a path without extension")

  return {
    input,
    compare: compare ? path.resolve(compare) : undefined,
    out,
  }
}

async function inspectRuntime(dir) {
  const executable = findExecutable(dir)
  const versionFile = path.join(dir, "version")
  const files = await Promise.all(
    runtimeFiles(dir).map((file) => inspectFile(file, dir)),
  )

  return {
    path: dir,
    version: existsSync(versionFile)
      ? readFileSync(versionFile, "utf8").trim()
      : null,
    executable: path.relative(dir, executable),
    files,
    summary: summarizeFiles(files),
  }
}

function findExecutable(dir) {
  for (const name of ["electron.exe", "PI-Desktop.exe", "OpenCode.exe"]) {
    const file = path.join(dir, name)
    if (existsSync(file)) return file
  }
  throw new Error(
    `Runtime directory must contain electron.exe, PI-Desktop.exe, or OpenCode.exe: ${dir}`,
  )
}

function runtimeFiles(dir) {
  const known = [
    "electron.exe",
    "PI-Desktop.exe",
    "OpenCode.exe",
    "chrome_elf.dll",
    "d3dcompiler_47.dll",
    "dxcompiler.dll",
    "dxil.dll",
    "ffmpeg.dll",
    "libEGL.dll",
    "libGLESv2.dll",
    "vk_swiftshader.dll",
    "vulkan-1.dll",
    "resources/app.asar",
  ]
  const topLevel = readdirSync(dir)
    .filter((name) => name.endsWith(".exe") || name.endsWith(".dll"))
    .map((name) => path.join(dir, name))
  const files = known
    .map((name) => path.join(dir, name))
    .filter((file) => existsSync(file))
  return Array.from(new Set([...files, ...topLevel]))
    .filter((file) => statSync(file).isFile())
    .sort()
}

async function inspectFile(file, root) {
  const bytes = readFileSync(file)
  const pe = isPe(bytes) ? readPe(bytes) : null
  return {
    path: path.relative(root, file).replaceAll(path.sep, "/"),
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    pe,
    risks: pe ? detectRisks(pe) : [],
  }
}

function summarizeFiles(files) {
  const peFiles = files.filter((file) => file.pe)
  return {
    file_count: files.length,
    pe_file_count: peFiles.length,
    lowered_pe_files: peFiles
      .filter((file) => file.pe?.os === "5.2" && file.pe.subsystem === "5.2")
      .map((file) => file.path),
    risk_files: peFiles
      .filter((file) => file.risks.length > 0)
      .map((file) => ({
        path: file.path,
        risks: file.risks,
      })),
  }
}

function isPe(bytes) {
  if (bytes.length < 0x40) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const peOffset = view.getUint32(0x3c, true)
  if (peOffset + 4 >= bytes.length) return false
  return view.getUint8(peOffset) === 0x50 && view.getUint8(peOffset + 1) === 0x45
}

function readPe(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
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

  if (importRva !== 0) {
    for (
      let descriptor = rvaToOffset(view, sectionTable, sections, importRva);
      descriptor + 20 <= view.byteLength;
      descriptor += 20
    ) {
      const originalFirstThunk = view.getUint32(descriptor, true)
      const nameRva = view.getUint32(descriptor + 12, true)
      const firstThunk = view.getUint32(descriptor + 16, true)
      if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break

      dlls.add(readString(view, rvaToOffset(view, sectionTable, sections, nameRva)))
      const thunkOffset = rvaToOffset(
        view,
        sectionTable,
        sections,
        originalFirstThunk || firstThunk,
      )
      for (
        let thunk = thunkOffset;
        thunk + (magic === 0x20b ? 8 : 4) <= view.byteLength;
        thunk += magic === 0x20b ? 8 : 4
      ) {
        const value =
          magic === 0x20b
            ? view.getBigUint64(thunk, true)
            : BigInt(view.getUint32(thunk, true))
        if (value === 0n) break
        const ordinalFlag =
          magic === 0x20b ? 0x8000000000000000n : 0x80000000n
        if ((value & ordinalFlag) !== 0n) continue
        functions.add(
          readString(view, rvaToOffset(view, sectionTable, sections, Number(value)) + 2),
        )
      }
    }
  }

  return {
    machine: `0x${view.getUint16(peOffset + 4, true).toString(16)}`,
    os: `${view.getUint16(optionalHeader + 40, true)}.${view.getUint16(optionalHeader + 42, true)}`,
    subsystem: `${view.getUint16(optionalHeader + 48, true)}.${view.getUint16(optionalHeader + 50, true)}`,
    import_dlls: Array.from(dlls).sort(),
    risky_imports: Array.from(functions)
      .filter((name) => riskyFunctions.has(name))
      .sort(),
    api_set_imports: Array.from(dlls)
      .filter((name) => name.toLowerCase().startsWith("api-ms-"))
      .sort(),
  }
}

function rvaToOffset(view, sectionTable, sections, rva) {
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

function readString(view, offset) {
  const bytes = []
  for (let i = offset; i < view.byteLength; i++) {
    const byte = view.getUint8(i)
    if (byte === 0) break
    bytes.push(byte)
  }
  return new TextDecoder("ascii").decode(new Uint8Array(bytes))
}

function detectRisks(pe) {
  return [
    ...pe.risky_imports.map((name) => `imports ${name}`),
    ...pe.api_set_imports.map((name) => `imports ${name}`),
  ]
}

function compareRuntimes(primary, comparison) {
  const compared = primary.files.flatMap((file) => {
    const other = comparison.files.find((item) => item.path === file.path)
    if (!other) {
      return [
        {
          path: file.path,
          status: "missing_in_comparison",
        },
      ]
    }
    return [
      {
        path: file.path,
        status: file.sha256 === other.sha256 ? "same" : "different",
        primary_sha256: file.sha256,
        comparison_sha256: other.sha256,
        primary_pe: file.pe
          ? { os: file.pe.os, subsystem: file.pe.subsystem }
          : null,
        comparison_pe: other.pe
          ? { os: other.pe.os, subsystem: other.pe.subsystem }
          : null,
      },
    ]
  })
  return {
    files: [
      ...compared,
      ...comparison.files
        .filter((file) => !primary.files.some((item) => item.path === file.path))
        .map((file) => ({
          path: file.path,
          status: "missing_in_primary",
        })),
    ],
  }
}

function renderMarkdown(report) {
  const lines = [
    "# Win7 Runtime Provenance",
    "",
    `Generated: ${report.generated_at}`,
    "",
    renderRuntime("Primary", report.primary),
    report.comparison ? renderRuntime("Comparison", report.comparison) : "",
    report.differences ? renderDifferences(report.differences) : "",
  ]
  return `${lines.filter(Boolean).join("\n\n")}\n`
}

function renderRuntime(title, runtime) {
  const exe = runtime.files.find((file) => file.path === runtime.executable)
  const risks = runtime.summary.risk_files.flatMap((file) =>
    file.risks.map((risk) => `- ${file.path}: ${risk}`),
  )
  return [
    `## ${title}`,
    "",
    `Path: \`${runtime.path}\``,
    `Version: \`${runtime.version ?? "unknown"}\``,
    `Executable: \`${runtime.executable}\``,
    exe?.pe
      ? `Executable PE: os=\`${exe.pe.os}\`, subsystem=\`${exe.pe.subsystem}\``
      : "Executable PE: unavailable",
    exe ? `Executable SHA256: \`${exe.sha256}\`` : "",
    "",
    `Lowered PE files: ${runtime.summary.lowered_pe_files.length}`,
    runtime.summary.lowered_pe_files.map((file) => `- ${file}`).join("\n"),
    "",
    risks.length > 0
      ? ["Risk imports:", ...risks].join("\n")
      : "Risk imports: none in scanned files",
  ]
    .filter(Boolean)
    .join("\n")
}

function renderDifferences(differences) {
  const changed = differences.files.filter((file) => file.status !== "same")
  return [
    "## Differences",
    "",
    `Changed or missing files: ${changed.length}`,
    changed.map((file) => `- ${file.path}: ${file.status}`).join("\n"),
  ].join("\n")
}
