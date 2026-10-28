/* 下载源选择 & ComfyUI 便携包源配置的测试
 *
 * 为什么单独测这一层：
 *   「一键安装」失败时用户只看到一句「没有可用的下载源」，但根因可能完全不同——
 *   ① 根本没传 sources（实现漏洞）② 传了但全是死链 ③ 源活着却不支持 Range。
 *   第三种最阴：镜像为了省事直接忽略 Range 头把整个文件吐回来，探测阶段看着「很快」，
 *   真下载时按分片偏移写进去就是错位的垃圾数据，2 GB 白下。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
function ok(cond, label, extra){
  if(cond){ pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  [' + extra + ']' : '')); }
}
function eq(a, b, label){
  if(a === b){ pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '  期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }
}

const DL = require('../electron/ollama-download.js');

/* 假 HTTP 层：status 206 表示支持 Range，200 表示无视 Range 吐整包 */
function handleFor(status, size, chunk){
  const stream = new EventEmitter();
  stream.destroy = () => {};
  setTimeout(() => {
    stream.emit('data', Buffer.alloc(chunk || 65536));
    setTimeout(() => stream.emit('end'), 8);
  }, 8);
  return {
    status,
    headers: status === 206
      ? { 'content-range': 'bytes 0-1023/' + size }
      : { 'content-length': String(size) },
    stream,
    abort(){}
  };
}
function fakeGet(behave){
  return async url => {
    const b = behave[url];
    if(!b) throw new Error('ECONNREFUSED');
    if(b.err) throw new Error(b.err);
    return handleFor(b.status, b.size, b.chunk);
  };
}

(async () => {
  console.log('\n=== A. 只保留真正支持分片的源 ===');
  {
    const sources = [
      { url: 'https://a/206', name: '支持分片的源' },
      { url: 'https://b/200', name: '只会吐整包的镜像' }
    ];
    const get = fakeGet({
      'https://a/206': { status: 206, size: 2000000000 },
      // 这种源「速度」往往更高，必须靠 rangeOk 把它挡掉，而不是靠速度
      'https://b/200': { status: 200, size: 2000000000, chunk: 262144 }
    });
    const r = await DL.pickSources(sources, get, {});
    eq(r.chosen.length, 1, '不支持 Range 的源被剔除');
    eq(r.chosen[0].url, 'https://a/206', '留下的是回了 206 的那个');
    eq(r.chosen[0].rangeOk, true, '保留下来的源都标记为支持分片');
    eq(r.total, 2000000000, '总大小取自 Content-Range');
  }

  console.log('\n=== B. 全部都不支持分片时明确报错 ===');
  {
    const sources = [
      { url: 'https://x/200', name: '镜像甲' },
      { url: 'https://y/200', name: '镜像乙' }
    ];
    const get = fakeGet({
      'https://x/200': { status: 200, size: 1000 },
      'https://y/200': { status: 200, size: 1000 }
    });
    let err = null;
    try{ await DL.pickSources(sources, get, {}); }catch(e){ err = String(e.message); }
    ok(!!err, '抛错而不是硬着头皮下');
    ok(/不支持分片/.test(err || ''), '错误里说清是「不支持分片」而不是「没有源」', err || '');
    ok(/镜像甲|镜像乙/.test(err || ''), '点名是哪个源', err || '');
  }

  console.log('\n=== C. 源全挂 ===');
  {
    const sources = [{ url: 'https://dead', name: '死链' }];
    const get = fakeGet({ 'https://dead': { err: 'ECONNREFUSED' } });
    let err = null;
    try{ await DL.pickSources(sources, get, {}); }catch(e){ err = String(e.message); }
    ok(/所有下载源都不可用/.test(err || ''), '说「都不可用」并带上原因', err || '');
  }

  console.log('\n=== D. 多源按速度排班 ===');
  {
    const sources = [
      { url: 'https://fast', name: '快' },
      { url: 'https://slow', name: '慢' }
    ];
    const get = async url => {
      // 两源只差 2 倍速（都在「最快 25% 以内」），应当都被保留用于聚合
      const chunk = url === 'https://fast' ? 262144 : 131072;
      const stream = new EventEmitter();
      stream.destroy = () => {};
      setTimeout(() => {
        stream.emit('data', Buffer.alloc(chunk));
        setTimeout(() => stream.emit('end'), 8);
      }, 8);
      return {
        status: 206,
        headers: { 'content-range': 'bytes 0-1023/2000000000' },
        stream,
        abort(){}
      };
    };
    const r = await DL.pickSources(sources, get, {});
    eq(r.chosen.length, 2, '都合格的源都保留（用于聚合加速）');
    eq(r.chosen[0].url, 'https://fast', '快的排前面');
    ok(Array.isArray(r.schedule) && r.schedule.length > 0, '产出排班表');
    const fastSlots = r.schedule.filter(x => x.url === 'https://fast').length;
    const slowSlots = r.schedule.filter(x => x.url === 'https://slow').length;
    ok(fastSlots > slowSlots, '快源分到更多槽位', 'fast=' + fastSlots + ' slow=' + slowSlots);
  }

  /* ---- E. ComfyUI 便携包的源配置 ----
   * 这一节防的是「实现漏了 sources 字段」：
   * 之前的 installPortable 定义了 PORTABLE_URL 却从没传进 download()，
   * 于是每次点「一键安装」都立刻失败在「没有可用的下载源」——而代码看起来完全正常。 */
  console.log('\n=== E. ComfyUI 便携包源配置 ===');
  {
    const cs = require('../electron/comfy-setup.js');
    ok(Array.isArray(cs.PORTABLE_SOURCES) && cs.PORTABLE_SOURCES.length >= 1,
      '至少配置了一个下载源', String((cs.PORTABLE_SOURCES || []).length));
    ok(cs.PORTABLE_SOURCES.every(s => /^https:\/\//.test(s.url)), '源地址都是 https');
    ok(cs.PORTABLE_SOURCES.every(s => s.name), '每个源都有可读名字（错误信息要用）');
    ok(cs.PORTABLE_SOURCES.every(s => /ComfyUI_windows_portable_nvidia\.7z$/.test(s.url)),
      '指向官方便携包文件名');
    ok(cs.PORTABLE_SOURCES.some(s => /github\.com\/comfyanonymous/.test(s.url)), '包含 GitHub 官方源');
    ok(cs.PORTABLE_GB > 1.9 && cs.PORTABLE_GB < 2.2,
      '体积按实测值（≈2.04 GB，不是早年文案里的 1.5 GB）', String(cs.PORTABLE_GB));

    const src = fs.readFileSync(path.join(__dirname, '..', 'electron/comfy-setup.js'), 'utf8');
    ok(/sources:\s*o\.sources\s*\|\|\s*PORTABLE_SOURCES/.test(src),
      'installPortable 真的把 sources 传给了 download()（漏了就会立刻报「没有可用的下载源」）');
    ok(/dest:\s*zipPath/.test(src), '下载目标仍然指向临时 zip 路径');
    /* 缺解压工具时的提示必须把「系统 tar 本来就够」说在前面，
     * 而不是像老弹窗那样一句「需要 7-Zip」把用户赶去装软件。 */
    ok(/tar\.exe/.test(src) && /Windows 10 1803/.test(src),
      '缺工具时给的是「系统自带 tar 已足够」的说明，不是直接要用户装 7-Zip');
  }

  console.log('\n结果：' + pass + ' / ' + (pass + fail) + ' 通过');
  if(fail) process.exit(1);
})();
