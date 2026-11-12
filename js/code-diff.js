/* 编码 App 的纯逻辑层：文本对比 + 精确替换
 *
 * 为什么单独成文件：这两件事全是纯函数，出错的代价却最高 ——
 *   替换错位置会写坏整个文件，diff 算错会让人误判 AI 改了什么。
 * 放在这里可以用 node 直接压测（tools/test-code-diff.js），不必启动 Electron。
 *
 * 三个必须处理好的地方（都踩过）：
 *
 *   ① **行尾必须归一化。** Windows 上文件是 CRLF，而模型输出的 old/new 几乎总是 LF。
 *      直接 indexOf 会一条都匹配不上，表现是「AI 说的改动明明在文件里却报找不到」。
 *      所以比对前全文归一化成 \n，写回时再按原文件的行尾还原。
 *
 *   ② **old 必须唯一匹配。** 只替换第一处是错的：可能是别的地方那处一样的代码。
 *      匹配到多处就报错，让模型补上下文 —— 报错+重试比改错行便宜一个数量级。
 *
 *   ③ **行号前缀容错。** ws_read 返回的是「  12| code」这种带行号的预览，
 *      模型极容易连行号一起复制进 old。所以首match 失败时，剥掉行号再试一次；
 *      但必须**在剥掉后真的能匹配**才采用，且回一个 warning —— 不静默，
 *      否则会掩盖「模型看错了文件」这类真问题。
 *
 * 导出：浏览器挂 global.CodeDiff，node 走 module.exports（同 UMD 惯例）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CodeDiff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EOL_CRLF = /\r\n/;

  function eolOf(text){ return EOL_CRLF.test(text) ? '\r\n' : '\n'; }
  function toLF(text){ return String(text == null ? '' : text).replace(/\r\n/g, '\n'); }
  function fromLF(text, eol){ return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text; }

  /* 剥掉 ws_read 预览里的行号前缀（"  12| code" → "code"）。
   * 只在需要容错时才调用，不参与正常路径。 */
  function stripLineNumbers(text){
    return toLF(text).replace(/^[ \t]*\d+\| ?/gm, '');
  }

  /* 精确替换。返回 { ok, text, warning, error, hits }
   *   ok=false 时 error 是可以直接回给模型的话（说清了下一步该干什么）。 */
  function applyEdit(source, oldStr, newStr, opts){
    const o = opts || {};
    const src = String(source == null ? '' : source);
    let oldS = String(oldStr == null ? '' : oldStr);
    const newS = String(newStr == null ? '' : newStr);

    if (!oldS.length) {
      return { ok:false, error:'old 不能为空。如果你想新建文件，用 fs_new；要整体重写请用 fs_edit 给出足够的上下文。' };
    }

    const eol = eolOf(src);
    const text = toLF(src);
    let needle = toLF(oldS);
    let warning = '';

    let idx = text.indexOf(needle);
    let hits = idx < 0 ? 0 : 1;
    if (idx >= 0 && text.lastIndexOf(needle) !== idx) {
      hits = countOccurrences(text, needle);
      return {
        ok:false, hits:hits,
        error:'old 在文件里匹配到 ' + hits + ' 处，无法确定改哪一处。'
          + '请把 old 写长一点（带上前后各一两行独有的代码），保证只有一处匹配。'
      };
    }

    /* 容错：行号前缀。只在首次失败时尝试，且必须匹配成功才采用。 */
    if (idx < 0) {
      const stripped = stripLineNumbers(oldS);
      if (stripped !== toLF(oldS) && stripped.length) {
        const idx2 = text.indexOf(stripped);
        if (idx2 >= 0 && text.lastIndexOf(stripped) === idx2) {
          needle = stripped;
          idx = idx2;
          hits = 1;
          warning = '已自动去掉 old 里的行号前缀（ws_read 的「 12| 」只是预览标注，不属于文件内容）。';
        }
      }
    }

    if (idx < 0) {
      /* 给一条最有用的线索：old 的第一行在不在文件里。
       * 在 → 说明是后续行不匹配（模型记错了中间内容）；不在 → 说明它没读这个文件。 */
      const firstLine = needle.split('\n')[0].trim();
      const firstHit = firstLine ? text.indexOf(firstLine) : -1;
      const hintText = firstLine
        ? (firstHit >= 0
          ? 'old 的第一行在文件里能找到（第 ' + (text.slice(0, firstHit).split('\n').length) + ' 行），但整段对不上 —— 请先 ws_read 确认中间那几行的真实内容。'
          : 'old 的第一行在文件里根本找不到 —— 请不要凭想象写代码，先 ws_read 这个文件。')
        : '';
      return { ok:false, hits:0, error:'old 在文件里找不到。' + hintText };
    }

    const out = text.slice(0, idx) + toLF(newS) + text.slice(idx + needle.length);
    const res = { ok:true, text: fromLF(out, eol), warning, hits:1, at: idx };
    if (o.withLine) res.line = text.slice(0, idx).split('\n').length;
    return res;
  }

  function countOccurrences(hay, needle){
    let n = 0, i = 0;
    while (n < 999) {
      const j = hay.indexOf(needle, i);
      if (j < 0) break;
      n++;
      i = j + needle.length;
    }
    return n;
  }

  /* 行级 diff。先裁公共前后缀，再对中间做 LCS ——
   * 直接对全文 LCS 在几千行的文件上会占几十 MB，而编码改动几乎总是局部的。 */
  const LCS_BUDGET = 400000;   // 中间块 n*m 的上限，超了退化成整块替换

  function diffLines(oldText, newText, opts){
    const o = opts || {};
    const A = toLF(oldText).split('\n');
    const B = toLF(newText).split('\n');

    let pre = 0;
    const maxPre = Math.min(A.length, B.length);
    while (pre < maxPre && A[pre] === B[pre]) pre++;

    let suf = 0;
    const maxSuf = Math.min(A.length - pre, B.length - pre);
    while (suf < maxSuf && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;

    const ma = A.slice(pre, A.length - suf);
    const mb = B.slice(pre, B.length - suf);

    const rows = [];
    let added = 0, removed = 0;
    const push = (type, text) => {
      rows.push({ type, text });
      if (type === 'add') added++;
      else if (type === 'del') removed++;
    };

    /* 裁掉的前后缀要**原样放回 rows** —— 不然后面的上下文折叠拿不到它们，
     * 结果是 diff 只剩中间那一小段，人看不出改动在文件的哪个位置。
     * 别担心行数：紧跟其后的折叠逻辑会把连续 same 段压成一条 gap。 */
    for (let k = 0; k < pre; k++) push('same', A[k]);

    if (ma.length && mb.length && ma.length * mb.length <= LCS_BUDGET) {
      const ops = lcsOps(ma, mb);
      for (const op of ops) push(op.type, op.text);
    } else {
      /* 退化：一侧为空，或中间块太大。整块删除 + 整块新增，
       * 语义上仍然正确（结果一样），只是展示不够精细。 */
      for (const line of ma) push('del', line);
      for (const line of mb) push('add', line);
    }

    for (let k = A.length - suf; k < A.length; k++) push('same', A[k]);

    /* 行号在**完整 rows** 上算，不能在折叠后的 out 上算 ——
     * gap 代表跳过的若干行，把它当一行算会让行号越错越远。 */
    let ln = 1, firstChange = 0;
    for (const r of rows) {
      if ((r.type === 'add' || r.type === 'del') && !firstChange) firstChange = ln;
      if (r.type === 'add' || r.type === 'same') ln++;
    }

    /* 上下文：改动前后各留 CONTEXT 行，中间连续未改动的折叠成一条省略标记。
     * 不折叠的话，改一行会带出整个文件，人根本找不到那一行。 */
    const CONTEXT = o.context == null ? 2 : Math.max(0, o.context);
    const out = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i].type !== 'same') { out.push(rows[i]); i++; continue; }
      let j = i;
      while (j < rows.length && rows[j].type === 'same') j++;
      const run = j - i;
      const keepHead = i === 0 ? Math.min(run, CONTEXT) : CONTEXT;
      const keepTail = j === rows.length ? Math.min(run, CONTEXT) : CONTEXT;
      if (run <= keepHead + keepTail) {
        for (let k = i; k < j; k++) out.push(rows[k]);
      } else {
        for (let k = i; k < i + keepHead; k++) out.push(rows[k]);
        out.push({ type: 'gap', text: '… ' + (run - keepHead - keepTail) + ' 行未改动 …' });
        for (let k = j - keepTail; k < j; k++) out.push(rows[k]);
      }
      i = j;
    }

    /* 变更所在的行号（新文件侧），给界面做跳转用 */
    return {
      rows: out, added, removed, firstChange: firstChange || pre + 1,
      oldLines: A.length, newLines: B.length
    };
  }

  /* 标准 LCS 回溯。返回 [{type:'same'|'add'|'del', text}] */
  function lcsOps(a, b){
    const n = a.length, m = b.length;
    const W = m + 1;
    const dp = new Int32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      const row = i * W, next = (i + 1) * W;
      for (let j = m - 1; j >= 0; j--) {
        dp[row + j] = (a[i] === b[j])
          ? dp[next + j + 1] + 1
          : Math.max(dp[next + j], dp[row + j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ type:'same', text: a[i] }); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { ops.push({ type:'del', text: a[i] }); i++; }
      else { ops.push({ type:'add', text: b[j] }); j++; }
    }
    while (i < n) { ops.push({ type:'del', text: a[i] }); i++; }
    while (j < m) { ops.push({ type:'add', text: b[j] }); j++; }
    return ops;
  }

  /* 统一 diff 的可读文本版，用于塞进模型上下文或日志。
   * 与界面上的 diff 是**同一份数据**，避免「界面显示改了 3 行、模型以为改了 1 行」。 */
  function diffText(oldText, newText, opts){
    const d = diffLines(oldText, newText, opts);
    const body = d.rows.map(r => {
      if (r.type === 'add') return '+' + r.text;
      if (r.type === 'del') return '-' + r.text;
      if (r.type === 'gap') return r.text;
      return ' ' + r.text;
    });
    return { text: body.join('\n'), added: d.added, removed: d.removed, rows: d.rows };
  }

  return { applyEdit, diffLines, diffText, stripLineNumbers, toLF, eolOf };
});
