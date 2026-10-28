/* 生图本地/在线切换 + ComfyUI 环境自动配置
 *
 * 背景：生图原先只有「在线接口 / Tripo」几个提供方，本地 ComfyUI 的 generate()
 * 是 `throw new Error('需要按工作流配置')` 的占位实现——用户切不过去也用不了。
 * 本轮补上：① 生图与语言模型一样有「本地 / 在线」选项卡；② 内置默认工作流，
 * 装完 ComfyUI 就能出图；③ 环境自动发现 / 启动 / 安装。
 *
 * 这些逻辑出错时的现象都很像「本地生图不能用」，光看界面分不清是没装、没启动、
 * 还是工作流拼错了，所以逐层用断言钉住：
 *   1) 来源模式的存取（与面板选项卡共用同一个键，两份状态必然打架）
 *   2) 工作流 JSON 的结构（ComfyUI 只认节点连线，错一个 id 就报节点校验失败）
 *   3) 尺寸规整（8 的倍数、上限，超了 4 GB 卡直接爆显存）
 *   4) 选中哪份 ckpt
 *   5) 错误文案（没运行 / 没模型，必须是能照着做的人话）
 *   6) 安装目录识别（便携版 / venv / 系统 Python 三种布局）
 *   7) 面板选项卡与空态文案
 *
 * node tools/comfy-image.js > log 2>&1
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name){ ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

/* ---------- 假 localStorage ---------- */
function makeLS(seed){
  const m = Object.assign({}, seed || {});
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    _dump: () => m
  };
}

/* ---------- 载入 js/provider.js ---------- */
function loadProvider(seed){
  const ls = makeLS(seed);
  const inputs = { imgSize: '512x512' };
  const sandbox = {
    console, localStorage: ls, JSON, Math, Number, String, Date, Object, Array, Promise,
    setTimeout, clearTimeout, isFinite,
    location: { search: '' },
    $: id => (inputs[id] !== undefined ? { value: inputs[id] } : { value: '' }),
    fetch: async () => { throw new TypeError('offline'); },
    FormData: class { append(){} },
    FileReader: class { readAsDataURL(){} },
    AbortController: class { constructor(){ this.signal = {}; } abort(){} }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'provider.js'), 'utf8'),
    sandbox, { filename: 'provider.js' });
  return { env: sandbox, ls };
}

/* ---------- 载入 js/models-console.js ---------- */
const els = {};
function makeEl(id){
  return {
    id, innerHTML: '', dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    querySelectorAll(){ return []; }, querySelector(){ return null; },
    // 极简 DOM：mcRenderProviders 是先给 section 设 innerHTML 再 append 进来的，
    // 所以把子节点的 HTML 拼上来就能断言（真正的 DOM 里是树，这里只关心内容）
    appendChild(el){ if(el && el.innerHTML) this.innerHTML += el.innerHTML; return el; },
    insertBefore(){}, insertAdjacentHTML(){}, addEventListener(){},
    style: {}
  };
}
function $(id){ return els[id] || (els[id] = makeEl(id)); }

const FAKE_PROVIDERS = {
  llm: [
    { id: 'cloud-llm', kind: 'llm', label: '云端对话接口', local: false, status: () => false },
    { id: 'ollama-llm', kind: 'llm', label: 'Ollama 本地模型', local: true, status: () => false }
  ],
  image: [
    { id: 'cloud-image', kind: 'image', label: '云端生图接口', local: false, status: () => false },
    { id: 'tripo-image', kind: 'image', label: 'Tripo 生图', local: false, status: () => false },
    { id: 'comfy-image', kind: 'image', label: 'ComfyUI 本地生图', local: true, status: () => false }
  ]
};

function loadConsole(seed, desktop, providers){
  const ls = makeLS(seed);
  const table = providers || FAKE_PROVIDERS;
  const sandbox = {
    console, JSON, Math, Number, String, Date, Object, Array, Promise, isFinite,
    localStorage: ls,
    document: { getElementById: id => $(id), createElement: () => makeEl('tmp') },
    window: { openagiDesktop: desktop || undefined },
    alert(){}, setTimeout, clearTimeout,
    fetch: async () => { throw new TypeError('offline'); },
    AbortController: class { constructor(){ this.signal = {}; } abort(){} },
    // 被测文件依赖的全局
    PROVIDER_KINDS: ['llm', 'image'],
    providersOfKind: kind => table[kind] || [],
    providerFor: () => null,
    registerProvider: () => {},
    deskSvg: () => '<svg/>',
    rtHealth: { ok: false, ollama: { ok: false }, comfy: { ok: false } },
    rtRefresh: async () => true,
    probeHardware: async () => ({ probedAt: Date.now(), gpu: {}, cpu: {}, recommend: {} }),
    describeHardware: () => 'CPU/GPU',
    describeOtherGpus: () => '',
    comfyCkptChoice: () => '',
    setComfyCkpt: () => {}
  };
  sandbox.$ = $;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'models-console.js'), 'utf8'),
    sandbox, { filename: 'models-console.js' });
  return { env: sandbox, ls };
}

