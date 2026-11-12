/* 编码工作区：把「一个文件夹」变成可安全读写的工作区
 *
 * 三条设计（都是这个能力真正的风险点，改动前先读）：
 *
 *   ① **沙箱在 resolve 之后判，不在之前判。**
 *      光看 rel 里有没有 '..' 是拦不住的：'a/../../b' 归一化后跑出去，
 *      软链接指向工作区外更看不出来，Windows 上还有盘符跨区。
 *      所以流程固定是 resolve → 比前缀 → 对已存在的路径再 realpath 一次（防软链逃逸）。
 *      只比较字符串会让 'C:\work2' 通过 'C:\work' 的前缀检查，所以补一个分隔符。
 *
 *   ② **写盘用「预期哈希」做乐观锁，不留 .bak。**
 *      编辑期间文件可能被别的工具（git checkout / 格式化 / 另一个编辑器）改过。
 *      带 .bak 备份是垃圾：用户不知道该用哪个，而工作区里堆满 .bak 更难处理。
 *      改成读的时候返回 sha1，写的时候带上，不匹配就拒绝 —— 人重新载入再决定，
 *      这正是「人确认才落盘」该有的样子。
 *
 *   ③ **搜索故意不做索引。**
 *      索引会过期，而这个场景最不能容忍的就是「搜索结果是旧的」。
 *      线性扫 + 严格上限（文件数 / 单文件大小 / 命中数），宁可少给也不给错的。
 *
 * 路径口径：所有接口的 rel 都相对工作区根；返回给渲染层的路径一律相对，绝对路径不外泄。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/* 默认不进树的目录：不是"用户不想看"，是"看不动"。
 * node_modules 动辄几万个文件，递归一次能把界面卡死；dist* 是本项目的构建产物。
 * 这些目录仍然可以手动展开（list 不拦），只是不参与搜索、且树里默认折叠。 */
const HEAVY_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-run', 'dist-setup', '.workbuddy', '__pycache__', '.venv', 'venv']);

/* 单文件上限：超过就拒绝读。渲染层拿到 20MB 的文本一定会卡死，
 * 而这种文件本来就该用专业编辑器开，不该塞进这里。 */
const MAX_READ = 2 * 1024 * 1024;
const MAX_WRITE = 4 * 1024 * 1024;
/* 二进制额度比文本宽得多：一张 4K 截图就有 5–8MB，卡在 4MB 等于这个能力没用。
 * 24MB 是「够放一张大图，又不至于让 IPC 通道被一条消息堵住」的分界。 */
const MAX_BIN = 24 * 1024 * 1024;
const SEARCH_MAX_FILES = 4000;
const SEARCH_MAX_HITS = 200;
const SEARCH_MAX_BYTES = 512 * 1024;

function sha1(buf){ return crypto.createHash('sha1').update(buf).digest('hex'); }

/* 文本判定：有 NUL 就当二进制。这个判据比"看扩展名"稳，
 * 因为工作区里会有 .glb / .png / 压缩包，扩展名清单永远补不全。 */
function looksBinary(buf){
  const n = Math.min(buf.length, 8000);
  for(let i = 0; i < n; i++) if(buf[i] === 0) return true;
  return false;
}

