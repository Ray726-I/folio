'use strict';
// Shell affordances stay outside the editor's source ledger and copied content.
function fuzzyFileScore(query, value) {
  if (!query) return 0;
  const text=value.toLocaleLowerCase(); let cursor=0, score=0, previous=-2;
  for(const character of query) {
    const at=text.indexOf(character,cursor); if(at<0)return -1;
    score+=at===previous+1?8:1; if(at===0||/[\s/\\._-]/.test(text[at-1]))score+=5;
    previous=at;cursor=at+1;
  }
  return score-text.length/1000;
}
function quickOpenCommands() {
  const rows=new Map();
  for(const doc of documents.values())rows.set(pathKey(doc.path||doc.documentId),{label:doc.name,detail:doc.path||'Unsaved document',icon:'file',action:()=>enqueue(()=>activateDocument(doc))});
  for(const entry of folderEntries)if(!entry.directory&&!rows.has(pathKey(entry.path)))rows.set(pathKey(entry.path),{label:entry.name,detail:entry.path,icon:'file',action:()=>requestOpen(entry.path)});
  return [...rows.values()];
}
function initializeTabScrolling() {
  const list=$('tab-list');
  const buttons=[];
  for(const [id,label,direction] of [['tab-scroll-previous','Scroll tabs left',-1],['tab-scroll-next','Scroll tabs right',1]]) {
    const button=document.createElement('button');button.id=id;button.className='icon-button tab-scroll';button.type='button';button.textContent=direction<0?'‹':'›';button.title=label;button.setAttribute('aria-label',label);
    button.onclick=()=>list.scrollBy({left:direction*Math.max(120,list.clientWidth*.7),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    direction<0?list.before(button):list.after(button);buttons.push(button);
  }
  const update=()=>{const overflow=list.scrollWidth>list.clientWidth+1;buttons.forEach(button=>button.hidden=!overflow);buttons[0].disabled=list.scrollLeft<=1;buttons[1].disabled=list.scrollLeft+list.clientWidth>=list.scrollWidth-1;};
  list.addEventListener('scroll',update,{passive:true});new ResizeObserver(update).observe(list);new MutationObserver(()=>requestAnimationFrame(update)).observe(list,{childList:true});update();
}
function initializeDocumentAffordances() {
  // Contextual selection toolbar: inline marks first, then links, then block
  // formatting, then the block-insertion overflow. It exists only while text
  // is selected in Edit mode; Folio keeps no persistent formatting chrome.
  const bubble=document.createElement('div');
  bubble.className='selection-format';bubble.setAttribute('role','toolbar');bubble.setAttribute('aria-label','Format selection');bubble.hidden=true;
  const FORMAT_ACTIONS=[
    { id:'bold',command:'bold',icon:'i-bold',label:'Bold',shortcut:'Ctrl+B',mark:'strong',group:1 },
    { id:'italic',command:'italic',icon:'i-italic',label:'Italic',shortcut:'Ctrl+I',mark:'em',group:1 },
    { id:'strike',command:'strike',icon:'i-strike',label:'Strikethrough',mark:'strike',group:1 },
    { id:'code',command:'code',icon:'i-code',label:'Inline code',mark:'code',group:1 },
    { id:'link',command:'link',icon:'i-link',label:'Link',group:2 },
    { id:'quote',command:'quote',icon:'i-quote',label:'Blockquote',group:3,block:true },
    { id:'bullet',command:'bullet',icon:'i-list-bullet',label:'Bulleted list',group:3,block:true },
    { id:'numbered',command:'numbered',icon:'i-list-ordered',label:'Numbered list',group:3,block:true },
    { id:'more',icon:'i-more',label:'More formatting',group:4,overflow:true },
  ];
  const formatButtons=new Map();
  let lastGroup=0;
  for(const action of FORMAT_ACTIONS) {
    if(action.group!==lastGroup&&lastGroup) {
      const rule=document.createElement('span');rule.className='selection-format-separator';rule.setAttribute('aria-hidden','true');bubble.append(rule);
    }
    lastGroup=action.group;
    const button=document.createElement('button');
    button.type='button';button.className='selection-format-button';button.dataset.action=action.id;
    button.setAttribute('aria-label',action.label);
    button.title=action.shortcut?`${action.label} (${action.shortcut})`:action.label;
    button.innerHTML=`<svg class="icon" aria-hidden="true"><use href="#${action.icon}"/></svg>`;
    if(action.mark) button.setAttribute('aria-pressed','false');
    if(action.overflow) button.setAttribute('aria-haspopup','menu');
    button.addEventListener('pointerdown',event=>{event.preventDefault();editor?.captureSelection?.();});
    button.addEventListener('click',()=>{
      if(!documentWritable())return;
      if(action.overflow) { editor?.openBlockMenu?.(button.getBoundingClientRect()); return; }
      editor?.command(action.command,action.id==='link'?{select:'label'}:undefined);
      // A command can move the logical range while the native selection stays
      // collapsed (for example Link selects the URL placeholder). Re-assert the
      // range so the bubble stays anchored to visible text.
      const logical=editor?.getSelection?.();
      if(logical&&logical.anchor!==logical.head&&(!getSelection()||getSelection().isCollapsed))editor?.selectRange?.(logical.anchor,logical.head,true);
      // Keep the bubble mounted after formatting and refresh its state right
      // away; the source-ledger round trip may settle asynchronously, so the
      // next frame re-reads it and re-measures the anchor as well.
      refreshFormatState();
      requestAnimationFrame(()=>{refreshFormatState();schedule();});
    });
    formatButtons.set(action.id,button);
    bubble.append(button);
  }
  document.body.append(bubble);
  function hideFormatToolbar(){ if(!bubble.hidden) bubble.hidden=true; }
  function refreshFormatState(){
    if(bubble.hidden)return;
    const writable=documentWritable();
    const context=writable?editor?.context?.():null;
    const locked=!writable||Boolean(context?.code);
    for(const action of FORMAT_ACTIONS) {
      const button=formatButtons.get(action.id);
      if(!button)continue;
      if(action.mark) {
        const active=Boolean(context?.marks?.includes(action.mark));
        const mixed=Boolean(context?.mixed?.includes(action.mark));
        button.setAttribute('aria-pressed',String(active||mixed));
        if(mixed)button.dataset.mixed='true';else delete button.dataset.mixed;
        button.setAttribute('aria-label',mixed?`${action.label} (partially applied)`:action.label);
        button.disabled=locked;
      } else if(action.block) {
        // Block syntax cannot render inside a code block or a table cell.
        button.disabled=locked||Boolean(context?.table);
      } else {
        button.disabled=!writable||Boolean(context?.code);
      }
    }
  }
  let bubbleFrame=0;
  const updateBubble=()=>{
    bubbleFrame=0;const selection=getSelection();
    if(documentMode!=='edit'||!documentWritable()||!selection||selection.isCollapsed||!$('preview').contains(selection.anchorNode)||!$('preview').contains(selection.focusNode)||selection.anchorNode.parentElement?.closest('pre,.code-container,.folio-source-edit')){hideFormatToolbar();return;}
    if(!selection.rangeCount) { hideFormatToolbar(); return; }
    const range=selection.getRangeAt(0);
    // Anchor to the first line of the selection, not the union rectangle of a
    // tall multiline range, so the toolbar tracks what the eye reads first.
    const rects=[...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0);
    const first=rects[0]||range.getBoundingClientRect();
    if(!first.width||!first.height||first.bottom<0||first.top>innerHeight){hideFormatToolbar();return;}
    bubble.hidden=false;
    const width=bubble.offsetWidth,height=bubble.offsetHeight,gap=9,margin=8;
    // Pane-aware: the reader pane's box already excludes the companion pane,
    // so the toolbar can never overlap the adjacent preview. When the pane is
    // narrower than the toolbar itself, fall back to the window so the
    // controls are never clipped.
    const pane=$('reader-scroll').getBoundingClientRect();
    const fitsPane=pane.width-margin*2>=width;
    const minLeft=fitsPane?pane.left+margin:Math.max(8,Math.min(pane.left,innerWidth-width-8));
    const maxLeft=fitsPane?pane.right-margin-width:Math.min(pane.right-margin-width,innerWidth-width-8);
    const center=first.left+first.width/2;
    const left=Math.max(minLeft,Math.min(maxLeft,center-width/2));
    const above=first.top-gap-height,below=first.bottom+gap;
    const useBelow=above<pane.top+margin&&below+height<=pane.bottom-margin;
    const top=Math.max(pane.top+margin,Math.min(pane.bottom-margin-height,useBelow?below:above));
    bubble.style.left=`${Math.round(left)}px`;
    bubble.style.top=`${Math.round(top)}px`;
    bubble.dataset.side=useBelow?'below':'above';
    const pointer=Math.max(14,Math.min(width-14,center-left));
    bubble.style.setProperty('--pointer-left',`${Math.round(pointer)}px`);
    refreshFormatState();
  };
  const schedule=()=>{if(!bubbleFrame)bubbleFrame=requestAnimationFrame(updateBubble);};
  document.addEventListener('selectionchange',schedule);window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);
  new MutationObserver(schedule).observe(root,{attributes:true,attributeFilter:['data-document-mode']});
  bubble.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();hideFormatToolbar();editor?.focus();}};
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||bubble.hidden)return;
    if(document.querySelector('dialog[open]'))return;
    // An open picker or table menu owns Escape; it closes itself and restores
    // focus.
    if(document.querySelector('.folio-slash-menu, .folio-table-menu'))return;
    event.preventDefault();hideFormatToolbar();editor?.focus();
  },true);
  const progress=document.createElement('span');progress.id='reading-progress';progress.setAttribute('aria-label','Reading progress');$('statusbar').querySelector('.status-start').append(progress);
  const updateProgress=()=>{const scroller=$(focusedPane==='companion'?'companion-scroll':'reader-scroll'),range=scroller.scrollHeight-scroller.clientHeight;progress.hidden=!current.active||documentMode==='source'||range<scroller.clientHeight;progress.textContent=` · ${Math.round(range>0?100*scroller.scrollTop/range:100)}%`;};
  for(const id of ['reader-scroll','companion-scroll'])$(id).addEventListener('scroll',updateProgress,{passive:true});new ResizeObserver(updateProgress).observe($('preview'));updateProgress();
  // Chrome is never part of document selection. During cross-pane drags the
  // other reading surface is excluded as well, then restored at gesture end.
  let selectionOwner=null, selectionPoint=null;
  const constrainSelection=()=>{
    const selection=getSelection(),owner=selectionOwner;
    if(!owner?.isConnected||!selection?.anchorNode||!owner.contains(selection.anchorNode)||owner.contains(selection.focusNode))return;
    const scroll=owner.closest('#reader-scroll,#companion-scroll'),box=scroll.getBoundingClientRect();
    const x=Math.max(box.left+2,Math.min(box.right-18,selectionPoint?.x??box.right-18));
    const y=Math.max(box.top+2,Math.min(box.bottom-2,selectionPoint?.y??box.bottom-2));
    let caret=document.caretRangeFromPoint?.(x,y);
    if(!caret&&document.caretPositionFromPoint){const position=document.caretPositionFromPoint(x,y);if(position){caret=document.createRange();caret.setStart(position.offsetNode,position.offset);}}
    if(!caret||!owner.contains(caret.startContainer)){caret=document.createRange();caret.selectNodeContents(owner);caret.collapse((selectionPoint?.y??0)<box.top);}
    selection.setBaseAndExtent(selection.anchorNode,selection.anchorOffset,caret.startContainer,caret.startOffset);
  };
  document.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.target.closest?.('input,textarea,button,select'))return;
    const owner=event.target.closest?.('#preview,#companion-preview');
    if(owner){selectionOwner=owner;selectionPoint={x:event.clientX,y:event.clientY};document.body.dataset.selectionPane=owner.closest('#reader-scroll,#companion-scroll').id;}
  },true);
  document.addEventListener('pointermove',event=>{if(selectionOwner){selectionPoint={x:event.clientX,y:event.clientY};constrainSelection();}},{passive:true});
  document.addEventListener('selectionchange',constrainSelection);
  const endSelection=()=>{constrainSelection();selectionOwner=null;selectionPoint=null;delete document.body.dataset.selectionPane;};
  window.addEventListener('pointerup',endSelection);window.addEventListener('pointercancel',endSelection);window.addEventListener('blur',endSelection);
}
function initializeSearchOptions() {
  const options=document.createElement('div');options.className='find-options';options.setAttribute('role','group');options.setAttribute('aria-label','Find options');
  for(const [id,label,text] of [['find-case','Match case','Aa'],['find-word','Match whole word','W'],['find-regex','Use regular expression','.*']]) {
    const button=document.createElement('button');button.id=id;button.type='button';button.className='find-option';button.textContent=text;button.title=label;button.setAttribute('aria-label',label);button.setAttribute('aria-pressed','false');
    button.onclick=()=>{button.setAttribute('aria-pressed',String(button.getAttribute('aria-pressed')!=='true'));updateFind();};options.append(button);
  }
  $('find-input').after(options);
}
function parseFolderSearch(input) {
  const include=[], exclude=[]; let hasFilters=false;
  const text=input.replace(/(^|\s)(-?in:)(?:"([^"]*)"|(\S+))/gi, (match,space,operator,quoted,bare)=>{
    const value=quoted ?? bare;
    if(!value)return match;
    (operator[0]==='-'?exclude:include).push(value); hasFilters=true;
    return '';
  });
  return {query:hasFilters?text.trim():text,include:include.join(','),exclude:exclude.join(',')};
}
function folderPathAllowed(path, folder, options=parseFolderSearch($('folder-search-input').value)) {
  const relative=path.slice(folder.length).replace(/^[/\\]/,'').replaceAll('\\','/');
  const match=pattern=>{const escaped=pattern.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*');return new RegExp(escaped,'i').test(relative);};
  const includes=options.include.split(',').map(s=>s.trim()).filter(Boolean),excludes=options.exclude.split(',').map(s=>s.trim()).filter(Boolean);
  return (!includes.length||includes.some(match))&&!excludes.some(match);
}

initializeSearchOptions();
initializeTabScrolling();
initializeDocumentAffordances();

// Keep table guides visual only: never touch the Markdown or selection.
function initializeTableColumnGuides() {
  let paintedTable = null;
  const syncCaret = () => {
    const focus = document.activeElement, anchor = getSelection()?.anchorNode;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement;
    const table = focus?.closest?.('#preview .ProseMirror[contenteditable="true"]') ? element?.closest('table') : null;
    const next = table?.closest('#preview') && table.isConnected ? table : null;
    if (paintedTable === next) return;
    paintedTable?.classList.remove('folio-column-guides');
    paintedTable = next;
    paintedTable?.classList.add('folio-column-guides');
  };
  document.addEventListener('selectionchange', syncCaret);
  document.addEventListener('focusin', syncCaret);
  document.addEventListener('focusout', () => requestAnimationFrame(syncCaret));
}
initializeTableColumnGuides();
