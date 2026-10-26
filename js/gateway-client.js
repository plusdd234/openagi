/* 账号网关客户端
 *
 * 「登录账号就能用」的前端实现：登录后所有 LLM 调用走网关，Key 由服务端托管；
 * 未登录时自动回落到用户自己填的 Key（老路径不变，两条路并存）。
 *
 * 会话存在 localStorage：{ token, user }。令牌是网关签发的 HMAC 串，7 天过期。
 * 网关地址优先级：?gateway= 参数 > 设置里保存的 > http://127.0.0.1:8791
 */
const GW_SESSION_KEY = 'hf_gw_session';
const GW_BASE_KEY = 'hf_gw_base';
const GW_MODEL_KEY = 'hf_gw_model';
const GW_MODE_KEY = 'hf_llm_mode';     // 'cloud'（默认，登录走网关） | 'local'（自定义模型）
let gwSession = null;
let gwModels = [];                      // 网关下发的模型目录 [{id,label,multiplier,tags}]

function gwLoad(){
  try { gwSession = JSON.parse(localStorage.getItem(GW_SESSION_KEY) || 'null'); }
  catch(e){ gwSession = null; }
  if(gwSession && (!gwSession.token || !gwSession.user)) gwSession = null;
  return gwSession;
}
function gwBase(){
  const m = (location.search.match(/[?&]gateway=([^&]+)/) || [])[1];
  if(m) return decodeURIComponent(m).replace(/\/$/, '');
  let saved = '';
  try { saved = (localStorage.getItem(GW_BASE_KEY) || '').trim(); } catch(e){}
  return (saved || 'http://127.0.0.1:8791').replace(/\/$/, '');
}
function gwSetBase(url){
  const v = String(url || '').trim().replace(/\/$/, '');
  try { localStorage.setItem(GW_BASE_KEY, v); } catch(e){}
}
function gwToken(){ return (gwSession && gwSession.token) || ''; }
function gwLogged(){ return !!(gwSession && gwSession.token && gwSession.user); }
function gwUser(){ return gwSession ? gwSession.user : null; }

function gwSave(d){
  gwSession = { token: d.token, user: d.user || {}, at: Date.now() };
  try { localStorage.setItem(GW_SESSION_KEY, JSON.stringify(gwSession)); } catch(e){}
}
function gwClear(){
  gwSession = null;
  try { localStorage.removeItem(GW_SESSION_KEY); } catch(e){}
}

