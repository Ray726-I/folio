const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
async function choose(page, query) {
  await page.locator('.editor-trailing-input').click();
  await page.keyboard.type('/' + query);
  await page.locator('.folio-slash-menu').waitFor({ state: 'visible' });
  await page.keyboard.press('Enter');
}
(async () => {
  let session = await openEditor('Body.\n');
  try {
    const { page } = session;
    await choose(page, 'code');
    const language = page.getByRole('textbox', { name: 'Code fence info' });
    await language.waitFor({state:'visible'});
    assert.equal(await language.getAttribute('placeholder'), 'Language');
    await page.keyboard.type('javascript'); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => !!getSelection()?.anchorNode?.parentElement?.closest('.code-surface')), true, 'caret visibly enters the code block');
    await page.keyboard.type('console.log(1)');
    assert.equal(await page.locator('.code-surface').innerText(), 'console.log(1)', 'typed code appears inside the block');
    assert.match(await page.evaluate(() => current.content), /```javascript\nconsole\.log\(1\)\n```/);
  } finally { await session.close(); }
  session = await openEditor('Before.\n\n```\n\n```\n\nAfter.\n');
  try {
    const { page } = session;
    const language = page.getByRole('textbox', { name: 'Code fence info' });
    await language.waitFor({ state: 'visible' });
    await language.fill('javascript'); await language.press('Enter');
    assert.equal(await page.evaluate(() => !!getSelection()?.anchorNode?.parentElement?.closest('.code-surface')), true, 'caret stays in a code block between paragraphs');
    await page.keyboard.type('console.log(1)');
    assert.match(await page.evaluate(() => current.content), /```javascript\nconsole\.log\(1\)\n```/);
    assert.equal(await page.locator('.code-surface').innerText(), 'console.log(1)');
  } finally { await session.close(); }
  session = await openEditor('Body.\n');
  try {
    const { page } = session;
    await choose(page, 'image');
    const input = page.locator('#editor-action-value');
    assert.equal(await input.isVisible(), true, 'image insertion offers a visible path field');
    assert.match(await input.getAttribute('placeholder'), /link|path/i);
    assert.equal(await input.evaluate(el => document.activeElement === el), true);
    await input.fill('images/my picture.png'); await page.locator('#editor-action-form button[type=submit]').click();
    assert.match(await page.evaluate(() => current.content), /!\[image\]\(<images\/my picture\.png>\)/);
  } finally { await session.close(); }
  session = await openEditor('Body.\n');
  try {
    const { page } = session;
    await choose(page, 'math');
    const input = page.locator('#editor-action-value');
    assert.equal(await input.isVisible(), true, 'math insertion offers a visible formula field');
    assert.match(await input.getAttribute('placeholder'), /formula|latex/i);
    await input.fill('a^2+b^2'); await page.locator('#editor-action-form button[type=submit]').click();
    assert.match(await page.evaluate(() => current.content), /\$\$\na\^2\+b\^2\n\$\$/);
  } finally { await session.close(); }
  session = await openEditor('Body.\n');
  try {
    const { page } = session;
    await choose(page, 'mermaid');
    const input = page.locator('#editor-action-value');
    assert.equal(await input.isVisible(), true, 'diagrams open an editable template');
    await input.fill('graph TD\n A --> B'); await page.locator('#editor-action-form button[type=submit]').click();
    assert.match(await page.evaluate(() => current.content), /```mermaid\ngraph TD\n A --> B\n```/);
  } finally { await session.close(); }
  session = await openEditor('Body.\n');
  try {
    const { page } = session;
    await choose(page, 'image');
    await page.locator('#editor-action-cancel').click();
    assert.equal(await page.evaluate(() => current.content), 'Body.\n\n/image', 'cancel keeps the typed slash text');
    assert.equal(await page.locator('.image-widget').count(), 0, 'cancel inserts no placeholder image');
  } finally { await session.close(); }
  console.log('PASS: slash insertions focus visible, usable code, image, and formula inputs');
})().catch(error => { console.error(error); process.exitCode = 1; });
