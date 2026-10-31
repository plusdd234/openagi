/* 参考图建模 · DeepSeek 监督循环（不依赖 Tripo）
 *
 * 循环：参考图 → DeepSeek 出「参数化建模规格」 → Modeler 建模 → **剪影对图（精确数字）**
 *       → 需要时再手动改规格重跑。默认**不做 AI 复核**：截图只能给模糊观感，
 *       判断「像不像」用 tools/match-ref.js 的 IoU + 逐高度带宽度差，可量化、可复现。
 *
 * 为什么要这个脚本（而不是只在流程里跑）：
 *   ① 每一步的中间产物都落盘（规格 JSON / GLB / 四视图），人（或我）能**在任意一步掐断**；
 *   ② 复核用的是「看渲染图」而不是「看模型数字」，AI 说谎/自我感觉良好会被截图打回原形；
 *   ③ 每轮结束打印差量（部件数 / 面数 / 尺寸），重跑有没有真的修好一眼可见。
 *
 * 用法：
 *   node tools/ref-model-supervise.js --struct=<图> --color=<图> [--rounds=2] [--out=dir] [--dry]
 * 配置：从 openagi-store.json 读 hf_llmBaseUrl / hf_llmKey / hf_llmModel（用的是你自己的账号）。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const flag = k => argv.indexOf('--' + k) >= 0;

const STRUCT = arg('struct', '');
const COLOR = arg('color', '');
const ROUNDS = Math.max(1, Math.min(4, Number(arg('rounds', 2)) || 2));
const OUT = path.resolve(ROOT, arg('out', 'tools/_out/supervise'));
const DRY = flag('dry');
const AI_REVIEW = flag('ai-review');

function cfg() {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'openagi-store.json'), 'utf8'));
  return {
    base: String(j.hf_llmBaseUrl || '').replace(/\/+$/, ''),
    key: String(j.hf_llmKey || ''),
    model: String(j.hf_llmModel || 'deepseek-chat'),
  };
}

async function chat(c, messages, maxTokens) {
  const url = /\/v1$/.test(c.base) ? c.base + '/chat/completions' : c.base + '/v1/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
    body: JSON.stringify({
      model: c.model,
      messages,
      temperature: 0.3,
      max_tokens: maxTokens || 3000,
      stream: false,
    }),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!r.ok || !data) {
    const hint = (data && data.error && (data.error.message || data.error)) || text.slice(0, 300);
    throw new Error('模型返回 HTTP ' + r.status + '：' + hint);
  }
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  return String((msg && msg.content) || '');
}

function pickJson(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cands = fence ? [fence[1], s] : [s];
  for (const t of cands) {
    try { return JSON.parse(t.trim()); } catch (e) {}
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  }
  return null;
}

(async () => {
  const c = cfg();
  if (!DRY && (!c.base || !c.key)) throw new Error('没有可用的语言模型配置（openagi-store.json 里缺 hf_llmBaseUrl / hf_llmKey）');
  if (!STRUCT) throw new Error('缺少 --struct=<结构参考图路径>');
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ channel: 'msedge', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof Modeler !== 'undefined' && typeof THREE !== 'undefined', null, { timeout: 20000 });

  /* 参考图压到 768 长边：给模型看形体和主色，不需要原图分辨率 */
  const shrink = async file => {
    const b64 = fs.readFileSync(file).toString('base64');
    const type = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    return page.evaluate(async ([src, w]) => {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
      const k = Math.min(1, w / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/jpeg', 0.86);
    }, ['data:' + type + ';base64,' + b64, 768]);
  };

  const structURL = await shrink(STRUCT);
  const colorURL = COLOR ? await shrink(COLOR) : '';

  const schema = await page.evaluate(() => Modeler.schemaHelp());

  const sys = [
    '你是三维建模师，输出「参数化建模规格 JSON」供本机建模内核直接执行。',
    '只输出 JSON，不要解释。规则：',
    '1) 只能用这些 shape：box / sphere / capsule / cylinder / cone / torus / plane；',
    '2) 全部以米为单位，height 填估计的总身高（人形 1.4~1.8）；',
    '3) 左右对称部件只写一个，加 "mirror":"x"；',
    '4) 重复小件用 repeat{count,offset}；',
    '5) 每个部件都给 color（取着色参考里的主色）；',
    '6) 先大形（头/躯干/四肢）再细节，部件总数 ≤ 40；',
    '6b) **曲线曲面优先**：头发束 / 卷发 / 飘带 / 手指 / 绳带一律用 tube 沿曲线扫掠；',
    '    腿、靴筒、杯形裙摆用 lathe 回转；躯干、裙子用 loft 放样。不要用一堆球和胶囊硬拼曲线。',
    '7) 位置用 pos:[x,y,z]，y 向上，脚底在 y≈0。',
    '规格格式：',
    schema,
  ].join('\n');

  const buildAndShoot = async spec => {
    const r = await page.evaluate(async (sp) => {
      const built = await Modeler.build(sp);
      const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().load(built.dataURL, res, undefined, rej));
      gltf.scene.updateMatrixWorld(true);
      const W = 420;
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(W, W); renderer.setPixelRatio(1);
      if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#f2f4f8');
      scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4b2, 1.0));
      const d1 = new THREE.DirectionalLight(0xffffff, 1.15); d1.position.set(1.2, 1.6, 1.4); scene.add(d1);
      const d2 = new THREE.DirectionalLight(0xdde7ff, 0.5); d2.position.set(-1.2, 0.6, 0.8); scene.add(d2);
      const d3 = new THREE.DirectionalLight(0xffffff, 0.45); d3.position.set(0.2, 0.8, -1.4); scene.add(d3);
      scene.add(gltf.scene);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const ctr = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const cam = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
      const dist = Math.max(size.x, size.y, size.z) / (2 * Math.tan(Math.PI * 32 / 360)) * 1.12;
      const out = [];
      for (const [name, dir] of [['front', [0, 0, 1]], ['side', [1, 0, 0.03]], ['back', [0, 0, -1]]]) {
        cam.position.copy(ctr).addScaledVector(new THREE.Vector3(...dir).normalize(), dist);
        cam.lookAt(ctr);
        renderer.render(scene, cam);
        out.push({ name, png: renderer.domElement.toDataURL('image/png') });
      }
      return { shots: out, stats: built.stats, size: built.size, warnings: built.warnings };
    }, spec);
    return r;
  };

  const writeShots = (tag, shots) => {
    const dir = path.join(OUT, tag);
    fs.mkdirSync(dir, { recursive: true });
    shots.forEach(s => fs.writeFileSync(path.join(dir, 'view-' + s.name + '.png'), Buffer.from(s.png.split(',')[1], 'base64')));
    return dir;
  };

  let spec = null, history = [];
  for (let round = 1; round <= ROUNDS; round++) {
    console.log('\n===== 第 ' + round + ' 轮 =====');

    /* ---- ① 出规格（第一轮从参考图，之后带上一轮的意见） ---- */
    if (DRY && spec) break;
    const user = [];
    user.push({ type: 'text', text: '结构参考（形体/比例）：' });
    user.push({ type: 'image_url', image_url: { url: structURL } });
    if (colorURL) {
      user.push({ type: 'text', text: '着色参考（配色/材质）：' });
      user.push({ type: 'image_url', image_url: { url: colorURL } });
    }
    if (history.length) {
      const last = history[history.length - 1];
      user.push({
        type: 'text',
        text: '上一版规格没过复核，意见：' + JSON.stringify(last.verdict) + '\n原规格：\n' + JSON.stringify(last.spec) +
          '\n请输出**完整的**修正后规格 JSON（不是 diff）。',
      });
    } else {
      user.push({ type: 'text', text: '请按参考图产出建模规格 JSON。' });
    }
    let raw = '';
    if (DRY) {
      raw = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/_demo_spec.json'), 'utf8')));
    } else {
      raw = await chat(c, [{ role: 'system', content: sys }, { role: 'user', content: user }], 3200);
    }
    spec = pickJson(raw);
    if (!spec) throw new Error('模型没有返回可用 JSON：' + raw.slice(0, 200));
    fs.writeFileSync(path.join(OUT, 'spec-r' + round + '.json'), JSON.stringify(spec, null, 1));

    /* ---- ② 建模 + 出图 ---- */
    let built;
    try {
      built = await buildAndShoot(spec);
    } catch (e) {
      console.log('建模失败：' + (e && e.message));
      history.push({ spec, verdict: { pass: false, issues: ['建模内核拒绝了这份规格：' + (e && e.message)], fixHint: '按报错修正规格字段' } });
      if (round === ROUNDS) break;
      continue;
    }
    const dir = writeShots('r' + round, built.shots);
    fs.writeFileSync(path.join(dir, 'model.glb'), Buffer.from(
      await page.evaluate(async sp => (await Modeler.build(sp)).dataURL, spec).then(u => u.split(',')[1]), 'base64'));
    console.log('规格部件 ' + (spec.parts || []).length + ' · 网格 ' + built.stats.meshes + ' · 面 ' + built.stats.tris +
      ' · 尺寸 ' + built.size.join('×') + ' → ' + dir);

    /* ---- ③ 对图：剪影 IoU + 逐高度带宽度差（精确，不靠观感） ---- */
    const matchOut = path.join(dir, 'match');
    try {
      const res = require('child_process').execFileSync(
        process.execPath,
        [path.join(__dirname, 'match-ref.js'), '--ref=' + STRUCT, '--glb=' + path.join(dir, 'model.glb'), '--out=' + matchOut, '--pick=' + (arg('pick', 0))],
        { encoding: 'utf8' }
      );
      console.log(res.split('\n').filter(l => /IoU|高度带|窄了|宽了|参考剪影/.test(l)).join('\n'));
    } catch (e) {
      console.log('对图失败：' + (e && e.message));
    }

    /* ---- ④ 可选：让模型看图复核（--ai-review）。默认关：模糊评语没法直接改数值 ---- */
    if (!AI_REVIEW) {
      history.push({ spec, stats: built.stats, size: built.size, verdict: { pass: null, issues: [], fixHint: '' } });
      break;
    }
    if (verdict.pass) break;
    if (round === ROUNDS) console.log('已达到轮次上限 ' + ROUNDS + '，停在这里等人看。');
  }

  fs.writeFileSync(path.join(OUT, 'history.json'), JSON.stringify(history.map(h => ({ verdict: h.verdict, stats: h.stats, size: h.size })), null, 1));
  if (pageErrors.length) console.log('页面错误：' + pageErrors.join(' | '));
  console.log('\n产物目录：' + OUT);
  await browser.close();
})();
