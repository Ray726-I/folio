const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async()=>{
 const source='---\ntitle: Example\n---\n\n> [!NOTE]\n> A note callout.\n\nTerm\n: Definition\n\n![Alt](local.png)\n\nAfter.\n';
 const session=await openEditor(source);
 try{
  const {page}=session;
  await page.locator('.extension-preview').first().waitFor({state:'attached'});
  await page.locator('.extension-block').last().hover();
  assert.equal(await page.locator('.extension-edit,.extension-source-editor,.extension-actions').count(),0,'no source buttons or separate source panels remain');
  assert.equal(await page.getByRole('button',{name:/edit (source|front matter|image)/i}).count(),0);
  await page.locator('.extension-preview').first().dblclick();
  await page.locator('.folio-source-edit').waitFor();
  assert.match(await page.locator('.folio-source-edit').textContent(), /title: Example/);
  await page.keyboard.press('Escape');
  await page.locator('.extension-preview').filter({hasText:'A note callout.'}).dblclick();
  assert.match(await page.locator('.folio-source-edit').textContent(), /> \[!NOTE\]/);
  await page.keyboard.press('Escape');
  await page.locator('.extension-preview').filter({hasText:'Definition'}).focus();
  await page.keyboard.press('F2');
  await page.locator('.folio-source-edit').waitFor();
  assert.match(await page.locator('.folio-source-edit').textContent(), /Term\n: Definition/);
  assert.equal(await page.evaluate(()=>current.content),source);
  assert.deepEqual(session.errors,[]);
 }finally{await session.close();}
 console.log('PASS: no source edit buttons; front matter/callouts/definitions keep shared-source editing');
})().catch(e=>{console.error(e);process.exitCode=1;});
