const fs = require('node:fs');
const path = require('node:path');

const bundleRoot = path.join('target', 'release', 'bundle');
const expected = {
  linux: [
    ['appimage', name => name.endsWith('.AppImage')],
    ['deb', name => name.endsWith('.deb')]
  ],
  darwin: [
    ['macos', name => name.endsWith('.app')],
    ['dmg', name => name.endsWith('.dmg')]
  ],
  win32: [
    ['msi', name => name.endsWith('.msi')],
    ['nsis', name => /-setup\.exe$/i.test(name)]
  ]
}[process.platform];

if (!expected) {
  console.error(`Unsupported bundle platform: ${process.platform}`);
  process.exit(1);
}

let failed = false;
for (const [directory, matches] of expected) {
  const location = path.join(bundleRoot, directory);
  const entries = fs.existsSync(location) ? fs.readdirSync(location) : [];
  const artifacts = entries.filter(matches);
  if (!artifacts.length) {
    console.error(`Missing ${directory} bundle in ${location}`);
    failed = true;
  } else {
    for (const artifact of artifacts) console.log(path.join(location, artifact));
  }
}
process.exit(failed ? 1 : 0);
