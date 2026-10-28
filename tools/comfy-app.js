/* 本地生图（ComfyUI）独立 app 的渲染与流程测试
 *
 * 这个 app 的价值全在「状态不同 → 按钮不同」这一步：
 * 未安装给「一键安装」、装了没跑给「启动」、跑起来给「打开界面」。
 * 三态搞错任何一个，用户就会在错误的页面上点不到能用的按钮。
 *
 * 另一个重点是**不许再弹确认框**：那正是「一键安装」要消灭的东西。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js/comfy-app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label, extra){
  if(cond){ pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  [' + extra + ']' : '')); }
}
function eq(a, b, label){
  if(a === b){ pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '  期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }
}

function makeEl(id){
  const cls = new Set();
  return {
    id, innerHTML: '', value: '', checked: false, dataset: {},
    classList: {
      add(c){ cls.add(c); }, remove(c){ cls.delete(c); }, contains(c){ return cls.has(c); }
    },
    querySelectorAll(){ return []; }, querySelector(){ return null; }, addEventListener(){}
  };
}

const TAR = 'C:\\Windows\\System32\\tar.exe';

function makeDesk(over){
  const st = Object.assign({
    ok: true, running: false, installed: false, dir: '', layout: null,
    sevenZip: '', tar: TAR, canInstall: true, systemStats: null, log: ''
  }, over || {});
  const calls = [];
  const desk = {
    calls,
    st,
    comfyDetect: async () => st,
    comfyInstall: async () => { calls.push('install'); st.installed = true; st.dir = 'C:\\Users\\me\\ComfyUI_windows_portable'; return { ok: true, dir: st.dir, via: '系统 tar' }; },
    comfyLaunch: async () => { calls.push('launch'); st.running = true; return { ok: true }; },
    comfyStop: async () => { calls.push('stop'); st.running = false; return { ok: true }; },
    comfyOpenUi: async () => { calls.push('openui'); return st.running ? { ok: true, url: 'http://127.0.0.1:8188' } : { ok: false, message: '还没启动' }; },
    comfyPickDir: async () => { calls.push('pick'); return { ok: false, cancelled: true }; },
    comfyCancel: async () => { calls.push('cancel'); return { ok: true }; },
    onComfyProgress: cb => { desk.prog = cb; }
  };
  return desk;
}

function makeEnv(desk, extra){
  const els = {};
  const log = { toasts: [], openedStore: 0 };
  const handlers = {};
  const sandbox = {
    console, Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, isNaN, isFinite,
    // 不执行定时器：底部那个 2.5s 探测会在加载期偷跑，干扰「初始状态」的断言
    setTimeout: () => 0, clearTimeout: () => {},
    window: Object.assign({
      openagiDesktop: desk || null,
      addEventListener: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); }
    }, extra || {}),
    document: { getElementById: id => (els[id] || (els[id] = makeEl(id))) },
    $: id => (els[id] || (els[id] = makeEl(id))),
    mcEsc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    bpToast: m => log.toasts.push(String(m)),
    refreshDeskStates: () => { log.refreshed = (log.refreshed || 0) + 1; },
    openModelStore: () => { log.openedStore++; }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'comfy-app.js' });
  sandbox.__els = els;
  sandbox.__log = log;
  // 模拟主进程推来的引擎状态（js/engines-auto.js 广播的那个事件）
  sandbox.__dispatch = (name, detail) => (handlers[name] || []).forEach(cb => cb({ detail }));
  return sandbox;
}
function stateOf(env){ return vm.runInContext('cfState', env); }
function htmlOf(env){ return env.__els.cfApp.innerHTML; }

(async () => {
  console.log('\n=== A. 未安装 ===');
  {
    const desk = makeDesk();
    const env = makeEnv(desk);
    await env.openComfyApp();
    const h = htmlOf(env);
    ok(/未安装/.test(h), '状态显示「未安装」');
    ok(/data-cf-act="install"/.test(h), '给「一键安装」主按钮');
    ok(/data-cf-act="pick"/.test(h), '给「选择已有目录」兜底');
    ok(/约 2 GB/.test(h), '说明体积（约 2 GB，实测 2.04 GB），不让人盲下');
    ok(!/7-Zip/.test(h), '不再提 7-Zip 这个前置条件（系统 tar 能解）');
    ok(/一键安装/.test(h) && /装生图模型/.test(h), '给出装好之后的两步引导');
    ok(!/打开使用界面/.test(h), '没装好时不该出现「打开使用界面」');
  }

  console.log('\n=== B. 已安装未启动 ===');
  {
    const desk = makeDesk({ installed: true, dir: 'D:\\ComfyUI', layout: { mode: 'portable' } });
    const env = makeEnv(desk);
    await env.openComfyApp();
    const h = htmlOf(env);
    ok(/已安装/.test(h), '状态显示「已安装 · 未启动」');
    ok(/data-cf-act="launch"/.test(h), '给「启动引擎」主按钮');
    ok(!/data-cf-act="install"/.test(h), '已安装就不该再出现「安装」');
    ok(/便携版/.test(h), '显示装法（便携版）');
    ok(/D:\\ComfyUI/.test(h), '显示安装目录');
  }

  console.log('\n=== C. 运行中 ===');
  {
    const desk = makeDesk({ running: true, installed: true, dir: 'D:\\ComfyUI' });
    const env = makeEnv(desk);
    await env.openComfyApp();
    const h = htmlOf(env);
    ok(/运行中/.test(h), '状态显示「运行中」');
    ok(/data-cf-act="openui"/.test(h), '给「打开使用界面」');
    ok(/data-cf-act="stop"/.test(h), '给「停止引擎」');
    ok(!/data-cf-act="launch"/.test(h), '已经在跑就不该再给「启动」');
    ok(/8188/.test(h), '说明监听端口');

    await env.cfOpenUi();
    eq(desk.calls.indexOf('openui') >= 0, true, '点「打开界面」真的调了主进程');
  }

  console.log('\n=== D. 缺解压工具 ===');
  {
    const desk = makeDesk({ tar: '', sevenZip: '', canInstall: false });
    const env = makeEnv(desk);
    await env.openComfyApp();
    const h = htmlOf(env);
    ok(/没找到解压工具/.test(h), '说清缺什么，而不是让「安装」静默失败');
    ok(!/data-cf-act="install"/.test(h), '解压工具都没有时不给「一键安装」（避免下完 1.5 GB 才失败）');
  }

  console.log('\n=== E. 一键安装：不弹确认、装完自动启动 ===');
  {
    const desk = makeDesk();
    const env = makeEnv(desk);
    await env.openComfyApp();
    await env.cfInstall();
    eq(desk.calls.indexOf('install') >= 0, true, '点一下就开始下载（没有确认框）');
    eq(desk.calls.indexOf('launch') >= 0, true, '装完自动启动，不用再点一次');
    eq(stateOf(env).running, true, '最终状态是运行中');
    ok(/运行中/.test(htmlOf(env)), '界面同步切到运行中');
  }

  console.log('\n=== F. 安装失败要把原因留在界面上 ===');
  {
    const desk = makeDesk();
    desk.comfyInstall = async () => { desk.calls.push('install'); return { ok: false, message: '解压失败：磁盘空间不足' }; };
    const env = makeEnv(desk);
    await env.openComfyApp();
    await env.cfInstall();
    ok(/解压失败/.test(htmlOf(env)), '失败信息显示在卡片里（不是 alert 完就没）');
    ok(!/data-cf-act="cancel"/.test(htmlOf(env)), '失败后不该还挂着「取消」');
  }

  console.log('\n=== G. 取消安装不当成失败 ===');
  {
    const desk = makeDesk();
    desk.comfyInstall = async () => ({ ok: false, cancelled: true });
    const env = makeEnv(desk);
    await env.openComfyApp();
    await env.cfInstall();
    const h = htmlOf(env);
    ok(/已取消/.test(h), '提示已取消');
    ok(!/cf-err/.test(h), '取消不该显示成红色错误');
  }

  console.log('\n=== H. 启动失败 ===');
  {
    const desk = makeDesk({ installed: true, dir: 'D:\\ComfyUI' });
    desk.comfyLaunch = async () => { desk.calls.push('launch'); return { ok: false, message: '缺少 torch', log: 'Traceback...' }; };
    const env = makeEnv(desk);
    await env.openComfyApp();
    await env.cfLaunch();
    const h = htmlOf(env);
    ok(/缺少 torch/.test(h), '启动失败原因显示出来');
    ok(/启动日志/.test(h), '同时露出日志入口（原因一般在里面）');
  }

  console.log('\n=== I. 网页版（无桌面端） ===');
  {
    const env = makeEnv(null);
    await env.openComfyApp();
    const h = htmlOf(env);
    ok(/需桌面端/.test(h), '说明要桌面版，而不是给一堆点了没用的按钮');
    ok(!/data-cf-act="install"/.test(h), '网页版不给「一键安装」');
  }

  console.log('\n=== J. 状态点给工作台用 ===');
  {
    const desk = makeDesk({ running: true, installed: true, dir: 'D:\\ComfyUI' });
    const env = makeEnv(desk);
    await env.openComfyApp();
    eq(stateOf(env).running, true, 'cfState.running 供桌面图标取状态');
  }

  console.log('\n=== J2. 撞上「正在启动中」：不报错，转成等待 ===');
  {
    const desk = makeDesk({ installed: true, dir: 'D:\\ComfyUI', layout: { mode: 'portable' } });
    desk.comfyLaunch = async () => ({ ok: false, message: '正在启动中，请稍候' });
    const env = makeEnv(desk);
    await env.openComfyApp();
    await env.cfLaunch();
    const h = htmlOf(env);
    const st = stateOf(env);
    eq(st.error, '', '「正在启动中」不当失败（以前这里是一片红字，而且永不消失）');
    ok(!/cf-err/.test(h), '卡片上没有红字块');
    eq(st.busy, '启动中', '按钮换成「启动中…」，用户知道在等');
    ok(/正在启动/.test(h), '进度文案说明已经在启动');
  }

  console.log('\n=== J3. 开机自动启动把引擎起好了：窗口自己变「运行中」 ===');
  {
    const desk = makeDesk({ installed: true, dir: 'D:\\ComfyUI', layout: { mode: 'portable' } });
    const env = makeEnv(desk);
    await env.openComfyApp();
    ok(/已安装/.test(htmlOf(env)), '先是「已安装 · 未启动」');
    env.__dispatch('engines-status', { comfy: 'starting', comfyNote: '正在启动 ComfyUI（首次加载 torch 约 100 秒）…' });
    ok(/启动中/.test(htmlOf(env)), '收到 starting → 显示启动中');
    ok(!/data-cf-act="launch"/.test(htmlOf(env)), '启动中不给「启动引擎」（点了也只是等）');
    desk.st.running = true;              // 引擎真的起来了
    env.__dispatch('engines-status', { comfy: 'ready' });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    const h = htmlOf(env);
    eq(stateOf(env).running, true, '自己重新检测到运行中');
    ok(/运行中/.test(h), '卡片变成「运行中」，不用用户点「重新检测」');
    ok(/data-cf-act="openui"/.test(h), '按钮换成「打开使用界面」');
  }

  console.log('\n=== J3b. 页面加载前自动启动就已经在跑：打开窗口就该是「启动中」 ===');
  {
    const desk = makeDesk({ installed: true, dir: 'D:\\ComfyUI', layout: { mode: 'portable' } });
    const env = makeEnv(desk, {
      engineAuto: {
        status: () => ({ comfy: 'starting', comfyNote: '正在启动 ComfyUI（首次加载 torch 约 100 秒）…' }),
        refresh: async () => ({ comfy: 'starting' })
      }
    });
    await env.openComfyApp();
    const h = htmlOf(env);
    ok(/启动中/.test(h), '不靠事件也能看出引擎正在起（打开窗口先对一次表）');
    ok(!/data-cf-act="launch"/.test(h), '启动中不给「启动引擎」');
    ok(/100 秒|启动/.test(h), '说明要等一会儿');
  }

  console.log('\n=== J4. 自动启动失败：给一句话，别一直转 ===');
  {
    const desk = makeDesk({ installed: true, dir: 'D:\\ComfyUI', layout: { mode: 'portable' } });
    const env = makeEnv(desk);
    await env.openComfyApp();
    env.__dispatch('engines-status', { comfy: 'starting' });
    eq(stateOf(env).busy, '启动中', '先进入启动中');
    env.__dispatch('engines-status', { comfy: 'failed', comfyNote: 'ComfyUI 启动失败或超时（缺 torch）' });
    const st = stateOf(env);
    eq(st.busy, '', '失败后放开按钮');
    ok(/缺 torch/.test(st.error), '把真正的原因写出来', st.error);
    ok(/data-cf-act="launch"/.test(htmlOf(env)), '可以再点一次启动');
  }

  /* ---- K. 主进程：解压 ----
   * 这一节是整个「一键安装」成立的前提：官方只发 .7z，
   * 如果系统 tar 解不开，就还得回到「请先装 7-Zip」那条老路。
   * 用仓库里那份 226 字节的真 .7z 实测，不靠「按理说 libarchive 支持」。 */
  console.log('\n=== K. 主进程解压 ===');
  {
    const cs = require('../electron/comfy-setup.js');
    const tar = cs.findTar();
    ok(!!tar, '本机找到系统 tar（免安装解压的前提）', tar || 'not found');
    if(tar) ok(fs.existsSync(tar), 'tar 路径确实存在', tar);

    const fixture = path.join(__dirname, 'fixtures', 'sample-7z.7z');
    ok(fs.existsSync(fixture), '测试用 7z 样例就位');

    const outA = path.join(os.tmpdir(), 'cf-ex-a-' + Date.now());
    fs.mkdirSync(outA, { recursive: true });
    const ra = await cs.extractArchive(fixture, outA, async () =>
      fs.existsSync(path.join(outA, 'src7', 'sub', 'hello.txt')));
    ok(ra.ok, '系统 tar 能解开真实 .7z（「一键安装」不用再要求装 7-Zip）', (ra.fails || []).join(' | '));
    eq(ra.via, '系统 tar', '首选系统 tar，不是先去要 7-Zip');
    try{
      const txt = fs.readFileSync(path.join(outA, 'src7', 'sub', 'hello.txt'), 'utf8');
      ok(/comfy test file/.test(txt), '解出来的内容和原文一致（不是空壳目录）');
    }catch(e){ ok(false, '解出来的内容和原文一致', String(e.message)); }
    fs.rmSync(outA, { recursive: true, force: true });

    /* 退出码 0 但没解出东西必须判失败：bsdtar 遇到不支持的过滤器就是这种行为，
     * 只看退出码会让人以为装好了，然后在空目录里找不到 ComfyUI。 */
    const outB = path.join(os.tmpdir(), 'cf-ex-b-' + Date.now());
    fs.mkdirSync(outB, { recursive: true });
    const rb = await cs.extractArchive(fixture, outB, async () => false);
    eq(rb.ok, false, '内容对不上时判失败（退出码 0 不算成功）');
    ok((rb.fails || []).length > 0, '失败时留下可读原因', (rb.fails || []).join(' | '));
    fs.rmSync(outB, { recursive: true, force: true });

    const st = await cs.detect('');
    eq(st.canInstall, !!(tar || st.sevenZip), 'canInstall 与「实际找到的工具」一致');
    ok(typeof st.tar === 'string', 'detect 把 tar 路径报给渲染层（用于显示解压方式）');
  }

  /* ---- L. 主进程：两人同时点「启动引擎」 ----
   * 开机自动启动 + 用户随手点一下，是常态而不是异常。
   * 以前的实现是第二次直接抛「正在启动中，请稍候」，被界面当失败挂成红字，
   * 而那次启动其实成功了 —— 用户看到的就是「卡在启动中」。 */
  console.log('\n=== L. 并发启动只起一次，后到的人等同一份结果 ===');
  {
    const cs = require('../electron/comfy-setup.js');
    const cfgTmp = path.join(os.tmpdir(), 'cf-join-' + Date.now() + '.json');
    const bogus = path.join(os.tmpdir(), 'no-such-comfy-' + Date.now());
    const one = cs.launch(cfgTmp, { dir: bogus }).catch(e => ({ ok: false, message: String(e.message) }));
    const two = cs.launch(cfgTmp, { dir: bogus }).catch(e => ({ ok: false, message: String(e.message) }));
    const [a, b] = await Promise.all([one, two]);
    ok(!!a && !!b, '两次调用都有结果，不会互相甩一个「正在启动中」');
    eq(JSON.stringify(a), JSON.stringify(b), '两次拿到的是同一份结果（同一份工作，不是两条路）');
    ok(!/正在启动中/.test(JSON.stringify(a)), '不再有「正在启动中，请稍候」这种伪失败', JSON.stringify(a).slice(0, 80));
    try{ fs.unlinkSync(cfgTmp); }catch(e){}
  }

  console.log('\n结果：' + pass + ' / ' + (pass + fail) + ' 通过');
  if(fail) process.exit(1);
})();
