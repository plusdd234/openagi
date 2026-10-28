/* 模型商店 · 主进程侧（阶段 E）
 *
 * 职责只有一件：把生图大模型（.safetensors）下到 ComfyUI/models/checkpoints。
 * 语言模型走 Ollama 自己的 /api/pull（渲染进程已有流式实现），不需要经过这里——
 * 两边都做一遍只会出现「两条进度、两套重试」。
 *
 * 为什么必须放主进程：
 *   ① 文件是 2-7 GB，浏览器里下完还得在内存里攒完整 blob 才能落盘，4 GB 的卡直接 OOM；
 *   ② 只有主进程知道 ComfyUI 装在哪（便携版 / venv / 系统 Python 三种装法）。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const dl = require('./ollama-download');
const comfy = require('./comfy-setup');

/* 文件名只允许「一层、无路径分隔符」：渲染进程传来的字符串会直接拼进磁盘路径，
 * 不校验就等于给了一个 ../ 穿越写任意位置的口子。 */
function safeFileName(name){
  const base = String(name || '').trim();
  if(!base) throw new Error('缺少文件名');
  if(/[\\/:*?"<>|]/.test(base) || base === '.' || base === '..') throw new Error('文件名不合法：' + base);
  if(base.length > 180) throw new Error('文件名过长');
  return base;
}

/* 找 checkpoints 目录。没有 ComfyUI 就没有落点——这里必须明确报错，
 * 而不是下到临时目录再让用户自己搬。 */
async function checkpointsDir(cfgFile){
  const st = await comfy.detect(cfgFile || '');
  if(!st || !st.installed || !st.layout){
    const e = new Error('没找到 ComfyUI，先在上方「本地生图引擎」里安装或指定目录');
    e.code = 'NO_COMFY';
    throw e;
  }
  return path.join(st.layout.comfyDir, 'models', 'checkpoints');
}

/* 已装清单：直接读磁盘，不依赖引擎在运行。
 * 走 /object_info 的话引擎没启动时会是空列表，看起来像「模型没装成功」。 */
async function list(cfgFile){
  let dir = '';
  try{ dir = await checkpointsDir(cfgFile); }
  catch(e){ return { ok: false, code: e.code || '', dir: '', files: [], message: String((e && e.message) || e) }; }
  let names = [];
  try{ names = await fsp.readdir(dir); }
  catch(e){ return { ok: true, dir, files: [] }; }
  const files = [];
  for(const n of names){
    if(!/\.(safetensors|ckpt|pt|bin)$/i.test(n)) continue;
    let sizeMB = 0;
    try{ sizeMB = Math.round((await fsp.stat(path.join(dir, n))).size / 1048576); }catch(e){}
    files.push({ file: n, sizeMB });
  }
  return { ok: true, dir, files };
}

/* 下载一个 checkpoint。
 * sources 由渲染进程按目录里的 urls 传进来（镜像在前、官方在后），下载器自己测速择优；
 * expectPE:false 是因为这里下的是 safetensors 而不是 Windows 安装包（PE 头校验会直接判死）。 */
async function install(cfgFile, req, opts){
  const o = opts || {};
  const r = req || {};
  const file = safeFileName(r.file);
  const urls = (Array.isArray(r.urls) ? r.urls : []).filter(u => /^https?:\/\//i.test(String(u || '')));
  if(!urls.length) throw new Error('这个模型没有可用的下载地址');

  const dir = await checkpointsDir(cfgFile);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, file);

  // 已经存在且大小对得上（±1 MB）就当作已安装，别重复下 2 GB
  if(!o.force){
    try{
      const st = await fsp.stat(dest);
      const want = Number(r.sizeGB) > 0 ? Number(r.sizeGB) * 1073741824 : 0;
      if(st.size > 1048576 && (!want || Math.abs(st.size - want) < 1048576)){
        return { ok: true, file, dest, bytes: st.size, cached: true };
      }
    }catch(e){/* 不存在，正常下载 */}
  }

  const report = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const res = await dl.download({
    dest,
    sources: urls.map(url => ({ url })),
    httpGet: o.httpGet || dl.nodeHttpGet,
    expectPE: false,
    canResume: true,
    onProgress: report,
    onLog: typeof o.onLog === 'function' ? o.onLog : () => {},
    isCancelled: typeof o.isCancelled === 'function' ? o.isCancelled : () => false
  });
  if(res && res.cancelled){
    const e = new Error('已取消下载（进度已保留，再次安装会续传）');
    e.cancelled = true;
    throw e;
  }
  return { ok: true, file, dest, bytes: res && res.bytes, resumed: !!(res && res.resumed) };
}

/* 卸载：只删 checkpoints 里的文件。删之前确认它确实在这个目录内，
 * 避免渲染进程传个奇怪的名字把别处文件带走。 */
async function remove(cfgFile, fileName){
  const file = safeFileName(fileName);
  const dir = await checkpointsDir(cfgFile);
  const target = path.join(dir, file);
  const rel = path.relative(dir, target);
  if(rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径不合法');
  await fsp.rm(target, { force: true });
  return { ok: true, file };
}

module.exports = { safeFileName, checkpointsDir, list, install, remove };
