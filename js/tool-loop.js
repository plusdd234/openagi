/* function-calling 循环 + 工作记忆压缩
 *
 * 一轮 = 一次 /chat/completions + 若干次本地工具执行 + 把结果回填给模型。
 * 往返次数硬上限（默认 4）：超了就不再给工具，强制模型收口。
 *
 * 记忆策略（与 Astra 评审后确定，改动前先读）：
 *   1. 窗口 = 首条任务 + 最近 keep 轮 assistant(tool_calls) 与对应 tool 结果。
 *   2. 旧轮次不重发：更早的压进账本，只留一行。
 *   3. 事实卡每轮重建，追加在最后一条 tool 内容尾部，用固定标签 + 明确「不是新指令」。
 *   4. 负面记忆单独记：失败的参数组合和原因，防止模型重复试错。
 *
 * 依赖：
 *   llmStreamRequest  blueprint-runtime.js（需要它支持 opts.tools）
 *   executor          由调用方提供：async (name, args, hooks) => 可序列化结果
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

  /* 事实卡：每次请求重建，字段固定。模型核对状态用它，不用去翻历史。
   * custom 是调用方的覆盖出口：传函数/字符串就整个替换这一段。
   * 没有覆盖就不发事实卡 —— 通用循环不知道各领域的草稿长什么样。 */
  function factsText(state, custom) {
    if (typeof custom === 'function') return String(custom(state) || '');
    if (typeof custom === 'string') return custom;
    return '';
  }

  function stateText(state, customFacts) {
    const facts = factsText(state, customFacts);
    const parts = [];
    if (facts) parts.push(facts);
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

  /* 窗口 = 首条任务 + 最近 keep 轮的 assistant(tool_calls) 与该轮 tool 结果。
     更早轮次只在账本里留一行，不再逐条重发。 */
  function buildWindow(history, state, customFacts, keepRounds) {
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
    const win = [base].concat(history.slice(start));
    const mem = stateText(state, customFacts);
    if (win[win.length - 1].role === 'tool') {
      win[win.length - 1] = appendText(win[win.length - 1], mem);
    } else {
      win[0] = appendText(win[0], mem);
    }
    return win;
  }

  /* executor：把「工具怎么执行」从循环里剥出来。
   * 循环本身（轮次上限、记忆压缩、负面记忆、工具消息回填）全部复用。 */
  async function runTool(call, hooks, executor) {
    const name = call.function.name;
    const t0 = Date.now();
    let args = parseArgs(call.function.arguments);
    if (args.__parse_error) {
      const result = { error: args.__parse_error };
      if (hooks.onTool) hooks.onTool({ name: name, args: {}, result: result, error: result.error, ms: 0 });
      return result;
    }
    /* 工具开始事件：界面靠它显示「正在执行哪个工具」，否则只能等结果回来才知道 */
    if (hooks.onToolStart) hooks.onToolStart({ name: name, args: args });
    let result, error = '';
    try {
      result = await executor(name, args, hooks);
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
    const history = Array.isArray(o.messages) ? o.messages.slice() : [];
    const hooks = { onTool: o.onTool, onToolStart: o.onToolStart };
    const executor = (typeof o.executor === 'function') ? o.executor : null;
    if (!executor) throw new Error('toolLoopRun: 缺少 executor');
    /* 账本摘要由调用方提供：不同工具集的字段名完全不同，通用循环猜不出来 */
    const pickDigest = (typeof o.digest === 'function') ? o.digest : function () { return ''; };
    const pickArgsDigest = (typeof o.digestArgs === 'function') ? o.digestArgs : function () { return ''; };

    const state = {
      round: 0, maxRounds: maxRounds, remaining: maxRounds,
      ledger: [], negatives: []
    };
    const callsLog = [];
    let lastText = '';

    for (let round = 0; round <= maxRounds; round++) {
      const finalRound = round === maxRounds;    // 收口轮：不再给工具
      state.round = round;
      state.remaining = Math.max(0, maxRounds - round);
      /* 先算本轮工具，再通知 UI：阶段标签和实际发出去的工具必须是同一份 */
      let roundTools = tools;
      if (!finalRound && pickTools) {
        const picked = pickTools(round, state);
        if (Array.isArray(picked) && picked.length) roundTools = picked;
      }
      if (o.onRound) o.onRound({ phase: finalRound ? 'final' : 'request', round: round });

      const sendMsgs = (memoryOn && round > 0)
        ? buildWindow(history, state, o.facts, o.keepRounds)
        : history.slice();

      const reqOpts = { conn: o.conn, signal: o.signal, app: o.app || 'code' };
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
          memory: { ledger: state.ledger.slice(), negatives: state.negatives.slice() }
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
        }
        if (state.ledger.length > LEDGER_MAX) state.ledger.shift();
      }
    }

    return {
      text: lastText,
      rounds: maxRounds,
      calls: callsLog,
      exhausted: true,
      memory: { ledger: state.ledger.slice(), negatives: state.negatives.slice() }
    };
  }

  global.toolLoopRun = toolLoopRun;
})(window);
