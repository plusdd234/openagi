/* ============================================================
 * 多视图 App · 模型来源（mv-models）
 *
 * 模型从哪来：桌面 App 的模型库 / 拖进来的文件 / 「＋ 文件」。
 * 独立页没有 openagiDesktop，就只剩后两条——这里用函数而不是常量判断，
 * 因为 preload 注入的时机可能比页面脚本晚一步。
 * ============================================================ */
(function () {
  'use strict';

  var MV = window.MV;
  if (!MV) throw new Error('mv-models.js 必须在 mv-core.js 之后加载');

  var state = MV.state;

  function hasDesk() {
    var d = window.openagiDesktop;
    return !!(d && typeof d.assetList === 'function');
  }

  function lib() {
    var d = window.openagiDesktop;
    return (d && typeof d.assetList === 'function') ? d : null;
  }

  function modelExt(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  async function loadModels() {
    var d = lib();
    if (!d) {
      state.models = [];
      state.error = '';
      state.loaded = true;
      return;
    }
    try {
      var r = await d.assetList();
      var all = (r && r.assets) || [];
      state.models = all.filter(function (a) { return a && a.kind === 'model' && !a.missing; });
      state.loaded = true;
      state.error = '';
    } catch (e) {
      state.models = [];
      state.error = '读模型库失败：' + MV.friendly(e);
    }
  }

  async function pickModel(id) {
    var d = lib();
    if (!d) { state.error = '桌面端才能读本地模型库'; MV.paint(); return; }
    var m = state.models.filter(function (a) { return a.id === id; })[0];
    if (!m) return;
    MV.setBusy('loading');
    try {
      var r = await d.assetRead(id);
      if (!r || !r.ok || !r.dataURL) throw new Error('文件已丢失');
      state.cur = { id: id, name: m.name, src: r.dataURL };
      state.error = '';
      if (window.MVProject && MVProject.clearResult) MVProject.clearResult();
      MV.paintModels();
      MV.render();                     // 选完立刻出图：改参数会自动重渲，选模型也该一样
    } catch (e) {
      state.error = '打不开「' + m.name + '」：' + MV.friendly(e);
      MV.setBusy('');
      MV.paint();
    }
  }

  function takeFile(file) {
    if (!file) return;
    var ext = modelExt(file.name);
    if (['glb', 'gltf', 'obj', 'fbx'].indexOf(ext) < 0) {
      state.error = '只认 glb / gltf / obj / fbx（' + (ext ? '.' + ext : '无扩展名') + ' 解析不了）';
      MV.paint();
      return;
    }
    MV.setBusy('loading');
    var rd = new FileReader();
    rd.onload = function () {
      state.cur = { id: '', name: file.name, src: String(rd.result || '') };
      state.error = '';
      if (window.MVProject && MVProject.clearResult) MVProject.clearResult();
      MV.paintModels();
      MV.render();
    };
    rd.onerror = function () {
      state.error = '读不了这个文件';
      MV.setBusy('');
      MV.paint();
    };
    rd.readAsDataURL(file);
  }

  MV.hasDesk = hasDesk;
  MV.lib = lib;
  MV.modelExt = modelExt;
  MV.loadModels = loadModels;
  MV.pickModel = pickModel;
  MV.takeFile = takeFile;
})();
