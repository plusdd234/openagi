#!/usr/bin/env node
/* tools/bench-aisearch-assist.js —— 智搜「AI 临时辅助脚本」对照实验
 *
 * 目的：验证「让模型在检索阶段写一段临时辅助脚本（补检索式 / 打分 / 过滤）」
 * 是否真的提升检索质量，而不是凭感觉加功能。
 *
 * 做法（同一套语料、同一套页面桩，只改一个变量）：
 *   A 组：辅助脚本关闭 → 走原有 意图 → 主检索 → 改写 → 三轮智搜 → 仓库 的链路；
 *   B 组：辅助脚本开启 → 在原链路末尾让模型写脚本，按脚本补检索式并加权 / 过滤。
 * 其余所有模型调用都被替换成确定性桩（筛选器固定失败走启发式、回答器只读资料），
 * 只有「写脚本」这一步真的调用本地 Ollama，因此差异只可能来自辅助脚本。
 *
 * 指标（每题）：
 *   · goldInResults  最终结果列表里命中几篇金标页（满分 2）
 *   · goldRead       实际精读到几篇金标页（满分 2）
 *   · factHit        交给模型的资料里是否出现「只有金标页才有」的关键事实
 *
 * 用法：
 *   node tools/bench-aisearch-assist.js
 *   ASSIST_MODEL=qwen2.5:3b node tools/bench-aisearch-assist.js
 *   BENCH_LLM=remote node tools/bench-aisearch-assist.js         用仓库 openagi-store.json 的配置
 *   BENCH_LLM=live   node tools/bench-aisearch-assist.js         用运行中桌面应用「The seed」profile 里的当前配置
 *
 * live / remote 需要联网：Windows 下先设 NODE_USE_ENV_PROXY=1 与 HTTPS_PROXY（系统代理）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { createRun } = require('./probe-run');

const ROOT = path.join(__dirname, '..');
const MODEL = process.env.ASSIST_MODEL || 'qwen2.5:3b';
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const REMOTE = process.env.BENCH_LLM === 'remote';
const LIVE = process.env.BENCH_LLM === 'live';

const run = createRun('bench-aisearch-assist');

function long(snippet) {
  return snippet + '。' + [
    '这段文字用来模拟真实网页里可读的正文段落，包含背景、定义、适用场景与常见问题。',
    '文中还列出了与主题相关的细节，方便后续抽取与比对。',
    '如果资料之间出现差异，以官方说明为准，并注意资料的发布日期。'
  ].join('');
}

function doc(title, url, keys, snippet, extra) {
  return Object.assign({ title: title, url: url, keys: keys, snippet: snippet, body: long(snippet) }, extra || {});
}

const TASKS = [
  {
    q: 'React 19 有哪些新特性',
    fact: 'useActionState',
    docs: [
      doc('React 19 正式发布 – React 官方博客', 'https://react.dev/blog/react-19', ['react', '新特性'],
        'React 19 正式发布：Actions、服务端组件与 React Compiler。', { gold: true }),
      doc('React 19 新特性一览 - 前端周刊', 'https://juejin.cn/post/react19', ['react', '新特性'],
        '社区整理的 React 19 变化：表单 Actions、ref 作为 prop、文档元数据。', { gold: true }),
      doc('React 18 升级指南', 'https://blog.example.com/react-upgrade', ['react', '升级'],
        '从 React 17 升到 18 的注意事项与迁移步骤。'),
      doc('React 19 官方文档：useActionState', 'https://react.dev/reference/useActionState',
        ['官方', '博客', 'release', 'useactionstate', 'api'],
        'useActionState 用于表单 Action 的挂起、错误与返回值。', { gold: true, deep: true, fact: true }),
      doc('React 19 React Compiler 文档', 'https://react.dev/learn/react-compiler', ['官方文档', '编译器'],
        'React Compiler 自动记忆化组件，减少手写 memo。', { gold: true }),
      doc('React 19 使用心得', 'https://zhuanlan.zhihu.com/p/123', ['react', '心得'],
        '一篇普通的使用心得，没有涉及具体 API。'),
      doc('React 下载页', 'https://legacy.example.com/download/react', ['react', '下载'],
        '下载安装包与历史版本。'),
      doc('2026 前端框架排行', 'https://rank.example.com/fe', ['前端', '排行'],
        'React、Vue、Svelte 的流行度排名。')
    ]
  },
  {
    q: 'Python 3.13 有哪些新变化',
    fact: 'free-threaded',
    docs: [
      doc('Python 3.13 正式发布 – Python 官方文档', 'https://docs.python.org/3.13/whatsnew/3.13.html',
        ['python', '新变化'],
        'Python 3.13 发布：实验性 JIT、交互式解释器改进与更清晰的报错。', { gold: true }),
      doc('Python 3.13 新变化清单 - 技术博客', 'https://blog.example.cn/python313', ['python', '新变化'],
        '社区整理：copy.replace、locals 改进、移动端支持。', { gold: true }),
      doc('Python 3.13 官方文档：free-threaded 模式（PEP 703）',
        'https://docs.python.org/3.13/whatsnew/free-threading.html',
        ['官方文档', 'free-threaded', 'pep 703'],
        'free-threaded 模式移除全局解释器锁，可用于多线程并行。', { gold: true, deep: true, fact: true }),
      doc('Python 教程：从零开始', 'https://www.runoob.com/python3', ['python', '教程'],
        'Python 基础语法教程。'),
      doc('Python 3.12 新变化回顾', 'https://blog.example.com/python312', ['python', '3.12'],
        '上一个版本的更新回顾。'),
      doc('2026 编程语言排行', 'https://rank.example.com/lang', ['编程', '排行'],
        'Python 依旧领先。'),
      doc('Python 下载页', 'https://www.python.org/downloads/', ['python', '下载'],
        '下载 Python 安装包。')
    ]
  },
  {
    q: '机械键盘怎么选',
    fact: '静音轴',
    docs: [
      doc('机械键盘选购指南 - 知乎', 'https://zhuanlan.zhihu.com/p/100', ['机械键盘', '选购'],
        '选购要点：配列、键程、预算与使用场景。', { gold: true }),
      doc('2026 机械键盘排行榜', 'https://rank.example.com/keyboard', ['机械键盘', '排行榜'],
        '热门型号排行：手感、配列、价格一次看全。'),
      doc('机械键盘 轴体详解：线性 / 段落 / 静音', 'https://www.example.org/switch', ['轴体', '线性', '段落'],
        '轴体决定手感：线性直上直下，段落有确认感，静音轴更安静。', { gold: true, deep: true, fact: true }),
      doc('机械键盘手感由什么决定', 'https://blog.example.com/feel', ['机械键盘', '手感'],
        '手感主要取决于轴体类型与键程，配列影响的是布局而不是手感。'),
      doc('键盘清洁教程', 'https://blog.example.com/clean', ['清洁', '键盘'],
        '拆键帽与清洁步骤。'),
      doc('机械键盘 2026 推荐', 'https://shop.example.com/keyboard', ['机械键盘', '推荐'],
        '入门到高端的购买建议。'),
      doc('静音鼠标怎么选', 'https://blog.example.com/mouse', ['鼠标', '静音'],
        '鼠标选购与握持方式。')
    ]
  },
  {
    q: '2026 年诺贝尔物理学奖',
    fact: 'John Smith',
    docs: [
      doc('2026 年诺贝尔物理学奖揭晓 - 诺贝尔奖官网', 'https://www.nobelprize.org/2026-physics',
        ['诺贝尔', '物理学奖'],
        '2026 年诺贝尔物理学奖授予量子纠缠实验，获奖者将在斯德哥尔摩公布。', { gold: true }),
      doc('2026 诺贝尔物理学奖获奖者：John Smith 与 Maria Lopez',
        'https://news.example.com/nobel2026', ['获奖者', 'winner'],
        'John Smith 与 Maria Lopez 因量子纠缠实验获奖。', { gold: true, deep: true, fact: true }),
      doc('2025 年诺贝尔奖回顾', 'https://news.example.com/nobel2025', ['2025', '诺贝尔'],
        '上一年度奖项回顾。'),
      doc('诺贝尔奖 - 百度百科', 'https://baike.baidu.com/item/nobel', ['百科'],
        '奖项背景与评选流程。'),
      doc('诺贝尔物理学奖历届得主', 'https://www.example.org/history', ['历届', '得主'],
        '1901 年以来的获奖名单。'),
      doc('诺贝尔物理学奖评选流程说明', 'https://www.nobelprize.org/process', ['诺贝尔', '物理学奖'],
        '评选流程与公布时间。')
    ]
  }
];

/* 页面桩：搜索索引、正文抓取、GitHub、以及确定性模型替身。 */
function installStubs(tasks) {
  const docByUrl = {};
  tasks.forEach((t) => t.docs.forEach((d) => { docByUrl[d.url] = d; }));
  window.__DOC_BY_URL = docByUrl;
  window.__TASK = tasks[0];
  window.__FACT = tasks[0].fact;
  window.__searches = [];
  window.__scriptRaw = '';

  window.deskSearch = {
    run: function (q) {
      window.__searches.push(String(q));
      const s = String(q || '').toLowerCase();
      const scored = window.__TASK.docs
        .map(function (d, i) {
          let sc = 0;
          d.keys.forEach(function (k) { if (s.indexOf(String(k).toLowerCase()) >= 0) sc++; });
          return { d: d, i: i, sc: sc };
        })
        .filter(function (x) { return x.sc > 0; })
        .sort(function (a, b) { return b.sc - a.sc || a.i - b.i; })
        .slice(0, 10);
      return Promise.resolve({
        ok: true, provider: 'stub', ms: 3,
        results: scored.map(function (x) {
          return { title: x.d.title, url: x.d.url, snippet: x.d.snippet };
        })
      });
    }
  };

  window.llmConn = function () {
    return { base: 'http://stub-llm.local/v1', key: 'stub', model: 'stub' };
  };

  window.fetch = function (url, init) {
    const u = String(url);
    const h = (init && init.headers) || {};
    const target = h['X-Relay-Target'] || h['x-relay-target'] || '';
    if (/\/health$/.test(u)) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' }
      }));
    }
    if (/\/proxy$/.test(u)) {
      if (/api\.github\.com\/search\/repositories/.test(target)) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        }));
      }
      const d = window.__DOC_BY_URL[target];
      if (!d) {
        return Promise.resolve(new Response('not found', {
          status: 404, headers: { 'content-type': 'text/plain' }
        }));
      }
      const html = '<html><head><title>' + d.title + '</title></head><body><article>'
        + '<h1>' + d.title + '</h1><p>' + d.body + '</p></article></body></html>';
      return Promise.resolve(new Response(html, {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }
      }));
    }
    return Promise.resolve(new Response('not found', {
      status: 404, headers: { 'content-type': 'text/plain' }
    }));
  };

  window.LLMRouter.complete = function (o) {
    const sys = String(o.sys || '');
    const user = String((o.messages && o.messages[0] && o.messages[0].content) || '');
    if (/检索辅助脚本生成器/.test(sys)) {
      return window.__benchOllama({ sys: sys, user: user }).then(function (out) {
        window.__scriptRaw = String(out || '');
        return out;
      });
    }
    /* 筛读固定走启发式：让两组只差辅助脚本这一项。 */
    if (/搜索结果筛选器/.test(sys)) return Promise.reject(new Error('judge disabled in bench'));
    /* 回答器只根据「真正喂进来的资料」作答：事实在资料里才答得出。 */
    if (/阅读助手/.test(sys)) {
      return Promise.resolve(user.indexOf(window.__FACT) >= 0
        ? '**结论**：资料给出的关键信息是 ' + window.__FACT + ' [1]。'
        : '**结论**：现有资料只覆盖背景与流程，关键信息还需再核对官方公告。');
    }
    return Promise.resolve('');
  };
}

