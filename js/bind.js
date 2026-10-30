/* 交互绑定 / 启动初始化
 * 原 index.html 5445-5622 行
 * 由解耦脚本机械切分，内容与顺序保持原样
 */
// 旧版节点迁移：必须在所有模块加载完成后执行（migrateAiTaskNodes / taskPin 定义在 js/desktop.js）
FLOWS.forEach(migrateAiTaskNodes);
const _legacyMigratedAll = FLOWS.reduce((sum, f) =>
  sum + migrateLegacyBranches(f) + migrateLegacyCondition(f), 0);   // aiBranch → smartBranch；condition → aiTask
if(_legacyMigratedAll) persistFlows();
// 大块数据（图片 / 模型）存在 IndexedDB 里，先读回内存再解析存根，否则界面上会是空图
blobInit();
// 输入节点改为纯参数节点后，清掉从它们拉出的旧执行线
const _dropped = FLOWS.reduce((sum, f) => sum + migrateExecLinks(f), 0);
if(_dropped){ persistFlows(); console.info('[blueprint] 已清理 ' + _dropped + ' 条失效执行线（输入节点不再提供执行输出）'); }

// ---- 交互绑定 ----
// 工作流导出 / 导入（手动备份，防丢失）
$('btnExportFlows').addEventListener('click', exportFlows);
$('btnImportFlows').addEventListener('click', () => $('fileImportFlows').click());
$('fileImportFlows').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { importFlowsText(String(reader.result || '')); e.target.value = ''; };
  reader.onerror = () => { bpToast('读取文件失败'); e.target.value = ''; };
  reader.readAsText(file);
});
$('btnModelsWinClose').addEventListener('click', closeModelsWin);
$('btnStoreWinClose').addEventListener('click', () => deskCloseWin($('storeWin')));
$('btnComfyWinClose').addEventListener('click', () => deskCloseWin($('comfyWin')));
$('btnLibWinClose').addEventListener('click', () => deskCloseWin($('libWin')));
$('btnImgEditClose').addEventListener('click', () => $('imgEditWin').classList.add('hidden'));
/* 3D 查看器的销毁逻辑（dispose renderer / 停 raf / 清宿主）全在 Model3D.closePreview 里，
 * 这里必须走它而不是直接加 hidden——只藏窗口的话渲染循环还在跑，WebGL 上下文会一直占着 */
$('btnModelViewClose').addEventListener('click', () => { if (window.Model3D) Model3D.closePreview(); });
$('btnDeskNewFlow').addEventListener('click', createFlow);
document.addEventListener('keydown', e => {
  if(e.key !== 'Escape') return;
  if($('settingsBackdrop').classList.contains('hidden')){
    if(!$('imgEditWin').classList.contains('hidden')) $('imgEditWin').classList.add('hidden');
    else if(!$('modelViewWin').classList.contains('hidden')) { if(window.Model3D) Model3D.closePreview(); }
    else if(!$('libWin').classList.contains('hidden')) deskCloseWin($('libWin'));
    else if(!$('comfyWin').classList.contains('hidden')) deskCloseWin($('comfyWin'));
    else if(!$('storeWin').classList.contains('hidden')) deskCloseWin($('storeWin'));
    else if(!$('modelsWin').classList.contains('hidden')) closeModelsWin();
  }
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
$('btnBpStop').addEventListener('click', stopFlow);
$('btnBpFit').addEventListener('click', fitView);
$('btnBpCheck').addEventListener('click', checkCurrentFlow);

// AI 搭建：自然语言 → 工作流（生成后必须人工确认才落盘）
$('btnFlowGen').addEventListener('click', openFlowGen);
$('genClose').addEventListener('click', closeFlowGen);
$('genCancel').addEventListener('click', () => { if(genAbort){ try { genAbort.abort(); } catch(e){} } closeFlowGen(); });
$('genRun').addEventListener('click', () => genStartRound($('genInput').value));
$('genConfirm').addEventListener('click', genConfirm);
$('genBackdrop').addEventListener('pointerdown', e => { if(e.target === $('genBackdrop')) closeFlowGen(); });
$('genInput').addEventListener('keydown', e => {
  if((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); genStartRound($('genInput').value); }
});

// 变体：提示词 A/B 试跑
$('btnVex').addEventListener('click', openVex);
$('vexClose').addEventListener('click', closeVex);
$('vexCancel').addEventListener('click', vexStop);
$('vexGen').addEventListener('click', vexGenerate);
$('vexRunAll').addEventListener('click', vexRunAll);
$('vexAdopt').addEventListener('click', vexAdopt);
$('vexBackdrop').addEventListener('pointerdown', e => { if(e.target === $('vexBackdrop')) closeVex(); });
$('vexGoal').addEventListener('keydown', e => {
  if((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); vexGenerate(); }
});

// 基准：一键回归
$('btnBenchCapture').addEventListener('click', benchCaptureNow);

// 运行历史
$('tabRuns').addEventListener('click', () => setBpSideTab('runs'));
$('btnRunRefresh').addEventListener('click', () => renderRunHistory());
$('btnRunClear').addEventListener('click', () => {
  if(!confirm('清空全部运行历史？只删记录，不影响工作流与结果。')) return;
  runHistoryClear().then(() => renderRunHistory()).then(() => bpToast('运行历史已清空'));
});

// 记忆：版本快照 + 经验
$('tabMem').addEventListener('click', () => setBpSideTab('mem'));
$('btnVerSave').addEventListener('click', memSaveVersionNow);
$('btnMemClear').addEventListener('click', memClearLessons);

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
  if(!e.target.closest('.var-menu')) hideVarMenu();
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
  if(linkDrag && linkDrag.temp){
    const a = portPos(linkDrag.nodeId, 'out', linkDrag.key);
    const p = screenToWorld(e.clientX, e.clientY);
    if(a) linkDrag.temp.setAttribute('d', linkD(a, p));
  }
});

window.addEventListener('pointerup', e => {
  if(libDrag) endLibDrag(e);
  if(varDrag) endVarDrag(e);
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

// 滚轮缩放已由编辑引擎接管（以光标为锚点），这里只补齐工具按钮
$('btnBpComment').addEventListener('click', () => Editor.comment());
$('btnZoomIn').addEventListener('click', () => Editor.zoomIn());
$('btnZoomOut').addEventListener('click', () => Editor.zoomOut());
$('btnZoomReset').addEventListener('click', () => Editor.zoomReset());
$('btnZoomFit').addEventListener('click', () => Editor.fit());

// 初始加载
initNodeLib();
applySideTab();
loadAll();
initPresets();
renderPresetLinks('llmPresetLinks');
initImgPresets();
syncEngineUI();
renderHome();
showView('home');
