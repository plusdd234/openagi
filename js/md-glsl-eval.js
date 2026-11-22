/* md-glsl-eval.js — GLSL ES 1.0 微型求值器（只服务捏脸烘焙）
 * ------------------------------------------------------------------
 * 为什么存在：捏脸形变住在顶点着色器里（md-lumen-bridge 的 SHAPE_VERT_HEAD，
 * 与流明逐字节相同）。导出 GLB 时 shader 形变不在 geometry.position 里 ——
 * 必须「烘焙」：逐顶点把 l3Deform 求值出来写进导出网格。
 *
 * 为什么不手写一份 JS 版 l3Deform：那是第二份形变实现，转译错一个数字
 * 就是「导出的脸和看到的不一样」且无报错（项目头号风险）。这里直接
 * **执行 GLSL 源码本身** —— GLSL 是唯一真源，语义同源天然成立。
 *
 * 支持范围（刻意收窄，超出即抛错，绝不静默）：
 *   float / vec2 / vec3 / vec4、const / uniform / varying 声明、函数定义与调用、
 *   if / else、三目、赋值（= += -= *= /=，目标限 var / var.swizzle）、
 *   多变量声明（float a = .., b = ..;）、成员选择 .xyzw/.rgba（含多分量读）、
 *   数组常量下标、构造器（vec3(x,y) / vec3(s) / vec3(v.xy, s)）、
 *   内置函数：abs sign floor ceil min max clamp mix step smoothstep
 *             pow cos sin tan sqrt length distance dot cross normalize mod
 *   广播：genType 与 float 混合运算 / 传参（GLSL genType 语义）。
 * 不支持（遇到就抛）：循环、矩阵、数组赋值/数组传参、struct、递归。
 *
 * 值表示：float = number；vecN = 普通 JS 数组（length 即维度）。
 * API：
 *   MDGlslEval.compile(src) -> { ok, error?, call(name, args, uniforms) }
 *     args 是 JS 值数组（number / 数组）；uniforms 是 { 名字: number|数组|数组的数组 }。
 */
