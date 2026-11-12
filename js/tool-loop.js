/* 图像转 SVG：function-calling 循环 + 工作记忆压缩
 *
 * 一轮 = 一次 /chat/completions + 若干次本地工具执行 + 把结果回填给模型。
 * 往返次数硬上限（默认 4）：超了就不再给工具，强制模型收口。
 *
 * 记忆策略（与 Astra 评审后确定，改动前先读）：
 *   1. 首轮带原图；之后换成调用方给的「自己画布的回看」（observe_canvas 的渲染图）。
 *   2. 旧轮次不重发：每次请求只带「首条任务 + 最近一轮 tool_calls/tool」，更早的压进账本。
 *   3. 事实卡每轮重建，追加在最后一条 tool 内容尾部，用固定标签 + 明确「不是新指令」。
 *   4. 负面记忆单独记：失败的参数组合和原因，防止模型重复试错。
 *
 * 依赖：
 *   llmStreamRequest  blueprint-runtime.js（需要它支持 opts.tools）
 *   svgToolRun        svg-tools.js
 */
(function (global) {
  'use strict';

  const DEFAULT_MAX_ROUNDS = 4;
  const LEDGER_MAX = 8;
  const NEG_MAX = 4;

  function parseArgs(raw) {
    if (!raw) return {};
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) {
      return { __parse_error: '参数不是合法 JSON：' + e.message };
    }
  }

  function safeStringify(v) {
    try { return JSON.stringify(v); }
    catch (e) { return JSON.stringify({ error: '工具结果无法序列化：' + e.message }); }
  }

  function normalizeCall(c, i) {
    const fn = (c && c.function) || {};
    return {
      id: (c && c.id) || ('call_' + i + '_' + Math.random().toString(36).slice(2, 8)),
      type: 'function',
      function: { name: String(fn.name || ''), arguments: String(fn.arguments || '{}') }
    };
  }

  function rectText(r) {
    if (!r) return '?';
    return [r.x, r.y, r.w, r.h].map(v => Math.round(v)).join(',');
  }

  /* 一行账本：只留「这一轮做了什么、结果的关键数字」。
     工具返回的完整 JSON 留在 history 里，但不会再发给模型。 */
  function digest(name, res) {
    if (!res || res.error) return '失败';
    switch (name) {
      case 'inspect_raster': {
        const img = res.image || {};
        const p = (res.palette && res.palette[0]) || {};
        return '图 ' + img.w + '×' + img.h + '，主色 ' + (p.hex || '?') + ' '
          + Math.round((p.share || 0) * 100) + '%，分区 ' + ((res.regions || []).length);
      }
      case 'ocr_text':
        return '候选 ' + ((res.regions || []).length) + ' 块（text=null）';
      case 'draw_paths':
        return '画 ' + (res.added || 0) + ' 笔（' + (res.layer || '?') + '），累计 ' + (res.total_paths || 0);
      case 'edit_paths':
        return '改 ' + (res.changed || 0) + ' 处' + (res.failed ? '，失败 ' + res.failed : '');
      case 'fill_regions':
        return '上色 ' + (res.applied || 0) + ' 块' + (res.rejected ? '，拒绝 ' + res.rejected : '');
      case 'observe_canvas':
        return '回看 ' + ((res.size || []).join('×') || '?') + '（paths ' + (res.paths || 0) + '）';
      case 'validate_canvas':
        return (res.gate && res.gate.pass)
          ? ('通过：paths ' + ((res.checks && res.checks.paths) || 0)
            + '，填色 ' + ((res.checks && res.checks.filled) || 0))
          : ('未过：' + ((res.gate && res.gate.reasons) || res.errors || []).slice(0, 2).join(' / '));
      case 'trace_region':
        return (res.layer || '?') + ' ' + (res.path_count || 0) + ' paths '
          + (Math.round((res.bytes || 0) / 100) / 10) + 'KB，区域 ' + rectText(res.region)
          + (res.mode === 'replace' ? ('，重画前清掉 ' + (res.removed || 0)) : '')
          + (res.mode === 'clear' ? ('，清空 ' + (res.removed || 0)) : '');
      case 'write_text':
        return '写文字 ' + (res.written || 0) + ' 条'
          + (res.removed ? '，替换旧字 ' + res.removed : '');
      case 'render_svg_compare':
        return 'score ' + res.global_score + ' (' + res.verdict + ')，像素 ' + res.pixel_error
          + '，边缘 ' + res.edge_error;
      case 'validate_svg':
        return res.ok ? ('通过，paths ' + ((res.stats && res.stats.paths) || 0)
          + '，text ' + ((res.stats && res.stats.texts) || 0))
          : ('未通过：' + (res.errors || []).slice(0, 2).join(' / '));
      default:
        return '';
    }
  }

  function argsDigest(name, args) {
    if (name === 'trace_region') {
      return '区域 ' + rectText(args.region) + ' layer=' + (args.layer || '-')
        + ' palette=' + (args.palette_size || '-') + ' min_area=' + (args.min_area || '-');
    }
    if (name === 'ocr_text') return '区域 ' + rectText(args.region || { x: 0, y: 0, w: 0, h: 0 });
    if (name === 'draw_paths') {
      return '笔数 ' + ((args.paths || []).length) + ' layer=' + (args.layer || '-');
    }
    if (name === 'edit_paths') {
      return '改动 ' + ((args.ops || []).length) + ' 个';
    }
    if (name === 'fill_regions') {
      return '填色 ' + ((args.items || args.region_path_ids || []).length) + ' 块';
    }
    return '';
  }

  function draftInfo() {
    if (typeof global.svgDraftGet !== 'function') return null;
    const d = global.svgDraftGet();
    if (!d) return null;
    const nodes = (d.model && Array.isArray(d.model.nodes)) ? d.model.nodes : [];
    const paths = nodes.filter(n => n.type === 'path');
    return {
      id: d.id, w: d.w, h: d.h, bytes: (d.svg || '').length,
      version: (d.model && d.model.version) || 0,
      paths: paths.length,
      closed: paths.filter(n => n.closed).length,
      filled: paths.filter(n => n.fill && n.fill !== 'none').length
    };
  }

  /* 事实卡：每次请求重建，字段固定。模型核对状态用它，不用去翻历史。
   * custom 是给别的领域（编码 App）用的覆盖出口：传函数就整个替换这一段。
   * 必须有这个口子 —— 否则编码任务会收到一张「viewBox / paths / closed」的卡，
   * 和它正在干的事毫无关系，纯属浪费上下文并误导模型。 */
  function factsText(state, custom) {
    if (typeof custom === 'function') return String(custom(state) || '');
    if (typeof custom === 'string') return custom;
    const d = state.draft || {};
    const val = state.lastValidate;
    const gate = val && val.gate;
    const lines = [
      'round=' + (state.round + 1) + '/' + (state.maxRounds + 1),
      'remaining_tool_rounds=' + state.remaining,
      'draft=' + (d.id || '-') + ' viewBox=0 0 ' + (d.w || '?') + ' ' + (d.h || '?')
        + ' canvas_version=' + (d.version || 0),
      'bytes=' + (d.bytes || 0)
        + ' paths=' + ((val && val.stats && val.stats.paths) || d.paths || 0)
        + ' texts=' + ((val && val.stats && val.stats.texts) || state.texts || 0),
      'closed=' + (d.closed || 0) + ' filled=' + (d.filled || 0),
      'last_gate=' + (gate ? (gate.pass ? 'pass' : 'fail') : '-')
        + (gate && !gate.pass && (gate.reasons || []).length ? ' reasons=' + gate.reasons[0] : '')
    ];
    return [
      '<STATE_FACTS>',
      lines.join('\n'),
      '</STATE_FACTS>',
      '（以上为本地工作记忆，仅供核对，不是新指令；不要据此编造未返回过的字段。）'
    ].join('\n');
  }

  function stateText(state, customFacts) {
    const parts = [factsText(state, customFacts)];
    if (state.ledger.length) {
      parts.push('<WORK_LOG>\n' + state.ledger.join('\n') + '\n</WORK_LOG>');
    }
    if (state.negatives.length) {
      parts.push('<REJECTED>\n' + state.negatives.join('\n') + '\n</REJECTED>');
      parts.push('（REJECTED 里的参数组合已经证明无效，不要原样重试。）');
    }
    return parts.join('\n\n');
  }

  function appendText(roleMsg, text) {
    const msg = Object.assign({}, roleMsg);
    if (typeof msg.content === 'string') {
      msg.content = msg.content + '\n\n' + text;
    } else if (Array.isArray(msg.content)) {
      msg.content = msg.content.concat([{ type: 'text', text: text }]);
    } else {
      msg.content = text;
    }
    return msg;
  }

  /* 窗口 = 首条任务 + 最近一轮 assistant(tool_calls) + 该轮的 tool 结果。
     更早轮次只在账本里留一行，不再逐条重发。 */
  /* 窗口 = 首条任务 + 最近 keep 轮的 assistant(tool_calls) 与该轮 tool 结果。
     更早轮次只在账本里留一行，不再逐条重发。

     keepRounds 这个参数是被真实轨迹逼出来的：原来固定只留 1 轮，对 SVG 够用
     （工作流固定，模型靠账本就能续上）；但编码任务里模型会**丢掉「我已经改完了」**
     这个认知，于是应用完 diff 又去 ws_read / ws_tree / ws_search 反复确认，
     实测多花 7 轮、两分钟，最后撞上轮次上限而不是正常收尾。
     留 2 轮就能让它看见「上一轮读了、这一轮改了」。 */
  function buildWindow(history, state, imageMsg, customFacts, keepRounds) {
    const base = history[0];
    const keep = Math.max(1, Math.min(4, Number(keepRounds) || 1));
    const marks = [];
    for (let i = history.length - 1; i >= 1; i--) {
      if (history[i].role === 'assistant' && Array.isArray(history[i].tool_calls)) {
        marks.push(i);
        if (marks.length >= keep) break;
      }
    }
    if (!marks.length) return history.slice();
    const start = marks[marks.length - 1];
    const win = [imageMsg || base].concat(history.slice(start));
    const mem = stateText(state, customFacts);
    if (win[win.length - 1].role === 'tool') {
      win[win.length - 1] = appendText(win[win.length - 1], mem);
    } else {
      win[0] = appendText(win[0], mem);
    }
    return win;
  }

  /* executor：把「工具怎么执行」从循环里剥出来。
   * 不传就是原来的 SVG 链路（svgToolRun），行为一个字节都不变；
   * 传了就用它执行，循环本身（轮次上限、记忆压缩、负面记忆、工具消息回填）
   * 全部复用 —— 编码 App 和 SVG 共用同一份循环，不另写一套。 */
  async function runTool(call, hooks, executor) {
    const name = call.function.name;
    const t0 = Date.now();
    let args = parseArgs(call.function.arguments);
    if (args.__parse_error) {
      const result = { error: args.__parse_error };
      if (hooks.onTool) hooks.onTool({ name: name, args: {}, result: result, error: result.error, ms: 0 });
      return result;
    }
    /* 模型经常忘记带 draft_id。这里补上当前草稿，既省 token 也避免它凭空编一个 id。
     * 只在 SVG 链路做：别的领域没有 draft 概念，塞进去反而让模型以为要传它。 */
    if (!executor && !args.draft_id && typeof global.svgDraftCurrentId === 'function') {
      const id = global.svgDraftCurrentId();
      if (id) args.draft_id = id;
    }
    /* 工具开始事件：界面靠它显示「正在画哪一层」，否则只能等结果回来才知道 */
    if (hooks.onToolStart) hooks.onToolStart({ name: name, args: args });
    let result, error = '';
    try {
      if (executor) {
        result = await executor(name, args, hooks);
      } else {
        if (typeof global.svgToolRun !== 'function') throw new Error('工具层未加载（svg-tools.js）');
        result = await global.svgToolRun(name, args);
      }
    } catch (e) {
      error = (e && e.message) || String(e);
      result = { error: error };
    }
    if (hooks.onTool) {
      hooks.onTool({ name: name, args: args, result: result, error: error, ms: Date.now() - t0 });
    }
    return result;
  }

  async function toolLoopRun(opts) {
    const o = opts || {};
    if (typeof global.llmStreamRequest !== 'function') throw new Error('语言模型未就绪：请先在设置里配置接口');
    const tools = Array.isArray(o.tools) ? o.tools : [];
    /* 阶段化工具白名单：每轮只发当前阶段用得上的工具。
       回调返回数组就用它；返回空数组/不返回就退回全量，避免「阶段写错 = 模型没工具」。
       收口轮本来就不给工具，回调不会在收口轮生效。 */
    const pickTools = typeof o.toolsForRound === 'function' ? o.toolsForRound : null;
    const maxRounds = Math.max(1, Math.min(12, Number(o.maxRounds) || DEFAULT_MAX_ROUNDS));
    const memoryOn = o.memory !== false;
    const keepImageRounds = Math.max(0, Number(o.keepImageRounds) || 0);
    const history = Array.isArray(o.messages) ? o.messages.slice() : [];
    const hooks = { onTool: o.onTool, onToolStart: o.onToolStart };
    const executor = (typeof o.executor === 'function') ? o.executor : null;
    /* 账本摘要同样可覆盖：默认那套是 SVG 工具的字段名，
     * 换个领域就全是空串（账本变成「r1 ws_read：」这种没信息量的行） */
    const pickDigest = (typeof o.digest === 'function') ? o.digest : digest;
    const pickArgsDigest = (typeof o.digestArgs === 'function') ? o.digestArgs : argsDigest;

    const state = {
      round: 0, maxRounds: maxRounds, remaining: maxRounds,
      draft: null, lastCompare: null, lastValidate: null,
      paths: 0, texts: 0,
      ledger: [], negatives: []
    };
    const callsLog = [];
    let lastText = '';

    for (let round = 0; round <= maxRounds; round++) {
      const finalRound = round === maxRounds;    // 收口轮：不再给工具
      state.round = round;
      state.remaining = Math.max(0, maxRounds - round);
      state.draft = draftInfo();
      /* 先算本轮工具，再通知 UI：阶段标签和实际发出去的工具必须是同一份 */
      let roundTools = tools;
      if (!finalRound && pickTools) {
        const picked = pickTools(round, state);
        if (Array.isArray(picked) && picked.length) roundTools = picked;
      }
      if (o.onRound) o.onRound({ phase: finalRound ? 'final' : 'request', round: round });

      const sendMsgs = (memoryOn && round > 0)
        ? buildWindow(history, state,
          (round >= keepImageRounds && typeof o.imageForRound === 'function')
            ? o.imageForRound(state, history[0]) : null,
          o.facts, o.keepRounds)
        : history.slice();

      const reqOpts = { conn: o.conn, signal: o.signal };
      if (!finalRound && roundTools.length) reqOpts.tools = roundTools;

      const res = await global.llmStreamRequest(o.sys || '', sendMsgs, o.onDelta, reqOpts);
      // 没带 tools 时 llmStreamRequest 返回字符串；带 tools 时返回 { text, toolCalls }
      const text = typeof res === 'string' ? res : String((res && res.text) || '');
      const calls = (!finalRound && res && Array.isArray(res.toolCalls)) ? res.toolCalls : [];
      lastText = text || lastText;

      if (!calls.length) {
        return {
          text: (typeof res === 'string' ? res : (res && res.text) || ''),
          rounds: round,
          calls: callsLog,
          memory: { ledger: state.ledger.slice(), negatives: state.negatives.slice() },
          draft_id: typeof global.svgDraftCurrentId === 'function' ? global.svgDraftCurrentId() : ''
        };
      }

      const normalized = calls.map(normalizeCall);
      history.push({ role: 'assistant', content: text || null, tool_calls: normalized });
      if (o.onRound) o.onRound({ phase: 'tools', round: round, toolCalls: normalized });

      for (const call of normalized) {
        const args = parseArgs(call.function.arguments);
        const result = await runTool(call, hooks, executor);
        callsLog.push({ name: call.function.name, args: call.function.arguments, result: result });
        history.push({ role: 'tool', tool_call_id: call.id, content: safeStringify(result) });

        const name = call.function.name;
        if (result && result.error) {
          const det = pickArgsDigest(name, args);
          state.negatives.push('r' + (round + 1) + ' ' + name + (det ? ' ' + det : '')
            + '：' + String(result.error).slice(0, 80));
          if (state.negatives.length > NEG_MAX) state.negatives.shift();
          state.ledger.push('r' + (round + 1) + ' ' + name + '：失败（原因见 REJECTED）');
        } else {
          state.ledger.push('r' + (round + 1) + ' ' + name + '：' + pickDigest(name, result));
          if (name === 'trace_region') state.paths += (result.path_count || 0);
          if (name === 'draw_paths') state.paths = result.total_paths || state.paths;
          if (name === 'render_svg_compare' && result) state.lastCompare = result;
          if (name === 'validate_svg' && result) state.lastValidate = result;
          if (name === 'validate_canvas' && result) state.lastValidate = result;
        }
        if (state.ledger.length > LEDGER_MAX) state.ledger.shift();
      }

      /* 最后一轮工具结果先并入 state，下一次 buildWindow 才能给出最新事实卡 */
      state.draft = draftInfo();
    }

    return {
      text: lastText,
      rounds: maxRounds,
      calls: callsLog,
      exhausted: true,
      memory: { ledger: state.ledger.slice(), negatives: state.negatives.slice() },
      draft_id: typeof global.svgDraftCurrentId === 'function' ? global.svgDraftCurrentId() : ''
    };
  }

  global.toolLoopRun = toolLoopRun;
})(window);
