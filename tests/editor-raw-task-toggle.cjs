const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// A caret in inline math is Comrak syntax the rich schema does not represent,
// so the whole task list becomes one raw_block projection. Its checkboxes are
// native HTML (`disabled`) and must still toggle the exact source marker.
const source = `# Raw task projection

- [x] Already done
- [ ] **Bold** task with $a^2+b^2=c^2$
  - [ ] Nested task
    - [x] Deep done
- \\[ ] escaped marker
- [ ] duplicate
- [ ] duplicate

> [!NOTE]
> - [ ] Callout task
>
> \`\`\`
> - [ ] fenced fake
> \`\`\`
`;
(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.waitForSelector('#preview .extension-block input[type=checkbox]');
    const blocks = page.locator('#preview .extension-block');
    assert.equal(await blocks.count(), 2, 'the list and the callout are raw projections');

    const list = blocks.nth(0);
    const listBoxes = list.locator('input[type=checkbox][data-task-index]');
    assert.equal(await listBoxes.count(), 6, 'escaped marker and fenced sample are not tasks');
    assert.equal(await listBoxes.nth(1).isDisabled(), false, 'unlocked raw task is interactive');

    // Toggle directly after the inline math that caused the raw fallback.
    const before = await page.evaluate(() => current.content);
    await listBoxes.nth(1).check();
    const checked = before.replace('- [ ] **Bold** task with $a^2+b^2=c^2$', '- [x] **Bold** task with $a^2+b^2=c^2$');
    await page.waitForFunction(text => current.content === text, checked);
    assert.equal(await page.evaluate(() => current.content), checked, 'only the marker byte changed');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, before);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(text => current.content === text, checked);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, before);

    // Nested list task.
    await listBoxes.nth(2).check();
    const nested = before.replace('  - [ ] Nested task', '  - [x] Nested task');
    await page.waitForFunction(text => current.content === text, nested);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, before);

    // Duplicate text: the second occurrence changes, the first stays put.
    await listBoxes.nth(5).check();
    const at = before.lastIndexOf('- [ ] duplicate');
    const duplicate = before.slice(0, at) + '- [x] duplicate' + before.slice(at + '- [ ] duplicate'.length);
    await page.waitForFunction(text => current.content === text, duplicate);
    const duplicated = await page.evaluate(() => current.content);
    assert.equal(duplicated, duplicate, 'duplicate text maps by position');
    assert.equal(duplicated.match(/- \[ ] duplicate/g)?.length, 1, 'first duplicate is untouched');
    assert.equal(duplicated.match(/- \[x] duplicate/g)?.length, 1, 'second duplicate is checked');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, before);

    // A task inside an alert block projects exactly as one checkbox; the
    // escaped and fenced lines are never counted.
    const callout = blocks.nth(1);
    const calloutBoxes = callout.locator('input[type=checkbox][data-task-index]');
    assert.equal(await calloutBoxes.count(), 1, 'callout has one real task');
    await calloutBoxes.first().check();
    const calloutChecked = before.replace('> - [ ] Callout task', '> - [x] Callout task');
    await page.waitForFunction(text => current.content === text, calloutChecked);
    const calloutSource = await page.evaluate(() => current.content);
    assert.ok(calloutSource.includes('- \\[ ] escaped marker'), 'escaped marker untouched');
    assert.ok(calloutSource.includes('> - [ ] fenced fake'), 'fenced sample untouched');

    // Lock disables every raw checkbox and a forced click cannot edit.
    await page.locator('#lock-document').click();
    assert.equal(await listBoxes.nth(1).isDisabled(), true, 'lock disables the raw list');
    assert.equal(await calloutBoxes.first().isDisabled(), true, 'lock disables the callout');
    const locked = await page.evaluate(() => current.content);
    await listBoxes.nth(1).click({ force: true }).catch(() => {});
    assert.equal(await page.evaluate(() => current.content), locked, 'click under lock preserves the document');
    await page.locator('#lock-document').click();
    assert.equal(await listBoxes.nth(1).isDisabled(), false, 'unlock restores availability');

    assert.deepEqual(session.errors, []);
    console.log('PASS: raw projection tasks toggle exact marker bytes, including nested, duplicate, callout, undo/redo and lock.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
