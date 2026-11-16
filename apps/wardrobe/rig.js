/* 衣柜的 Live2D 预览运行时。
 *
 * 单独抽成一个模块（挂在 window.WD_RIG），不碰任何界面：
 *   · 皮套目录与数字人 App 共用 apps/live2d/model/<id>/，运行时也用同一套 vendor；
 *   · 每个模型由 tools/pack-live2d.js 预打包成 pack.js（moc3 → base64、json → 对象），
 *     file:// 下不走 XHR，直接吃包里的数据；
 *   · 换装用「部件透明度」：Cubism 运行时每个部件都有 opacity，压到 0 即停绘。
 *     不沿用动作 / pose 的自然透明度 —— 隐藏时先记下原值，取消隐藏再还回去。
 *
 * 扩展方式：新 App 想复用舞台，直接 WD_RIG.create(host) 即可；
 * 新的「换装维度」可以在这个模块上加方法，不用改界面。
 */
window.WD_RIG = (function () {
  'use strict';

  var VENDOR = [
    'apps/live2d/vendor/pixi.min.js',
    'apps/live2d/vendor/live2dcubismcore.min.js',
    'apps/live2d/vendor/cubism4.min.js'
  ];
  var MODEL_DIR = 'apps/live2d/model/';
  var MODELS_SRC = MODEL_DIR + 'models.js';
  /* 皮套在舞台上占的高度比例；1 刚好不裁切 */
  var FIT = 0.96;

  /* 与数字人 App 共用脚本缓存：pixi / Cubism 运行时全页只加载一次 */
  var scriptCache = window.__L2D_SCRIPT_CACHE || (window.__L2D_SCRIPT_CACHE = {});

  function inject(src) {
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = function () { resolve(); };
      el.onerror = function () { reject(new Error('脚本加载失败：' + src)); };
      document.head.appendChild(el);
    });
    return scriptCache[src];
  }

  function b64ToBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }

  /* 模型加载器中间件：只回答「settings 上挂了 __wdPack」的请求。
     按 settings 归属而不是全局当前包，多个 App 同时开着也不会串包。 */
  function installPackHook() {
    var loader = window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DLoader;
    if (!loader || loader.__wdPackHook) return;
    loader.__wdPackHook = true;
    loader.middlewares.unshift(function (ctx, next) {
      var pack = ctx.settings && ctx.settings.__wdPack;
      if (!pack) return next();
      var mocUrl = pack.settings.FileReferences.Moc;
      if (ctx.type === 'arraybuffer' && ctx.url === mocUrl) {
        ctx.result = b64ToBuffer(pack.moc);
        return;
      }
      var data = pack.json[ctx.url];
      if (data) { ctx.result = data; return; }
      return next();
    });
  }

  function ensureRuntime() {
    var chain = Promise.resolve();
    VENDOR.forEach(function (src) {
      chain = chain.then(function () { return inject(src); });
    });
    return chain.then(function () {
      if (window.L2D_MODELS) return window.L2D_MODELS;
      return inject(MODELS_SRC).then(function () { return window.L2D_MODELS || []; });
    }).then(function (models) {
      if (!window.PIXI || !window.PIXI.live2d) throw new Error('Live2D 运行时未就绪');
      installPackHook();
      return models || [];
    });
  }

  /* 从 cdi3 读部件名，再补上运行时里 cdi3 没写到的部件 */
  function readParts(pack, model) {
    var list = [];
    var seen = {};
    var refs = (pack.settings && pack.settings.FileReferences) || {};
    var cdi = refs.DisplayInfo ? pack.json[refs.DisplayInfo] : null;
    if (cdi && Array.isArray(cdi.Parts)) {
      cdi.Parts.forEach(function (p) {
        if (!p || !p.Id || seen[p.Id]) return;
        seen[p.Id] = 1;
        list.push({ id: p.Id, name: p.Name || p.Id });
      });
    }
    try {
      var ids = model.internalModel.coreModel.getModel().parts.ids || [];
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (!id || seen[id]) continue;
        seen[id] = 1;
        list.push({ id: id, name: id });
      }
    } catch (e) { /* 运行时读不到部件就只用 cdi3 */ }
    return list;
  }

  function create(host, hooks) {
    hooks = hooks || {};

    var st = {
      host: host,
      app: null,
      model: null,
      pack: null,
      def: null,
      modelId: '',
      parts: [],
      loading: false,
      ready: false,
      error: '',
      gen: 0,
      /* want：界面要求隐藏的部件；hidden：当前真正压住的部件 */
      want: [],
      hidden: {},
      stash: {},
      raf: 0,
      last: 0,
      ro: null
    };

    function info() {
      return {
        ready: st.ready,
        loading: st.loading,
        error: st.error,
        modelId: st.modelId,
        parts: st.parts,
        hidden: Object.keys(st.hidden)
      };
    }

    function emit() {
      if (typeof hooks.onChange !== 'function') return;
      try { hooks.onChange(info()); } catch (e) { /* 回调出错不拖垮舞台 */ }
    }

    function fit() {
      if (!st.ready || !st.app || !st.model) return;
      var w = host.clientWidth;
      var h = host.clientHeight;
      if (!w || !h) return;
      st.app.renderer.resize(w, h);

      /* internalModel 的宽高是模型画布尺寸（未乘缩放），先量再缩放 */
      var bw = st.model.internalModel.width || st.model.width;
      var bh = st.model.internalModel.height || st.model.height;
      if (!bw || !bh) return;
      var s = Math.min(w / bw, h / bh) * FIT;
      st.model.scale.set(s);
      st.model.x = (w - bw * s) / 2;
      st.model.y = h - bh * s;
    }

    /* 把 want 落到运行时；取消隐藏时还回记下的原透明度 */
    function syncHidden() {
      if (!st.model) return;
      var cm = st.model.internalModel.coreModel;
      var next = {};
      st.want.forEach(function (id) { if (id) next[id] = 1; });

      Object.keys(st.hidden).forEach(function (id) {
        if (next[id]) return;
        var v = st.stash[id];
        cm.setPartOpacityById(id, v == null ? 1 : v);
        delete st.stash[id];
      });
      Object.keys(next).forEach(function (id) {
        if (st.hidden[id]) return;
        var v = 1;
        try { v = cm.getPartOpacityById(id); } catch (e) { v = 1; }
        st.stash[id] = v;
        cm.setPartOpacityById(id, 0);
      });
      st.hidden = next;
    }

    function setHidden(ids) {
      st.want = (ids || []).filter(function (id) { return typeof id === 'string' && id; });
      syncHidden();
      emit();
    }

    function partOpacity(id) {
      if (!st.model) return null;
      try { return st.model.internalModel.coreModel.getPartOpacityById(id); }
      catch (e) { return null; }
    }

    function startLoop() {
      if (st.raf) return;
      st.last = 0;
      var step = function (now) {
        if (!st.model || !st.app) { st.raf = 0; return; }
        st.raf = requestAnimationFrame(step);
        if (document.hidden) return;
        var win = host.closest ? host.closest('.os-win') : null;
        if (win && (win.classList.contains('hidden') || !win.offsetWidth)) return;
        var dt = st.last ? Math.min(0.06, (now - st.last) / 1000) : 0.016;
        st.last = now;
        /* ⚠ Live2DModel.update() 吃毫秒，不是秒 */
        st.model.update(dt * 1000);
      };
      st.raf = requestAnimationFrame(step);
    }

    function mount(def, pack, gen) {
      var refs = Object.assign({}, pack.settings.FileReferences, { Textures: pack.textures });
      var json = Object.assign({}, pack.settings, {
        FileReferences: refs,
        url: new URL(def.dir, location.href).href
      });
      var settings = new window.PIXI.live2d.Cubism4ModelSettings(json);
      /* 中间件靠这个标记认领本模型的 moc / json */
      settings.__wdPack = pack;

      var app = new window.PIXI.Application({
        transparent: true,
        antialias: true,
        autoStart: true,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        autoDensity: true,
        backgroundAlpha: 0
      });
      app.view.className = 'wd-cvs';
      host.appendChild(app.view);
      st.app = app;

      return window.PIXI.live2d.Live2DModel.from(settings, {
        autoUpdate: false,
        autoInteract: false
      }).then(function (model) {
        /* 加载途中换了皮套：丢掉这次结果，别往舞台上叠第二个模型 */
        if (st.gen !== gen) {
          try { app.destroy(true); } catch (e) { /* 已销毁 */ }
          return;
        }
        app.stage.addChild(model);
        st.model = model;
        st.pack = pack;
        st.parts = readParts(pack, model);
        st.hidden = {};
        st.stash = {};

        /* 每帧在模型更新前把隐藏部件压回 0：动作 / 变形会改部件透明度，不压会被拉起来 */
        model.internalModel.on('beforeModelUpdate', function () {
          var cm = model.internalModel.coreModel;
          var ids = Object.keys(st.hidden);
          for (var i = 0; i < ids.length; i++) cm.setPartOpacityById(ids[i], 0);
        });

        /* idle 组一般叫 Idle；本项目皮套注册成 idle，有就优先用 */
        var mm = model.internalModel.motionManager;
        if (mm && mm.definitions && mm.definitions.idle) mm.groups.idle = 'idle';

        st.ready = true;
        st.loading = false;
        fit();
        syncHidden();
        if (window.ResizeObserver) {
          st.ro = new ResizeObserver(function () { fit(); });
          st.ro.observe(host);
        }
        startLoop();
        emit();
      });
    }

    function pickDef(models, id) {
      var def = null;
      (models || []).forEach(function (m) { if (m && m.id === id) def = m; });
      return def;
    }

    /* 销毁场景，但保留 want（换皮套后还要继续隐藏同一批部件） */
    function destroyScene() {
      if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
      if (st.ro) { st.ro.disconnect(); st.ro = null; }
      if (st.app) {
        try { st.app.destroy(true, { children: true, texture: false }); }
        catch (e) { try { st.app.destroy(true); } catch (e2) { /* 已销毁 */ } }
      }
      if (host) host.innerHTML = '';
      st.app = null;
      st.model = null;
      st.pack = null;
      st.parts = [];
      st.ready = false;
      st.loading = false;
      st.stash = {};
      st.hidden = {};
    }

    function load(modelId) {
      var gen = ++st.gen;
      destroyScene();
      st.loading = true;
      st.error = '';
      emit();

      return ensureRuntime().then(function (models) {
        if (gen !== st.gen) return null;
        var def = pickDef(models, modelId);
        if (!def) def = (models || []).filter(function (m) { return m && m.id && m.pack; })[0];
        if (!def) throw new Error('没有可用的皮套：apps/live2d/model/models.js 为空');
        st.def = def;
        st.modelId = def.id;
        return inject(def.pack).then(function () {
          if (gen !== st.gen) return null;
          var pack = window.L2D_PACKS && window.L2D_PACKS[def.id];
          if (!pack) throw new Error('皮套数据包缺失：' + def.pack);
          return mount(def, pack, gen).then(function () {
            return st.gen === gen ? info() : null;
          });
        });
      }).catch(function (err) {
        if (gen !== st.gen) return null;
        st.loading = false;
        st.ready = false;
        st.error = (err && err.message) || String(err);
        emit();
        return info();
      });
    }

    function dispose() {
      st.gen++;
      destroyScene();
      st.want = [];
      st.modelId = '';
      st.error = '';
      emit();
    }

    return {
      load: load,
      dispose: dispose,
      setHidden: setHidden,
      partOpacity: partOpacity,
      fit: fit,
      info: info,
      parts: function () { return st.parts.slice(); }
    };
  }

  return {
    create: create,
    runtime: ensureRuntime,
    models: function () { return ensureRuntime(); }
  };
})();
