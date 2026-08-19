// afterSign hook called by electron-builder after code-signing on macOS.
// Submits the signed .app to Apple's notarization service and staples the
// ticket so the app can be opened offline (Gatekeeper reads the staple).
//
// Required env vars (set in CI secrets — never hardcode):
//   APPLE_ID                  — Apple Developer account email
//   APPLE_APP_SPECIFIC_PASSWORD — app-specific password from appleid.apple.com
//   APPLE_TEAM_ID             — 10-character Developer Team ID
//
// If any variable is missing the hook skips silently (local / non-macOS builds).
const { notarize } = require("@electron/notarize");

module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    if (process.env.DAIMON_REQUIRE_SIGNING === "1") {
      throw new Error("notarization credentials are required for a protected release build");
    }
    console.log(
      "[notarize] skipping — set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID to notarize",
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`[notarize] submitting ${appPath} …`);

  await notarize({
    appBundleId: "com.daimon-os.desktop",
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log("[notarize] done — ticket stapled by electron-builder");
};
