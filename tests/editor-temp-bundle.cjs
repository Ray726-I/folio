const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { openEditor } = require('./editor-browser.cjs');

const scratchRoot = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();

// Build the edited rich/source engine in a throwaway directory. The shared
// vendor bundle stays untouched; tests route only their own browser session to
// the fresh bundle.
function buildEditorBundle() {
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'folio-audit-'));
  const outfile = path.join(directory, 'editor.js');
  esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, '../ui/editor/entry.js')], bundle: true, format: 'iife', globalName: 'FolioEditor',
    target: ['es2022'], minify: true, legalComments: 'eof', outfile, logLevel: 'silent'
  });
  return { directory, outfile, cleanup() { fs.rmSync(directory, { recursive: true, force: true }); } };
}

async function openIsolatedEditor(source, outfile, viewport) {
  const session = await openEditor(source, viewport);
  let served = 0;
  await session.page.route(/\/vendor\/editor\/editor\.js(?:\?.*)?$/, route => {
    served++;
    return route.fulfill({ path: outfile, contentType: 'application/javascript' });
  });
  await session.page.reload();
  await session.page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
  assert.equal(served, 1, 'audit tests must run against the freshly built editor bundle');
  return session;
}

module.exports = { buildEditorBundle, openIsolatedEditor };
