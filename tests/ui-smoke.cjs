const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
let errors = [];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
  errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    window.nativeCalls = [];
    window.nativeEvents = {};
    const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    window.__TAURI__ = {
      core: { invoke: async (command, args = {}) => {
        window.nativeCalls.push({ command, args });
        switch (command) {
          case 'bootstrap': return { paths: [], theme: { name: 'midnight', mode: 'dark', colors: { background: '#060b1e', foreground: '#ffcead', accent: '#7d82d9', dark_background: '#040816', lighter_background: '#131a3a' } } };
          case 'render_markdown': {
            if (args.content.includes('Plain text, beautifully rendered')) {
              const items = [...args.content.matchAll(/^- \[([ x])\] (.*)$/gm)];
              return { html: `<h1 id="heading-1">A quiet place for your words</h1><p>Folio opens individual Markdown files.</p><h2 id="heading-2">Plain text, beautifully rendered</h2><ul>${items.map((item, index) => `<li><input type="checkbox" data-task-index="${index}" ${item[1] === 'x' ? 'checked' : ''}> ${escape(item[2])}</li>`).join('')}</ul>`, blocks: [] };
            }
            const parts = args.content.split(/\n\n/);
            const heading = parts[0] || '# Opened';
            const body = parts[1] || 'Text';
            return { html: `<h1 id="heading-1">${escape(heading.replace(/^# /, ''))}</h1><p>${escape(body)}</p>`, blocks: [{ source: heading, start: 0, end: heading.length }, { source: body, start: heading.length + 2, end: heading.length + 2 + body.length }] };
          }
          case 'browse_directory': {
            const folder = args.path || '/tmp';
            const contents = {
              '/tmp': [{ path: '/tmp/notes', name: 'notes', directory: true }, { path: '/tmp/opened.md', name: 'opened.md', directory: false }],
              '/tmp/notes': [{ path: '/tmp/notes/sub', name: 'sub', directory: true }, { path: '/tmp/notes/item.md', name: 'item.md', directory: false }],
              '/tmp/notes/sub': []
            };
            return { path: folder, parent: folder === '/' ? null : folder.slice(0, folder.lastIndexOf('/')) || '/', entries: contents[folder] || [] };
          }
          case 'path_is_directory': return args.path === '/tmp/notes' || args.path === '/tmp/notes/sub' || args.path === '/tmp';
          case 'open_folder': return { path: args.path, name: args.path.split('/').pop(), entries: args.path === '/tmp/notes' ? [{ path: '/tmp/notes/sub', name: 'sub', depth: 0, directory: true }, { path: '/tmp/notes/item.md', name: 'item.md', depth: 0, directory: false }] : [] };
          case 'open_document': return { path: args.path, name: args.path.split('/').pop(), content: '# Opened\n\nText', lineEnding: 'LF' };
          case 'set_task_checked': {
            const matches = [...args.content.matchAll(/^- \[([ x])\] /gm)];
            const marker = matches[args.taskIndex].index + 3;
            return args.content.slice(0, marker) + (args.checked ? 'x' : ' ') + args.content.slice(marker + 1);
          }
          case 'edit_markdown_block': return args.content.replace('Text', args.replacement);
          case 'save_document': return { path: '/tmp/saved.md', name: 'saved.md' };
          case 'document_changed': return false;
          default: return null;
        }
      } },
      event: { listen: async (name, callback) => { window.nativeEvents[name] = callback; return () => {}; } },
      webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }
    };
  });
  await page.goto('file://' + path.resolve(__dirname, '../ui/index.html'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'omarchy');
  assert.equal(await page.evaluate(() => typeof window.katex?.render), 'function', 'vendored KaTeX should load locally');
  const diagram = await page.evaluate(async () => {
    if (typeof mermaid === 'undefined' || typeof mermaid.render !== 'function') return null;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    try { const { svg } = await mermaid.render('smoke-diagram', 'graph TD;\nA-->B;'); return svg.includes('<svg'); } catch { return false; }
  });
  assert.equal(diagram, true, 'vendored Mermaid should render a diagram');
  await page.locator('#sample').click();
  await page.locator('#preview h1').waitFor();
  await page.waitForFunction(() => !busy);
  const initialRenderCalls = await page.evaluate(() => window.nativeCalls.filter(call => call.command === 'render_markdown').length);
  await page.evaluate(() => { window.initialHeading = document.querySelector('#preview h1'); });
  for (const button of ['#edit-mode', '#read-mode', '#edit-mode', '#read-mode']) {
    await page.locator(button).click();
    await page.waitForFunction(() => !busy);
  }
  assert.equal(await page.evaluate(() => window.nativeCalls.filter(call => call.command === 'render_markdown').length), initialRenderCalls, 'unchanged mode switches should reuse the rendered preview');
  assert(await page.evaluate(() => window.initialHeading === document.querySelector('#preview h1')), 'unchanged mode switches should preserve the preview DOM');
  assert.equal(await page.locator('html').getAttribute('data-document-width'), 'centered');
  const centeredWidth = await page.locator('#preview').evaluate(element => element.getBoundingClientRect().width);
  await page.locator('#width-toggle').click();
  assert(await page.locator('#preview').evaluate(element => element.getBoundingClientRect().width) > centeredWidth + 200);
  await page.keyboard.press('Control+Shift+P');
  await page.locator('#command-search').fill('centered document width');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.dataset.documentWidth === 'centered');

  await page.keyboard.press('Control+Equal');
  assert.equal(await page.locator('#zoom-reset').textContent(), '110%');
  await page.keyboard.press('Control+Shift+Equal');
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-size')), '19px');
  await page.keyboard.press('Control+Minus');
  assert.equal(await page.locator('#zoom-reset').textContent(), '100%');
  await page.keyboard.press('Control+Shift+Minus');
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-size')), '18px');
  assert.equal(await page.evaluate(() => window.nativeCalls.filter(call => call.command === 'set_window_zoom').at(-1).args.scale), 1);

  await page.locator('#edit-mode').click();
  await page.locator('#preview input[data-task-index="3"]').check();
  await page.waitForFunction(() => document.getElementById('dirty-dot').hidden === false);
  await page.locator('#edit-mode').click();
  const source = await page.evaluate(() => current.content);
  assert(source.includes('- [x] Tables, task lists, and footnotes'));
  assert(source.includes('- [x] Your next idea'));
  assert(source.includes('```rust'));
  assert.equal((source.match(/Your next idea/g) || []).length, 1);

  await page.keyboard.press('Control+O');
  await page.locator('#open-dialog').waitFor();
  await page.getByRole('option', { name: 'opened.md' }).click();
  await page.locator('#open-confirm').click();
  await page.locator('#confirm-dialog').waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert((await page.evaluate(() => current.content)).includes('Your next idea'));
  await page.keyboard.press('Control+S');
  await page.waitForFunction(() => document.getElementById('dirty-dot').hidden);

  await page.keyboard.press('Control+O');
  await page.getByRole('option', { name: 'notes' }).click();
  await page.locator('#open-confirm').click();
  await page.waitForFunction(() => document.getElementById('folder-name').textContent === 'notes');
  assert.equal(await page.locator('#folder-divider').isVisible(), true);
  const initialWidth = await page.locator('#file-browser').evaluate(node => node.getBoundingClientRect().width);
  const divider = await page.locator('#folder-divider').boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 60);
  await page.mouse.down(); await page.mouse.move(divider.x + 65, divider.y + 60); await page.mouse.up();
  const expandedWidth = await page.locator('#file-browser').evaluate(node => node.getBoundingClientRect().width);
  assert(expandedWidth > initialWidth + 30, 'folder sidebar should resize by dragging');
  await page.getByRole('button', { name: 'sub' }).click();
  await page.waitForFunction(() => document.querySelector('.folder-entry[aria-expanded="true"]') !== null);
  await page.locator('#folder-close').click();
  assert.equal(await page.locator('#file-browser').getAttribute('hidden'), '');
  await page.keyboard.press('Control+B');
  await page.waitForFunction(() => document.getElementById('file-browser').hidden === false);
  await page.getByRole('button', { name: 'item.md' }).click();
  await page.locator('#preview h1').waitFor();
  await page.locator('#edit-mode').click();
  await page.locator('#preview p').click();
  await page.locator('.live-editor textarea').fill('Edited text');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => !busy);
  await page.locator('#edit-mode').click();
  assert.equal(await page.evaluate(() => current.content), '# Opened\n\nEdited text');

  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS: math and diagrams load, unchanged modes preserve the preview DOM, document width toggles through the toolbar and palette, task boxes and inline edits preserve Markdown, zoom shortcuts work, and the tree sidebar resizes and collapses.');
})().catch(error => { console.error(error); console.error('PAGE ERRORS:', errors); process.exit(1); });