let storeCache = null;
function storeConf() {
  if (storeCache) return storeCache;
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'openagi-store.json'), 'utf8'));
  storeCache = {
    base: String(raw.hf_llmBaseUrl || '').replace(/\/+$/, ''),
    key: String(raw.hf_llmKey || ''),
    model: process.env.ASSIST_MODEL || String(raw.hf_llmModel || '')
  };
  return storeCache;
}

/* 运行中的桌面应用可能比仓库里的 openagi-store.json 更新（换过 Key / 地址）。
   live 模式直接从 Electron profile 的 localStorage 里读「当前配置」，不打印密钥。 */
function liveConf() {
  const dir = path.join(process.env.APPDATA || '', 'The seed', 'Local Storage', 'leveldb');
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(log|ldb)$/.test(f)) continue;
    const txt = fs.readFileSync(path.join(dir, f)).toString('utf8');
    const i = txt.indexOf('hf_llmBaseUrl');
    if (i < 0) continue;
    /* 一次读取会按 base → key → model 的顺序落盘，700 字符窗口足够覆盖这三项。 */
    const seg = txt.slice(i, i + 700);
    const base = (seg.match(/https?:\/\/[^\s\u0000-\u001f]+?\/v1\b/) || [])[0] || '';
    const key = (seg.match(/sk-[A-Za-z0-9]{20,}/) || [])[0] || '';
    if (!base || !key) continue;
    const after = seg.slice(seg.indexOf(key) + key.length);
    const cands = after.match(/[a-z][a-z0-9._-]{5,40}/gi) || [];
    const model = cands.filter((m) => !/^(model|think|true|false|enabled|apps|data|hf)$/i.test(m))[0] || '';
    if (model) return { base: base, key: key, model: model };
  }
  return null;
}

