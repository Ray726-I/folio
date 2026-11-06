const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

async function openSlash(page) {
  await page.locator('.editor-trailing-input').click({ timeout: 5000 });
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
  await page.keyboard.type('/');
  await page.locator('.folio-slash-menu').waitFor({ state: 'visible', timeout: 5000 });
}

async function insertCommand(source, keys, typed = '') {
  const session = await openEditor(source, { width: 1100, height: 800 });
  try {
    const { page, errors } = session;
    await openSlash(page);
    for (const key of keys) await page.keyboard.type(key, { delay: 5 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    if (['image', 'math', 'mermaid'].includes(keys[0])) {
      if (typed) await page.locator('#editor-action-value').fill(typed);
      await page.locator('#editor-action-form button[type=submit]').click();
    } else if (typed) {
      await page.keyboard.type(typed);
      await page.waitForTimeout(120);
    }
    const content = await page.evaluate(() => current.content);
    assert.deepEqual(errors, []);
    return content;
  } finally { await session.close(); }
}

(async () => {
  // 1. Slash is literal on a non-empty line, and the permanent document prompt
  //    is gone: the trailing strip is an invisible target, not body copy.
  let session = await openEditor('First paragraph.\n', { width: 1100, height: 800 });
  try {
    const { page, errors } = session;
    assert.equal(await page.locator('.editor-trailing-input').textContent(), '', 'the trailing strip is not document copy');
    assert.equal(await page.locator('.folio-empty-hint').count(), 0, 'no hint while the caret is not on an empty final line');
    await page.locator('#preview p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('/');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.folio-slash-menu').count(), 0, 'slash on a non-empty line stays literal');
    assert.equal(await page.evaluate(() => current.content), 'First paragraph./\n');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => current.content === 'First paragraph.\n');

    await page.locator('.editor-trailing-input').click();
    const hint = page.locator('.folio-empty-hint');
    await hint.waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await hint.textContent(), /Type for blocks/, 'the hint belongs to the empty final line');
    await page.keyboard.type('/');
    const menu = page.locator('.folio-slash-menu');
    await menu.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await hint.count(), 0, 'typing the slash replaces the empty-line hint');
    const anchorX = (await menu.boundingBox()).x;
    await page.keyboard.type('head');
    await page.waitForTimeout(80);
    const filteredX = (await menu.boundingBox()).x;
    assert.ok(Math.abs(filteredX - anchorX) <= 2, 'filtering does not drag the picker sideways');

    // Outside click dismisses and the menu never outlives the caret.
    await page.locator('#preview p').first().click();
    assert.equal(await page.locator('.folio-slash-menu').count(), 0, 'outside click dismisses the picker');
    assert.deepEqual(errors, []);
  } finally { await session.close(); }

  // 2. Short grouped root, submenu flyout and keyboard navigation.
  session = await openEditor('Body.\n', { width: 1100, height: 800, });
  try {
    const { page, errors } = session;
    await openSlash(page);
    const menu = page.locator('.folio-slash-menu');
    const roots = await page.locator('.folio-slash-row').allTextContents();
    assert.equal(roots.length, 7, 'the root menu stays short');
    assert.deepEqual(await page.locator('.folio-slash-row').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label') || row.querySelector('.folio-slash-label')?.textContent)), ['Paragraph', 'Heading', 'List', 'Quote', 'Code block', 'Table', 'More']);
    const box = await menu.boundingBox();
    assert.ok(box.height < 320, 'the grouped menu is shorter than the old flat list');
    assert.ok(box.x >= 0 && box.y >= 0, 'the picker stays inside the viewport');

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.locator('.folio-slash-submenu').waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await page.locator('.folio-slash-submenu .folio-slash-row').count(), 6, 'Heading exposes all six levels');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    assert.match(await page.evaluate(() => current.content), /Body\.\n\n## $/);
    assert.deepEqual(errors, []);
  } finally { await session.close(); }

  // 3. Narrow windows turn the flyout into an in-picker drill-down with a back
  //    row, so a submenu never leaves the visible window.
  session = await openEditor('Body.\n', { width: 480, height: 700 });
  try {
    const { page, errors } = session;
    await openSlash(page);
    await page.getByRole('option', { name: 'Heading', exact: true }).click();
    await page.waitForTimeout(220);
    assert.equal(await page.locator('.folio-slash-menu').evaluate(element => element.classList.contains('compact')), true, 'the narrow picker uses drill-down');
    assert.equal(await page.locator('.folio-slash-back').isVisible(), true, 'drill-down exposes a back control');
    assert.equal(await page.locator('.folio-slash-list').isVisible(), false, 'the root list gives the submenu the picker body');
    const menuBox = await page.locator('.folio-slash-menu').boundingBox();
    const subBox = await page.locator('.folio-slash-submenu').boundingBox();
    assert.ok(subBox.x >= menuBox.x && subBox.x + subBox.width <= menuBox.x + menuBox.width + 1, 'the drill-down stays inside the picker');
    await page.locator('.folio-slash-back').click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.folio-slash-list').isVisible(), true, 'back restores the grouped root');
    await page.getByRole('option', { name: 'Heading', exact: true }).click();
    await page.waitForTimeout(150);
    await page.getByRole('option', { name: 'Heading 2', exact: true }).click();
    await page.waitForTimeout(150);
    assert.match(await page.evaluate(() => current.content), /Body\.\n\n## $/);
    assert.deepEqual(errors, []);
  } finally { await session.close(); }

  // 4. The picker flips above a caret that sits near the bottom edge instead of
  //    clamping over the writing line (the old "looks embedded" failure).
  const longSource = `${'# Top\n\n'}${Array.from({ length: 24 }, (_, index) => `Paragraph ${index + 1} with enough text to take a line.\n`).join('\n')}`;
  session = await openEditor(longSource, { width: 1100, height: 620 });
  try {
    const { page, errors } = session;
    await page.locator('.reader-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await openSlash(page);
    const placement = await page.evaluate(() => {
      const menu = document.querySelector('.folio-slash-menu');
      const caret = getSelection().getRangeAt(0).getBoundingClientRect();
      const box = menu.getBoundingClientRect();
      return { side: menu.dataset.side, menu: box.toJSON(), caret: caret.toJSON(), viewport: innerHeight };
    });
    assert.equal(placement.side, 'above', 'a low caret opens the menu upward');
    assert.ok(placement.menu.bottom <= placement.caret.top - 6, 'the menu clears the caret line');
    assert.ok(placement.menu.top >= 0, 'the flipped menu stays on screen');
    assert.deepEqual(errors, []);
  } finally { await session.close(); }

  // 4. The missing block types insert exact Markdown and stay editable.
  const insertions = [
    [['task'], '', 'Body.\n\n- [ ] '],
    [['image'], 'picture.png', 'Body.\n\n![image](picture.png)'],
    [['math'], 'a^2', 'Body.\n\n$$\na^2\n$$'],
    [['mermaid'], '', 'Body.\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```'],
    [['table'], 'Name', 'Body.\n\n| Name | Column 2 |\n| --- | --- |\n|  |  |']
  ];
  for (const [keys, typed, expected] of insertions) {
    const content = await insertCommand('Body.\n', keys, typed);
    assert.equal(content, expected, `insertion ${keys[0]} writes exact Markdown`);
  }

  session = await openEditor('Body.\n', { width: 1100, height: 800 });
  try {
    const { page, errors } = session;
    await openSlash(page); await page.keyboard.type('code'); await page.keyboard.press('Enter');
    const language = page.getByRole('textbox', { name: 'Code fence info' });
    await language.waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await language.evaluate(element => document.activeElement === element), true, 'new code blocks focus their language field');
    await page.keyboard.type('javascript'); await page.keyboard.press('Enter'); await page.keyboard.type('const x = 1;');
    await page.waitForFunction(() => current.content === 'Body.\n\n```javascript\nconst x = 1;\n```', null, { timeout: 3000 });
    assert.deepEqual(errors, []);
  } finally { await session.close(); }

  console.log('PASS: slash picker is grouped, anchored, empty-line guarded, and covers the missing block types.');
})().catch(error => { console.error(error); process.exitCode = 1; });