(async () => {

/* ================= 1. 来源模式 ================= */
console.log('\n=== 1. 生图来源（本地 / 在线） ===');
{
  const { env, ls } = loadProvider();
  eq(env.imgMode(), 'online', '默认是在线（老用户行为不变）');
  eq(env.setImgMode('local'), 'local', '切到本地');
  eq(ls.getItem('mc_scope_image'), 'local', '存进 mc_scope_image（和面板选项卡同一个键）');
  eq(env.imgMode(), 'local', '读回来是本地');
  env.setImgMode('CLOUD');
  eq(env.imgMode(), 'online', '非法值回落成在线，不会卡在中间态');

  // 这个键必须和面板共用：两处各存一份，切了选项卡生图还走原来那侧
  const { env: env2 } = loadConsole({ mc_scope_image: 'local' });
  eq(env2.mcGetScope('image'), 'local', '面板读同一个键 → 也是本地');
}

/* ================= 2. 工作流结构 ================= */
console.log('\n=== 2. 内置工作流（txt2img / img2img） ===');
{
  const { env } = loadProvider();
  const wf = env.comfyWorkflow({
    ckpt: 'sd15.safetensors', prompt: 'a cat', negative: 'bad', size: '512x512',
    seed: 42, steps: 20, cfg: 7, denoise: 0.6, uploaded: ''
  });
  ok(!!wf['4'] && wf['4'].class_type === 'CheckpointLoaderSimple', '有 CheckpointLoaderSimple');
  eq(wf['4'].inputs.ckpt_name, 'sd15.safetensors', 'ckpt 名写进加载节点');
  ok(!!wf['5'] && wf['5'].class_type === 'EmptyLatentImage', 'txt2img 用 EmptyLatentImage 起 latent');
  eq(wf['5'].inputs.width, 512, 'latent 宽');
  ok(!!wf['6'] && wf['6'].class_type === 'CLIPTextEncode', '正向提示词节点');
  eq(wf['6'].inputs.text, 'a cat', '正向提示词内容');
  ok(Array.isArray(wf['6'].inputs.clip) && wf['6'].inputs.clip[0] === '4', 'CLIP 接在模型节点上');
  eq(wf['7'].inputs.text, 'bad', '负向提示词内容');
  ok(!!wf['3'] && wf['3'].class_type === 'KSampler', '有 KSampler');
  eq(wf['3'].inputs.denoise, 1, 'txt2img 的 denoise 是 1');
  ok(wf['3'].inputs.latent_image[0] === '5', 'KSampler 的 latent 来自 EmptyLatentImage');
  ok(wf['3'].inputs.positive[0] === '6' && wf['3'].inputs.negative[0] === '7', '正负条件接对了');
  ok(wf['3'].inputs.model[0] === '4', '模型接对了');
  eq(wf['3'].inputs.seed, 42, '种子透传');
  ok(!!wf['8'] && wf['8'].class_type === 'VAEDecode', '有 VAEDecode');
  eq(wf['8'].inputs.samples[0], '3', 'VAEDecode 接 KSampler');
  ok(!!wf['9'] && wf['9'].class_type === 'SaveImage', '有 SaveImage（否则取不到图）');
  eq(wf['9'].inputs.images[0], '8', 'SaveImage 接 VAEDecode');

  const i2i = env.comfyWorkflow({
    ckpt: 'x.safetensors', prompt: 'p', negative: 'n', size: '512x512',
    seed: 1, steps: 20, cfg: 7, denoise: 0.55, uploaded: 'sub\\in.png'
  });
  ok(!!i2i['10'] && i2i['10'].class_type === 'LoadImage', 'img2img 用 LoadImage 载入参考图');
  eq(i2i['10'].inputs.image, 'sub\\in.png', '参考图文件名透传（含子目录）');
  ok(!!i2i['11'] && i2i['11'].class_type === 'VAEEncode', 'img2img 用 VAEEncode 编码');
  eq(i2i['11'].inputs.pixels[0], '10', 'VAEEncode 接 LoadImage');
  eq(i2i['3'].inputs.denoise, 0.55, 'img2img 的 denoise 透传');
  ok(i2i['3'].inputs.latent_image[0] === '11', 'img2img 的 latent 来自参考图');
  ok(!i2i['5'], 'img2img 不该再有 EmptyLatentImage（多余节点会白占显存）');
}

/* ================= 3. 尺寸规整 ================= */
console.log('\n=== 3. 尺寸规整 ===');
{
  const { env } = loadProvider();
  const s1 = env.comfySize('1024x1024');
  ok(s1.width === 1024 && s1.height === 1024, '1024x1024 原样');
  const s2 = env.comfySize('768×512');
  ok(s2.width === 768 && s2.height === 512, '认全角乘号 768×512');
  const s3 = env.comfySize('100x100');
  ok(s3.width === 104 && s3.width % 8 === 0, '不是 8 的倍数要就近上取整（ComfyUI 硬要求）', String(s3.width));
  const s4 = env.comfySize('3000x3000');
  ok(s4.width === 2048, '超上限收到 2048（4 GB 卡上更大必爆显存）', String(s4.width));
  const s5 = env.comfySize('abc');
  ok(s5.width === 512 && s5.height === 512, '读不出来时用 512 兜底');
  const s6 = env.comfySize('');
  ok(s6.width === 512, '空值也兜底');
}

/* ================= 4. 选哪份 ckpt ================= */
console.log('\n=== 4. 选生图模型 ===');
{
  const list = ['sdxl_base.safetensors', 'v1-5-pruned.safetensors', 'dreamshaper_8.safetensors'];
  const { env } = loadProvider();
  eq(env.comfyPickCkpt(list), 'v1-5-pruned.safetensors', '没选过时优先 SD1.5（4 GB 卡跑得动）');
  eq(env.comfyPickCkpt(['aaa.safetensors', 'bbb.safetensors']), 'aaa.safetensors', '没有 SD1.5 时取第一份');

  const picked = loadProvider({ mc_comfy_ckpt: 'dreamshaper_8.safetensors' });
  eq(picked.env.comfyPickCkpt(list), 'dreamshaper_8.safetensors', '用户点选过的优先');
  // 用户选的模型被删了不能就此卡死，要回落到可用列表
  eq(picked.env.comfyPickCkpt(['sdxl_base.safetensors']), 'sdxl_base.safetensors', '选过的模型已删除时回落到可用列表');
  eq(env.comfyPickCkpt([]), '', '没有模型时返回空（交给调用方报可读错误）');
}

/* ================= 5. 错误文案 ================= */
console.log('\n=== 5. 用不了的时候说什么 ===');
{
  // 引擎没运行
  const { env } = loadProvider();
  const p = env.providerFor('image', 'comfy-image');
  ok(!!p, 'comfy-image 已注册为 image 提供方');
  eq(p.local, true, '标记为本地');
  eq(p.status(), false, '未探测到引擎时 status 为 false');
  let e1 = '';
  try{ await p.generate({ prompt: 'x' }); }catch(e){ e1 = String(e.message); }
  ok(/ComfyUI 没在运行/.test(e1) && /启动/.test(e1), '没运行时提示「没在运行」并告诉去哪启动', e1);

  // 引擎在，但没有生图模型
  const ok2 = loadProvider();
  // rtHealth 在 provider.js 里是 let 声明，不会变成沙箱属性，
  // 只能在同一个作用域里改（外面 sandbox.rtHealth = ... 会被 let 绑定遮住）
  vm.runInContext('rtHealth.comfy.ok = true', ok2.env);
  ok2.env.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[]] } } } })
  });
  let e2 = '';
  try{ await ok2.env.providerFor('image', 'comfy-image').generate({ prompt: 'x' }); }
  catch(e){ e2 = String(e.message); }
  ok(/还没有生图模型/.test(e2) && /checkpoints/.test(e2), '没模型时告诉用户该放到哪个目录', e2);

  // 有模型时 listModels 能列出来
  const ok3 = loadProvider();
  ok3.env.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors']] } } } })
  });
  const models = await ok3.env.providerFor('image', 'comfy-image').listModels();
  eq(models.length, 2, 'listModels 从 ckpt_name 枚举里读模型');
  eq(models[0].id, 'a.safetensors', '模型 id 就是文件名');
}