async function liveChat(payload) {
  const conf = liveConf();
  if (!conf) throw new Error('读不到运行中应用的模型配置');
  return cloudChat(conf, payload);
}

async function storeChat(payload) {
  const conf = storeConf();
  if (!conf.base || !conf.key || !conf.model) throw new Error('桌面配置里没有可用的语言模型');
  return cloudChat(conf, payload);
}

/* 与应用一致地走云端 OpenAI 兼容接口：密钥只在进程内使用，不打印、不落盘。 */
async function cloudChat(conf, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 90000);
  const t0 = Date.now();
  try {
    const res = await fetch(conf.base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + conf.key },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: conf.model,
        temperature: 0,
        messages: [
          { role: 'system', content: payload.sys },
          { role: 'user', content: payload.user }
        ]
      })
    });
    if (!res.ok) throw new Error('LLM HTTP ' + res.status);
    const j = await res.json();
    const out = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
    console.log('    [cloud] ' + conf.model + ' 写脚本 ' + (Date.now() - t0) + 'ms · ' + out.replace(/\s+/g, ' ').slice(0, 160));
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaChat(payload) {
  if (LIVE) return liveChat(payload);
  if (REMOTE) return storeChat(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 90000);
  const t0 = Date.now();
  try {
    const res = await fetch(OLLAMA + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: payload.sys },
          { role: 'user', content: payload.user }
        ]
      })
    });
    if (!res.ok) throw new Error('Ollama HTTP ' + res.status);
    const j = await res.json();
    const out = String((j.message && j.message.content) || '');
    console.log('    [ollama] ' + MODEL + ' 写脚本 ' + (Date.now() - t0) + 'ms · ' + out.replace(/\s+/g, ' ').slice(0, 120));
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function newPage(browser, assistOn) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', function (e) { errors.push(String(e && e.message)); });
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.exposeFunction('__benchOllama', ollamaChat);
  await page.evaluate(function (on) {
    try {
      localStorage.setItem('hf_aisearch_assist', on ? '1' : '0');
      localStorage.setItem('hf_aisearch_mode', 'web');
    } catch (e) { /* 忽略 */ }
  }, assistOn);
  await page.evaluate(installStubs, TASKS);
  await page.evaluate(function () { window.openDeskApp('aisearch'); });
  await page.waitForTimeout(900);
  return { page: page, errors: errors };
}

