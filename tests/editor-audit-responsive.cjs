const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

async function drawerState(page) {
  return page.evaluate(() => {
    const drawer = document.getElementById('outline');
    const head = drawer.querySelector('.sidebar-head');
    const header = document.querySelector('.headerbar');
    const drawerRect = drawer.hidden ? null : drawer.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    return {
      hidden: drawer.hidden,
      top: drawerRect?.top ?? null,
      headerBottom: headerRect.bottom,
      headTop: head.getBoundingClientRect().top,
      closeVisible: (() => {
        const close = document.getElementById('outline-close');
        const rect = close.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(hit && hit.closest('#outline'));
      })(),
    };
  });
}

(async () => {
  // Narrow windows start with the dock closed, and opening it places the
  // drawer below the real chrome with a reachable close control.
  for (const width of [600, 760]) {
    const session = await openEditor('# Title\n\nA paragraph.\n\n- one\n', { width, height: 700 });
    try {
      const { page, errors } = session;
      await page.waitForTimeout(300);
      const closed = await drawerState(page);
      assert.equal(closed.hidden, true, `${width}px starts with the dock closed`);
      await page.evaluate(() => document.querySelector('[data-dock-tab="outline"]').click());
      await page.waitForTimeout(250);
      const open = await drawerState(page);
      assert.equal(open.hidden, false, `${width}px opens the dock on demand`);
      assert.ok(open.top >= open.headerBottom - 1, `${width}px drawer starts below the header`);
      assert.equal(open.closeVisible, true, `${width}px drawer close control is reachable`);
      assert.deepEqual(errors, []);
    } finally { await session.close(); }
  }

  // Wide windows keep the dock open.
  {
    const session = await openEditor('# Title\n\nA paragraph.\n', { width: 1180, height: 800 });
    try {
      const { page } = session;
      await page.waitForTimeout(300);
      const state = await drawerState(page);
      assert.equal(state.hidden, false, 'the wide layout shows the outline');
    } finally { await session.close(); }
  }

  // Empty documents show a quiet prompt; zero words shows no reading time.
  {
    const session = await openEditor('', { width: 1000, height: 760 });
    try {
      const { page } = session;
      await page.waitForTimeout(350);
      const empty = await page.evaluate(() => ({
        prompt: getComputedStyle(document.querySelector('.ProseMirror > p'), '::before').content,
        reading: document.getElementById('reading-time').textContent,
      }));
      assert.ok(empty.prompt.includes('Start writing, or type / for blocks'), 'an empty document shows a prompt');
      assert.equal(empty.reading, '', 'zero words does not claim a one-minute read');
      await page.keyboard.type('Hello');
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.ProseMirror > p'), '::before').content), 'none', 'the prompt disappears once writing starts');
    } finally { await session.close(); }
  }

  // Inspect Markdown opens at the top of a document-wide snapshot.
  {
    const session = await openEditor('# H\n\n' + 'A paragraph.\n\n'.repeat(80), { width: 1000, height: 760 });
    try {
      const { page } = session;
      await page.evaluate(() => document.getElementById('source-snapshot').click());
      await page.waitForTimeout(250);
      const snapshot = await page.evaluate(() => {
        const input = document.getElementById('source-snapshot-text');
        return { scrollTop: input.scrollTop, start: input.selectionStart };
      });
      assert.equal(snapshot.scrollTop, 0, 'the snapshot opens at the top');
      assert.equal(snapshot.start, 0, 'the snapshot opens without selecting the tail');
    } finally { await session.close(); }
  }

  console.log('PASS: narrow docks open below the chrome and stay reachable, empty documents are legible, and snapshots open at the top.');
})().catch(error => { console.error(error); process.exit(1); });
