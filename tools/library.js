/* 图库 / 模型库（Content Browser）界面测试
 *
 * 这一层最容易错的三件事：
 *   ① 引用统计扫不出来 → 删图时不给警告，流程里的图变成打不开的空框；
 *   ② 把没被引用的资产当成「可删」自动清掉 → 用户的产出说没就没；
 *   ③ 占用数字算错 → 用户以为是别的东西占了盘，白折腾一圈。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js/library.js'), 'utf8');

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
    id, innerHTML: '', textContent: '', value: '', checked: false, dataset: {},
    classList: { add(c){ cls.add(c); }, remove(c){ cls.delete(c); }, toggle(c, on){ on ? cls.add(c) : cls.delete(c); }, contains(c){ return cls.has(c); } },
    querySelectorAll(){ return []; }, querySelector(){ return null; }, addEventListener(){}, focus(){}
  };
}

const MB = 1048576;

function makeDesk(over){
  const assets = (over && over.assets) || [];
  const calls = [];
  const desk = {
    calls,
    assetList: async () => ({ ok: true, assets, totalBytes: assets.reduce((s, a) => s + a.size, 0), count: assets.length }),
    assetStat: async () => ({
      ok: true, totalBytes: assets.reduce((s, a) => s + a.size, 0), count: assets.length,
      byKind: {
        image: { count: assets.filter(a => a.kind === 'image').length, bytes: assets.filter(a => a.kind === 'image').reduce((s, a) => s + a.size, 0) },
        model: { count: assets.filter(a => a.kind === 'model').length, bytes: assets.filter(a => a.kind === 'model').reduce((s, a) => s + a.size, 0) }
      },
      trashBytes: (over && over.trashBytes) || 0,
      trashCount: (over && over.trashCount) || 0
    }),
    assetRead: async id => {
      calls.push('read:' + id);
      const a = assets.find(x => x.id === id);
      // 文件丢失时主进程返回 ok:false —— 假的 read 也必须照做，
      // 否则「打开失败要提示」这类用例永远测不到真实分支
      if(a && a.missing) return { ok: false, error: '文件缺失', missing: true };
      return { ok: true, dataURL: 'data:image/png;base64,AAA' };
    },
    assetRemove: async ids => { calls.push('remove:' + ids.join(',')); return { ok: true, moved: ids, failed: [] }; },
    assetImport: async () => { calls.push('import'); return { ok: true, imported: [{ id: 'imp1' }] }; },
    assetReconcile: async () => { calls.push('reconcile'); return { ok: true, added: ['x'], dropped: [] }; },
    assetEmptyTrash: async () => { calls.push('empty'); return { ok: true }; },
    assetExport: async ids => { calls.push('export:' + ids.join(',')); return { ok: true, files: ['a.png'], dir: 'C:\\out' }; },
    assetThumb: async id => { calls.push('thumb:' + id); return (over && over.thumb) || { ok: false }; },
    assetThumbSave: async (id, url) => { calls.push('thumbSave:' + id); return { ok: true }; }
  };
  return desk;
}

function makeEnv(desk, opts){
  const els = {};
  const o = opts || {};
  const log = { toasts: [], confirms: [] };
  const sandbox = {
    console, Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, Set, Map, isNaN, isFinite,
    setTimeout: () => 0, clearTimeout: () => {},
    window: { openagiDesktop: desk || null },
    document: { getElementById: id => (els[id] || (els[id] = makeEl(id))) },
    $: id => (els[id] || (els[id] = makeEl(id))),
    mcEsc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    confirm: msg => { log.confirms.push(String(msg)); return o.confirm !== false; },
    FLOWS: o.flows || [],
    bp: o.bp || null,
    bpToast: (m) => log.toasts.push(String(m))
  };
  // 3D 查看器 / 图片编辑器由外部注入：这里只验证「双击有没有路由到位」
  if(o.model3d) sandbox.Model3D = o.model3d;
  if(o.openImageEditor) sandbox.openImageEditor = o.openImageEditor;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'library.js' });
  sandbox.__els = els;
  sandbox.__log = log;
  return sandbox;
}
function stateOf(env){ return vm.runInContext('libState', env); }
function htmlOf(env){ return env.__els.libBody.innerHTML; }

(async () => {
  console.log('\n=== A. 引用统计 ===');
  {
    const flows = [
      { id: 'f1', name: '海报流程', nodes: [{ data: { image: 'blob:b100_aaa' } }] },
      { id: 'f2', name: '电商图', nodes: [{ data: { ref: 'blob:b100_aaa', other: 'blob:b200_bbb' } }] },
      { id: 'f3', name: '没人用的图', nodes: [{ data: { image: 'blob:b300_ccc' } }] }
    ];
    const env = makeEnv(makeDesk(), { flows });
    const r = env.libScanRefs();
    eq(r.counts['b100_aaa'], 2, '同一个资产被两个流程引用，计 2');
    eq(r.counts['b200_bbb'], 1, '另一个资产计 1');
    ok(r.where['b100_aaa'].indexOf('海报流程') >= 0, '记得住是哪个流程在用（删除时能点名）', String(r.where['b100_aaa']));
    eq(r.counts['b300_ccc'], 1, '只被一个流程用的也算（不能当成孤儿）');

    // 同一流程里重复出现只算一次：资产在一个流程里贴两次仍然只是「1 个流程在用」
    const env2 = makeEnv(makeDesk(), { flows: [{ id: 'x', name: '重复', nodes: [{ a: 'blob:b100_aaa' }, { b: 'blob:b100_aaa' }] }] });
    eq(env2.libScanRefs().counts['b100_aaa'], 1, '同一流程内重复引用只计 1 次（否则删除警告会夸大）');
  }

  console.log('\n=== B. 空状态 ===');
  {
    const env = makeEnv(makeDesk({ assets: [] }));
    await env.openLibrary('image');
    const h = htmlOf(env);
    ok(/图库/.test(h), '标题是图库');
    ok(/还没有图片/.test(h), '空状态给出「怎么才会有图」');
    ok(/导入/.test(h), '给了导入入口');
    ok(!/回收站还占着/.test(h), '回收站为空时不显示黄条');
  }

  console.log('\n=== C. 有资产时的渲染 ===');
  {
    const assets = [
      { id: 'b100_aaa', kind: 'image', name: '首屏海报.png', size: 3.2 * MB, created: Date.now() - 3600e3, missing: false, ext: 'png' },
      { id: 'b200_bbb', kind: 'image', name: '四视图.png', size: 1.1 * MB, created: Date.now() - 86400e3, missing: false, ext: 'png' },
      { id: 'b300_ccc', kind: 'image', name: '没人用的.png', size: 0.4 * MB, created: Date.now() - 7200e3, missing: false, ext: 'png' },
      { id: 'm1', kind: 'model', name: 'dragon.glb', size: 8.5 * MB, created: Date.now(), missing: false, ext: 'glb' }
    ];
    const flows = [
      { id: 'f1', name: '海报流程', nodes: [{ d: 'blob:b100_aaa' }] },
      { id: 'f2', name: '复用流程', nodes: [{ d: 'blob:b100_aaa' }] }
    ];
    const env = makeEnv(makeDesk({ assets }), { flows });
    await env.openLibrary('image');
    const h = htmlOf(env);
    ok(/首屏海报\.png/.test(h), '列出图片名');
    ok(/3\.2 MB/.test(h), '显示体积（用户第一眼看的就是这个）');
    ok(/2 处在用/.test(h), '被引用的资产标出引用数');
    ok(!/dragon\.glb/.test(h), '图库不显示 3D 资产（两类分开管）');
    ok(/4\.7 MB/.test(h), '顶部汇总只算本类资产（3.2+1.1+0.4）', h.slice(0, 400));

    await env.openLibrary('model');
    const h2 = htmlOf(env);
    ok(/dragon\.glb/.test(h2), '模型库只显示 3D 资产');
    ok(!/首屏海报\.png/.test(h2), '模型库里不混图片');
    ok(/GLB/.test(h2), '模型卡片显示格式标签（3D 缩略图先不渲染）');
  }

  console.log('\n=== D. 缺失文件要显眼 ===');
  {
    const assets = [{ id: 'gone', kind: 'image', name: '丢了.png', size: 100, created: Date.now(), missing: true, ext: 'png' }];
    const env = makeEnv(makeDesk({ assets }));
    await env.openLibrary('image');
    ok(/文件丢失/.test(htmlOf(env)), '文件丢了要标出来，不能假装能打开');
  }

  console.log('\n=== E. 排序 ===');
  {
    const assets = [
      { id: 'a', kind: 'image', name: '小.png', size: 0.1 * MB, created: 3000 },
      { id: 'b', kind: 'image', name: '大.png', size: 9 * MB, created: 1000 },
      { id: 'c', kind: 'image', name: '中.png', size: 2 * MB, created: 2000 }
    ];
    const env = makeEnv(makeDesk({ assets }));
    await env.openLibrary('image');
    const st = stateOf(env);
    eq(st.sort, 'new', '默认按最新排');
    st.sort = 'big';
    env.libPaint();
    const h = htmlOf(env);
    ok(h.indexOf('大.png') < h.indexOf('中.png') && h.indexOf('中.png') < h.indexOf('小.png'),
      '按大小降序（找占空间的头目）');

    st.sort = 'new';
    env.libPaint();
    const h2 = htmlOf(env);
    ok(h2.indexOf('小.png') < h2.indexOf('中.png'), '按时间降序（最新的在最前）');
  }

  console.log('\n=== F. 删除：引用不为零必须警告 ===');
  {
    const assets = [{ id: 'b100_used', kind: 'image', name: '在用.png', size: MB, created: 1, missing: false, ext: 'png' }];
    const flows = [{ id: 'f1', name: '发布会物料', nodes: [{ d: 'blob:b100_used' }] }];
    const desk = makeDesk({ assets });
    const env = makeEnv(desk, { flows });
    await env.openLibrary('image');
    stateOf(env).sel.add('b100_used');
    env.libPaint();
    await env.libRemoveSelected();
    const msg = env.__log.confirms.join(' | ');
    ok(/正被流程引用/.test(msg), '确认框说清「有东西在用」', msg);
    ok(/发布会物料/.test(msg), '点名是哪个流程（用户能自己去确认）', msg);
    ok(/打不开的图/.test(msg), '说清后果');
    ok(desk.calls.some(c => /^remove:b100_used/.test(c)), '确认后才真的删');

    // 用户点取消时不能删
    const desk2 = makeDesk({ assets });
    const env2 = makeEnv(desk2, { flows, confirm: false });
    await env2.openLibrary('image');
    stateOf(env2).sel.add('b100_used');
    await env2.libRemoveSelected();
    ok(!desk2.calls.some(c => /^remove:/.test(c)), '取消就不删');
  }

  console.log('\n=== G. 删除是「移到回收站」不是抹掉 ===');
  {
    const assets = [{ id: 'x', kind: 'image', name: 'x.png', size: MB, created: 1, missing: false, ext: 'png' }];
    const env = makeEnv(makeDesk({ assets }));
    await env.openLibrary('image');
    stateOf(env).sel.add('x');
    await env.libRemoveSelected();
    ok(/回收站/.test(htmlOf(env)), '提示里明确说进了回收站还能捞回来', htmlOf(env).slice(0, 200));
  }

  console.log('\n=== H. 回收站占用要单独提醒 ===');
  {
    const env = makeEnv(makeDesk({ assets: [], trashBytes: 512 * MB, trashCount: 12 }));
    await env.openLibrary('image');
    const h = htmlOf(env);
    ok(/回收站还占着/.test(h), '回收站有东西就提醒（那里常堆着几个 GB 被忘掉）');
    ok(/512\.0 MB/.test(h), '给出回收站体积');
  }

  console.log('\n=== I. 动作都打到主进程 ===');
  {
    const desk = makeDesk({ assets: [] });
    const env = makeEnv(desk);
    await env.openLibrary('image');
    await env.libImport();
    await env.libReconcile();
    eq(desk.calls.indexOf('import') >= 0, true, '导入调到主进程');
    eq(desk.calls.indexOf('reconcile') >= 0, true, '核对调到主进程');

    const assets = [{ id: 'e', kind: 'image', name: 'e.png', size: MB, created: 1, missing: false, ext: 'png' }];
    const desk2 = makeDesk({ assets });
    const env2 = makeEnv(desk2);
    await env2.openLibrary('image');
    stateOf(env2).sel.add('e');
    await env2.libExportSelected();
    eq(desk2.calls.some(c => /^export:e/.test(c)), true, '导出调到主进程');
  }

  console.log('\n=== J. 网页版（无桌面端） ===');
  {
    const env = makeEnv(null);
    await env.openLibrary('image');
    ok(/桌面版/.test(htmlOf(env)), '说明资产要落盘、需要桌面版，而不是给一堆点了没用的按钮');
  }

  console.log('\n=== K. 体积格式化 ===');
  {
    const env = makeEnv(makeDesk());
    eq(env.libFmt(0), '1 KB', '0 字节也显示成 1 KB（写 0 会让人以为统计坏了）');
    eq(env.libFmt(1536), '2 KB', 'KB 四舍五入');
    eq(env.libFmt(3.2 * MB), '3.2 MB', 'MB 保留一位');
    eq(env.libFmt(2.5 * 1024 * MB), '2.50 GB', 'GB 保留两位');
  }

  console.log('\n=== L. 3D 缩略图 ===');
  {
    const assets = [{ id: 'b2_b', kind: 'model', name: '模.glb', size: 2 * MB, created: 2, missing: false, ext: 'glb' }];
    /* 第一次打开：没有缓存缩略图 → 现场渲染 → 存回去。
     * 第二次打开：直接读文件，不该再渲染（渲染一个模型要建 WebGL 上下文，几秒起步）。 */
    let renderCount = 0;
    const desk = makeDesk({ assets });
    const env = makeEnv(desk, {
      model3d: { renderThumb: async () => { renderCount++; return { dataURL: 'data:image/png;base64,THUMB' }; } }
    });
    await env.openLibrary('model');
    ok(/data-lib-kind="model"/.test(htmlOf(env)), '3D 卡片标了「这是模型、要渲染缩略图」');
    ok(!/data-lib-3d/.test(htmlOf(env)), '不用 data-lib-3d（dataset 读不到「-数字」形式的属性名，会静默走错分支）');

    const holder = { dataset: { libKind: 'model' }, innerHTML: '' };
    await env.libLoadThumb('b2_b', holder);
    eq(renderCount, 1, '没有缓存时渲染一次');
    ok(/<img/.test(holder.innerHTML), '渲染完把图塞进磁贴');
    ok(desk.calls.some(c => /^thumbSave:b2_b/.test(c)), '渲染结果存回磁盘（下次不用再渲染）');

    const holder2 = { dataset: { libKind: 'model' }, innerHTML: '' };
    await env.libLoadThumb('b2_b', holder2);
    eq(renderCount, 1, '第二次同类卡片不再重复渲染');
  }

  console.log('\n=== M. 双击打开 ===');
  {
    const assets = [
      { id: 'b1_a', kind: 'image', name: '海报.png', size: MB, created: 1, missing: false, ext: 'png' },
      { id: 'b2_b', kind: 'model', name: '龙.glb', size: 2 * MB, created: 2, missing: false, ext: 'glb' }
    ];
    const opened = {};
    const env = makeEnv(makeDesk({ assets }), {
      model3d: { openPreview: (src, o) => { opened.preview = { title: o && o.title, hasSrc: /^data:/.test(src) }; } },
      openImageEditor: (id, a, src) => { opened.editor = { id, name: a && a.name, hasSrc: /^data:/.test(src) }; }
    });

    await env.openLibrary('model');
    await env.libOpenAsset('b2_b');
    eq(opened.preview && opened.preview.title, '龙.glb', '双击 3D 资产进查看器（带资产名当标题）');
    eq(opened.preview && opened.preview.hasSrc, true, '查看器拿到的是可加载的 dataURL');
    eq(opened.editor, undefined, '模型不会误开图片编辑器');

    await env.openLibrary('image');
    await env.libOpenAsset('b1_a');
    eq(opened.editor && opened.editor.name, '海报.png', '双击图片进编辑器');
    eq(opened.editor && opened.editor.hasSrc, true, '编辑器拿到的是可解码的 dataURL');

    // 文件已丢失时不能静默：用户双击没反应会以为程序卡了
    const env2 = makeEnv(makeDesk({
      assets: [{ id: 'gone', kind: 'image', name: '丢了.png', size: 0, created: 1, missing: true, ext: 'png' }]
    }));
    await env2.openLibrary('image');
    await env2.libOpenAsset('gone');
    ok(/打不开/.test(htmlOf(env2)), '打开失败要有提示（双击没反应会被当成卡死）', htmlOf(env2).slice(0, 160));
  }

  console.log('\n结果：' + pass + ' / ' + (pass + fail) + ' 通过');
  if(fail) process.exit(1);
})();
