// electron-builder afterPack hook — ad-hoc sign the macOS app.
//
// This fork has no Apple Developer ID, so electron-builder's own signing is
// disabled (CSC_IDENTITY_AUTO_DISCOVERY=false; notarize=false). A fully-unsigned
// app trips Gatekeeper hard ("app is damaged"); an ad-hoc signature keeps it
// openable via right-click -> Open — same as `npm run build:mac` does locally.
//
// afterPack runs after the .app is packed but before the dmg/zip targets are
// built, so the published artifacts contain the ad-hoc-signed app.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync('codesign', ['--sign', '-', '--force', '--deep', appPath], { stdio: 'inherit' });
  console.log(`[afterpack] ad-hoc signed ${appPath}`);
};
