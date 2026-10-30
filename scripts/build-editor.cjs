const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const check = process.argv.includes('--check');
const directory = check ? fs.mkdtempSync(path.join(os.tmpdir(), 'folio-editor-build-')) : 'ui/vendor/editor';
fs.mkdirSync(directory, { recursive: true });
try {
  const outfile = path.join(directory, 'editor.js');
  const result = esbuild.buildSync({ entryPoints: ['ui/editor/entry.js'], bundle: true, format: 'iife', globalName: 'FolioEditor', target: ['es2022'], minify: true, legalComments: 'eof', outfile, metafile: true, logLevel: 'silent' });
  const packages = new Set(Object.keys(result.metafile.inputs).filter(file => file.startsWith('node_modules/')).map(file => file.split('/').slice(1, file.split('/')[1].startsWith('@') ? 3 : 2).join('/')));
  const notices = [...packages].sort().map(name => {
    const base = path.join('node_modules', name), pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json')));
    const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENSE-MIT'].find(file => fs.existsSync(path.join(base, file)));
    return `${name} ${pkg.version} (${pkg.license || 'see package license'})\n${license ? fs.readFileSync(path.join(base, license), 'utf8') : 'License information: https://www.npmjs.com/package/' + name}\n`;
  }).join('\n--------------------\n\n');
  fs.writeFileSync(path.join(directory, 'NOTICE.txt'), notices);
  if (check) {
    for (const file of ['editor.js', 'editor.css', 'NOTICE.txt']) if (!fs.readFileSync(path.join(directory, file)).equals(fs.readFileSync(path.join('ui/vendor/editor', file)))) throw new Error('Editor bundle is stale. Run npm run build:editor.');
    console.log('PASS: editor bundle matches pinned source/dependencies.');
  } else console.log(`Built offline editor: ${fs.statSync(outfile).size} bytes`);
} finally { if (check) fs.rmSync(directory, { recursive: true, force: true }); }
