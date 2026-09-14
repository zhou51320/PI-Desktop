try {
  const macosVersion = require("app-builder-lib/out/util/macosVersion")
  if (macosVersion && typeof macosVersion.isMacOsCatalina === "function") {
    macosVersion.isMacOsCatalina = () => true
  }
} catch {
  // ignore if not present
}