(function () {
  'use strict';

  function EvalError2(msg) { this.message = msg; }
  EvalError2.prototype = Object.create(Error.prototype);

  /* ---------------- tokenizer ---------------- */
  var PUNCT2 = ['<=', '>=', '==', '!=', '+=', '-=', '*=', '/=', '&&', '||',
    '+', '-', '*', '/', '(', ')', '[', ']', '{', '}', ',', ';', '.', ':', '?', '<', '>', '=', '!'];

  function tokenize(src) {
    var out = [], i = 0, n = src.length;
    function err(msg) { throw new EvalError2('tokenize@' + i + ': ' + msg); }
    while (i < n) {
      var c = src[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        var e = src.indexOf('*/', i + 2);
        if (e < 0) err('未闭合的块注释');
        i = e + 2; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        var j = i;
        while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
        out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        var k = i;
        while (k < n && /[0-9.eE]/.test(src[k])) {
          if ((src[k] === 'e' || src[k] === 'E') && /[0-9+\-]/.test(src[k + 1] || '')) { k += 2; continue; }
          k++;
        }
        out.push({ t: 'num', v: parseFloat(src.slice(i, k)) }); i = k; continue;
      }
      var matched = null;
      for (var p = 0; p < PUNCT2.length; p++) {
        if (src.startsWith(PUNCT2[p], i)) { matched = PUNCT2[p]; break; }
      }
      if (!matched) err('无法识别的字符 ' + JSON.stringify(c));
      out.push({ t: 'p', v: matched }); i += matched.length;
    }
    out.push({ t: 'eof', v: '' });
    return out;
  }

  /* ---------------- parser ---------------- */
  var TYPE_RE = /^(float|vec2|vec3|vec4)$/;
  var ASSIGN_OPS = { '=': '=', '*=': '*', '+=': '+', '-=': '-', '/=': '/' };

  function parse(tokens) {
    var i = 0;
    function peek(o) { return tokens[i + (o || 0)]; }
    function next() { return tokens[i++]; }
    function expect(v) {
      var t = next();
      if (t.v !== v) throw new EvalError2('parse: 期望 ' + v + ' 实得 ' + JSON.stringify(t.v));
      return t;
    }

    var consts = Object.create(null);
    var uniformDecls = Object.create(null);
    var fns = Object.create(null);

    function typeName() {
      var t = next();
      if (!TYPE_RE.test(t.v)) throw new EvalError2('parse: 不支持的类型 ' + JSON.stringify(t.v));
      return t.v;
    }

    function parseStmts(untilBrace) {
      var list = [];
      while (true) {
        var t = peek();
        if (t.t === 'eof') break;
        if (t.v === '}') break;
        list.push(parseStmt());
      }
      return list;
    }

    function parseStmt() {
      var t = peek();
      if (t.v === '{') { i++; var body = parseStmts(true); expect('}'); return { k: 'block', body: body }; }
      if (t.v === 'if') {
        i++; expect('(');
        var cond = parseExpr(); expect(')');
        var yes = parseStmt();
        var no = null;
        if (peek().v === 'else') { i++; no = parseStmt(); }
        return { k: 'if', cond: cond, yes: yes, no: no };
      }
      if (t.v === 'return') {
        i++;
        var rv = null;
        if (peek().v !== ';') rv = parseExpr();
        expect(';');
        return { k: 'return', expr: rv };
      }
      if (t.v === ';') { i++; return { k: 'empty' }; }
      if (t.v === 'precision') { while (peek().t !== 'eof' && peek().v !== ';') i++; if (peek().v === ';') i++; return { k: 'empty' }; }
      if (t.t === 'id') {
        if (t.v === 'uniform' || t.v === 'varying' || t.v === 'attribute') {
          i++;
          var ty = typeName();
          var nm = next().v;
          var dim = 0;
          if (peek().v === '[') { i++; dim = next().v; expect(']'); }
          expect(';');
          if (t.v === 'uniform') uniformDecls[nm] = { type: ty, dim: dim };
          return { k: 'empty' };
        }
        if (t.v === 'const') {
          i++;
          var cty = typeName();
          var cnm = next().v;
          expect('=');
          var ce = parseExpr();
          expect(';');
          consts[cnm] = { type: cty, expr: ce };
          return { k: 'empty' };
        }
        if (t.v === 'for' || t.v === 'while' || t.v === 'do') {
          throw new EvalError2('parse: 循环不支持（烘焙求值不需要）');
        }
        if (TYPE_RE.test(t.v) && peek(1).t === 'id' && (peek(2).v === '=' || peek(2).v === ',' || peek(2).v === ';')) {
          i++;
          return parseDeclRest(t.v);
        }
        /* 赋值预判：lvalue（id[.swizzle]）后跟赋值运算符。先回溯试探。 */
        var save = i;
        try {
          var lv = parseLValue();
          if (lv && ASSIGN_OPS[peek().v]) {
            var op = next().v;
            var rhs = parseExpr();
            expect(';');
            return { k: 'assign', target: lv, op: ASSIGN_OPS[op], expr: rhs };
          }
        } catch (e2) { /* 不是赋值，回溯走表达式 */ }
        i = save;
        var e2x = parseExpr();
        expect(';');
        return { k: 'expr', expr: e2x };
      }
      throw new EvalError2('parse: 意外的记号 ' + JSON.stringify(t.v));
    }

    /* lvalue：id 或 id.swizzle（不含下标——数组元素赋值不需要） */
    function parseLValue() {
      var t = next();
      if (t.t !== 'id') throw new EvalError2('parse: 非法的赋值目标');
      if (peek().v === '.') {
        i++;
        var f = next().v;
        if (!/^[xyzwrgba]{1,4}$/.test(f)) throw new EvalError2('parse: 非法 swizzle .' + f);
        return { k: 'swiz', a: { k: 'var', name: t.v }, f: f };
      }
      return { k: 'var', name: t.v };
    }

    /* 已消费「类型」，解析 `name = expr (, name = expr)* ;` */
    function parseDeclRest(ty) {
      var decls = [];
      while (true) {
        var nm = next().v;
        var init = null;
        if (peek().v === '=') { i++; init = parseExpr(); }
        decls.push({ name: nm, type: ty, init: init });
        if (peek().v === ',') { i++; continue; }
        expect(';');
        break;
      }
      return { k: 'decl', decls: decls };
    }

    function parseFn() {
      var ret = typeName();
      var name = next().v;
      expect('(');
      var params = [];
      if (peek().v !== ')') {
        while (true) {
          var pty = typeName();
          var pnm = next().v;
          if (peek().v === '[') throw new EvalError2('parse: 数组参数不支持');
          params.push({ type: pty, name: pnm });
          if (peek().v === ',') { i++; continue; }
          break;
        }
      }
      expect(')');
      expect('{');
      var body = parseStmts(true);
      expect('}');
      fns[name] = { ret: ret, params: params, body: body };
    }

    /* ---- 表达式（优先级爬升）---- */
    function parseExpr() { return parseTernary(); }
    function parseTernary() {
      var c = parseCompare();
      if (peek().v === '?') {
        i++;
        var a = parseTernary();
        expect(':');
        var b = parseTernary();
        return { k: 'sel', cond: c, a: a, b: b };
      }
      return c;
    }
    function parseCompare() {
      var a = parseAdd();
      while (['<', '>', '<=', '>=', '==', '!='].indexOf(peek().v) >= 0) {
        var op = next().v;
        a = { k: 'bin', op: op, a: a, b: parseAdd() };
      }
      return a;
    }
    function parseAdd() {
      var a = parseMul();
      while (peek().v === '+' || peek().v === '-') {
        var op = next().v;
        a = { k: 'bin', op: op, a: a, b: parseMul() };
      }
      return a;
    }
    function parseMul() {
      var a = parseUnary();
      while (peek().v === '*' || peek().v === '/') {
        var op = next().v;
        a = { k: 'bin', op: op, a: a, b: parseUnary() };
      }
      return a;
    }
    function parseUnary() {
      if (peek().v === '-') { i++; return { k: 'neg', a: parseUnary() }; }
      if (peek().v === '+') { i++; return parseUnary(); }
      if (peek().v === '!') throw new EvalError2('parse: 逻辑非不支持');
      return parsePostfix();
    }
    function parsePostfix() {
      var e = parsePrimary();
      while (true) {
        var t = peek();
        if (t.v === '.') {
          i++;
          var f = next().v;
          if (!/^[xyzwrgba]{1,4}$/.test(f)) throw new EvalError2('parse: 非法 swizzle .' + f);
          e = { k: 'swiz', a: e, f: f };
        } else if (t.v === '[') {
          i++;
          var idx = parseExpr();
          expect(']');
          e = { k: 'idx', a: e, i: idx };
        } else break;
      }
      return e;
    }
    function parsePrimary() {
      var t = next();
      if (t.t === 'num') return { k: 'lit', v: t.v };
      if (t.t === 'id') {
        if (peek().v === '(') {
          i++;
          var args = [];
          if (peek().v !== ')') {
            while (true) {
              args.push(parseExpr());
              if (peek().v === ',') { i++; continue; }
              break;
            }
          }
          expect(')');
          return { k: 'call', name: t.v, args: args };
        }
        return { k: 'var', name: t.v };
      }
      if (t.v === '(') {
        var e = parseExpr();
        expect(')');
        return e;
      }
      throw new EvalError2('parse: 表达式里遇到 ' + JSON.stringify(t.v));
    }

    while (peek().t !== 'eof') {
      if (peek().t === 'id' && TYPE_RE.test(peek().v) && peek(1).t === 'id' && peek(2).v === '(') {
        parseFn();
        continue;
      }
      parseStmt();
    }
    return { consts: consts, uniformDecls: uniformDecls, fns: fns };
  }

  /* ---------------- 运行期求值 ---------------- */

  function isVec(v) { return Array.isArray(v); }

  function bin(op, a, b) {
    var va = isVec(a), vb = isVec(b);
    if (va && vb && a.length !== b.length) {
      throw new EvalError2('eval: 维度不匹配 ' + a.length + ' vs ' + b.length);
    }
    if (!va && !vb) {
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '<': return a < b;
        case '>': return a > b;
        case '<=': return a <= b;
        case '>=': return a >= b;
        case '==': return a === b;
        case '!=': return a !== b;
      }
      throw new EvalError2('eval: 运算符 ' + op);
    }
    var n = va ? a.length : b.length;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
      var x = va ? a[i] : a, y = vb ? b[i] : b;
      switch (op) {
        case '+': out[i] = x + y; break;
        case '-': out[i] = x - y; break;
        case '*': out[i] = x * y; break;
        case '/': out[i] = x / y; break;
        default: throw new EvalError2('eval: 比较运算不逐分量（' + op + '）');
      }
    }
    return out;
  }

  var SWIZ = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };

  function swizzle(v, f) {
    if (!isVec(v)) throw new EvalError2('eval: 标量不能 swizzle .' + f);
    if (f.length === 1) return v[SWIZ[f]];
    var out = new Array(f.length);
    for (var i = 0; i < f.length; i++) out[i] = v[SWIZ[f[i]]];
    return out;
  }

  function writeSwiz(dst, f, val) {
    if (f.length === 1) {
      if (isVec(val)) throw new EvalError2('eval: 向量赋给单分量 .' + f);
      dst[SWIZ[f]] = val;
      return;
    }
    if (!isVec(val) || val.length !== f.length) throw new EvalError2('eval: swizzle 赋值维度不匹配');
    for (var i = 0; i < f.length; i++) dst[SWIZ[f[i]]] = val[i];
  }

  function typeCast(ty, v) {
    if (ty === 'float') {
      if (isVec(v)) throw new EvalError2('eval: vec 不能赋给 float');
      return v;
    }
    var n = Number(ty.slice(3));
    if (isVec(v)) {
      if (v.length !== n) throw new EvalError2('eval: vec 维度不匹配（' + v.length + ' vs ' + n + '）');
      return v.slice();
    }
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = v;
    return out;
  }

  function vecN(n, fill) {
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = fill;
    return out;
  }
  function perComp(fn, xs) {
    /* 全标量输入必须返回标量（GLSL 的 float smoothstep/mix 返回 float）；
     * 有向量输入才逐分量返回数组 —— 否则 float v = mix(...) 直接炸。 */
    let hasVec = false;
    for (var i = 0; i < xs.length; i++) if (isVec(xs[i])) { hasVec = true; break; }
    if (!hasVec) return fn.apply(null, xs);
    var n = 1;
    for (i = 0; i < xs.length; i++) if (isVec(xs[i])) n = xs[i].length;
    var out = new Array(n);
    for (var j = 0; j < n; j++) {
      var a2 = new Array(xs.length);
      for (var k = 0; k < xs.length; k++) a2[k] = isVec(xs[k]) ? xs[k][j] : xs[k];
      out[j] = fn.apply(null, a2);
    }
    return out;
  }
  function flatten(args) {
    var flat = [];
    for (var k = 0; k < args.length; k++) {
      if (isVec(args[k])) for (var q = 0; q < args[k].length; q++) flat.push(args[k][q]);
      else flat.push(args[k]);
    }
    return flat;
  }
  function construct(ty, args) {
    var n = Number(ty.slice(3));
    if (args.length === 1 && !isVec(args[0])) return vecN(n, args[0]);
    var flat = flatten(args);
    if (flat.length !== n) throw new EvalError2('eval: ' + ty + ' 构造参数数不符（得 ' + flat.length + '）');
    return flat;
  }

  var BUILTIN = {
    abs: function (x) { return perComp(Math.abs, [x]); },
    sign: function (x) { return perComp(Math.sign, [x]); },
    floor: function (x) { return perComp(Math.floor, [x]); },
    ceil: function (x) { return perComp(Math.ceil, [x]); },
    cos: function (x) { return perComp(Math.cos, [x]); },
    sin: function (x) { return perComp(Math.sin, [x]); },
    tan: function (x) { return perComp(Math.tan, [x]); },
    sqrt: function (x) { return perComp(Math.sqrt, [x]); },
    pow: function (x, y) { return perComp(Math.pow, [x, y]); },
    mod: function (x, y) {
      return perComp(function (a, b) { return a - b * Math.floor(a / b); }, [x, y]);
    },
    min: function (x, y) { return perComp(Math.min, [x, y]); },
    max: function (x, y) { return perComp(Math.max, [x, y]); },
    clamp: function (x, lo, hi) {
      return perComp(function (a, b, c) { return Math.min(Math.max(a, b), c); }, [x, lo, hi]);
    },
    mix: function (a, b, k) {
      return perComp(function (x, y, t) { return x + (y - x) * t; }, [a, b, k]);
    },
    step: function (edge, x) {
      return perComp(function (e, v) { return v < e ? 0 : 1; }, [edge, x]);
    },
    smoothstep: function (a, b, x) {
      return perComp(function (e0, e1, v) {
        var t = Math.min(Math.max((v - e0) / (e1 - e0), 0), 1);
        return t * t * (3 - 2 * t);
      }, [a, b, x]);
    },
    length: function (v) {
      if (!isVec(v)) return Math.abs(v);
      var s = 0;
      for (var i = 0; i < v.length; i++) s += v[i] * v[i];
      return Math.sqrt(s);
    },
    distance: function (a, b) { return BUILTIN.length(bin('-', a, b)); },
    dot: function (a, b) {
      if (!isVec(a)) return a * b;
      var s = 0;
      for (var i = 0; i < a.length; i++) s += a[i] * b[i];
      return s;
    },
    cross: function (a, b) {
      return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    },
    normalize: function (v) {
      var l = BUILTIN.length(v);
      if (isVec(v)) return v.map(function (x) { return x / l; });
      return v / l;
    }
  };

  function compile(src) {
    var ast;
    try {
      ast = parse(tokenize(String(src)));
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }

    var consts = Object.create(null);
    function evalConst(expr) { return execExpr(expr, null, null); }
    Object.keys(ast.consts).forEach(function (k) {
      var c = ast.consts[k];
      consts[k] = typeCast(c.type, evalConst(c.expr));
    });

    function lookup(name, scope, uni) {
      if (scope && Object.prototype.hasOwnProperty.call(scope.vars, name)) return scope.vars[name];
      if (uni && Object.prototype.hasOwnProperty.call(uni, name)) return uni[name];
      if (Object.prototype.hasOwnProperty.call(consts, name)) return consts[name];
      throw new EvalError2('eval: 未定义的标识符 ' + name);
    }

    function execExpr(e, scope, uni) {
      switch (e.k) {
        case 'lit': return e.v;
        case 'var': return lookup(e.name, scope, uni);
        case 'bin': return bin(e.op, execExpr(e.a, scope, uni), execExpr(e.b, scope, uni));
        case 'neg': {
          var v = execExpr(e.a, scope, uni);
          return isVec(v) ? v.map(function (x) { return -x; }) : -v;
        }
        case 'sel': {
          var c = execExpr(e.cond, scope, uni);
          if (typeof c !== 'boolean') throw new EvalError2('eval: 三目条件不是 bool');
          return execExpr(c ? e.a : e.b, scope, uni);
        }
        case 'swiz': return swizzle(execExpr(e.a, scope, uni), e.f);
        case 'idx': {
          var base = execExpr(e.a, scope, uni);
          var ix = execExpr(e.i, scope, uni);
          if (!Array.isArray(base)) throw new EvalError2('eval: 标量不能下标');
          if (!Number.isInteger(ix) || ix < 0 || ix >= base.length) {
            throw new EvalError2('eval: 数组下标越界 ' + ix);
          }
          return base[ix];
        }
        case 'call': {
          var args = e.args.map(function (a) { return execExpr(a, scope, uni); });
          return call(e.name, args, uni);
        }
        default: throw new EvalError2('eval: 未知表达式 ' + e.k);
      }
    }

    function assign(target, val, scope, uni) {
      if (target.k === 'var') {
        var nm = target.name;
        if (!(scope && Object.prototype.hasOwnProperty.call(scope.vars, nm))) {
          throw new EvalError2('eval: 赋值目标未声明 ' + nm);
        }
        scope.vars[nm] = val;
        return;
      }
      /* var.swiz 赋值：目标本体必须是可写的局部变量数组 */
      if (target.k === 'swiz' && target.a.k === 'var') {
        var nm2 = target.a.name;
        var dst = scope && scope.vars[nm2];
        if (!Array.isArray(dst)) throw new EvalError2('eval: 分量赋值目标不是局部向量 ' + nm2);
        writeSwiz(dst, target.f, val);
        return;
      }
      throw new EvalError2('eval: 不支持的赋值目标');
    }

    function execStmt(st, scope, uni) {
      switch (st.k) {
        case 'empty': return null;
        case 'block': {
          for (var i = 0; i < st.body.length; i++) {
            var r = execStmt(st.body[i], scope, uni);
            if (r) return r;
          }
          return null;
        }
        case 'decl': {
          for (var d = 0; d < st.decls.length; d++) {
            var dc = st.decls[d];
            scope.vars[dc.name] = dc.init == null
              ? (dc.type === 'float' ? 0 : vecN(Number(dc.type.slice(3)), 0))
              : typeCast(dc.type, execExpr(dc.init, scope, uni));
          }
          return null;
        }
        case 'expr': execExpr(st.expr, scope, uni); return null;
        case 'assign': {
          var val = execExpr(st.expr, scope, uni);
          if (st.op !== '=') val = bin(st.op, execExpr(st.target, scope, uni), val);
          assign(st.target, val, scope, uni);
          return null;
        }
        case 'return': return { k: 'ret', v: st.expr ? execExpr(st.expr, scope, uni) : undefined };
        case 'if': {
          var c = execExpr(st.cond, scope, uni);
          if (typeof c !== 'boolean') throw new EvalError2('eval: if 条件不是 bool');
          return c ? execStmt(st.yes, scope, uni) : (st.no ? execStmt(st.no, scope, uni) : null);
        }
        default: throw new EvalError2('eval: 未知语句 ' + st.k);
      }
    }

    function call(name, args, uni) {
      var fn = ast.fns[name];
      if (!fn) {
        if (TYPE_RE.test(name)) return construct(name, args);
        var bf = BUILTIN[name];
        if (!bf) throw new EvalError2('eval: 没有函数 ' + name);
        return bf.apply(null, args);
      }
      if (args.length !== fn.params.length) {
        throw new EvalError2('eval: ' + name + ' 参数数不符（' + args.length + ' vs ' + fn.params.length + '）');
      }
      var vars = Object.create(null);
      for (var i2 = 0; i2 < fn.params.length; i2++) {
        vars[fn.params[i2].name] = typeCast(fn.params[i2].type, args[i2]);
      }
      var scope = { vars: vars };
      for (var s = 0; s < fn.body.length; s++) {
        var r = execStmt(fn.body[s], scope, uni);
        if (r && r.k === 'ret') return r.v;
      }
      return undefined;
    }

    return {
      ok: true,
      consts: consts,
      uniformDecls: ast.uniformDecls,
      fns: Object.keys(ast.fns),
      call: function (name, args, uniforms) {
        var uni = uniforms || {};
        Object.keys(ast.uniformDecls).forEach(function (u) {
          if (!(u in uni)) throw new EvalError2('eval: 缺 uniform ' + u);
        });
        var r = call(name, args, uni);
        if (r === undefined) throw new EvalError2('eval: ' + name + ' 没有 return');
        return r;
      }
    };
  }

  window.MDGlslEval = { compile: compile };
})();