async function gwFetch(path, opts){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(gwBase() + path, Object.assign({ signal: ctrl.signal }, opts || {}));
    let data = null;
    try { data = await res.json(); } catch(e){}
    if(!res.ok) throw new Error((data && data.error) || ('网关返回 ' + res.status));
    return data || {};
  } catch(e){
    if(e && e.name === 'AbortError') throw new Error('网关无响应（15 秒超时）');
    if(e instanceof TypeError) throw new Error('连不上网关：' + gwBase() + '（服务启动了吗？地址对吗？）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
function gwJsonOpts(body, token){
  return {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body || {})
  };
}

async function gwLogin(email, password){
  const d = await gwFetch('/auth/login', gwJsonOpts({ email, password }));
  gwSave(d);
  gwAfterAuthChange();
  return d;
}
async function gwRegister(email, password, code){
  const d = await gwFetch('/auth/register', gwJsonOpts({ email, password, code: code || '' }));
  gwSave(d);
  gwAfterAuthChange();
  return d;
}
async function gwRefreshMe(){
  if(!gwLogged()) return null;
  const d = await gwFetch('/auth/me', { headers: { authorization: 'Bearer ' + gwToken() } });
  if(d && d.user){
    gwSession.user = d.user;
    try { localStorage.setItem(GW_SESSION_KEY, JSON.stringify(gwSession)); } catch(e){}
  }
  return d;
}
async function gwLogout(){
  try {
    if(gwLogged()) await gwFetch('/auth/logout', gwJsonOpts({}, gwToken()));
  } catch(e){ /* 服务端不可达也要能本地退出 */ }
  gwClear();
  gwAfterAuthChange();
}

/* ---------- 模型目录与「云端 / 自定义」模式 ---------- */
function llmMode(){
  try { return localStorage.getItem(GW_MODE_KEY) === 'local' ? 'local' : 'cloud'; } catch(e){ return 'cloud'; }
}
function setLlmMode(mode){
  try { localStorage.setItem(GW_MODE_KEY, mode === 'local' ? 'local' : 'cloud'); } catch(e){}
  gwAfterAuthChange();
}
function gwModelId(){
  let saved = '';
  try { saved = localStorage.getItem(GW_MODEL_KEY) || ''; } catch(e){}
  if(saved && (!gwModels.length || gwModels.some(m => m.id === saved))) return saved;
  return (gwUser() && gwUser().model) || (gwModels[0] && gwModels[0].id) || '';
}
function gwSetModel(id){
  try { localStorage.setItem(GW_MODEL_KEY, String(id || '')); } catch(e){}
  gwAfterAuthChange();
}
async function gwLoadModels(){
  if(!gwLogged()){ gwModels = []; return []; }
  const d = await gwFetch('/v1/models', { headers: { authorization: 'Bearer ' + gwToken() } });
  gwModels = Array.isArray(d.data) ? d.data.map(m => ({
    id: String(m.id),
    label: String(m.label || m.id),
    multiplier: Math.max(0, Number(m.multiplier) || 0),
    tags: Array.isArray(m.tags) ? m.tags : []
  })) : [];
  return gwModels;
}

/* 网关凭据（仅登录时返回；模型在目录内可选） */
function gwConn(){
  if(!gwLogged()) return null;
  const model = gwModelId();
  // base 带上 /v1：与 OpenAI 兼容约定一致，现有 post()/llmStreamRequest 拼 /chat/completions 就能用
  return { base: gwBase() + '/v1', key: gwToken(), model, via: 'gateway' };
}

/* 统一取「这次调用用哪套连接」：登录走网关，否则用本地 Key */
function llmConn(){
  if(llmMode() !== 'local'){
    const g = gwConn();
    if(g) return g;   // 云端模式且已登录
  }
  return {
    base: ($('llmBaseUrl').value || '').trim().replace(/\/$/, ''),
    key: ($('llmKey').value || '').trim(),
    model: ($('llmModel').value || '').trim(),
    via: 'local'
  };
}

/* ---------- 设置面板渲染 ---------- */
function gwMsg(text, cls){
  const el = $('gwMsg');
  if(!el) return;
  el.textContent = text || '';
  el.className = 'note' + (cls ? ' ' + cls : '');
}
function renderGatewayPane(){
  const out = $('gwLoggedOut'), inside = $('gwLoggedIn');
  if(!out || !inside) return;
  const serverEl = $('gwServer');
  if(serverEl && !serverEl.value) serverEl.value = gwBase();

  const on = gwLogged();
  out.classList.toggle('hidden', on);
  inside.classList.toggle('hidden', !on);
  if(!on) return;

  const u = gwUser() || {};
  const usage = u.usage || {};
  const credits = Number(usage.credits) || 0;
  $('gwUserLine').textContent = (u.email || '') + (u.role === 'admin' ? ' · 管理员' : '');
  $('gwUsage').textContent = credits > 0
    ? '已用 ' + (Number(usage.cost) || 0).toFixed(2) + ' / ' + credits + ' · 剩余 ' +
      (Number(usage.remaining) || 0).toFixed(2) + ' · 今天 ' + (usage.requests || 0) + ' 次'
    : '不限额度 · 今天 ' + (usage.requests || 0) + ' 次';
  $('gwHint').textContent = llmMode() === 'local'
    ? '当前使用「自定义模型」（你自己的 Key），云端额度不会消耗。'
    : '已登录：AI 调用走网关，模型与额度由服务器管理。';
  renderGatewayModels();
}

function renderGatewayModels(){
  const host = $('gwModels');
  if(!host) return;
  host.innerHTML = '';
  if(!gwModels.length){
    const e = document.createElement('div');
    e.className = 'note';
    e.textContent = gwLogged() ? '（网关没有返回模型列表）' : '登录后显示云端模型';
    host.appendChild(e);
    return;
  }
  const cur = gwModelId();
  const cloud = llmMode() !== 'local';
  gwModels.forEach(m => {
    const row = document.createElement('div');
    row.className = 'gw-model' + (cloud && m.id === cur ? ' on' : '');
    const label = document.createElement('span');
    label.className = 'm-label';
    label.textContent = m.label || m.id;
    row.appendChild(label);
    (m.tags || []).forEach(t => {
      const tag = document.createElement('span');
      tag.className = 'm-tag';
      tag.textContent = t;
      row.appendChild(tag);
    });
    const mul = document.createElement('span');
    mul.className = 'm-mul';
    mul.textContent = (Number(m.multiplier) || 0).toFixed(2) + 'x';
    mul.title = '调用一次消耗的额度';
    row.appendChild(mul);
    if(cloud && m.id === cur){
      const ok = document.createElement('span');
      ok.className = 'm-ok';
      ok.textContent = '✓';
      row.appendChild(ok);
    }
    row.addEventListener('click', () => { gwSetModel(m.id); setLlmMode('cloud'); });
    host.appendChild(row);
  });
}

function gwAfterAuthChange(){
  renderGatewayPane();
  try { if(typeof updateStatusChips === 'function') updateStatusChips(); } catch(e){}
  try { if(typeof refreshDeskStates === 'function') refreshDeskStates(); } catch(e){}
}

function gwBind(){
  const login = $('gwLogin'), reg = $('gwRegister'), out = $('gwLogout'), ref = $('gwRefresh');
  if(!login) return;
  const creds = () => ({
    server: ($('gwServer').value || '').trim(),
    email: ($('gwEmail').value || '').trim(),
    password: $('gwPassword').value || '',
    code: ($('gwCode').value || '').trim()
  });
  const busy = (b) => {
    [login, reg].forEach(x => { if(x) x.disabled = b; });
  };
  const run = async (fn) => {
    const c = creds();
    if(c.server) gwSetBase(c.server);
    if(!c.email || !c.password){ gwMsg('先填邮箱和密码', 'warn'); return; }
    busy(true); gwMsg('连接中…');
    try {
      await fn(c);
      gwMsg('');
      $('gwPassword').value = '';
      try { await gwLoadModels(); } catch(e){}
      renderGatewayModels();
      if(typeof bpToast === 'function') bpToast('已登录 ' + ((gwUser() || {}).email || ''));
    } catch(e){
      gwMsg(String((e && e.message) || e), 'error');
    } finally { busy(false); }
  };
  login.addEventListener('click', () => run(c => gwLogin(c.email, c.password)));
  reg.addEventListener('click', () => run(c => gwRegister(c.email, c.password, c.code)));
  out.addEventListener('click', async () => {
    await gwLogout();
    gwMsg('已退出登录');
    if(typeof bpToast === 'function') bpToast('已退出云端账号');
  });
  const custom = $('gwCustom'), useCloud = $('gwUseCloud');
  if(custom) custom.addEventListener('click', () => {
    setLlmMode('local');
    try { if(typeof switchTab === 'function') switchTab('llm'); } catch(e){}
    gwMsg('已切到自定义模型：填好 Key 与模型名即可，不消耗云端额度', 'warn');
  });
  if(useCloud) useCloud.addEventListener('click', () => {
    if(!gwLogged()){ gwMsg('先登录云端账号', 'warn'); return; }
    setLlmMode('cloud');
    gwMsg('已切回云端模型');
  });
  ref.addEventListener('click', async () => {
    try { await gwRefreshMe(); renderGatewayPane(); gwMsg('额度已刷新'); }
    catch(e){ gwMsg(String((e && e.message) || e), 'error'); }
  });
}

gwLoad();
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', gwBind);
else gwBind();
