const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:900,height:700}});
  try {
    const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"%3E%3Crect width="1600" height="900" fill="red"/%3E%3C/svg%3E';
    await page.setContent(`<article id="preview" class="markdown"><span class="image-widget" contenteditable="false"><img alt="Example image" src='${image}'></span><span class="image-widget"><img alt="Broken image" src="data:image/png;base64,broken"></span></article>`);
    await page.addStyleTag({path:path.resolve('ui/styles.css')});
    await page.addStyleTag({path:path.resolve('ui/diagram-viewer.css')});
    await page.addScriptTag({path:path.resolve('ui/diagram-viewer.js')});
    const host = page.locator('.image-widget').first();
    const expand = host.getByRole('button',{name:'Expand image'});
    await expand.waitFor({timeout:3000});
    assert.equal(await expand.evaluate(el=>getComputedStyle(el).opacity),'0');
    await host.hover(); assert.equal(await expand.evaluate(el=>getComputedStyle(el).opacity),'1');
    assert.equal(await page.locator('.image-widget').nth(1).getByRole('button',{name:'Expand image'}).count(),0,'broken images have no expand action');
    await expand.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog',{name:'Expanded image'}); await dialog.waitFor();
    assert.equal(await dialog.locator('img').getAttribute('alt'),'Example image');
    const picture=dialog.locator('img'); const fitWidth=await picture.evaluate(el=>el.getBoundingClientRect().width);
    await dialog.getByRole('button',{name:'Actual size'}).click();
    assert.ok(await picture.evaluate(el=>el.getBoundingClientRect().width)>fitWidth);
    await dialog.getByRole('button',{name:'Fit image'}).click();
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    assert.equal(await expand.evaluate(el=>el===document.activeElement),true,'focus returns to the image action');
    await expand.click(); await dialog.waitFor();
    await host.locator('img').evaluate(el=>el.remove());
    await dialog.waitFor({state:'hidden'});
  } finally { await browser.close(); }
  const session = await openEditor('Text.\n');
  try {
    const { page } = session;
    await page.evaluate(() => {
      const invoke = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = (command, args) => command === 'render_markdown' && args.content.startsWith('![image](')
        ? Promise.resolve({html: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aao8AAAAASUVORK5CYII=" alt="image">'})
        : invoke(command, args);
      editor.replaceContent('![Landscape](local.png)\n');
    });
    const image = page.locator('#preview .image-widget img'); await image.waitFor();
    const expand = page.getByRole('button', {name:'Expand image'}); await expand.waitFor({timeout:3000});
    const before = await page.evaluate(() => current.content);
    await expand.click(); const dialog = page.getByRole('dialog',{name:'Expanded image'}); await dialog.waitFor();
    assert.equal(await dialog.locator('img').getAttribute('alt'),'Landscape');
    assert.equal(await page.evaluate(() => current.content), before, 'opening the viewer never changes Markdown');
    await dialog.getByRole('button',{name:'Close image'}).click();
    assert.deepEqual(session.errors, []);
    console.log('PASS: image expansion supports hover, fit, zoom, focus, cleanup and editor integrity');
  } finally { await session.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