async function runTask(page, task) {
  await page.evaluate(function (t) {
    window.__TASK = t;
    window.__FACT = t.fact;
    window.__searches = [];
    window.__scriptRaw = '';
  }, task);
  await page.evaluate(function () {
    const h = document.querySelector('#aisearchWin .ais-brand');
    if (h) h.click();
  });
  await page.waitForTimeout(200);
  await page.fill('#aisearchWin .ais-hero-input', task.q);
  await page.press('#aisearchWin .ais-hero-input', 'Enter');
  await page.waitForFunction(function () {
    const s = document.querySelector('#aisearchWin .ais-status');
    return s && /完成|未找到|失败/.test(s.textContent || '');
  }, null, { timeout: 90000 });
  await page.waitForTimeout(200);

  const data = await page.evaluate(function () {
    const answer = document.querySelector('#aisearchWin .ais-answer-body');
    return {
      hits: Array.from(document.querySelectorAll('#aisearchWin .ais-hit-title')).map(function (a) { return a.href; }),
      reads: Array.from(document.querySelectorAll('#aisearchWin .ais-src.is-read')).map(function (a) { return a.href; }),
      answer: String((answer && answer.textContent) || ''),
      trace: Array.from(document.querySelectorAll('#aisearchWin .ais-trace-item')).map(function (el) { return el.textContent; }),
      searches: window.__searches.slice(),
      scriptRaw: window.__scriptRaw
    };
  });

  const gold = task.docs.filter(function (d) { return d.gold; }).map(function (d) { return d.url; });
  const deep = task.docs.filter(function (d) { return d.deep; }).map(function (d) { return d.url; });
  const goldInResults = data.hits.filter(function (u) { return gold.indexOf(u) >= 0; });
  const goldRead = data.reads.filter(function (u) { return gold.indexOf(u) >= 0; });
  const scriptLine = data.trace.filter(function (t) { return /脚本/.test(t); });
  return {
    q: task.q,
    hits: data.hits,
    reads: data.reads,
    goldInResults: goldInResults.length,
    goldRead: goldRead.length,
    deepInResults: data.hits.filter(function (u) { return deep.indexOf(u) >= 0; }).length,
    deepRead: data.reads.filter(function (u) { return deep.indexOf(u) >= 0; }).length,
    factHit: data.answer.indexOf(task.fact) >= 0,
    answer: data.answer.replace(/\s+/g, ' ').slice(0, 160),
    searches: data.searches,
    scriptUsed: scriptLine.length > 0,
    scriptLine: scriptLine.join(' | '),
    scriptRaw: data.scriptRaw,
    trace: data.trace
  };
}

