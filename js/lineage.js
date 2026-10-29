/* 资产血缘（P3 · 让「资产工厂」这个定位不只是口号）
 *
 * 在这之前 library 条目只有 kind / name / size / created ——
 * 看图库时无法回答最基本的问题：**这张图是哪次运行、哪个节点、哪版流程产出的？**
 * 答不出这个，「哪版参数出的好」「三个月后重跑同一版」都无从谈起。
 *
 * 做法是**旁表**而不是往资产文件里塞字段：
 * 资产可能来自磁盘（桌面端）、IndexedDB（网页端）、图库扫描、对话保存，四条路都要改一遍很容易漏。
 * 一张旁表按 assetKey 关联，四条路各自写一条就行，历史资产也能补记。
 *
 * 记录是**边**而不是树：每条边带 parents（这个产出的输入资产），
 * 于是从任意一张图都能往上追成链（图 → 参考图 → 上游生成图），往下追成影响面。
 */

const LINEAGE_STORE = 'lineage';
const LINEAGE_KEEP = 800;

/* 资产键归一：不同来源对同一个文件叫法不同，这里收敛成一种。
 *   desk:/abs/path.png   → desk:/abs/path.png
 *   blob:b123            → blob:b123
 *   http(s)://…          → 原样（网页版产出没法本地寻址，只能记地址）
 *   裸文件名             → name:xxx
 * 不做大小写/斜杠归一：桌面端路径在 Windows 上大小写不敏感，但改了反而跟磁盘对不上。 */
function lineageKeyOf(x){
  const s = String(x == null ? '' : x).trim();
  if(!s) return '';
  if(/^(desk|blob|name):/i.test(s)) return s;
  if(/^https?:\/\//i.test(s)) return s.length > 300 ? s.slice(0, 300) : s;
  if(/^[a-zA-Z]:[\\/]/.test(s) || s.indexOf('/') >= 0 || s.indexOf('\\') >= 0) return 'desk:' + s;
  return 'name:' + s;
}

function lineageTx(mode, fn){
  return runDbTx(mode, fn, LINEAGE_STORE);
}

/* 记一条产出边。永不抛错：血缘是附加价值 */
function lineageAdd(rec){
  const r = rec && typeof rec === 'object' ? rec : {};
  const asset = lineageKeyOf(r.asset);
  if(!asset) return Promise.resolve(false);
  const item = {
    id: asset,
    at: Number(r.at) || Date.now(),
    asset,
    kind: String(r.kind || 'image').slice(0, 20),
    runId: String(r.runId || ''),
    flowId: String(r.flowId || ''),
    versionId: String(r.versionId || ''),
    nodeId: String(r.nodeId || ''),
    nodeType: String(r.nodeType || '').slice(0, 40),
    cap: String(r.cap || '').slice(0, 40),
    model: String(r.model || '').slice(0, 80),
    engine: String(r.engine || '').slice(0, 40),
    determinism: String(r.determinism || '').slice(0, 16),
    parents: (Array.isArray(r.parents) ? r.parents : []).map(lineageKeyOf).filter(Boolean).slice(0, 12),
    name: String(r.name || '').slice(0, 120)
  };
  return lineageTx('readwrite', s => s.put(item)).then(ok => {
    if(ok) lineagePrune();
    return !!ok;
  }).catch(() => false);
}

function lineageAll(){
  return runDbOpen().then(db => {
    if(!db) return [];
    return new Promise(res => {
      let t;
      try { t = db.transaction(LINEAGE_STORE, 'readonly'); } catch(e){ res([]); return; }
      let q;
      try { q = t.objectStore(LINEAGE_STORE).getAll(); } catch(e){ res([]); return; }
      q.onsuccess = () => res((q.result || []).slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)));
      q.onerror = () => res([]);
    });
  }).catch(() => []);
}

function lineageOf(asset){
  const key = lineageKeyOf(asset);
  if(!key) return Promise.resolve(null);
  return lineageAll().then(list => list.find(x => x.asset === key) || null);
}

function lineageByRun(runId){
  const id = String(runId || '');
  if(!id) return Promise.resolve([]);
  return lineageAll().then(list => list.filter(x => x.runId === id));
}

/* 往上追：这张图是怎么来的（链）。depth 控制层数，防止异常数据成环时死循环 */
function lineageUp(asset, depth){
  const max = Math.max(1, Math.trunc(Number(depth) || 4));
  const seen = new Set();
  const out = [];
  const walk = (key, level) => {
    if(!key || level > max || seen.has(key)) return Promise.resolve();
    seen.add(key);
    return lineageOf(key).then(rec => {
      if(!rec) return;
      out.push({ asset: key, level, rec });
      return Promise.all((rec.parents || []).map(p => walk(p, level + 1)));
    });
  };
  return walk(lineageKeyOf(asset), 0).then(() => out);
}

/* 淘汰：按时间保留最近的若干条。血缘是诊断信息，不是账本，丢老的可以接受 */
function lineagePrune(){
  return lineageAll().then(list => {
    if(list.length <= LINEAGE_KEEP) return 0;
    const drop = list.slice(LINEAGE_KEEP).map(x => x.id);
    return lineageTx('readwrite', s => drop.forEach(id => s.delete(id))).then(ok => (ok ? drop.length : 0));
  }).catch(() => 0);
}

function lineageStats(){
  return lineageAll().then(list => {
    const byCap = {};
    const byDet = {};
    list.forEach(x => {
      byCap[x.cap || '—'] = (byCap[x.cap || '—'] || 0) + 1;
      byDet[x.determinism || '—'] = (byDet[x.determinism || '—'] || 0) + 1;
    });
    return { total: list.length, byCap, byDet, lastAt: list.length ? list[0].at : 0 };
  });
}