/* ================= 6. 安装目录识别 ================= */
console.log('\n=== 6. ComfyUI 目录识别 ===');
const COMFY = require('../electron/comfy-setup');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-test-'));
function touch(p){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
}
{
  // 便携版：外层目录带 python_embeded，内层 ComfyUI 带 main.py
  const port = path.join(tmp, 'ComfyUI_windows_portable');
  touch(path.join(port, 'python_embeded', 'python.exe'));
  touch(path.join(port, 'ComfyUI', 'main.py'));
  const r1 = COMFY.resolveLayout(port);
  ok(!!r1 && r1.mode === 'portable', '认得出便携版布局', JSON.stringify(r1 && r1.mode));
  eq(r1 && r1.cwd, port, '便携版的工作目录是外层（main.py 依赖相对路径找模型）');
  ok(!!r1 && /python_embeded/.test(r1.python), '用便携包自带的 python');

  // 直接选到内层 ComfyUI 也要认
  const r1b = COMFY.resolveLayout(path.join(port, 'ComfyUI'));
  ok(!!r1b && r1b.mode === 'portable', '直接选到内层 ComfyUI 也能认出来');

  // venv 装法
  const ven = path.join(tmp, 'venvinstall');
  touch(path.join(ven, 'main.py'));
  touch(path.join(ven, 'venv', 'Scripts', 'python.exe'));
  const r2 = COMFY.resolveLayout(ven);
  eq(r2 && r2.mode, 'venv', '认得出 venv 布局');
  ok(!!r2 && /Scripts/.test(r2.python), '用 venv 里的 python');

  // 系统 Python 装法
  const sys = path.join(tmp, 'sysinstall');
  touch(path.join(sys, 'main.py'));
  const r3 = COMFY.resolveLayout(sys);
  eq(r3 && r3.mode, 'system', '没有 venv 时装法记为 system');
  eq(r3 && r3.python, 'python', 'system 装法用 PATH 里的 python');

  // 不是 ComfyUI
  eq(COMFY.resolveLayout(path.join(tmp, 'nothing')), null, '没有 main.py 的目录一律不认');
  eq(COMFY.resolveLayout(''), null, '空路径不认');
}

