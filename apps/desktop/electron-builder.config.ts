import type { Configuration } from "electron-builder"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const packageJson = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
)
const baseConfig: Configuration = packageJson.build ?? {}

const win7Build = process.env.PI_DESKTOP_WIN7 === "1"
const win7ElectronVersion = process.env.PI_DESKTOP_ELECTRON_VERSION ?? "40.2.0"
const win7ElectronDist = process.env.PI_DESKTOP_ELECTRON_DIST
  ? path.resolve(process.env.PI_DESKTOP_ELECTRON_DIST)
  : undefined

const hostCoreExePath = path.resolve(
  __dirname,
  "../../target/release/pi-desktop-host-core.exe",
)
const hostCoreExeExists = existsSync(hostCoreExePath)

const win7TargetEnv = process.env.PI_DESKTOP_WIN7_TARGET ?? "dir"
const win7Targets = (() => {
  if (win7TargetEnv === "both") {
    return [
      { target: "dir", arch: ["x64"] },
      { target: "nsis", arch: ["x64"] },
    ]
  }
  if (win7TargetEnv === "nsis") {
    return [{ target: "nsis", arch: ["x64"] }]
  }
  return [{ target: "dir", arch: ["x64"] }]
})()

try {
  // Enables pure-JS NSIS uninstaller extraction without Wine on Linux/macOS
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const macosVersion = require("app-builder-lib/out/util/macosVersion")
  if (macosVersion && typeof macosVersion.isMacOsCatalina === "function") {
    macosVersion.isMacOsCatalina = () => true
  }
} catch {
  // ignore if not present
}

const config: Configuration = {
  ...baseConfig,
  electronVersion: win7Build ? win7ElectronVersion : undefined,
  electronDist: win7Build ? win7ElectronDist : undefined,
  directories: {
    ...baseConfig.directories,
    output: win7Build
      ? "dist/win7"
      : (baseConfig.directories?.output ?? "release"),
  },
  artifactName: win7Build
    ? "PI-Desktop-win7-${version}-${arch}.${ext}"
    : (baseConfig.artifactName ?? "${productName}-${version}-${os}-${arch}.${ext}"),
  afterPack: async (context) => {
    if (win7Build && context.electronPlatformName === "win32") {
      const exePath = path.join(context.appOutDir, "PI-Desktop.exe")
      const iconPath = path.resolve(__dirname, "build/icon.ico")
      if (existsSync(exePath) && existsSync(iconPath)) {
        const { Data, NtExecutable, NtExecutableResource, Resource } =
          await import("resedit")
        const buffer = readFileSync(exePath)
        const parsed = NtExecutable.from(buffer, { ignoreCert: true })
        const resources = NtExecutableResource.from(parsed)
        const icons = Data.IconFile.from(readFileSync(iconPath)).icons.map(
          (item) => item.data,
        )
        const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
        if (!groups.length) {
          throw new Error(`Win7 icon patch failed: no icon group in ${exePath}`)
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
        writeFileSync(exePath, Buffer.from(parsed.generate()))
        console.log(`[afterPack] Applied PI-Desktop icon to ${exePath}`)
      }
    }
  },
  win: {
    ...baseConfig.win,
    executableName: "PI-Desktop",
    target: win7Build
      ? win7Targets
      : (baseConfig.win?.target ?? [
          { target: "nsis", arch: ["x64"] },
          { target: "portable", arch: ["x64"] },
        ]),
    icon: "build/icon.ico",
    signAndEditExecutable: !win7Build,
    extraResources: hostCoreExeExists
      ? [
          {
            from: "../../target/release/pi-desktop-host-core.exe",
            to: "bin/pi-desktop-host-core.exe",
          },
        ]
      : [],
  },
  nsis: {
    ...baseConfig.nsis,
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "PI-Desktop",
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    installerHeaderIcon: "build/icon.ico",
    artifactName: win7Build
      ? "PI-Desktop-win7-Setup-${version}-${arch}.${ext}"
      : (baseConfig.nsis?.artifactName ?? "${productName}-Setup-${version}.${ext}"),
  },
}

export default config
