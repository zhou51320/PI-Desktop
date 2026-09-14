#!/usr/bin/env node
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const env = {
  ...process.env,
  PI_DESKTOP_TARGET_PLATFORM: "win32",
  PI_DESKTOP_TARGET_ARCH: "x64",
  PI_DESKTOP_WIN7: "1",
}

console.log("Building experimental Win7 desktop assets for win32/x64")

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: desktopDir,
      env,
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
  await runCommand("pnpm", ["run", "build:deps"])
  try {
    console.log("Checking for cargo to compile host-core binary...")
    await runCommand("cargo", [
      "build",
      "--release",
      "--manifest-path",
      "../../Cargo.toml",
      "-p",
      "host-core",
    ])
  } catch (err) {
    console.warn("Skipping host-core cargo build:", err.message)
  }
  await runCommand("pnpm", ["run", "bundle:runtime"])
  await runCommand("pnpm", ["run", "build"])
  console.log("Win7 build completed successfully!")
} catch (error) {
  console.error("Win7 build failed:", error)
  process.exit(1)
}
