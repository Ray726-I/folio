// Open the exact Markdown for the rendered block under a locator.
async function openMarkdown(target) {
  const page = target.page();
  await target.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: /^(Document|Table) menu$/ });
  const action = menu.getByRole('menuitem', { name: 'Edit Markdown', exact: true });
  await action.waitFor();
  if (await action.isDisabled()) { await page.keyboard.press('Escape'); return; }
  await action.click();
}
module.exports = { openMarkdown };
