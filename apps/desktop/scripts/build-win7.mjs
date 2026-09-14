#!/usr/bin/env node
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const rootDir = path.resolve(desktopDir, "../..")

const env = {
  ...process.env,
  PI_DESKTOP_TARGET_PLATFORM: "win32",
  PI_DESKTOP_TARGET_ARCH: "x64",
  PI_DESKTOP_WIN7: "1",
}

console.log("Building experimental Win7 desktop assets for win32/x64")

function runCommand(command, args, options = {}) {
  const isWindows = process.platform === "win32"
  const bin = isWindows && (command === "pnpm" || command === "npm") ? `${command}.cmd` : command
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd: desktopDir,
      env,
      stdio: "inherit",
      shell: isWindows,
      ...options,
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
  try {
    const filterArg = process.platform === "win32" ? "@pi-desktop/desktop^^..." : "@pi-desktop/desktop^..."
    console.log("Building workspace dependencies...")
    await runCommand("pnpm", ["--filter", filterArg, "--fail-if-no-match", "build"], { cwd: rootDir })
  } catch (err) {
    console.warn("Workspace dependency build skipped or handled externally:", err.message)
  }

  console.log("Bundling agent-runtime...")
  await runCommand("pnpm", ["-C", path.resolve(rootDir, "packages/agent-runtime"), "bundle"], { cwd: rootDir })

  console.log("Building Electron Vite frontend assets...")
  await runCommand("pnpm", ["run", "build"], { cwd: desktopDir })

  console.log("Win7 build completed successfully!")
} catch (error) {
  console.error("Win7 build failed:", error)
  process.exit(1)
}
