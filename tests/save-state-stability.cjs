const assert=require('node:assert/strict');
const {openEditor}=require('./editor-browser.cjs');
(async()=>{
 const session=await openEditor('# Title\n\nA paragraph.\n');
 try{
  const {page}=session;
  const geometry=()=>page.evaluate(()=>Object.fromEntries(['save','document-mode-button','view-menu-button','document-more-button'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return[id,{x:r.x,width:r.width}];})));
  for(const width of [1400,1180,890,600,460]){
   await page.setViewportSize({width,height:800});
   await page.evaluate(()=>setOutline(false));
   await page.keyboard.press('Control+s');
   await page.waitForFunction(()=>current.content===current.saved&&!busy);
   const clean=await geometry();
   assert.equal(await page.locator('#save').isVisible(),true);
   assert.equal(await page.locator('#save-state').evaluate(n=>getComputedStyle(n).clipPath),'inset(50%)');
   assert.match(await page.locator('#save').getAttribute('title'),/saved/i);
   await page.locator('#preview p').click();await page.keyboard.press('End');await page.keyboard.type(' edit');
   assert.match(await page.locator('#save').getAttribute('aria-label'),/unsaved changes/i);
   const dirty=await geometry();
   for(const id of Object.keys(clean)){
    assert.ok(Math.abs(clean[id].x-dirty[id].x)<1.5,`${id} stays in place at ${width}`);
    assert.equal(dirty[id].width,clean[id].width);
   }
   assert.ok(dirty.save.width<=44);
   for(const [state,label] of [['saving','Saving'],[{error:'Disk is full'},'Save failed']]){
    await page.evaluate(state=>{saveStatus=state;updateTitle();},state);
    assert.match(await page.locator('#save').getAttribute('title'),new RegExp(label,'i'));
    assert.equal((await geometry()).save.width,clean.save.width);
    assert.equal(await page.locator('#save-state').evaluate(n=>getComputedStyle(n).clipPath),'inset(50%)');
   }
   await page.evaluate(()=>{saveStatus=null;updateTitle();});
   await page.locator('#save').click();
   await page.waitForFunction(()=>current.content===current.saved&&!busy);
  }
  // Dismissing the external-change banner must stick until the file settles.
  await page.evaluate(async()=>{
   const original=window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke=(cmd,args)=>cmd==='document_changed'?Promise.resolve(true):original(cmd,args);
   await checkDiskChange();
  });
  assert.equal(await page.locator('#disk-banner').isVisible(),true,'an external change raises the banner');
  await page.locator('#dismiss-disk').click();
  await page.evaluate(()=>checkDiskChange());
  assert.equal(await page.locator('#disk-banner').isVisible(),false,'dismissing the banner survives the next disk poll');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'reader-scroll','dismissing the banner returns focus to the document');
  assert.deepEqual(session.errors,[]);
 }finally{await session.close();}
 console.log('PASS: icon-only save state is accessible, actionable and stable at every toolbar width');
})().catch(e=>{console.error(e);process.exitCode=1;});
