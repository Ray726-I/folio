'use strict';
// Folder contents search owns its sidebar; Ctrl+F keeps its document-only scope.
let grepEpoch = 0, grepTimer, grepResultsFolder = null;
function clearFolderSearch() {
  ++grepEpoch; clearTimeout(grepTimer); grepResultsFolder = null;
  $('folder-search-input').value = ''; $('folder-search-results').replaceChildren();
  $('folder-search-status').textContent = 'Type to search folder contents.';
  $('folder-search-root').textContent = activeFolder?.name || '';
}
function openFolderSearch() {
  if (!activeFolder) { openFind(); return; }
  if (grepResultsFolder && !samePath(grepResultsFolder, activeFolder.path)) clearFolderSearch();
  dockTab = 'search'; dockVisible = true; outlineVisible = false; folderVisible = false;
  $('folder-search-root').textContent = activeFolder.name;
  $('folder-search-root').title = activeFolder.path;
  renderNavigationDock(); $('folder-search-input').focus();
}
function folderBufferHits(query, document) {
  const results = [], needle = query.toLowerCase(); let offset = 0;
  for (const [index, line] of document.content.split('\n').entries()) {
    if (line.toLowerCase().includes(needle)) {
      const span = foldedSearchSpan(line, query);
      const start = Math.max(0, (span?.from || 0) - 40);
      results.push({ path: document.path, name: document.name, line: index + 1, offset, length: line.length, snippet: line.slice(start, start + 180), buffer: document.content });
      if (results.length > 100) break;
    }
    offset += line.length + 1;
  }
  return results;
}
function foldedSearchSpan(text, query) {
  const needle = query.toLowerCase(), at = text.toLowerCase().indexOf(needle);
  if (at < 0 || !needle) return null;
  const ranges = []; let offset = 0;
  for (const character of text) {
    for (let i = 0; i < character.toLowerCase().length; i++) ranges.push([offset, offset + character.length]);
    offset += character.length;
  }
  return { from: ranges[at][0], to: ranges[at + needle.length - 1][1] };
}
async function searchFolderContents() {
  const epoch = ++grepEpoch, folder = activeFolder?.path, options = parseFolderSearch($('folder-search-input').value), {query, include, exclude} = options;
  const results = $('folder-search-results'), status = $('folder-search-status');
  results.replaceChildren();
  if (!folder || !query) { status.textContent = 'Type to search folder contents.'; return; }
  grepResultsFolder = folder; status.textContent = 'Searching…';
  try {
    const response = await invoke('search_folder', { query, include, exclude });
    if (epoch !== grepEpoch || activeFolder?.path !== folder) return;
    let hits = response?.results || [], limited = Boolean(response?.truncated);
    if (current.active && isWithin(current.path || '', folder)) {
      hits = hits.filter(hit => !samePath(hit.path, current.path)).concat(folderPathAllowed(current.path,folder,options)?folderBufferHits(query, current):[]);
      if (hits.length > 100) { limited = true; hits = hits.slice(0, 100); }
    }
    hits=hits.filter(hit=>folderPathAllowed(hit.path,folder,options));
    const groups = new Map();
    for (const hit of hits) {
      if (!groups.has(hit.path)) {
        const group = document.createElement('section'), title = document.createElement('h3');
        group.className = 'grep-file'; title.textContent = hit.path.slice(folder.length).replace(/^[/\\]/, '') || hit.name;
        title.title = hit.path; group.append(title); results.append(group); groups.set(hit.path, group);
      }
      const button = document.createElement('button'); button.className = 'grep-match';
      const line = document.createElement('span'), snippet = document.createElement('span');
      line.className = 'grep-line'; line.textContent = String(hit.line || 1);
      snippet.className = 'grep-snippet';
      const text = hit.snippet || '', span = foldedSearchSpan(text, query);
      if (span) {
        const mark = document.createElement('mark'); mark.textContent = text.slice(span.from, span.to);
        snippet.append(document.createTextNode(text.slice(0, span.from)), mark, document.createTextNode(text.slice(span.to)));
      } else snippet.textContent = text;
      button.append(line, snippet); button.title = `${hit.name}:${hit.line || 1} · ${text}`;
      button.onclick = async () => {
        if (activeFolder?.path !== folder) return;
        const opened = samePath(current.path || '', hit.path) ? true : await enqueue(() => activeFolder?.path === folder && openPath(hit.path));
        if (!opened || !samePath(current.path || '', hit.path)) return;
        const owner = current, snapshot = current.content;
        let stale = (hit.buffer !== undefined && hit.buffer !== snapshot) || (hit.buffer === undefined && dirty());
        if (hit.buffer === undefined && hit.fingerprint) {
          try {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
            const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            stale ||= fingerprint !== hit.fingerprint;
          } catch { stale = true; }
        }
        if (current !== owner || current.content !== snapshot) return;
        if (stale) {
          await searchFolderContents();
          if (activeFolder?.path === folder) status.textContent = 'Results refreshed after edits. Select a matching line.';
          return;
        }
        const offset = Math.min(current.content.length, Math.max(0, Number(hit.offset) || 0));
        const match = findMatches(query).find(match => match.from >= offset && match.from <= offset + (Number(hit.length) || text.length));
        jumpToSource(match?.from ?? offset);
        if (match && documentMode !== 'source') { editor?.selectRange(match.from, match.to); editor?.highlightRange?.(match.from, match.to); }
      };
      groups.get(hit.path).append(button);
    }
    status.textContent = `${hits.length} matching ${hits.length === 1 ? 'line' : 'lines'} in ${groups.size} ${groups.size === 1 ? 'file' : 'files'}`
      + (limited ? ' · Search limited; narrow your query. Some files or results were skipped.' : '');
  } catch (error) { if (epoch === grepEpoch && activeFolder?.path === folder) status.textContent = errorMessage(error); }
}
function initializeFolderSearch() {
  $('folder-search-input').addEventListener('input', () => {
    ++grepEpoch; clearTimeout(grepTimer);
    // Remove stale clickable results immediately while the next query is pending.
    $('folder-search-results').replaceChildren();
    $('folder-search-status').textContent = $('folder-search-input').value ? 'Searching…' : 'Type to search folder contents.';
    grepTimer = setTimeout(searchFolderContents, 180);
  });
  $('folder-search-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); clearTimeout(grepTimer); void searchFolderContents(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dockVisible = false; renderNavigationDock(); document.querySelector('[data-rail-action="find"]').focus(); }
  });
  $('folder-search-close').onclick = () => { dockVisible = false; renderNavigationDock(); document.querySelector('[data-rail-action="find"]').focus(); };
}
