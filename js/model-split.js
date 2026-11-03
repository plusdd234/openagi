/* ============================================================
 * AI 拆件：让语言模型自己读 UV 岛，把模型分成若干部件
 *
 * 流程（三步，前两步是「看懂」，第三步才是「动手」）：
 *   ① 分析：ModelTex.analyze 按共享 UV 边分出 UV 岛，挑出「候选岛」
 *      （真实角色动辄上千个碎岛，全塞给 AI 既读不完也没必要——
 *        按三角形数从大到小取前 N 个，剩下的岛最后按空间位置自动归属）
 *   ② 观察：每个网格一张「候选岛编号图」+ 一张三视图，连同候选岛元数据
 *      （三角数 / UV 面积 / 归一化质心 / Y 跨度）发给语言模型
 *   ③ 重建：按 AI 的岛→部件映射，把三角形重建成独立几何（复用原材质），
 *      导出多节点 GLB；剩下的碎岛按「最近的已归属岛」逐级传播归属
 *
 * 为什么候选岛图要**按网格分开**：GLB 里同一角色的头发 / 身体 / 脸常是
 * 多个 mesh，各自占满 0–1 UV 空间。叠在一张图上编号会互相压在同一个位置，
 * 图看着挺满，AI 却会把「头发的 15 号」读成「身体的 15 号」。
 *
 * 依赖：three.js、Model3D、ModelTex、GLTFExporter（本地 vendor）。
 * 对外接口（全局 ModelSplit）：
 *   open(model) / close()                 UI 弹层（mvSplitPanel）
 *   prepare(src, opts)                    分析 + 候选岛图
 *   run(src, opts, progress)              完整拆件（AI + 重建 + 预览）
 *   build(a, parts)                       纯几何重建（无 AI，测试可用）
 *   preview(built) / toGLB(root) / toPartGLB(built, i)
 * ============================================================ */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  var TIMEOUT = 180000;          // AI 读图慢，默认 180s；普通文本接口 20s 就够
  var ATLAS_SIZE = 1024;
  var VIEW_CELL = 430;
  var MAX_PART_VIEWS = 4;        // 超过 4 个网格时不再逐网格出图，合并成一张
  var COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0',
    '#f032e6', '#bcf60c', '#008080', '#9a6324', '#e6beff', '#808000'];

  function $(id) { return document.getElementById(id); }
  function ls(k) { try { return localStorage.getItem('hf_' + k) || ''; } catch (e) { return ''; } }
  function clamp(v, lo, hi) { v = Number(v); if (!isFinite(v)) v = lo; return Math.max(lo, Math.min(hi, v)); }
  function valOf(id) { var el = $(id); return el && typeof el.value === 'string' ? el.value.trim() : ''; }

  /* ---------------- 配置：桌面 App 读 DOM，独立页读 localStorage ---------------- */

  function readCfg() {
    return {
      base: (valOf('llmBaseUrl') || ls('llmBaseUrl')).replace(/\/$/, ''),
      model: valOf('llmModel') || ls('llmModel'),
      key: valOf('llmKey') || ls('llmKey'),
      relayOn: (function () {
        var el = $('relayOn');
        if (el) return !!el.checked;
        var v = ls('relayOn').toLowerCase();
        return v === '1' || v === 'true';
      })(),
      relayBase: (valOf('relayUrl') || ls('relayUrl') || 'http://127.0.0.1:8787').replace(/\/$/, '')
    };
  }

  function cfgIssue(c) {
    if (!c.base) return '没有配置分析接口的 Base URL（设置 → 模型与接口）';
    if (!c.model) return '没有配置分析模型';
    if (!c.key) return '没有配置分析接口的 API Key';
    return '';
  }

  /* ---------------- 网络：直连优先，失败再走本地中转 ---------------- */

  function fetchTimeout(url, init, ms) {
    return new Promise(function (resolve, reject) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('请求超时（' + Math.round(ms / 1000) + 's）'));
      }, ms);
      fetch(url, ctrl ? Object.assign({}, init, { signal: ctrl.signal }) : init).then(function (r) {
        clearTimeout(timer); resolve(r);
      }, function (e) {
        clearTimeout(timer); reject(e);
      });
    });
  }

  async function readJsonBody(res) {
    if (!res.ok) {
      var t = await res.text();
      throw new Error('HTTP ' + res.status + ': ' + String(t).slice(0, 300));
    }
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('text/html') >= 0) {
      throw new Error('接口返回的是网页而不是 API 数据（通常是地址少了 /v1）');
    }
    return res.json();
  }

  async function chat(c, messages, maxTokens) {
    var url = c.base + '/chat/completions';
    var body = JSON.stringify({
      model: c.model,
      messages: messages,
      max_tokens: maxTokens || 1600,
      temperature: 0
    });
    var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key };
    try {
      return await readJsonBody(await fetchTimeout(url, { method: 'POST', headers: headers, body: body }, TIMEOUT));
    } catch (e) {
      /* 网络层失败（CORS / 连不上）才切中转；接口返回的 4xx 原样抛出去，
       * 那不是中转能解决的问题，切了也是再错一次。 */
      var net = /Failed to fetch|NetworkError|Load failed|ERR_|请求超时/.test(String(e && e.message));
      if (!net || !c.relayOn) throw e;
      var rh = Object.assign({}, headers, { 'X-Relay-Target': url });
      return await readJsonBody(await fetchTimeout(c.relayBase + '/proxy',
        { method: 'POST', headers: rh, body: body }, TIMEOUT));
    }
  }

  function replyText(data) {
    var msg = data && data.choices && data.choices[0] && data.choices[0].message;
    var c = msg && msg.content;
    if (Array.isArray(c)) c = c.map(function (p) { return (p && (p.text || p.content)) || ''; }).join('');
    if (typeof c !== 'string' || !c.trim()) {
      throw new Error('模型没有返回内容' + (data && data.error ? '：' + JSON.stringify(data.error).slice(0, 120) : ''));
    }
    return c.trim();
  }

  /* ---------------- 候选岛 ---------------- */

  function pickCandidates(a, maxC, minTris) {
    maxC = clamp(maxC || 120, 12, 260);
    minTris = clamp(minTris == null ? 8 : minTris, 3, 60);
    var sorted = a.islands.slice().sort(function (x, y) { return y.tris.length - x.tris.length; });
    var out = [];
    for (var i = 0; i < sorted.length && out.length < maxC; i++) {
      var o = sorted[i];
      if (o.tris.length < minTris && out.length >= 24) break;
      out.push(o);
    }
    out.sort(function (x, y) { return x.id - y.id; });
    return out;
  }

  /* 每个候选岛一行元数据。归一化到 0–1，AI 不需要知道模型单位是毫米还是厘米。 */
  function candidateTable(a, chosen) {
    var size = a.box.getSize(new THREE.Vector3());
    var min = a.box.min;
    var sumArea = 0;
    a.islands.forEach(function (o) { sumArea += o.area; });
    sumArea = Math.max(sumArea, 1e-9);
    function n(v, lo, span) { return ((v - lo) / Math.max(span, 1e-6)).toFixed(3); }
    return chosen.map(function (o) {
      var c = o.centroid, b = o.bbox;
      return {
        id: o.id,
        tris: o.tris.length,
        uvPct: +(o.area / sumArea * 100).toFixed(2),
        slot: o.tris[0] ? o.tris[0].part : 0,
        center: [n(c[0], min.x, size.x), n(c[1], min.y, size.y), n(c[2], min.z, size.z)],
        dy: +((b[4] - b[1]) / Math.max(a.h, 1e-6)).toFixed(3)
      };
    });
  }

  /* 岛图 / 三视图都以 JPEG 发出：同样 1024 见方，PNG 一张能到 2MB，
   * 三张加起来 4MB+，中转上游会被 Cloudflare 524 掐断（实测）。JPEG 0.85 只有 1/10 体积，
   * 图上只有平涂色块和编号，压缩伪影不影响识别。 */
  function imgURL(canvas, q) {
    return canvas.toDataURL('image/jpeg', q == null ? 0.85 : q);
  }

  function atlasOf(a, ids, slots) {
    if (Array.isArray(slots)) {
      /* 每个网格一张图。parts 参数是「只看这个插槽的三角形」，编号保持不变。 */
      return slots.map(function (pi) {
        return imgURL(ModelTex.islandAtlas(a, ATLAS_SIZE, { labels: true, candidates: ids, parts: [pi], bg: '#181b20' }));
      });
    }
    return [imgURL(ModelTex.islandAtlas(a, ATLAS_SIZE, { labels: true, candidates: ids, bg: '#181b20' }))];
  }

  /* 本轮还剩的岛对应的岛图：只出「确实还有剩余岛」的槽位，少发一张是一张。 */
  function atlasFor(a, ids, slots) {
    var idSet = ids instanceof Set ? ids : new Set(ids);
    var useSlots = Array.isArray(slots) ? slots.filter(function (pi) { return pi != null; }) : [];
    var has = {};
    a.islands.forEach(function (o) {
      if (!idSet.has(o.id)) return;
      o.tris.forEach(function (r) { has[r.part] = 1; });
    });
    var keep = useSlots.filter(function (pi) { return has[pi]; });
    if (!keep.length) keep = useSlots;
    if (!keep.length) {
      return {
        slots: [null],
        urls: [imgURL(ModelTex.islandAtlas(a, ATLAS_SIZE, {
          labels: true, candidates: Array.from(idSet), bg: '#181b20'
        }))]
      };
    }
    return {
      slots: keep,
      urls: keep.map(function (pi) {
        return imgURL(ModelTex.islandAtlas(a, ATLAS_SIZE, {
          labels: true, candidates: Array.from(idSet), parts: [pi], bg: '#181b20'
        }));
      })
    };
  }

  function allSlots(a) {
    return a.parts.map(function (_, i) { return i; });
  }

  /* 三视图观察图：告诉 AI 「这个模型长什么样」，UV 图告诉它「编号在哪」。
   * 透明底会让 PNG 在某些查看器/模型里发黑，这里铺一层浅灰底。 */
  async function observe(src) {
    if (!global.Model3D || typeof Model3D.viewGrid !== 'function') return '';
    var o = await Model3D.viewGrid(src, {
      views: ['front', 'left', 'back'],
      cell: VIEW_CELL, cols: 3, gap: 8,
      mode: 'shaded', wire: false, labels: false,
      transparent: false, bgColor: '#eef1f5'
    });
    return o && o.png || '';
  }

  /* ---------------- 提示词 ---------------- */

  function splitNames(text) {
    var out = String(text || '').split(/[、,，;；\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    return out.length ? out.slice(0, 8) : ['面部和脖子', '头发和头饰', '身体'];
  }

  /* 每轮只拆一个部件。把「已拆走」和「还没归属」在图上分开，让模型专注最有把握的一刀，
   * 而不是一次性把 120 个 id 摊给三个部件（实测那样最容易把一堆中低位置的岛塞进头部）。
   * 图片顺序：已分件视图（每个一张）→ 未分件三视图 → 各槽位 UV 岛图（只编号还没归属的岛）。 */
  function buildRoundMessages(prep, ctx, withImages) {
    var rows = prep.table.filter(function (m) { return ctx.someIds(m.id); })
      .map(function (m) {
        return m.id + ': tris=' + m.tris + ' uv=' + m.uvPct + '% c=(' +
          m.center.join(',') + ') dy=' + m.dy + ' slot=' + m.slot;
      }).join('\n');

    /* 只对常见部件加解释，别的名字按字面划分。
     * 不加这几句时模型会把胸甲、披风一起算进头（实测），或者把裙摆算成头发。 */
    var tips = [];
    if (ctx.names.some(function (s) { return /头|面|脸|颈|脖/.test(s) && !/发/.test(s); })) {
      tips.push('· 头部（面部 / 脖子）：只含头骨、脸、五官、耳朵和脖子；肩膀以下不算。'
        + '它只占模型总高度的最上端一小段，一堆积在中低位置的岛分给它就是分错了。');
    }
    if (ctx.names.some(function (s) { return /发/.test(s); })) {
      tips.push('· 头发（含头饰）：只含发丝、刘海、发束、马尾、发卡发饰；衣服、裙子、披风、四肢一律不算。');
    }
    if (ctx.names.some(function (s) { return /身|体|躯干/.test(s); })) {
      tips.push('· 身体：含躯干、衣服、裙摆、披风、手臂、腿、脚、鞋子。');
    }

    var intro = [
      '你是 3D 角色的 UV 拆件助手。模型的 Y 轴向上，包围盒已归一化到 0–1。',
      '清单每行一个候选岛（id: 三角形数 / UV 面积占比 / 三维质心 x,y,z / Y 跨度 / 网格槽位）。',
      '质心 y 越大越高（0 是脚底，1 是头顶）；dy 是岛在竖直方向跨过的比例（长发、裙摆会很大）。',
      '',
      '这一轮可以拆一个或多个部件：把你有把握的都挑出来（每个都带 confidence），没把握的留到下一轮。',
      '待拆部件：' + ctx.names.join('、') + '。',
      '每个岛要么给某一个部件、要么留在清单里；同一个岛不能给两个部件。',
      ctx.locked.length
        ? '已经拆走：' + ctx.locked.map(function (p) { return p.name + '（' + p.count + ' 岛）'; }).join('、')
          + '——这些岛已经不在本轮清单里了，别重复。'
        : '这是第一轮，所有岛都还没归属。',
      'confidence 是你对那一份归属的把握（0–1）；没把握的部件就别急着给岛。',
      '',
      '也可以不数编号、直接画框：在「未分件四视图」（前 / 左 / 后 / 右）上各画一个矩形，系统取四个框的交集——同时落在四个框里的岛才算选中。',
      '{"marks":[{"part":"' + ctx.names[0] + '","view":"front","box":[0.2,0.05,0.8,0.3]},'
        + '{"part":"' + ctx.names[0] + '","view":"left","box":[0.2,0.05,0.8,0.3]},'
        + '{"part":"' + ctx.names[0] + '","view":"back","box":[0.2,0.05,0.8,0.3]},'
        + '{"part":"' + ctx.names[0] + '","view":"right","box":[0.2,0.05,0.8,0.3]}]}',
      '坐标归一化：左上 0,0，右下 1,1，图上有 0.1 网格。四个视图少一个就选不中；同一视图里多个框先并集。',
      '框要贴住部件本身：想切掉前后层，就把侧视图的左右边界收窄；只想留头部，就把四个框的上边界都压在肩膀以上。',
      '系统会自己算出命中哪些岛，再回一张确认图给你看——这时候只要说对不对，不用抄 id。'
    ].join('\n');

    if (ctx.hint) intro += '\n\n注意：' + ctx.hint;
    if (tips.length) intro += '\n\n' + tips.join('\n');

    if (withImages) {
      intro += '\n\n随附图片：'
        + (ctx.parts.length ? ctx.parts.length + ' 张「已分件四视图」（已经拆走的部件单独长什么样，颜色对应）+ ' : '')
        + '1 张「未分件四视图」（还没归属的岛，带 0.1 网格）'
        + '、' + ctx.atlases.length + ' 张「UV 岛图」（只给还没归属的候选岛编号；暗灰色是已拆走或碎岛，别再选）。'
        + '先看未分件四视图判断这一刀切开哪，再画框或翻 UV 图的编号落到具体的岛。';
    }

    var content = [{ type: 'text', text: intro }];
    if (withImages) {
      ctx.parts.forEach(function (p) {
        content.push({ type: 'text', text: '已分件 · ' + p.name });
        content.push({ type: 'image_url', image_url: { url: p.url } });
      });
      if (ctx.rest) {
        content.push({ type: 'text', text: '未分件四视图（前 / 左 / 后 / 右）' });
        content.push({ type: 'image_url', image_url: { url: ctx.rest } });
      }
      ctx.atlases.forEach(function (url, i) {
        content.push({ type: 'text', text: 'UV 岛图 · slot ' + (ctx.atlasSlots[i] == null ? i : ctx.atlasSlots[i]) });
        content.push({ type: 'image_url', image_url: { url: url } });
      });
      if (ctx.confirm) {
        content.push({ type: 'text', text: '框选确认图（绿 = 选中，红 = 排除，灰 = 没选中；描边是原样的四个框）' });
        content.push({ type: 'image_url', image_url: { url: ctx.confirm.img } });
      }
    }

    var ask = ctx.confirm
      ? '这是「' + ctx.confirm.part + '」的框选结果：四个视图的框取交集，算出 ' + ctx.confirm.count + ' 个岛。'
        + '\n看确认图：绿块正好是该部件、没有多圈进别的部件 → 输出 {"ok":true,"part":"' + ctx.confirm.part + '","confidence":0.9}；'
        + '有漏就把对应视图的框改大一点（四个视图重新给全），有多余就把框收紧或加一个 mode=out 的框。'
        + '\n只输出 JSON：{"ok":true,"part":"...","confidence":0.9}'
      : '候选岛清单：\n' + rows
        + '\n\n只输出 JSON，不要解释：\n'
        + '{"parts":[{"part":"' + ctx.names[0] + '","islands":[12,34,56],"confidence":0.9}]}'
        + '\n或者画框（四个视图都必须给）：\n'
        + '{"marks":[{"part":"' + ctx.names[0] + '","view":"front","box":[0.2,0.05,0.8,0.3]},'
        + '{"part":"' + ctx.names[0] + '","view":"left","box":[0.2,0.05,0.8,0.3]},'
        + '{"part":"' + ctx.names[0] + '","view":"back","box":[0.2,0.05,0.8,0.3]},'
        + '{"part":"' + ctx.names[0] + '","view":"right","box":[0.2,0.05,0.8,0.3]}]}';

    content.push({ type: 'text', text: ask });

    return [
      { role: 'system', content: '你只输出合法 JSON，不输出任何解释、Markdown 或代码块标记。' },
      { role: 'user', content: content }
    ];
  }

  function extractJson(text) {
    var s = String(text || '');
    s = s.replace(/```json/gi, '').replace(/```/g, '').trim();
    var i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
    try { return JSON.parse(s); } catch (e) { }
    /* 偶尔模型会把 JSON 写成单引号 / 尾逗号，容忍一次 */
    var t = s.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"');
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  /* 一轮的应答：
   *   {"parts":[{part, islands, confidence}, ...]}  → 直接给岛
   *   {"marks":[{part, view, cx, cy, r, mode}]}     → 画圈，由系统算出命中的岛
   *   {"ok":true,"part":...,"confidence":...}       → 确认上一张圈选图
   * 同一轮里重复出现的岛只算给第一个部件；也兼容只给单个对象的写法。 */
  function parseRound(text, ctx) {
    var j = extractJson(text);
    if (!j) throw new Error('AI 返回的不是约定的 JSON：' + String(text).slice(0, 160));
    if (Array.isArray(j.marks) && j.marks.length) return { marks: parseMarks(j.marks, ctx.names) };
    if (j.ok === true || j.ok === 'true') {
      var want2 = String(j.part || '').trim();
      var hitOk = ctx.names.filter(function (n) { return want2 && (want2.indexOf(n) >= 0 || n.indexOf(want2) >= 0); })[0];
      var c2 = Number(j.confidence);
      return { ok: true, part: hitOk || ctx.names[0], confidence: isFinite(c2) ? clamp(c2, 0, 1) : 0 };
    }
    var arr = Array.isArray(j.parts) ? j.parts
      : (Array.isArray(j) ? j : ((j.islands || j.ids) ? [j] : null));
    if (!arr) throw new Error('AI 返回里没有 parts：' + String(text).slice(0, 160));

    var seen = {};
    var out = [];
    arr.forEach(function (obj) {
      var ids = obj && (obj.islands || obj.ids || obj.island || obj.list);
      if (!Array.isArray(ids)) return;
      var keep = [];
      ids.forEach(function (raw) {
        var id = Number(raw);
        if (!isFinite(id) || !ctx.someIds(id) || seen[id]) return;
        seen[id] = 1; keep.push(id);
      });
      if (!keep.length) return;

      var want = String((obj.part || obj.name || obj.label) || '').trim();
      var hit = ctx.names.filter(function (n) { return want && (want.indexOf(n) >= 0 || n.indexOf(want) >= 0); })[0];
      if (!hit) {
        hit = ctx.names[0];
        console.info('[ModelSplit] 部件名不在待拆清单里（' + want + '），按待拆第一位处理');
      }
      var conf = Number(obj.confidence);
      out.push({ name: hit, ids: keep, confidence: isFinite(conf) ? clamp(conf, 0, 1) : 0 });
    });

    if (!out.length) throw new Error('AI 没有给出有效的岛归属：' + String(text).slice(0, 160));
    /* 同一轮里同一个部件写了两次：合并，免得后一份把前一份覆盖掉 */
    var merged = [];
    out.forEach(function (p) {
      var m = merged.filter(function (x) { return x.name === p.name; })[0];
      if (m) {
        m.ids = m.ids.concat(p.ids);
        m.confidence = Math.max(m.confidence, p.confidence);
      } else merged.push(p);
    });
    return merged.sort(function (a, b) { return b.confidence - a.confidence; });
  }

  async function askOneRound(cfg, prep, ctx, state, progress) {
    /* state.answer 是离线替身：测试时不联网，直接拿脚本来喂 JSON。
     * 放这里而不是放 run() 里，是为了「真实流程一行不改也能被完整验证」。 */
    if (typeof state.answer === 'function') {
      var t0 = await state.answer(buildRoundMessages(prep, ctx, state.withImages), ctx);
      ui.rawReply = t0;
      return parseRound(t0, ctx);
    }
    var issue = cfgIssue(cfg);
    if (issue) throw new Error(issue);
    try {
      var data = await chat(cfg, buildRoundMessages(prep, ctx, state.withImages), 2000);
      ui.rawReply = replyText(data);
      return parseRound(ui.rawReply, ctx);
    } catch (e) {
      /* 有的端点收不了 image_url：退回纯文本（元数据里已有三维位置）。
       * 只在「看起来像图片被拒」时重试，别把普通解析失败也再打一次。 */
      if (!state.withImages || !/image|vision|multimodal|media|图片|图像|content.*(type|part)/i.test(String(e && e.message))) throw e;
      if (progress) progress('round', '这个模型不收图片，后续改用纯元数据继续拆…');
      state.withImages = false;
      var d2 = await chat(cfg, buildRoundMessages(prep, ctx, false), 2000);
      ui.rawReply = replyText(d2);
      return parseRound(ui.rawReply, ctx);
    }
  }

  /* ---------------- 岛归属：AI 给的先记下，其余按最近邻传播 ---------------- */

  function resolveAssign(a, parts) {
    var n = a.islands.length;
    var assign = new Int32Array(n);
    for (var i = 0; i < n; i++) assign[i] = -1;
    var list = parts.map(function (p, pi) {
      return { name: p.name, color: COLORS[pi % COLORS.length], ids: [], tris: 0 };
    });
    parts.forEach(function (p, pi) {
      (p.islands || []).forEach(function (raw) {
        var id = Number(raw);
        if (!isFinite(id) || id < 0 || id >= n || assign[id] >= 0) return;
        assign[id] = pi; list[pi].ids.push(id);
      });
    });

    var assigned = 0;
    for (var i2 = 0; i2 < n; i2++) if (assign[i2] >= 0) assigned++;
    if (!assigned) throw new Error('一个岛都没分出去');

    /* 未归属的岛按三角形数从大到小处理：先喂大的，小的再就近贴到已经归属的邻居上。
     * 这比「离部件质心最近」靠谱——部件质心是全局平均值，长发发梢离发根很远，
     * 但离旁边那撮已经归好的头发很近。 */
    var rest = [];
    var anchors = [];
    for (var i3 = 0; i3 < n; i3++) {
      if (assign[i3] >= 0) anchors.push(i3); else rest.push(i3);
    }
    rest.sort(function (x, y) { return a.islands[y].tris.length - a.islands[x].tris.length; });
    var auto = 0;
    rest.forEach(function (id) {
      var c = a.islands[id].centroid, best = -1, bd = Infinity;
      for (var k = 0; k < anchors.length; k++) {
        var ac = a.islands[anchors[k]].centroid;
        var dx = c[0] - ac[0], dy = c[1] - ac[1], dz = c[2] - ac[2];
        var d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; best = anchors[k]; }
      }
      assign[id] = assign[best];
      anchors.push(id);
      auto++;
    });

    a.islands.forEach(function (o, id) {
      var pi = assign[id];
      if (!list[pi]) return;
      list[pi].tris += o.tris.length;
    });

    return { assign: assign, list: list, auto: auto, aiAssigned: assigned };
  }

  /* ---------------- 按岛归属重建几何 ---------------- */

  function sourceMaterials(a) {
    var mats = [];
    a.root.traverse(function (o) {
      if (o.isMesh && o.geometry && o.geometry.attributes.position) mats.push(o.material);
    });
    return mats;
  }

  /* 一个源网格里选中的三角形 → 非索引几何。
   * 坐标烘成世界空间（父节点的缩放/旋转不再参与），这样各部件能平铺在同一个组里；
   * 法线用 normalMatrix 变换，没有法线时按重建后的面算一遍。 */
  function extractGeometry(part, tris) {
    var vi = function (t, k) { return part.idx ? part.idx.getX(t * 3 + k) : t * 3 + k; };
    var pos = part.pos, uv = part.uv, nAttr = part.g.attributes.normal;
    var mat3 = nAttr ? new THREE.Matrix3().getNormalMatrix(part.mw) : null;
    var v = new THREE.Vector3(), n = new THREE.Vector3();
    var P = [], U = [], N = [];
    for (var i = 0; i < tris.length; i++) {
      var t = tris[i];
      for (var k = 0; k < 3; k++) {
        var idx = vi(t, k);
        v.set(pos.getX(idx), pos.getY(idx), pos.getZ(idx)).applyMatrix4(part.mw);
        P.push(v.x, v.y, v.z);
        U.push(uv.getX(idx), uv.getY(idx));
        if (nAttr) {
          n.set(nAttr.getX(idx), nAttr.getY(idx), nAttr.getZ(idx)).applyMatrix3(mat3).normalize();
          N.push(n.x, n.y, n.z);
        }
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    if (nAttr) g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    else g.computeVertexNormals();
    g.computeBoundingBox();
    return g;
  }

  function defaultMaterial() {
    return new THREE.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.9, metalness: 0 });
  }

  function cloneMaterial(m) {
    if (!m) return defaultMaterial();
    if (Array.isArray(m)) m = m[0];
    return m && typeof m.clone === 'function' ? m.clone() : defaultMaterial();
  }

  function build(a, parts) {
    var r = resolveAssign(a, parts);
    var nParts = r.list.length;
    var mats = sourceMaterials(a);
    var groups = r.list.map(function (p, pi) {
      var g = new THREE.Group();
      g.name = p.name + '_' + (pi + 1);
      g.userData.splitPart = pi;
      return g;
    });

    var off = 0;
    a.parts.forEach(function (part, spi) {
      var buckets = [];
      for (var pi2 = 0; pi2 < nParts; pi2++) buckets.push([]);
      for (var t = 0; t < part.tri; t++) {
        var pi3 = r.assign[a.triIsland[off + t]];
        if (pi3 >= 0 && buckets[pi3]) buckets[pi3].push(t);
      }
      off += part.tri;
      buckets.forEach(function (tris, pi4) {
        if (!tris.length) return;
        var mesh = new THREE.Mesh(extractGeometry(part, tris), cloneMaterial(mats[spi]));
        mesh.name = (groups[pi4].name) + '_src' + spi;
        groups[pi4].add(mesh);
      });
    });

    return {
      assign: r.assign, list: r.list, groups: groups,
      stats: {
        islands: a.islands.length,
        aiAssigned: r.aiAssigned,
        auto: r.auto,
        tris: a.parts.reduce(function (s, p) { return s + p.tri; }, 0)
      }
    };
  }

  /* ---------------- 预览：三个角度、每个部件一种颜色 ---------------- */

  var _rd = null;
  function renderer(cell) {
    if (!_rd) {
      _rd = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      _rd.setPixelRatio(1);
      _rd.domElement.style.display = 'none';
      document.body.appendChild(_rd.domElement);
    }
    _rd.setSize(cell, cell, false);
    return _rd;
  }

  /* 相机：定焦、固定 1.15 倍留白。圈选要把「图上画的圆」换算回三维，
   * 所以相机的 center / radius 必须由整件模型给出，不能跟着每一组的包围盒缩放。 */
  function viewCamera(deg, center, radius) {
    var fov = 35;
    var cam = new THREE.PerspectiveCamera(fov, 1, radius / 100, radius * 40);
    var dist = radius / Math.tan(fov * Math.PI / 360) * 1.15;
    var ang = deg * Math.PI / 180;
    cam.position.set(center.x + Math.sin(ang) * dist, center.y, center.z + Math.cos(ang) * dist);
    cam.lookAt(center);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.updateProjectionMatrix();
    return cam;
  }

  /* 一组「{group, color}」的三视图单格。
   * 拆件预览、已分件视图、未分件视图都走这一条渲染路径，观感才一致。
   * frame 传入时用整件模型的包围盒取景（圈选坐标才和图外的三维对得上）。 */
  function shotGroups(items, deg, cell, bg, frame) {
    var rd = renderer(cell);
    var root = new THREE.Group();
    items.forEach(function (it) {
      var c = it.group.clone(true);
      var color = it.color;
      c.traverse(function (o) {
        if (!o.isMesh) return;
        o.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(color), roughness: 0.9, metalness: 0, side: THREE.DoubleSide
        });
      });
      root.add(c);
    });

    var box = new THREE.Box3().setFromObject(root);
    var center = frame ? frame.center : box.getCenter(new THREE.Vector3());
    var radius = frame ? frame.radius : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);

    var scene = new THREE.Scene();
    scene.add(root);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    var l1 = new THREE.DirectionalLight(0xffffff, 0.5); l1.position.set(2, 4, 5); scene.add(l1);
    var l2 = new THREE.DirectionalLight(0xffffff, 0.28); l2.position.set(-3, 2, -4); scene.add(l2);

    var cam = viewCamera(deg, center, radius);

    rd.setClearColor(new THREE.Color(bg || '#16181c'), 1);
    rd.clear(true, true, true);
    rd.render(scene, cam);
    var cv = document.createElement('canvas');
    cv.width = cell; cv.height = cell;
    cv.getContext('2d').drawImage(rd.domElement, 0, 0);
    return cv;
  }

  function shot(built, deg, cell) {
    return shotGroups(built.groups.map(function (g, pi) {
      return { group: g, color: built.list[pi].color };
    }), deg, cell, '#16181c');
  }

  /* 单组几何的三视图（前 / 左 / 后）→ dataURL。
   * 用途：给 AI 看「已经拆走的部件」和「还没拆走的剩余部分」。 */
  function viewTrio(group, label, color, bg, opts) {
    return trioOf([{ group: group, color: color }], label, bg, opts);
  }

  /* 多组一起画：绿=选中、红=排除、灰=剩余。圈选确认图用它。
   * 四格：正 / 左 / 后 / 右 —— 选中要求四个视图都画框、取交集，
   * 少一个视图就切不出前后层，框又会退化成贯穿柱体。
   * opts: { frame, grid, marks } —— grid 画 0.1 网格（AI 用归一化坐标画框），
   * marks 把 AI 画的框描回图上，方便它自己对位。 */
  var VIEW_DEGS = [0, 90, 180, 270];
  function trioOf(items, label, bg, opts) {
    opts = opts || {};
    var gap = 8, cell = VIEW_CELL, cols = 2;
    var cells = VIEW_DEGS.map(function (d) { return shotGroups(items, d, cell, bg, opts.frame); });
    var rows = Math.ceil(cells.length / cols);
    var out = document.createElement('canvas');
    out.width = cols * cell + (cols - 1) * gap;
    out.height = rows * cell + (rows - 1) * gap + 24;
    var ctx = out.getContext('2d');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, out.width, out.height);
    cells.forEach(function (img, i) {
      /* 2×2 排：四格拼成一张方图，缩到 1024 长边时单格还有 500 多像素，
       * 一排四格会被压到 250px，网格线和部件边界都糊了 */
      var x = (i % cols) * (cell + gap), y = 24 + Math.floor(i / cols) * (cell + gap);
      ctx.drawImage(img, x, y, cell, cell);
      if (opts.grid) drawGrid(ctx, x, y, cell);
      if (opts.marks) (opts.marks[i] || []).forEach(function (m) { drawMark(ctx, x, y, cell, m); });
    });
    ctx.fillStyle = '#5b6472';
    ctx.font = '600 13px system-ui,"Microsoft YaHei",sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(label + ' · 前 / 左 / 后 / 右', 8, 12);
    return imgURL(out);
  }

  function drawGrid(ctx, x, y, w) {
    ctx.save();
    ctx.strokeStyle = 'rgba(45,52,64,0.20)';
    ctx.lineWidth = 1;
    for (var i = 1; i < 10; i++) {
      var g = w * i / 10;
      ctx.beginPath(); ctx.moveTo(x + g, y); ctx.lineTo(x + g, y + w); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + g); ctx.lineTo(x + w, y + g); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(45,52,64,0.55)';
    ctx.font = '9px system-ui,sans-serif';
    ctx.fillText('0,0', x + 2, y + 9);
    ctx.fillText('1,0', x + w - 18, y + 9);
    ctx.fillText('0,1', x + 2, y + w - 3);
    ctx.restore();
  }

  function drawMark(ctx, x, y, w, m) {
    var col = m.mode === 'out' ? '#d92b2b' : '#1f9d55';
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    var tx, ty;
    if (m.box) {
      var bx = x + m.box[0] * w, by = y + m.box[1] * w;
      var bw = (m.box[2] - m.box[0]) * w, bh = (m.box[3] - m.box[1]) * w;
      ctx.strokeRect(bx, by, bw, bh);
      tx = bx + 3; ty = by - 3;
    } else {
      var cx = x + m.cx * w, cy = y + m.cy * w, r = m.r * w;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      tx = cx; ty = cy - r - 3;
    }
    ctx.fillStyle = col;
    ctx.font = '600 10px system-ui,sans-serif';
    ctx.textAlign = m.box ? 'left' : 'center';
    ctx.fillText((m.mode === 'out' ? '−' : '+') + String(m.part || '').slice(0, 6), tx, ty);
    ctx.restore();
  }

  /* 任意一撮岛 → 可渲染的 Group。与 build() 的区别：不做部件归属、不为导出服务，
   * 只为「把这块几何单独看清楚」。 */
  function islandGroup(a, ids, color) {
    var root = new THREE.Group();
    var idSet = ids instanceof Set ? ids : new Set(ids);
    var perPart = a.parts.map(function () { return []; });
    a.islands.forEach(function (o) {
      if (!idSet.has(o.id)) return;
      o.tris.forEach(function (r) {
        if (perPart[r.part]) perPart[r.part].push(r.t);
      });
    });
    perPart.forEach(function (tris, spi) {
      if (!tris.length) return;
      var m = new THREE.Mesh(extractGeometry(a.parts[spi], tris),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(color), roughness: 0.9, metalness: 0, side: THREE.DoubleSide
        }));
      m.name = 'view_src' + spi;
      root.add(m);
    });
    return root;
  }

  function preview(built) {
    var degs = [0, 90, 180];
    var gap = 8, cell = VIEW_CELL;
    var cells = degs.map(function (d) { return shot(built, d, cell); });
    var out = document.createElement('canvas');
    out.width = cells.length * (cell + gap) - gap;
    out.height = cell + 28;
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#16181c'; ctx.fillRect(0, 0, out.width, out.height);
    cells.forEach(function (img, i) {
      var x = i * (cell + gap), y = 28;
      ctx.drawImage(img, x, y, cell, cell);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(x, y, cell, 26);
      ctx.fillStyle = '#dfe3e8';
      ctx.font = '600 13px system-ui,"Microsoft YaHei",sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(['正视图', '左视图', '后视图'][i] + ' · ' + built.list.length + ' 部件', x + 8, y + 13);
    });
    /* 顶部图例：颜色块 + 部件名。三个视图里颜色一一对应，看图即知归属。 */
    var lx = 8;
    built.list.forEach(function (p) {
      ctx.fillStyle = p.color;
      ctx.fillRect(lx, 8, 10, 10);
      ctx.fillStyle = '#dfe3e8';
      ctx.font = '500 12px system-ui,"Microsoft YaHei",sans-serif';
      var label = p.name + '（' + p.ids.length + ' 岛）';
      ctx.fillText(label, lx + 14, 13);
      lx += 14 + ctx.measureText(label).width + 14;
    });
    return out.toDataURL('image/png');
  }

  /* ---------------- GLB 导出 ---------------- */

  function bufToDataURL(buf, mime) {
    var u8 = new Uint8Array(buf), s = '', CH = 8192;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    }
    return 'data:' + (mime || 'model/gltf-binary') + ';base64,' + btoa(s);
  }

  function toGLB(root) {
    return new Promise(function (resolve, reject) {
      if (!THREE || typeof THREE.GLTFExporter !== 'function') {
        reject(new Error('GLTFExporter 未加载，无法导出 GLB'));
        return;
      }
      var ex = new THREE.GLTFExporter();
      try {
        ex.parse(root, function (buf) { resolve(buf); }, function (e) { reject(e || new Error('导出失败')); },
          { binary: true, onlyVisible: true });
      } catch (e) { reject(e); }
    });
  }

  function mergedGroup(built, name) {
    var root = new THREE.Group();
    root.name = name || 'ai-split';
    built.groups.forEach(function (g) { root.add(g.clone(true)); });
    return root;
  }

  function toPartGLB(built, i) {
    if (!built || !built.groups[i]) throw new Error('没有这个部件');
    return toGLB(built.groups[i]);
  }

  function saveDataURL(name, url) {
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------------- 圈选：图上画的圆 → 命中的岛 ---------------- */

  var VIEW_DEG = { front: 0, back: 180, left: 90, right: 270 };

  /* 一个岛在某一视图里的采样点（世界坐标）。长发、裙摆这类长条岛必须多点采样，
   * 只看质心会把「圆压在发梢上、质心却在发根」的岛判错。 */
  function islandSamples(a, o, cap) {
    var pts = [];
    var n = o.tris.length;
    var step = Math.max(1, Math.ceil(n / (cap || 24)));
    for (var i = 0; i < n; i += step) {
      var r = o.tris[i], part = a.parts[r.part];
      if (!part) continue;
      var k = part.idx ? part.idx.getX(r.t * 3) : r.t * 3;
      pts.push(new THREE.Vector3(part.pos.getX(k), part.pos.getY(k), part.pos.getZ(k)).applyMatrix4(part.mw));
    }
    return pts;
  }

  function projectToView(cam, v) {
    var p = v.clone().project(cam);   // 已含 matrixWorldInverse / projectionMatrix
    return { u: (p.x + 1) / 2, v: (1 - p.y) / 2 };
  }

  /* 命中判定：点是否落在 AI 画的范围里。框和圈共用一套投影，只是边界不同。
   * 框（box:[x0,y0,x1,y1]）适合切「头 / 长发 / 身体」这种上下分段的部件；
   * 圈（cx,cy,r）适合抓手臂、鞋这类局部。 */
  function inRegion(mark, u, v) {
    if (mark.box) {
      return u >= mark.box[0] && u <= mark.box[2] && v >= mark.box[1] && v <= mark.box[3];
    }
    var dx = u - mark.cx, dy = v - mark.cy;
    return dx * dx + dy * dy <= mark.r * mark.r;
  }

  /* 区域命中：岛有 30% 以上的采样点落在范围内，或质心落在范围内。
   * 不做遮挡判断——选中范围是「穿过模型的一块空间」，被身体挡住的部分也算，
   * 这正是三视图圈选的语义；最终对不对由 AI 看确认图决定。 */
  function pickRegion(a, ids, mark, frame) {
    var deg = VIEW_DEG[String(mark.view || 'front').toLowerCase()];
    if (deg == null) deg = 0;
    var cam = viewCamera(deg, frame.center.clone(), frame.radius);
    var hit = [];
    (ids || []).forEach(function (id) {
      var o = a.islands[id];
      if (!o) return;
      var pts = islandSamples(a, o, 24), inside = 0;
      for (var i = 0; i < pts.length; i++) {
        var q = projectToView(cam, pts[i]);
        if (inRegion(mark, q.u, q.v)) inside++;
      }
      var c = projectToView(cam, new THREE.Vector3(o.centroid[0], o.centroid[1], o.centroid[2]));
      if (inside / Math.max(1, pts.length) >= 0.3 || inRegion(mark, c.u, c.v)) hit.push(id);
    });
    return hit;
  }

  function parseMarks(arr, names) {
    return (Array.isArray(arr) ? arr : []).filter(function (m) {
      if (!m) return false;
      if (Array.isArray(m.box) && m.box.length === 4) return true;
      return isFinite(Number(m.cx)) && isFinite(Number(m.cy));
    }).map(function (m) {
      var want = String(m.part || m.name || '').trim();
      var part = names.filter(function (n) { return want && (want.indexOf(n) >= 0 || n.indexOf(want) >= 0); })[0] || names[0];
      var mk = {
        part: part, view: String(m.view || 'front').toLowerCase(),
        mode: (function (s) {
          s = String(s || 'in').toLowerCase();
          return s.indexOf('out') >= 0 ? 'out' : (s.indexOf('only') >= 0 ? 'only' : 'in');
        })(m.mode)
      };
      if (Array.isArray(m.box) && m.box.length === 4) {
        var b = m.box.map(Number);
        mk.box = [clamp(Math.min(b[0], b[2]), 0, 1), clamp(Math.min(b[1], b[3]), 0, 1),
          clamp(Math.max(b[0], b[2]), 0, 1), clamp(Math.max(b[1], b[3]), 0, 1)];
      } else {
        mk.cx = clamp(Number(m.cx), 0, 1);
        mk.cy = clamp(Number(m.cy), 0, 1);
        mk.r = clamp(Number(m.r) || 0.12, 0.02, 0.9);
      }
      return mk;
    });
  }

  /* ---------------- 完整流程 ---------------- */

  async function prepare(src, opts) {
    opts = opts || {};
    if (!global.ModelTex || typeof ModelTex.analyze !== 'function') throw new Error('modeltex.js 未加载');
    var a = await ModelTex.analyze(src);
    var chosen = pickCandidates(a, opts.maxCandidates, opts.minTris);
    var ids = chosen.map(function (o) { return o.id; });
    var slots = allSlots(a);
    var useSlots = slots.length <= MAX_PART_VIEWS ? slots : null;
    var atlases = atlasOf(a, ids, useSlots);
    return {
      a: a, src: src,
      candidates: chosen, candidateIds: ids,
      atlasSlots: useSlots ? useSlots : [null],
      atlases: atlases,
      table: candidateTable(a, chosen),
      views: '',
      /* 所有三视图统一用整件模型的取景，AI 画的圆才能换算回三维 */
      frame: { center: new THREE.Vector3(a.center.x, a.center.y, a.center.z), radius: a.radius }
    };
  }

  /* 画框 → 求交 → 确认 → 锁定。命中集合由几何算出，模型只判断「是不是这块」，
   * 不用再抄 id（实测它抄一半漏一半，漏掉的只能靠最近邻补）。
   * 选中必须四个视图（前/左/后/右）都给了框，四个框取交集；
   * 同一视图里多个框先并集再参与交集，mode=out 的框最后扣掉。
   * 最多来回 3 次，任一次说 ok 就锁定。 */
  var VIEW_KEYS = ['front', 'left', 'back', 'right'];
  async function settleMarks(cfg, prep, ctx, state, say, marks) {
    var part = marks[0].part;
    var cur = marks, ids = [], conf = 0.5;

    for (var step = 0; step < 3; step++) {
      var perView = { front: [], left: [], back: [], right: [] };
      var exc = new Set();
      cur.forEach(function (m) {
        if (m.mode === 'out') {
          pickRegion(prep.a, ctx.restIds, m, prep.frame).forEach(function (id) { exc.add(id); });
          return;
        }
        if (!m.box) return;              // 圈选不再参与选中，只接受框
        var k = perView[m.view] ? m.view : 'front';
        perView[k].push(m);
      });
      var missing = VIEW_KEYS.filter(function (v) { return !perView[v].length; });
      if (missing.length) {
        /* 四个视图缺一个就切不出前后层（框又退化成贯穿柱体），所以不允许选中。
         * 模型漏视图是常见的，先明说缺哪几个让它重画一次；还漏就直接报错。 */
        var why = '选中必须四个视图都画框，缺少：' + missing.join(' / ');
        if (step >= 1) throw new Error(why);
        var fixCtx = Object.assign({}, ctx, {
          hint: '你上一轮只给了 ' + (marks.length ? marks.map(function (m) { return m.view; }).join(' / ') : '空')
            + ' 的框，缺少 ' + missing.join(' / ') + '。四个视图（前 / 左 / 后 / 右）各给一个 box，重新输出完整的 marks。'
        });
        var again = await askOneRound(cfg, prep, fixCtx, state, say);
        if (again && again.marks && again.marks.length) { cur = again.marks; continue; }
        throw new Error(why);
      }

      var inter = null;
      VIEW_KEYS.forEach(function (v) {
        var set = new Set();
        perView[v].forEach(function (m) {
          pickRegion(prep.a, ctx.restIds, m, prep.frame).forEach(function (id) { set.add(id); });
        });
        inter = inter ? new Set(Array.from(inter).filter(function (id) { return set.has(id); })) : set;
      });
      ids = (inter ? Array.from(inter) : []).filter(function (id) { return !exc.has(id); });
      if (!ids.length) return null;

      var selSet = new Set(ids);
      var grayIds = ctx.restIds.filter(function (id) { return !selSet.has(id) && !exc.has(id); });
      var items = [
        { group: islandGroup(prep.a, grayIds, '#7c8698'), color: '#7c8698' },
        { group: islandGroup(prep.a, ids, '#1f9d55'), color: '#1f9d55' }
      ];
      if (exc.size) items.push({ group: islandGroup(prep.a, Array.from(exc), '#d92b2b'), color: '#d92b2b' });

      /* 把 AI 画的范围按视图描回确认图上，它才能判断自己定的位置准不准。
       * 图是 2×2 四格（前 / 左 / 后 / 右），索引必须对齐 VIEW_DEGS。 */
      var markCells = [[], [], [], []];
      cur.forEach(function (m) {
        markCells[Math.max(0, VIEW_KEYS.indexOf(m.view))].push(m);
      });
      var img = trioOf(items, '框选 · ' + part + ' · ' + ids.length + ' 岛', '#eef1f5',
        { frame: prep.frame, grid: true, marks: markCells });
      say('confirm', '框选「' + part + '」命中 ' + ids.length + ' 岛，等 AI 确认…', { views: img });

      var ctx2 = {
        names: [part], locked: ctx.locked, atlases: ctx.atlases, atlasSlots: ctx.atlasSlots,
        rest: ctx.rest, restIds: ctx.restIds, frame: ctx.frame, parts: ctx.parts,
        someIds: ctx.someIds,
        confirm: { img: img, part: part, count: ids.length }
      };
      var ans = await askOneRound(cfg, prep, ctx2, state, say);
      if (Array.isArray(ans)) {
        var own = ans.filter(function (p) { return p.name === part; })[0];
        return own ? { name: part, ids: own.ids, confidence: own.confidence } : null;
      }
      if (ans && ans.marks) { cur = ans.marks; continue; }
      if (ans && ans.ok) { conf = ans.confidence || 0.6; break; }
      break;
    }
    return ids.length ? { name: part, ids: ids, confidence: conf } : null;
  }

  async function run(src, opts, progress) {
    opts = opts || {};
    var say = typeof progress === 'function' ? progress : function () { };
    var names = Array.isArray(opts.names) && opts.names.length ? opts.names : splitNames(opts.partsText);

    say('analyze', '正在分析 UV 岛…');
    var prep = await prepare(src, opts);

    say('atlas', '找到 ' + prep.a.islands.length + ' 个 UV 岛，取最大的 ' + prep.candidates.length + ' 个作为候选', {
      atlas: prep.atlases[0]
    });
    /* 整件三视图不再单独渲染：第一轮的「未分件视图」就是整件，渲染一次就够 */
    prep.views = '';

    var cfg = readCfg();
    var state = { withImages: prep.atlases.length > 0, answer: opts.answer };

    /* 按确信度多轮：一轮可以拆多个部件。每轮把已拆走的部分渲染出来给它看，
     * 剩下的岛单独渲染一张，下一轮只在剩下的岛里挑——比一次性摊 120 个 id 稳得多。 */
    var remaining = new Set(prep.candidateIds);
    var locked = [];
    var tail = names.slice();
    var maxRounds = Math.max(1, Math.min(opts.maxRounds || 4, 8));

    for (var round = 1; tail.length > 1 && remaining.size > 0 && round <= maxRounds; round++) {
      var restIds = Array.from(remaining);
      var restGroup = islandGroup(prep.a, remaining, '#7c8698');
      /* 未分件视图带 0.1 网格：AI 要按归一化坐标画圈，图上有刻度才画得准 */
      var restImg = viewTrio(restGroup, '未分件 · 还剩 ' + restIds.length + ' 岛', '#7c8698', '#eef1f5',
        { frame: prep.frame, grid: true });
      if (round === 1) prep.views = restImg;
      var partImgs = locked.map(function (p) {
        return {
          name: p.name,
          url: viewTrio(p.group, p.name + ' · ' + p.ids.size + ' 岛', p.color, '#eef1f5', { frame: prep.frame })
        };
      });
      var atlasPack = atlasFor(prep.a, remaining, prep.atlasSlots);

      say('round', '第 ' + round + ' 轮：' + (cfg.model || '模型') + ' 在读图挑部件（待拆 '
        + tail.join(' / ') + '，还剩 ' + restIds.length + ' 岛）…',
        { atlas: atlasPack.urls[0], views: restImg });

      var ctx = {
        names: tail,
        locked: locked.map(function (p) { return { name: p.name, count: p.ids.size }; }),
        atlases: atlasPack.urls,
        atlasSlots: atlasPack.slots,
        rest: restImg,
        restIds: restIds,
        frame: prep.frame,
        parts: partImgs,
        someIds: function (id) { return remaining.has(Number(id)); }
      };

      var ans = await askOneRound(cfg, prep, ctx, state, say);
      var picks = Array.isArray(ans) ? ans : [];
      if (ans && ans.marks) {
        var mk = await settleMarks(cfg, prep, ctx, state, say, ans.marks);
        if (!mk) break;
        picks = [mk];
      }
      var got = 0;
      picks.forEach(function (pick) {
        var picked = new Set(pick.ids);
        picked.forEach(function (id) { remaining.delete(id); });
        if (!picked.size) return;
        var color = COLORS[locked.length % COLORS.length];
        locked.push({
          name: pick.name, ids: picked, color: color,
          group: islandGroup(prep.a, picked, color), confidence: pick.confidence
        });
        tail = tail.filter(function (n) { return n !== pick.name; });
        got += picked.size;
        say('round', '第 ' + round + ' 轮锁定「' + pick.name + '」· 确信度 '
          + pick.confidence.toFixed(2) + ' · ' + picked.size + ' 岛', { views: restImg });
      });

      /* 这一轮一个岛都没拆走就别再循环了，否则同样的输入会白跑 */
      if (!got) break;
    }

    /* 收尾：还没拆的部件（通常只剩最后一个）直接吃剩下的岛 */
    var leftovers = Array.from(remaining);
    var parts = names.map(function (n) {
      var L = locked.filter(function (p) { return p.name === n; })[0];
      return { name: n, islands: L ? Array.from(L.ids) : leftovers };
    });

    say('rebuild', '正在按岛重建几何…');
    var built = build(prep.a, parts);

    say('preview', '正在渲染拆件预览…');
    var png = preview(built);

    return {
      prep: prep,
      parts: parts,
      built: built,
      list: built.list,
      stats: built.stats,
      atlases: prep.atlases,
      views: prep.views,
      preview: png,
      names: names,
      rounds: locked.map(function (p) {
        return { name: p.name, islands: p.ids.size, confidence: p.confidence };
      }),
      leftover: leftovers.length
    };
  }

  /* ---------------- UI 弹层 ---------------- */

  var ui = { bound: false, model: null, busy: false, result: null, prep: null };

  function setInfo(text, err) {
    var el = $('mvSplitInfo');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-err', !!err);
  }

  function setBusy(on) {
    ui.busy = !!on;
    ['mvSplitRun', 'mvSplitDlGlb', 'mvSplitSaveLib'].forEach(function (id) {
      var el = $(id); if (!el) return;
      el.disabled = !!on || (id !== 'mvSplitRun' && !ui.result);
    });
    var btn = $('mvSplitRun');
    if (btn) btn.textContent = on ? '拆件中…' : '开始拆件';
    var max = $('mvSplitMax');
    if (max) max.disabled = !!on;
  }

  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 20) || 'part';
  }

  function baseName() {
    var n = (ui.model && ui.model.name) || 'model';
    return String(n).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'model';
  }

  function paintList(result) {
    var host = $('mvSplitList');
    if (!host) return;
    host.innerHTML = '';
    var total = Math.max(result.stats.tris, 1);
    result.list.forEach(function (p, i) {
      var row = document.createElement('div');
      row.className = 'mv-sp-row';
      row.innerHTML =
        '<span class="mv-sp-dot" style="background:' + p.color + '"></span>'
        + '<span class="mv-sp-name"></span>'
        + '<span class="mv-sp-meta"></span>'
        + '<button type="button" class="mv-mini" data-sp-dl="' + i + '" title="只下载这个部件的 GLB">↓ GLB</button>';
      row.querySelector('.mv-sp-name').textContent = p.name;
      row.querySelector('.mv-sp-meta').textContent =
        p.ids.length + ' 岛 · ' + (p.tris / total * 100).toFixed(1) + '% 三角';
      host.appendChild(row);
    });
    var dl = $('mvSplitDlGlb'), lib = $('mvSplitSaveLib');
    if (dl) dl.disabled = !result.list.length;
    if (lib) lib.disabled = !result.list.length || typeof global.openagiDesktop === 'undefined';
  }

  function showResult(result) {
    var atlas = $('mvSplitAtlas'), views = $('mvSplitViews');
    if (atlas && result.atlases && result.atlases[0]) {
      atlas.src = result.atlases[0];
      atlas.classList.remove('hidden');
    }
    if (views && result.preview) {
      views.src = result.preview;
      views.classList.remove('hidden');
    }
    paintList(result);
  }

  async function runUI() {
    if (ui.busy) return;
    if (!ui.model || !ui.model.src) { setInfo('先选一个模型', true); return; }
    var maxEl = $('mvSplitMax');
    var opts = {
      names: splitNames(($('mvSplitParts') || {}).value),
      maxCandidates: maxEl ? Number(maxEl.value) : 120
    };
    setInfo('准备中…');
    setBusy(true);
    try {
      var result = await run(ui.model.src, opts, function (stage, msg, data) {
        setInfo(msg);
        if (data && data.atlas) {
          var img = $('mvSplitAtlas');
          if (img) { img.src = data.atlas; img.classList.remove('hidden'); }
        }
        /* 每一轮把「未分件」的三视图顶到右边那格，边拆边能看见剩下什么 */
        if (data && data.views) {
          var v = $('mvSplitViews');
          if (v) { v.src = data.views; v.classList.remove('hidden'); }
        }
      });
      ui.result = result;
      ui.prep = result.prep;
      showResult(result);
      var ai = result.stats.aiAssigned, auto = result.stats.auto;
      setInfo('完成 · ' + result.list.map(function (p) { return p.name + ' ' + p.ids.length + ' 岛'; }).join(' · ')
        + (result.rounds.length
          ? '；按确信度锁定 ' + result.rounds.map(function (r) {
            return r.name + ' ' + r.confidence.toFixed(2);
          }).join(' → ')
          : '')
        + '；AI 判定 ' + ai + ' 岛，其余 ' + auto + ' 岛按空间位置自动归属');
      setBusy(false);
    } catch (e) {
      var msg = String(e && e.message || e);
      setInfo('拆件失败：' + msg, true);
      console.error('[ModelSplit]', e);
      setBusy(false);
    }
  }

  async function downloadMerged() {
    if (!ui.result) return;
    setInfo('正在导出整件 GLB…');
    try {
      var buf = await toGLB(mergedGroup(ui.result.built, baseName()));
      saveDataURL(baseName() + '_拆件.glb', bufToDataURL(buf));
      setInfo('已导出整件 GLB · ' + ui.result.list.length + ' 个部件（多节点，各自保留材质）');
    } catch (e) { setInfo('导出失败：' + String(e && e.message || e), true); }
  }

  async function downloadPart(i) {
    if (!ui.result) return;
    try {
      var buf = await toPartGLB(ui.result.built, i);
      saveDataURL(baseName() + '_' + safeName(ui.result.list[i].name) + '.glb', bufToDataURL(buf));
      setInfo('已导出「' + ui.result.list[i].name + '」');
    } catch (e) { setInfo('导出失败：' + String(e && e.message || e), true); }
  }

  async function saveToLib() {
    if (!ui.result) return;
    var d = global.openagiDesktop;
    if (!d || typeof d.assetPut !== 'function') { setInfo('独立页没有模型库，请在桌面 App 里用这个按钮', true); return; }
    setInfo('正在存入模型库…');
    try {
      var buf = await toGLB(mergedGroup(ui.result.built, baseName()));
      var url = bufToDataURL(buf);
      var r = await d.assetPut({
        kind: 'model', ext: 'glb',
        name: baseName() + '_拆件.glb',
        data: url, source: 'ai-split'
      });
      if (r && r.ok === false) throw new Error(r.error || '写入失败');
      setInfo('已存入模型库：' + (r && r.asset ? r.asset.name : baseName() + '_拆件.glb'));
    } catch (e) { setInfo('存入失败：' + String(e && e.message || e), true); }
  }

  function bindUI() {
    if (ui.bound) return;
    ui.bound = true;
    var runBtn = $('mvSplitRun'); if (runBtn) runBtn.addEventListener('click', runUI);
    var closeBtn = $('mvSplitClose'); if (closeBtn) closeBtn.addEventListener('click', close);
    var dlBtn = $('mvSplitDlGlb'); if (dlBtn) dlBtn.addEventListener('click', downloadMerged);
    var libBtn = $('mvSplitSaveLib'); if (libBtn) libBtn.addEventListener('click', saveToLib);
    var maxEl = $('mvSplitMax'), maxV = $('mvSplitMaxV');
    if (maxEl) {
      var sync = function () { if (maxV) maxV.textContent = maxEl.value; };
      maxEl.addEventListener('input', sync);
      sync();
    }
    var list = $('mvSplitList');
    if (list) list.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-sp-dl]') : null;
      if (b) downloadPart(Number(b.getAttribute('data-sp-dl')));
    });
  }

  function open(model) {
    bindUI();
    var panel = $('mvSplitPanel');
    if (!panel) return;
    if (model && model.src !== (ui.model && ui.model.src)) {
      ui.result = null; ui.prep = null;
      var list = $('mvSplitList'); if (list) list.innerHTML = '';
      var a = $('mvSplitAtlas'), v = $('mvSplitViews');
      if (a) { a.src = ''; a.classList.add('hidden'); }
      if (v) { v.src = ''; v.classList.add('hidden'); }
      var dl = $('mvSplitDlGlb'), lib = $('mvSplitSaveLib');
      if (dl) dl.disabled = true;
      if (lib) lib.disabled = true;
    }
    ui.model = model || ui.model;
    var sub = $('mvSplitSub');
    if (sub) sub.textContent = ui.model ? ui.model.name : '';
    var parts = $('mvSplitParts');
    if (parts && !parts.value) parts.value = '面部和脖子、头发和头饰、身体';
    setInfo('AI 会先看「UV 岛图 + 四视图」，再按确信度逐轮把候选岛拆给这几个部件。');
    panel.classList.remove('hidden');
    setBusy(false);
  }

  function close() {
    var panel = $('mvSplitPanel');
    if (panel) panel.classList.add('hidden');
  }

  global.ModelSplit = {
    readCfg, prepare, run, build, preview, toGLB, toPartGLB, mergedGroup,
    pickCandidates, splitNames, parseRound, resolveAssign, bufToDataURL,
    pickRegion, parseMarks, settleMarks,
    open, close, _ui: ui
  };
})(window);