/* ================= 7. 探测与安装前置 ================= */
console.log('\n=== 7. 探测 / 安装前置 ===');
{
  const cfg = path.join(tmp, 'conf', 'comfy.json');
  /* 开发机上通常真装了 ComfyUI，而 detect 会自动扫用户目录 / 各盘根目录。
   * 这一节要测的是「没装」的分支，所以临时把 homedir 指到一个空目录，
   * 否则断言会随开发机状态飘（本机装了 → installed 变 true → 测试红）。 */
  const realHomedir = os.homedir;
  os.homedir = () => path.join(tmp, 'no-such-home');
  let st;
  try{
    // 没有服务、没有配置：不能抛异常，要回一个「未安装」的状态
    st = await COMFY.detect(cfg);
  }finally{
    os.homedir = realHomedir;
  }
  eq(st.ok, true, 'detect 不抛异常');
  /* 断言的是「detect 如实反映端口状态」，而不是「本机一定没开 ComfyUI」。
   * 后者会让调试时开着引擎的人一跑回归就看到两条莫名其妙的红。 */
  const live = await COMFY.httpProbe(COMFY.COMFY_BASE + '/system_stats', 1200);
  eq(st.running, !!live.ok, 'running 与 8188 的实际状态一致');
  eq(st.installed, false, '没有目录时 installed=false');
  ok(typeof st.sevenZip === 'string', 'sevenZip 字段存在（空串表示没装 7-Zip）');
  ok(typeof st.tar === 'string', 'tar 字段存在（系统自带的解压器）');
  eq(typeof st.canInstall, 'boolean', 'canInstall 是布尔（tar 或 7z 有一个就为真）');

  // 配置里存了目录 → installed 变 true
  COMFY.writeConfig(cfg, { dir: path.join(tmp, 'ComfyUI_windows_portable') });
  const st2 = await COMFY.detect(cfg);
  eq(st2.installed, true, '配置里存了目录就能认出来');
  eq(st2.layout && st2.layout.mode, 'portable', '并带上装法');

  const cands = COMFY.candidateDirs('/some/saved/ComfyUI');
  ok(cands[0] === path.resolve('/some/saved/ComfyUI') || cands[0] === '/some/saved/ComfyUI',
    '候选目录里第一个是保存过的路径', cands[0]);
  ok(cands.length === new Set(cands).size, '候选目录没有重复');

  /* ⚠️ 这里**绝对不能调 installPortable** 来测「缺工具」：
   * 它第一步就是下载 2 GB。以前 sources 漏传时它会当场抛错所以「看着没事」，
   * 修好下载源之后，在没有 7-Zip 的机器上跑回归就会真的开始下 2 GB。
   * 缺工具的分支改用两件安全的事来守：
   *   ① 静态确认 installPortable 在动手下载**之前**就检查工具；
   *   ② 用 extractArchive 跑一次必然失败的解压，确认它返回 ok:false 而不是抛出去。 */
  const csSrc = fs.readFileSync(path.join(__dirname, '..', 'electron/comfy-setup.js'), 'utf8');
  ok(/if\(!tar && !seven\)\s*\{/.test(csSrc),
    '没有解压工具时在下载之前就拒绝（不能下完 2 GB 才说解不开）');

  const exBad = await COMFY.extractArchive(
    path.join(tmp, 'definitely-not-here.7z'),
    path.join(tmp, 'ex-none'),
    async () => false
  );
  eq(exBad.ok, false, '解压失败时返回 ok:false（不把异常抛给调用方）');
  ok((exBad.fails || []).length >= 1, '失败时留下可读原因', (exBad.fails || []).join(' | ').slice(0, 90));


  /* ---- locateLayout：detect 与 launch 必须共用同一套定位逻辑 ----
   * 用户实际遇到的 bug：面板显示「已安装 · 未启动」（detect 靠扫描认出来了），
   * 点「启动引擎」却说「没有找到 ComfyUI 安装目录」（launch 只认配置里存的目录）。
   * 同一个程序对同一件事给出两个答案，比两个都错更难排查。 */
  {
    const fhome = path.join(tmp, 'fake-home');
    const fcomfy = path.join(fhome, 'ComfyUI_windows_portable');
    fs.mkdirSync(path.join(fcomfy, 'ComfyUI'), { recursive: true });
    fs.writeFileSync(path.join(fcomfy, 'ComfyUI', 'main.py'), '# fake');
    fs.mkdirSync(path.join(fcomfy, 'python_embeded'), { recursive: true });
    fs.writeFileSync(path.join(fcomfy, 'python_embeded', 'python.exe'), '');

    const lay0 = COMFY.locateLayout({}, fcomfy);
    eq(lay0 && lay0.dir, fcomfy, '显式给的目录直接采用');
    eq(lay0 && lay0.mode, 'portable', '并认成便携版');

    const realHome3 = os.homedir;
    os.homedir = () => fhome;
    try{
      const a = COMFY.locateLayout({});
      eq(a && a.dir, fcomfy, '配置为空时靠扫描找到（手动装过 / 旧版本升上来的机器就是这样）');
      const b = COMFY.locateLayout({ dir: path.join(tmp, 'definitely-nope') });
      eq(b && b.dir, fcomfy, '配置里存着坏路径也能回落到扫描');

      const cfg3 = path.join(tmp, 'conf', 'cfg3.json');
      try{ fs.rmSync(cfg3, { force: true }); }catch(e){}
      await COMFY.detect(cfg3);
      const saved = JSON.parse(fs.readFileSync(cfg3, 'utf8'));
      eq(saved.dir, fcomfy, 'detect 扫到后写回配置，launch 下次直接读得到');
    }finally{
      os.homedir = realHome3;
    }
  }

  /* 没有目录时启动要报人话，而不是 spawn 一个空命令。
   * ⚠️ 必须先把 homedir 指到空目录：launch 现在会走自动扫描，
   * 开发机上真装了 ComfyUI 时会**真的把引擎启动起来**，这个用例就变成了副作用。 */
  if(live.ok){
    console.log('  - 8188 上有 ComfyUI 在跑，跳过「没装时启动报错」断言（否则会误判）');
  } else {
    const realHome4 = os.homedir;
    os.homedir = () => path.join(tmp, 'no-such-home');
    let lmsg = '';
    try{ await COMFY.launch(path.join(tmp, 'conf2.json'), {}); }
    catch(e){ lmsg = String(e.message); }
    finally{ os.homedir = realHome4; }
    ok(/没有找到 ComfyUI 安装目录/.test(lmsg), '没装时启动给出「去选目录」的提示', lmsg);
  }
}

/* ================= 8. 面板选项卡 ================= */
console.log('\n=== 8. 模型控制台：生图也有本地/在线 ===');
{
  // 没有任何本地引擎 → 生图默认走在线，避免新用户点进本地看到空列表
  {
    loadConsole({});
    const env = loadConsole({}).env;
    eq(env.mcGetScope('image'), 'online', '生图默认在线');
    eq(env.mcGetScope('llm'), 'cloud', '语言模型默认云端（行为不变）');
    env.mcRenderProviders();
    const html = $('mcKinds').innerHTML;
    ok(/data-mc-scope="image\/local"/.test(html) && /data-mc-scope="image\/online"/.test(html),
      '生图分类渲染出本地/在线两个选项卡');
    ok(/本地生成/.test(html) && /在线接口/.test(html), '选项卡文案是「本地生成 / 在线接口」');
    ok(/data-mc-scope="llm\/local"/.test(html), '语言模型的选项卡仍在（没被改坏）');
    ok(/云端生图接口/.test(html) && !/ComfyUI 本地生图/.test(html), '在线模式下只列在线提供方');
  }

  // 切到本地：只列本地引擎
  {
    const { env } = loadConsole({});
    env.mcSetScope('image', 'local');
    env.mcRenderProviders();
    const html = $('mcKinds').innerHTML;
    ok(!/云端生图接口/.test(html), '本地模式下不列在线提供方');
    ok(/ComfyUI 本地生图/.test(html), '本地模式下列出 ComfyUI');
  }

  // 一个本地提供方都没有时，空态要把用户指到引擎区块去
  {
    const { env } = loadConsole({}, undefined, { llm: [], image: [] });
    env.mcSetScope('image', 'local');
    env.mcRenderProviders();
    ok(/本地生图引擎/.test($('mcKinds').innerHTML), '没有引擎时空态文案指向「本地生图引擎」');
  }

  // 引擎没跑时的区块：给一键安装 + 选择目录两条路
  {
    const { env } = loadConsole({}, {
      comfyDetect: async () => ({ ok: true, running: false, installed: false, dir: '', sevenZip: '' })
    });
    await env.mcComfyDetect();
    env.mcPaintComfy();
    const html = $('mcComfy').innerHTML;
    ok(/未安装/.test(html), '状态显示「未安装」');
    ok(/data-mc-comfy="install"/.test(html), '有「一键安装」');
    ok(/data-mc-comfy="pick"/.test(html), '有「选择目录」（自动搜不到时的后路）');
    ok(/解压工具|7-Zip/.test(html), '缺解压工具时提前告知，别等下载完 2 GB 才失败');
    ok(/约 2 GB/.test(html), '写明体积（实测 2.04 GB）');
  }

  // 找到但没跑：给启动按钮
  {
    const { env } = loadConsole({}, {
      comfyDetect: async () => ({ ok: true, running: false, installed: true,
        dir: 'D:\\ComfyUI_windows_portable', layout: { mode: 'portable' }, sevenZip: '7z.exe', log: '' })
    });
    await env.mcComfyDetect();
    env.mcPaintComfy();
    const html = $('mcComfy').innerHTML;
    ok(/已找到 · 未运行/.test(html), '状态显示「已找到 · 未运行」');
    ok(/data-mc-comfy="launch"/.test(html), '有「启动引擎」');
    ok(/便携版/.test(html), '标出装法（便携版 / venv / 系统 Python）');
    ok(/D:\\ComfyUI_windows_portable/.test(html), '显示找到的目录，用户能核对是不是这一份');
  }

  // 跑起来了：给停止按钮
  {
    const { env } = loadConsole({}, {
      comfyDetect: async () => ({ ok: true, running: true, installed: true,
        dir: 'D:\\ComfyUI', layout: { mode: 'venv' }, sevenZip: '', log: '' })
    });
    await env.mcComfyDetect();
    env.mcPaintComfy();
    const html = $('mcComfy').innerHTML;
    ok(/运行中/.test(html), '状态显示「运行中」');
    ok(/data-mc-comfy="stop"/.test(html), '有「停止」（跑着的 python 会占显存）');
    ok(!/data-mc-comfy="install"/.test(html), '已就绪时不再显示安装');
  }
}

/* ================= 9. 本地模型的两条硬限制 =================
 * 用户报的两个「图和提示词没关系」，根子都在这里：
 *   ① SD1.5 的 CLIP 只懂英文 —— 中文提示词等于噪声（实测「猫在窗边」→ 一张燃烧的街景）
 *   ② SD1.5 只见过 512 —— 按设置默认 1024 出图，它会画出几十个互不相干的小主体
 */
console.log('\n=== 9. 本地模型：尺寸上限与中文提示词 ===');
{
  const { env } = loadProvider();

  // ① 尺寸按模型收紧
  const sd15 = 'v1-5-pruned-emaonly-fp16.safetensors';
  const s1 = env.comfySize('1024x1024', sd15);
  ok(s1.width === 768 && s1.height === 768, 'SD1.5 + 1024x1024 → 收到 768（再大就画成拼贴画）', s1.width + 'x' + s1.height);
  const s2 = env.comfySize('1024x512', sd15);
  ok(Math.max(s2.width, s2.height) === 768 && s2.width === 768 && s2.height === 384,
    '按比例缩，不把宽幅压成方的', s2.width + 'x' + s2.height);
  const s3 = env.comfySize('', sd15);
  ok(s3.width === 512 && s3.height === 512, '没填尺寸时用 SD1.5 的原生 512');
  const s4 = env.comfySize('2048x2048', 'sd_xl_base_1.0.safetensors');
  ok(s4.width === 1536, 'SDXL 能到 1536（它见过 1024，不按 1.5 的尺子量）', String(s4.width));
  const s5 = env.comfySize('', 'sd_xl_base_1.0.safetensors');
  ok(s5.width === 1024, 'SDXL 默认 1024');

  // 工作流真的用上了收紧后的尺寸（不然改了也白改）
  const wf = env.comfyWorkflow({ ckpt: sd15, prompt: 'a cat', negative: 'n', size: '1024x1024',
    seed: 1, steps: 20, cfg: 7, denoise: 1, uploaded: '' });
  ok(wf['5'].inputs.width === 768, '工作流里的 EmptyLatentImage 已经是 768', String(wf['5'].inputs.width));

  // ② 中文提示词先译成英文
  const asyncOk = await (async () => {
    let seenSys = '';
    env.llmConn = () => ({ base: 'http://x/v1', key: 'k', model: 'm' });
    env.llmStreamRequest = async (sys, msgs) => {
      seenSys = String(sys || '');
      return 'a cat sitting by the window, sunlight, realistic photo';
    };
    const en = await env.comfyLocalize('一只猫站在窗户边，阳光洒在它身上');
    const info = env.comfyLastLocalize();
    ok(/英文/.test(seenSys) || /English/i.test(seenSys), '翻译用的是一条专门的系统提示');
    ok(!/[\u4e00-\u9fff]/.test(en), '送去 CLIP 的是英文', en);
    ok(/window/.test(en) && /cat/.test(en), '主体没丢', en);
    ok(info.ok === true && info.zh === '一只猫站在窗户边，阳光洒在它身上', 'lastLocalize 记录了这次翻译');

    // 缓存：再生成不该再花一次翻译
    let calls = 0;
    env.llmStreamRequest = async () => { calls++; return 'x'; };
    await env.comfyLocalize('一只猫站在窗户边，阳光洒在它身上');
    eq(calls, 0, '同一句不重复翻译（点「再生成」不该再调一次模型）');

    // 英文提示词原样透传，不该多花一次调用
    let calls2 = 0;
    env.llmStreamRequest = async () => { calls2++; return 'x'; };
    const same = await env.comfyLocalize('a cat by the window');
    eq(calls2, 0, '英文提示词不翻译');
    eq(same, 'a cat by the window', '英文原样返回');

    // 没配语言模型：原样送，但要如实报告 ok:false（界面据此提示）
    env.llmConn = () => null;
    const keep = await env.comfyLocalize('一只狗在草地上');
    eq(keep, '一只狗在草地上', '没配模型就原样送（不阻塞出图）');
    eq(env.comfyLastLocalize().ok, false, '并且标记成「没译成」，界面才能提示');
    return true;
  })();
  ok(asyncOk, '中文提示词处理链路跑通');

  /* ---- 9b. 中英混排的译文不能整条扔掉（用户第二张「图和提示词不对」的真凶） ----
   * 实测 qwen2.5:3b 的典型输出：
   *   `Cat on the ground, sunlight filtering through leaves onto it,细腻材质，低角度镜头，简洁构图…`
   * 主体/动作/光线全在，只是后半段犯懒复述中文。
   * 原来的判据是「含汉字就失败」，于是这条本来能用的译文被丢弃，整段中文进了 CLIP，
   * 出图就成了一张随机的航拍街景——界面上还只写「语言模型没配好」。
   */
  const q1 = env.comfyTrQuality('Cat on the ground, sunlight filtering through leaves onto it,细腻材质，低角度镜头，简洁构图，写实风格');
  ok(q1.ok === true, '前半英文 + 后半中文 → 判定可用（别整条扔掉）', JSON.stringify(q1));
  ok(!/[\u4e00-\u9fff]/.test(q1.text || ''), '残字的汉字片段被剔干净', q1.text);
  ok(/Cat on the ground/.test(q1.text || '') && /leaves/.test(q1.text || ''), '主体和光线都留着', q1.text);

  const q2 = env.comfyTrQuality('猫趴在地上，阳光透过树叶洒在它身上');
  ok(q2.ok === false, '整段还是中文 → 判定不可用');
  ok(/中文/.test(q2.why || ''), '说清是「还是中文」', q2.why);

  const q3 = env.comfyTrQuality('');
  ok(q3.ok === false, '空译文 → 不可用');
  const q4 = env.comfyTrQuality('猫');
  ok(q4.ok === false, '只剩一个汉字 → 不可用');

  /* ---- 9e. 图生图的重绘强度按「想改多少」分档 ----
   * 写死 0.6 在 SD1.5 上会把构图改掉（主体挪位、姿态变），用户看到的就是「和参考图不吻合」。
   * 本地没有 mask / ControlNet，强度就是唯一的构图约束，所以顺序很重要：
   * 「把背景换成海边日落，猫保持不变」里既有「背景」也有「保持」，必须先认「要动哪儿」。 */
  const dn = t => env.comfyDenoiseFor(t);
  ok(dn('把背景换成海边日落，猫和它的姿态保持不变') === 0.62, '换背景 → 0.62（不被句尾的「保持」带偏）', String(dn('把背景换成海边日落，猫和它的姿态保持不变')));
  ok(dn('改成水彩风格') === 0.52, '换风格 → 0.52');
  ok(dn('提升清晰度，保持构图不变') === 0.35, '只微调 → 0.35');
  ok(dn('加点雾') === 0.45, '其他改图 → 0.45');
  ok(dn('') === 0.45, '没有提示词时给中性值');

  /* ---- 9f. 负向词不能混进正向提示词 ----
   * 实测「把背景换成海边日落」被译成 `cat, seaside sunset, blurred, low resolution, soft lighting`
   * —— 在正向提示里写 blurred 等于主动要一张糊图，直接毁掉图生图的结果。 */
  const neg = env.comfyTrQuality('cat, seaside sunset, blurred, low resolution, soft lighting');
  ok(neg.ok === true, '含负面词的译文仍可用（不该整条扔掉）');
  ok(!/blurred/i.test(neg.text || ''), 'blurred 被剔掉', neg.text);
  ok(!/low resolution/i.test(neg.text || ''), 'low resolution 被剔掉', neg.text);
  ok(/seaside sunset/.test(neg.text || ''), '真正的内容留着', neg.text);
  const neg2 = env.comfyTrQuality('blurred, low quality, watermark');
  ok(neg2.ok === false, '通篇都是负面词 → 判定不可用');
  {
    const { env: e2 } = loadProvider();
    const calls = [];
    e2.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: opts && opts.body ? String(opts.body) : '' });
      if(/\/ollama\/api\/tags/.test(url)){
        return { ok: true, json: async () => ({ models: [
          { name: 'qwen3-vl:8b' }, { name: 'nomic-embed-text' }, { name: 'qwen2.5:3b' }
        ] }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'cat lying on the ground, warm tone, realistic' } }] }) };
    };
    e2.llmConn = () => ({ base: 'http://x/v1', key: 'k', model: 'm' });
    e2.llmStreamRequest = async () => { throw new Error('HTTP 401'); };
    const en = await e2.comfyLocalize('猫趴在地上，色调温暖');
    const tr = e2.comfyLastLocalize();
    ok(/cat/.test(en) && !/[\u4e00-\u9fff]/.test(en), '语言模型挂了，Ollama 顶上（中文不会原样进 CLIP）', en);
    ok(tr.ok === true && tr.via === 'ollama', '来源记成 ollama', tr.via);
    eq(tr.model, 'qwen2.5:3b', '挑模型跳过 embedding、视觉模型排后面、参数小的优先');
    const post = calls.find(c => /\/ollama\/v1\/chat\/completions/.test(c.url));
    ok(!!post, '走桥上的 OpenAI 兼容端点', calls.map(c => c.url).join(' | ').slice(0, 120));
    ok(/qwen2\.5:3b/.test(post ? post.body : ''), '请求里点名了挑出来的模型');
  }

  /* ---- 9d. 两条路都断：原样送 + 把真正的原因带出来 ---- */
  {
    const { env: e3 } = loadProvider();
    e3.fetch = async () => { throw new TypeError('offline'); };
    e3.llmConn = () => null;
    const keep = await e3.comfyLocalize('一只狗在草地上');
    const tr = e3.comfyLastLocalize();
    eq(keep, '一只狗在草地上', '两条路都断时仍原样送（不阻塞出图）');
    eq(tr.ok, false, '标记成没译成');
    ok(/没配语言模型/.test(tr.reason || ''), '原因里写明「没配语言模型」', tr.reason);
    ok(/Ollama/.test(tr.reason || ''), '也写明 Ollama 那条为什么没成', tr.reason);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n---------------------------------------');
console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n✗ 测试脚本自身抛异常：' + (e && e.stack));
  process.exit(1);
});
