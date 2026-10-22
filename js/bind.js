/* 交互绑定 / 启动初始化
 * 原 index.html 5445-5622 行
 * 由解耦脚本机械切分，内容与顺序保持原样
 */
// 旧版节点迁移：必须在所有模块加载完成后执行（migrateAiTaskNodes / taskPin 定义在 js/desktop.js）
FLOWS.forEach(migrateAiTaskNodes);
// 输入节点改为纯参数节点后，清掉从它们拉出的旧执行线
const _dropped = FLOWS.reduce((sum, f) => sum + migrateExecLinks(f), 0);
if(_dropped){ persistFlows(); console.info('[blueprint] 已清理 ' + _dropped + ' 条失效执行线（输入节点不再提供执行输出）'); }

// ---- 交互绑定 ----
$('btnNewFlow').addEventListener('click', createFlow);
$('btnFlowsWinClose').addEventListener('click', closeFlowsWin);
document.addEventListener('keydown', e => {
  if(e.key !== 'Escape') return;
  if(!$('flowsWin').classList.contains('hidden') && $('settingsBackdrop').classList.contains('hidden')) closeFlowsWin();
});
$('brandHome').addEventListener('click', () => {
  if(bp){ clearTimeout(bpSaveTimer); saveFlowNow(); bp = null; }
  showView('home');
});
$('btnBpBack').addEventListener('click', () => {
  clearTimeout(bpSaveTimer);
  saveFlowNow();
  bp = null;
  showView('home');
});
$('bpName').addEventListener('input', () => {
  if(!bp) return;
  bp.name = $('bpName').value;
  scheduleFlowSave();
});
$('bpAdd').addEventListener('change', e => {
  const type = e.target.value;
  e.target.value = '';
  if(!type || !bp) return;
  const c = $('bpCanvas');
  const off = (bp.nodes.length % 4) * 26;
  addNodeAt(type, (c.clientWidth / 2 - bpPan.x) / bpZoom - 120 + off, (c.clientHeight / 2 - bpPan.y) / bpZoom - 40 + off);
});
$('btnBpRun').addEventListener('click', runFlow);
$('btnBpFit').addEventListener('click', fitView);

$('varMenu').addEventListener('pointerdown', e => e.stopPropagation());
$('varMenu').querySelectorAll('button[data-mode]').forEach(b => {
  b.addEventListener('click', e => {
    e.stopPropagation();
    const t = varMenuTarget;
    if(!t || !bp){ hideVarMenu(); return; }
    hideVarMenu();
    addVarNode(t.v, b.dataset.mode, t.x, t.y);
  });
});
$('tabLib').addEventListener('click', () => setBpSideTab('lib'));
$('tabVars').addEventListener('click', () => setBpSideTab('vars'));
$('btnAddVar').addEventListener('click', () => {
  bpVarAddOpen = !bpVarAddOpen;
  renderVars();
});

$('bpFile').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if(!file || !bpPickedNode) return;
  loadNodeImage(bpPickedNode, file);
});

$('bpModelFile').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if(!file || !bpPickedModelNode) return;
  loadNodeModel(bpPickedModelNode, file);
});

$('bpParamFile').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  if(bpPickedVar){
    const v = bpPickedVar;
    bpPickedVar = null;
    loadVarFile(v, file);
    return;
  }
  const pick = bpPickedParam;
  if(!pick) return;
  loadParamFile(pick.n, pick.p, file);
});

$('bpNodes').addEventListener('pointerdown', e => {
  const pin = e.target.closest('.pin.out');
  if(!pin) return;
  e.preventDefault();
  e.stopPropagation();
  const nodeEl = pin.closest('.node');
  linkDrag = {
    nodeId: nodeEl.dataset.id,
    key: pin.dataset.key,
    type: pin.dataset.type || pinType(nodeById(nodeEl.dataset.id), pin.dataset.key),
    temp: null
  };
  const a = portPos(linkDrag.nodeId, 'out', linkDrag.key);
  if(!a) return;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', 'bp-link temp');
  path.setAttribute('d', `M${a.x},${a.y} L${a.x},${a.y}`);
  path.style.pointerEvents = 'none';
  $('bpLinks').appendChild(path);
  linkDrag.temp = path;
});

$('bpCanvas').addEventListener('pointerdown', e => {
  if(e.button !== 0) return;
  if(!e.target.closest('.var-menu')) hideVarMenu();
  if(e.target.closest('.node') || e.target.closest('.bp-link')) return;
  panDrag = { sx: e.clientX, sy: e.clientY, ox: bpPan.x, oy: bpPan.y };
  $('bpCanvas').setPointerCapture(e.pointerId);
});

window.addEventListener('pointermove', e => {
  if(libDrag){
    libDrag.ghost.style.left = e.clientX + 'px';
    libDrag.ghost.style.top = e.clientY + 'px';
    if(Math.abs(e.clientX - libDrag.x) > 4 || Math.abs(e.clientY - libDrag.y) > 4) libDrag.moved = true;
  }
  if(varDrag){
    varDrag.ghost.style.left = e.clientX + 'px';
    varDrag.ghost.style.top = e.clientY + 'px';
    if(Math.abs(e.clientX - varDrag.x) > 4 || Math.abs(e.clientY - varDrag.y) > 4) varDrag.moved = true;
  }
  if(panDrag){
    bpPan.x = panDrag.ox + (e.clientX - panDrag.sx);
    bpPan.y = panDrag.oy + (e.clientY - panDrag.sy);
    applyBpTransform();
  }
  if(linkDrag && linkDrag.temp){
    const a = portPos(linkDrag.nodeId, 'out', linkDrag.key);
    const p = screenToWorld(e.clientX, e.clientY);
    if(a) linkDrag.temp.setAttribute('d', linkD(a, p));
  }
});

window.addEventListener('pointerup', e => {
  if(libDrag) endLibDrag(e);
  if(varDrag) endVarDrag(e);
  if(panDrag) panDrag = null;
  if(!linkDrag) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const pin = el && el.closest('.pin.in');
  if(linkDrag.temp) linkDrag.temp.remove();

  if(pin && bp){
    const targetNode = pin.closest('.node').dataset.id;
    const targetKey = pin.dataset.key;
    if(targetNode === linkDrag.nodeId){
      bpToast('不能连接到自身');
    } else if((pin.dataset.type || 'string') !== linkDrag.type){
      bpToast('引脚类型不匹配');
    } else {
      bp.links = bp.links.filter(l => !(l.to.node === targetNode && l.to.key === targetKey));
      bp.links.push({ id: uid(), from:{ node:linkDrag.nodeId, key:linkDrag.key }, to:{ node:targetNode, key:targetKey } });
      scheduleFlowSave();
      renderNodes();
    }
  }
  linkDrag = null;
});

$('bpCanvas').addEventListener('wheel', e => {
  e.preventDefault();
  const r = $('bpCanvas').getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const wx = (mx - bpPan.x) / bpZoom, wy = (my - bpPan.y) / bpZoom;
  const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  bpZoom = Math.min(1.8, Math.max(.35, bpZoom * factor));
  bpPan.x = mx - wx * bpZoom;
  bpPan.y = my - wy * bpZoom;
  applyBpTransform();
}, { passive: false });

// 初始加载
initNodeLib();
applySideTab();
loadAll();
initPresets();
renderPresetLinks('llmPresetLinks');
initImgPresets();
syncEngineUI();
baseSetTab(baseTab);
renderHome();
showView('home');
