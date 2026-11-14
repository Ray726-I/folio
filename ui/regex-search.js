'use strict';
// Only this static function becomes worker code. User patterns travel as data.
function regexSearchWorker() {
  self.onmessage = ({ data }) => {
    try {
      const search = new RegExp(data.pattern, data.flags);
      if (data.replacement !== undefined) {
        self.postMessage({ content: data.source.replace(search, () => data.replacement) });
        return;
      }
      const matches = []; let match;
      while (matches.length < 2000 && (match = search.exec(data.source))) {
        matches.push({ from: match.index, to: match.index + match[0].length });
        if (!match[0].length) search.lastIndex += data.source.codePointAt(search.lastIndex) > 0xffff ? 2 : 1;
      }
      self.postMessage({ matches });
    } catch { self.postMessage({ error: 'Invalid regular expression' }); }
  };
}
class RegexSearch {
  cancel() { this.finish?.(null); }
  run(data) {
    this.cancel();
    return new Promise(resolve => {
      let worker, url, timer;
      const finish = result => {
        clearTimeout(timer); worker?.terminate();
        if (url) URL.revokeObjectURL(url);
        if (this.finish === finish) this.finish = null;
        resolve(result);
      };
      this.finish = finish;
      try {
        url = URL.createObjectURL(new Blob([`(${regexSearchWorker.toString()})()`], { type: 'text/javascript' }));
        worker = new Worker(url);
        worker.onmessage = event => finish(event.data);
        worker.onerror = event => { event.preventDefault(); finish({ error: 'Search unavailable. Try again.' }); };
        timer = setTimeout(() => finish({ error: 'Search took too long. Simplify the regular expression.' }), 500);
        worker.postMessage(data);
      } catch { finish({ error: 'Search unavailable. Try again.' }); }
    });
  }
}