function createCodeWorkspace(stateFile){
  let root = '';      // realpath 后的绝对路径，空表示未选

  /* 状态只存一个 root，且每次取用前都验证它还在 —— 用户完全可能在两次会话之间
   * 删掉或改名那个文件夹，此时应该回到"未选择"，而不是抛一个看不懂的 ENOENT。 */
  function loadState(){
    try{
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const p = raw && typeof raw.root === 'string' ? raw.root : '';
      if(p && isDirReal(p)) root = fs.realpathSync(p);
    }catch(e){ root = ''; }
  }
  function isDirReal(p){
    try { return fs.statSync(p).isDirectory(); } catch(e){ return false; }
  }
  function saveState(){
    try{
      fs.mkdirSync(path.dirname(stateFile), { recursive:true });
      fs.writeFileSync(stateFile, JSON.stringify({ root }, null, 1), 'utf8');
    }catch(e){ /* 存不下来不影响本次会话，只是下次要重选 */ }
  }

  /* 工作区内的绝对路径。这是整个模块唯一的路径出口，其余全走它。
   *
   * 三步缺一不可：
   *   1) 绝对路径直接拒（否则 rel 就能绕过 root 本身）
   *   2) resolve 后比前缀（拦 '..' 归一化后的逃逸）
   *   3) 已存在的路径再 realpath（拦软链接；新文件则查父目录）
   */
  function absOf(rel, { mustExist = false } = {}){
    if(!root) throw new Error('还没有选择工作区文件夹');
    const r = String(rel == null ? '' : rel);
    if(path.isAbsolute(r)) throw new Error('只接受相对工作区的路径');
    const target = path.resolve(root, r);
    const rootCmp = process.platform === 'win32' ? root.toLowerCase() : root;
    const tCmp = process.platform === 'win32' ? target.toLowerCase() : target;
    if(tCmp !== rootCmp && !tCmp.startsWith(rootCmp + path.sep)){
      throw new Error('路径越出工作区');
    }
    // 软链接检查：存在的走自己，不存在的走父目录（父目录也可能是一个通到外面的软链）
    let probe = target;
    if(!fs.existsSync(probe)) probe = path.dirname(probe);
    let real = '';
    try { real = fs.realpathSync(probe); } catch(e){ real = probe; }
    const rCmp = process.platform === 'win32' ? real.toLowerCase() : real;
    if(rCmp !== rootCmp && !rCmp.startsWith(rootCmp + path.sep)){
      throw new Error('路径经软链接越出工作区');
    }
    if(mustExist && !fs.existsSync(target)) throw new Error('文件不存在：' + r);
    return target;
  }

  function relOf(abs){
    const r = path.relative(root, abs);
    return r.split(path.sep).join('/');
  }

  function setRoot(dir){
    const real = fs.realpathSync(dir);
    if(!isDirReal(real)) throw new Error('不是一个文件夹：' + dir);
    root = real;
    saveState();
    /* 必须回 info() 而不是手拼一个 {root, name} —— 调用方（渲染层的 pickDir）
     * 用 info.ready 判断"有没有选成"，少一个字段就会被当成"用户取消"，
     * 表现是选完文件夹界面毫无反应。这个坑是 test-code-ws.js 抓出来的。 */
    return info();
  }

  function info(){
    if(!root) return { root:'', name:'', ready:false };
    return { root, name: path.basename(root) || root, ready:true };
  }

  /* 断开工作区。只清指针，**不碰磁盘** —— 用户选的是他自己的文件夹，
   * 这里任何"顺手清理"都是不可接受的。 */
  function clear(){
    root = '';
    saveState();
    return info();
  }

  /* 列一层。不递归 —— 树是按需展开的，递归一次 node_modules 就能把主进程拖住。 */
  async function list(rel){
    const dir = absOf(rel || '');
    const st = await fsp.stat(dir);
    if(!st.isDirectory()) throw new Error('不是文件夹');
    const ents = await fsp.readdir(dir, { withFileTypes:true });
    const out = [];
    for(const e of ents){
      // 单条 stat 失败不该让整个列表失败（权限、并发删除、超长路径都会出现）
      let size = 0, mtime = 0;
      try{
        const s = await fsp.stat(path.join(dir, e.name));
        size = s.size; mtime = s.mtimeMs;
      }catch(err){ /* 列出来但没元信息，比整层不见了好 */ }
      out.push({
        name: e.name,
        dir: e.isDirectory(),
        size,
        mtime,
        heavy: e.isDirectory() && HEAVY_DIRS.has(e.name)
      });
    }
    out.sort((a, b) => (a.dir === b.dir) ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1));
    return { dir: relOf(dir), entries: out };
  }

  async function read(rel){
    const file = absOf(rel, { mustExist:true });
    const st = await fsp.stat(file);
    if(st.isDirectory()) throw new Error('这是一个文件夹，不能当文件读');
    if(st.size > MAX_READ) throw new Error('文件太大（' + Math.round(st.size / 1024) + 'KB），请用外部编辑器打开');
    const buf = await fsp.readFile(file);
    if(looksBinary(buf)) throw new Error('看起来是二进制文件，不支持编辑');
    return {
      rel: relOf(file),
      text: buf.toString('utf8'),
      sha: sha1(buf),
      size: st.size,
      mtime: st.mtimeMs,
      eol: buf.includes('\r\n') ? '\r\n' : '\n'
    };
  }

  /* 写盘：expectSha 为空表示"新文件或强制覆盖"。
   * 不匹配直接抛错，让上层把「文件已被外部改动」原样告给用户 ——
   * 这时候自动合并是错的，人必须重新看一眼。 */
  async function write(rel, text, opts){
    const o = opts || {};
    const body = String(text == null ? '' : text);
    const buf = Buffer.from(body, 'utf8');
    if(buf.length > MAX_WRITE) throw new Error('内容太大，拒绝写入（上限 4MB）');
    const file = absOf(rel);
    const exists = fs.existsSync(file);
    if(exists){
      const cur = await fsp.readFile(file);
      const curSha = sha1(cur);
      if(o.expectSha && o.expectSha !== curSha){
        throw new Error('文件已被外部改动，请重新载入后再保存');
      }
      if(!o.expectSha && !o.force){
        /* 没带哈希也没说强制：说明调用方不知道当前内容，不允许覆盖 */
        throw new Error('缺少内容校验，拒绝覆盖已有文件');
      }
      const st = await fsp.stat(file);
      if(st.size + buf.length > MAX_WRITE * 2) { /* 只在异常膨胀时提一句，不拦 */ }
    }
    await fsp.mkdir(path.dirname(file), { recursive:true });
    /* 原子写：先写临时文件再 rename。直接写目标文件在中途崩溃时会留下半个文件，
     * 而这里是代码 —— 半个文件意味着语法错误，比"没保存"难排查得多。 */
    const tmp = file + '.ogtmp' + process.pid;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file).catch(async err => {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    });
    const st2 = await fsp.stat(file);
    return { rel: relOf(file), sha: sha1(buf), size: st2.size, mtime: st2.mtimeMs, created: !exists };
  }

  /* 一次性给出项目结构（给模型看的，不是给树用的）。
   *
   * 为什么必须有：Agent 如果只能 list 一层，摸清一个中型项目要花掉十几轮工具调用，
   * 每轮都是一次完整往返 —— 又慢又贵，而且它在拿到全貌前就开始瞎改。
   * 这里一次给到 N 层、限量截断，让它第一轮就能看到「东西大概在哪」。
   *
   * 输出是纯文本（缩进 + 结尾 '/' 表示目录），不用 JSON：
   * 同样的信息，JSON 的括号和引号要多花一倍 token。 */
  async function tree(rel, opts){
    const o = opts || {};
    const maxDepth = Math.max(1, Math.min(6, Number(o.maxDepth) || 3));
    const maxEntries = Math.max(50, Math.min(2000, Number(o.maxEntries) || 500));
    const base = absOf(rel || '');
    const lines = [];
    let count = 0;
    let cut = false;

    async function walk(dir, depth, indent){
      if(cut) return;
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes:true }); } catch(e){ return; }
      ents.sort((a, b) => (a.isDirectory() === b.isDirectory()) ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1));
      for(const e of ents){
        if(count >= maxEntries){ cut = true; return; }
        const name = e.name;
        if(name === '.DS_Store' || name === 'Thumbs.db' || name.indexOf('.ogtmp') >= 0) continue;
        if(e.isDirectory()){
          if(HEAVY_DIRS.has(name)){
            // 重目录只报存在，不进去：模型知道它在就够了，进去只会把名额吃光
            lines.push(indent + name + '/ (已忽略)');
            count++;
            continue;
          }
          lines.push(indent + name + '/');
          count++;
          if(depth < maxDepth) await walk(path.join(dir, name), depth + 1, indent + '  ');
          continue;
        }
        lines.push(indent + name);
        count++;
      }
    }

    await walk(base, 1, '');
    return {
      text: lines.join('\n') + (cut ? '\n…（条目过多已截断，用 ws_list 看具体目录）' : ''),
      entries: count,
      truncated: cut,
      maxDepth
    };
  }

  /* 朴素全文搜索。上限三处：文件数、单文件大小、命中数。
   * 命中里给出「行号 + 该行文本」，够渲染层直接跳转，不返回整个文件。 */
  async function search(q, opts){
    const needle = String(q == null ? '' : q);
    if(!needle) return { hits:[], scanned:0, truncated:false };
    const limit = Math.min(Number((opts || {}).maxHits) || SEARCH_MAX_HITS, SEARCH_MAX_HITS);
    const base = absOf('');
    const hits = [];
    let scanned = 0;
    let truncated = false;

    async function walk(dir){
      if(hits.length >= limit || scanned >= SEARCH_MAX_FILES){ truncated = true; return; }
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes:true }); } catch(e){ return; }
      for(const e of ents){
        if(hits.length >= limit || scanned >= SEARCH_MAX_FILES){ truncated = true; return; }
        const full = path.join(dir, e.name);
        if(e.isDirectory()){
          if(HEAVY_DIRS.has(e.name) || e.name.startsWith('.ogtmp')) continue;
          await walk(full);
          continue;
        }
        scanned++;
        let st;
        try { st = await fsp.stat(full); } catch(err){ continue; }
        if(st.size > SEARCH_MAX_BYTES) continue;
        let buf;
        try { buf = await fsp.readFile(full); } catch(err){ continue; }
        if(looksBinary(buf)) continue;
        const text = buf.toString('utf8');
        if(text.indexOf(needle) < 0) continue;
        const lines = text.split(/\r?\n/);
        for(let i = 0; i < lines.length && hits.length < limit; i++){
          if(lines[i].indexOf(needle) < 0) continue;
          hits.push({ rel: relOf(full), line: i + 1, text: lines[i].slice(0, 300) });
        }
      }
    }

    await walk(base);
    return { hits, scanned, truncated };
  }

  /* 写二进制（图片 / 字体 / 音频）。
   *
   * 为什么不并进 write：
   *   write 的契约是「文本 + 乐观锁 + 4MB」，而图片动辄十几 MB、还没法做 diff 给人看。
   *   两条路混在一起，拒绝理由也搅成一团（"太大"到底是 4MB 还是 24MB？）。
   *   分开之后各自的额度、各自的提示都是准的。
   *
   * 安全边界完全复用 absOf —— 二进制不比文本更危险，
   * 但它更容易被当成「随便写个文件」的通道，所以路径校验一步都不能省。
   */
  async function putBinary(rel, b64, opts){
    const o = opts || {};
    const raw = String(b64 == null ? '' : b64);
    if(!raw) throw new Error('内容为空');
    /* 容错而非拒绝：模型给 base64 时经常顺手带上 data:image/png;base64, 前缀，
     * 报错让它重来一轮纯属浪费。前缀里的 mime 不可信（可以是随便写的），
     * 所以剥掉之后只信文件扩展名。 */
    const clean = raw.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new Error('不是合法的 base64 内容');
    const buf = Buffer.from(clean, 'base64');
    if(!buf.length) throw new Error('内容为空（解码后 0 字节）');
    if(buf.length > MAX_BIN) throw new Error('文件太大（' + Math.round(buf.length / 1048576) + 'MB，上限 ' + Math.round(MAX_BIN / 1048576) + 'MB）');

    const file = absOf(rel);
    if(!path.basename(file) || path.basename(file).startsWith('.')) throw new Error('文件名不能以点开头');
    const exists = fs.existsSync(file);
    if(exists){
      const cur = await fsp.readFile(file);
      const curSha = sha1(cur);
      if(o.expectSha && o.expectSha !== curSha) throw new Error('文件已被外部改动，请重新载入');
      if(!o.expectSha && !o.force) throw new Error('文件已存在，拒绝覆盖（要覆盖请显式说明）');
    }

    await fsp.mkdir(path.dirname(file), { recursive:true });
    const tmp = file + '.ogtmp' + process.pid;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file).catch(async err => {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    });
    const st = await fsp.stat(file);
    return { rel: relOf(file), sha: sha1(buf), size: st.size, mtime: st.mtimeMs, created: !exists };
  }

  /* 轻量存在性判断。渲染层在决定「新建还是覆盖」时要问一句，
   * 而 read() 对二进制文件会抛错，用它判断存在性既慢又会误判。 */
  async function exists(rel){
    try {
      const file = absOf(rel);
      const st = await fsp.stat(file);
      return st.isFile() ? { exists:true, size:st.size, mtime:st.mtimeMs } : { exists:false };
    } catch(e){
      return { exists:false };
    }
  }

  loadState();

  return { info, setRoot, clear, list, tree, read, write, putBinary, exists, search, _absOf: absOf };
}

module.exports = { createCodeWorkspace, HEAVY_DIRS, MAX_READ, MAX_WRITE, MAX_BIN };
