const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Fenced code is still ordinary editable text. The rich presentation should
// layer the native highlighter's safe token spans behind that text instead of
// showing the block as a single colour. Mermaid remains a diagram host.
const source = [
  '# Code',
  '',
  '```js',
  'const answer = 42; // note',
  'console.log("hello");',
  '```',
  '',
  '```mermaid',
  'graph TD;',
  'A-->B;',
  '```',
  '',
  '```html',
  '<img src=x onerror="window.__xss = true">',
  '```',
  ''
].join('\n');

(async () => {
  const session = await openEditor(source);
  const { page, errors } = session;
  const text = () => page.evaluate(() => current.content);
  try {
    const js = page.locator('.code-container[data-language="js"]');
    await js.locator('.code-highlight span').first().waitFor();
    await page.waitForFunction(() => document.querySelector('.code-container[data-language="js"]')?.classList.contains('code-highlighted'));
    assert.ok(await js.locator('.code-highlight .keyword, .code-highlight .storage, .code-highlight .string, .code-highlight .comment, .code-highlight .constant').count() > 0,
      'JavaScript code should expose highlighter token spans');
    assert.equal(await js.locator('.code-surface code').innerText(), 'const answer = 42; // note\nconsole.log("hello");',
      'the editable code text must remain intact');
    assert.equal(await js.locator('.code-highlight code').innerText(), await js.locator('.code-surface code').innerText(),
      'the highlight layer must mirror the editable text exactly');

    // Typing in the block still edits the document and refreshes the overlay.
    await js.locator('.code-surface code').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('const extra = 1;');
    await page.waitForFunction(() => document.querySelector('.code-container[data-language="js"] .code-highlight')?.textContent.includes('const extra = 1;'));
    assert.ok((await text()).includes('const extra = 1;'), 'typing must round-trip to the Markdown source');

    // Markdown mode removed in the single-editor migration.

    // Mermaid keeps its diagram treatment and has no code highlight layer.
    const mermaid = page.locator('.code-container[data-language="mermaid"]');
    assert.equal(await mermaid.locator('.code-highlight').count(), 0);
    await mermaid.locator('svg').waitFor();

    // The HTML-like code is escaped text in both layers: no element, no handler.
    const html = page.locator('.code-container[data-language="html"]');
    await html.locator('.code-highlight span').first().waitFor();
    assert.equal(await page.locator('#preview img').count(), 0, 'code text must not create elements');
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'code text must never execute');
    assert.ok((await html.locator('.code-highlight code').innerText()).includes('<img src=x onerror="window.__xss = true">'));

    assert.deepEqual(errors, []);
    console.log('PASS: rich fenced code keeps editable source while showing safe native token highlighting; Mermaid is unaffected.');
  } catch (error) {
    console.error('PAGE ERRORS:', errors, 'URL:', page.url());
    console.error(await page.locator('#toast').textContent({ timeout: 1000 }).catch(() => 'App document is unavailable'));
    throw error;
  } finally {
    await session.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