(async function main() {
  let activeModel = MODEL;
  let modelOk = true;
  if (LIVE) {
    const conf = liveConf();
    activeModel = (conf && conf.model) || '（读不到运行中配置）';
    modelOk = !!(conf && conf.base && conf.key && conf.model);
    if (!modelOk) {
      console.error('❌ 读不到运行中桌面应用的模型配置（' + path.join(process.env.APPDATA || '', 'The seed', 'Local Storage', 'leveldb') + '）。');
      console.error('   请确认桌面应用至少启动过一次，并在设置里填好了模型地址 / Key / 模型名。');
      process.exit(1);
    }
  } else if (REMOTE) {
    const conf = storeConf();
    activeModel = conf.model;
    modelOk = !!(conf.base && conf.key && conf.model);
  } else {
    try {
      const r = await fetch(OLLAMA + '/api/tags');
      if (!r.ok) modelOk = false;
    } catch (e) { modelOk = false; }
  }
  if (!modelOk) {
    console.error('❌ 模型不可用（' + activeModel + '），无法做真实模型对照实验。');
    process.exit(1);
  }
  console.log('实验模型：' + activeModel + '（' + (LIVE ? '运行中应用的当前配置' : REMOTE ? '仓库 openagi-store.json' : '本地 Ollama') + '）');

  const browser = await chromium.launch({ channel: 'msedge' });
  const report = { model: activeModel, startedAt: new Date().toISOString(), groups: {} };
  try {
    const groups = [{ key: 'baseline', assist: false }, { key: 'assist', assist: true }];
    for (const g of groups) {
      const ctx = await newPage(browser, g.assist);
      const rows = [];
      for (const task of TASKS) {
        console.log('\n[' + g.key + '] ' + task.q);
        const row = await runTask(ctx.page, task);
        rows.push(row);
        console.log('  → 深页进结果 ' + row.deepInResults + '/1 · 深页精读 ' + row.deepRead + '/1 · 事实命中 ' +
          (row.factHit ? '是' : '否') + (row.scriptUsed ? ' · 脚本：已用' : ''));
      }
      report.groups[g.key] = { rows: rows, pageErrors: ctx.errors };
      await ctx.page.close();
    }
  } finally {
    await browser.close();
  }

  function sum(rows, key) {
    return rows.reduce(function (n, r) { return n + (key === 'factHit' ? (r.factHit ? 1 : 0) : r[key]); }, 0);
  }
  const a = report.groups.baseline.rows;
  const b = report.groups.assist.rows;
  report.summary = {
    baseline: {
      results: sum(a, 'goldInResults'), read: sum(a, 'goldRead'),
      deepResults: sum(a, 'deepInResults'), deepRead: sum(a, 'deepRead'), fact: sum(a, 'factHit')
    },
    assist: {
      results: sum(b, 'goldInResults'), read: sum(b, 'goldRead'),
      deepResults: sum(b, 'deepInResults'), deepRead: sum(b, 'deepRead'), fact: sum(b, 'factHit'),
      scripts: b.filter(function (r) { return r.scriptUsed; }).length
    }
  };

  console.log('\n================ 对照结果 ================');
  console.log('指标              基线(A)   辅助脚本(B)');
  console.log('金标命中(满分8)     ' + report.summary.baseline.results + '        ' + report.summary.assist.results);
  console.log('金标精读(满分8)     ' + report.summary.baseline.read + '        ' + report.summary.assist.read);
  console.log('深页进结果(满分4)   ' + report.summary.baseline.deepResults + '        ' + report.summary.assist.deepResults);
  console.log('深页精读(满分4)     ' + report.summary.baseline.deepRead + '        ' + report.summary.assist.deepRead);
  console.log('事实命中(满分4)     ' + report.summary.baseline.fact + '        ' + report.summary.assist.fact);
  console.log('脚本生效题数        -        ' + report.summary.assist.scripts + '/4');
  console.log('模型                ' + activeModel);
  const p = run.writeJson('bench.json', report);
  console.log('明细：' + p);

  const improved = report.summary.assist.fact > report.summary.baseline.fact
    || report.summary.assist.deepRead > report.summary.baseline.deepRead
    || report.summary.assist.deepResults > report.summary.baseline.deepResults;
  const regressed = report.summary.assist.fact < report.summary.baseline.fact
    || report.summary.assist.deepRead < report.summary.baseline.deepRead
    || report.summary.assist.deepResults < report.summary.baseline.deepResults;
  console.log('\n结论：' + (improved && !regressed ? '有提升' : improved && regressed ? '有提升也有回退，需按题分析' : '未观察到提升'));
  process.exit(0);
})().catch(function (e) {
  console.error('实验失败：', e && (e.stack || e.message));
  try { run.finish([e]); } catch (_) { /* 忽略 */ }
  process.exit(1);
});
