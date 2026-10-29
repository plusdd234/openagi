/* 跨运行复用缓存（P3 · 改一个节点不必重买整条链）
 *
 * 之前 blueprint-runtime 里那个 `cache` 是**单次运行内**的 Map（同一节点在一次运行里
 * 被多条执行线读到时不重复算）。跨运行一律重算 —— 云端按张计费时这是真金白银：
 * 22 个节点改最后一个参数，前面 21 个全部重新付一次。
 *
 * 语义是「**复用**」不是「命中」：
 *   键 = 能力 + 引擎 + 解析后的输入；值 = 上次的产出。
 * 因为大部分出图能力 determinism 是 none（云端不给 seed），复用意味着
 * **拿到的是上次那张图**，而不是「同参数重新生成一张一样的图」。
 * 这个区别必须在 UI 上说清楚，否则用户会以为是缓存命中。
 *
 * 容量：按时间保留最近若干条，单条超过 2MB 的不入缓存（大图性价比低且撑配额）。
 */

const CACHE_STORE = 'cache';
const CACHE_KEEP = 80;
const CACHE_ONE_MAX = 2 * 1024 * 1024;

/* 键的构成要素要**穷尽所有影响产出的东西**：
 * 少一个字段就会出现「参数不同却命中同一条」——那种 bug 极难发现，
 * 因为表面上一切正常，只是出来的图是上一次的。 */
function cacheKeyFor(cap, engine, inputs){
  let body = '';
  try { body = JSON.stringify({ cap: String(cap || ''), engine: String(engine || ''), inputs: inputs || {} }); }
  catch(e){ return ''; }
  if(body.length > 20000) body = body.slice(0, 20000);
  const h = fnv1a(body, 2166136261).toString(36) + fnv1a(body, 84696351).toString(36);
  return 'k' + h;
}

function cacheTx(mode, fn){
  return runDbTx(mode, fn, CACHE_STORE);
}

function cacheGet(key){
  const id = String(key || '');
  if(!id) return Promise.resolve(null);
  return runDbOpen().then(db => {
    if(!db) return null;
    return new Promise(res => {
      let t;
      try { t = db.transaction(CACHE_STORE, 'readonly'); } catch(e){ res(null); return; }
      let q;
      try { q = t.objectStore(CACHE_STORE).get(id); } catch(e){ res(null); return; }
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  }).catch(() => null);
}

function cachePut(key, rec){
  const id = String(key || '');
  if(!id) return Promise.resolve(false);
  const r = rec && typeof rec === 'object' ? rec : {};
  let out = r.out;
  let size = 0;
  try { size = JSON.stringify(out == null ? null : out).length; }
  catch(e){ return Promise.resolve(false); }
  if(size > CACHE_ONE_MAX) return Promise.resolve(false);   // 太大的不值当
  const item = {
    id,
    at: Date.now(),
    cap: String(r.cap || '').slice(0, 40),
    engine: String(r.engine || '').slice(0, 40),
    model: String(r.model || '').slice(0, 80),
    determinism: String(r.determinism || '').slice(0, 16),
    cost: Math.max(0, Number(r.cost) || 0),
    size,
    hits: 0,
    out
  };
  return cacheTx('readwrite', s => s.put(item)).then(ok => {
    if(ok) cachePrune();
    return !!ok;
  }).catch(() => false);
}

/* 记一次复用次数：用来判断「哪些能力其实一直是同一份输入」，
 * 也是后续做自动跳过、预热的依据。失败不影响主流程。 */
function cacheTouch(key){
  const id = String(key || '');
  if(!id) return Promise.resolve(false);
  return runDbOpen().then(db => {
    if(!db) return false;
    return new Promise(res => {
      let t;
      try { t = db.transaction(CACHE_STORE, 'readwrite'); } catch(e){ res(false); return; }
      const st = t.objectStore(CACHE_STORE);
      const q = st.get(id);
      q.onsuccess = () => {
        const rec = q.result;
        if(!rec){ res(false); return; }
        rec.hits = (Number(rec.hits) || 0) + 1;
        rec.usedAt = Date.now();
        try { st.put(rec); } catch(e){ res(false); return; }
      };
      q.onerror = () => res(false);
      t.oncomplete = () => res(true);
      t.onerror = () => res(false);
    });
  }).catch(() => false);
}

function cacheAll(){
  return runDbOpen().then(db => {
    if(!db) return [];
    return new Promise(res => {
      let t;
      try { t = db.transaction(CACHE_STORE, 'readonly'); } catch(e){ res([]); return; }
      let q;
      try { q = t.objectStore(CACHE_STORE).getAll(); } catch(e){ res([]); return; }
      q.onsuccess = () => res((q.result || []).slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)));
      q.onerror = () => res([]);
    });
  }).catch(() => []);
}

function cachePrune(){
  return cacheAll().then(list => {
    if(list.length <= CACHE_KEEP) return 0;
    const drop = list.slice(CACHE_KEEP).map(x => x.id);
    return cacheTx('readwrite', s => drop.forEach(id => s.delete(id))).then(ok => (ok ? drop.length : 0));
  }).catch(() => 0);
}

function cacheClear(){
  return cacheTx('readwrite', s => s.clear()).catch(() => false);
}

function cacheStats(){
  return cacheAll().then(list => {
    let bytes = 0, saved = 0, hits = 0;
    list.forEach(x => {
      bytes += Number(x.size) || 0;
      saved += Number(x.cost) || 0;
      hits += Number(x.hits) || 0;
    });
    return { entries: list.length, bytes, savedU: Math.round(saved * 100) / 100, hits, lastAt: list.length ? list[0].at : 0 };
  });
}
