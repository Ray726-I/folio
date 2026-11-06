const { openMarkdown } = require('./editor-test-actions.cjs');
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 const source = 'Before.\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\nAfter diagram.\n';
 const session = await openEditor(source);
 try {
  const { page } = session;
  await page.locator('.mermaid-host svg').waitFor();
  assert.equal(await page.locator('.mermaid-host summary').count(), 0, 'diagram has no separate source disclosure');
  await page.locator('.mermaid-host svg').click();
  assert.equal(await page.locator('.folio-source-edit').count(), 0, 'single click keeps the diagram rendered');
  await openMarkdown(page.locator('.mermaid-host svg'));
  const block = page.locator('.folio-source-edit');
  await block.waitFor();
  assert.equal(await block.textContent(), '```mermaid\ngraph TD;\nA-->B;\n```');
  assert.equal(await page.evaluate(()=>current.content), source, 'revealing source never writes');
  await page.evaluate(() => { window.getSelection().collapse(document.querySelector('.folio-source-edit code').firstChild, 0); });
  await page.keyboard.press('Control+Shift+End');
  const selected = await page.evaluate(()=>window.getSelection().toString());
  assert.match(selected, /graph TD;[\s\S]*A-->B;[\s\S]*After diagram/);
  await page.keyboard.press('ArrowLeft');
  await block.click();
  await page.keyboard.press('Home');
  await page.keyboard.type(' ');
  assert.notEqual(await page.evaluate(()=>current.content), source, 'diagram source edits are live');
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(()=>current.content), source);
  await page.keyboard.press('Escape');
  await page.locator('.mermaid-host svg').waitFor();
  assert.equal(await page.locator('.mermaid-host summary').count(), 0);
  await page.locator('#document-mode-menu-button').click(); await page.locator('#lock-document').click();
  await page.locator('.mermaid-host svg').click();
  assert.equal(await page.locator('.folio-source-edit').count(), 0, 'lock keeps diagrams rendered');
  assert.equal(await page.evaluate(()=>current.content), source);
  assert.deepEqual(session.errors, []);
 } finally { await session.close(); }
 console.log('PASS: context-menu Mermaid source participates in document selection, live edits, undo and lock');
})().catch(e=>{console.error(e);process.exitCode=1;});
