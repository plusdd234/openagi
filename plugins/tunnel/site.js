/* 公网页面：上传资源 + 提交反馈
 *
 * 这个字符串会由隧道插件直接返回给外部访问者，所以：
 *   - 不引外部 CSS / JS / 字体（断网、弱网都可用）
 *   - 移动端优先，单列布局
 *   - 不含任何服务端路径、密钥、本机信息
 *   - 上传用 XHR + 原始 body（PUT），能拿到真实进度且省内存
 */
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildPage(opts) {
  const o = opts || {};
  const note = esc(o.note || '欢迎上传素材、模型或文档，也欢迎留下你的意见与反馈。');
  const maxMB = Number(o.maxMB || 200);
  const feedbackOn = o.feedbackOn !== false;
  const keyOn = o.keyOn !== false;

  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<title>分享与反馈</title>' +
    '<style>' +
    '*{box-sizing:border-box}' +
    'html,body{margin:0;padding:0}' +
    'body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
    'color:#26303c;background:linear-gradient(180deg,#f7f9fc 0%,#eef2f8 100%);min-height:100vh;padding:22px 16px 40px}' +
    '.wrap{max-width:720px;margin:0 auto}' +
    'header h1{font-size:22px;margin:0 0 6px;letter-spacing:.3px}' +
    'header p{margin:0 0 18px;color:#64748b;font-size:13.5px}' +
    '.card{background:#fff;border:1px solid #e3e8ef;border-radius:14px;padding:18px;margin:0 0 16px;box-shadow:0 2px 10px rgba(37,53,74,.05)}' +
    '.card h2{font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px}' +
    '.card h2 .dot{width:7px;height:7px;border-radius:50%;background:#5b8fd9}' +
    '.drop{border:1.6px dashed #cdd8e6;border-radius:12px;padding:26px 16px;text-align:center;color:#6b7c92;cursor:pointer;transition:.16s;background:#fbfcfe}' +
    '.drop:hover,.drop.on{border-color:#5b8fd9;background:#f2f7ff;color:#3f6fb5}' +
    '.drop b{display:block;color:#34435a;font-size:14.5px;margin-bottom:4px}' +
    '.drop small{font-size:12.5px;color:#8b9cb3}' +
    'input[type=text],textarea{width:100%;font:inherit;color:inherit;background:#fbfcfe;border:1px solid #dde4ee;border-radius:10px;padding:10px 12px;outline:none;transition:.15s}' +
    'textarea{min-height:96px;resize:vertical}' +
    'input[type=text]:focus,textarea:focus{border-color:#8db3e8;background:#fff;box-shadow:0 0 0 3px rgba(91,143,217,.13)}' +
    '.row{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap}' +
    '.row>*{flex:1 1 180px}' +
    'button{font:inherit;border:0;border-radius:10px;padding:10px 18px;background:#5b8fd9;color:#fff;cursor:pointer;transition:.15s}' +
    'button:hover{background:#4a7ec8}' +
    'button:disabled{background:#b9c9de;cursor:not-allowed}' +
    'button.ghost{background:#eef3fa;color:#3f6fb5}' +
    'button.ghost:hover{background:#e2ebf7}' +
    '.queue{margin-top:12px;display:flex;flex-direction:column;gap:8px}' +
    '.item{border:1px solid #e6ebf3;border-radius:10px;padding:9px 11px;font-size:13px;background:#fbfcfe}' +
    '.item .top{display:flex;justify-content:space-between;gap:10px}' +
    '.item .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:68%}' +
    '.item .meta{color:#8494aa;font-size:12px;flex:none}' +
    '.bar{height:5px;border-radius:3px;background:#e8eef7;margin-top:7px;overflow:hidden}' +
    '.bar i{display:block;height:100%;width:0;background:#5b8fd9;transition:width .18s}' +
    '.item.ok .bar i{background:#4caf83}' +
    '.item.err .bar i{background:#e06868}' +
    '.hint{font-size:12.5px;color:#8b9cb3;margin-top:10px}' +
    '.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,14px);background:#2d3a4b;color:#fff;' +
    'padding:9px 16px;border-radius:99px;font-size:13px;opacity:0;pointer-events:none;transition:.22s;z-index:9;max-width:88vw}' +
    '.toast.on{opacity:1;transform:translate(-50%,0)}' +
    'footer{text-align:center;color:#93a1b5;font-size:12px;margin-top:6px}' +
    '@media (max-width:520px){body{padding:16px 12px 32px}header h1{font-size:19.5px}}' +
    '</style></head><body><div class="wrap">' +
    '<header><h1>分享与反馈</h1><p>' + note + '</p></header>' +

    '<section class="card">' +
    '<h2><span class="dot"></span>上传资源</h2>' +
    '<label class="drop" id="drop"><b>点击或拖拽文件到这里</b><small>可多选 · 单个文件不超过 ' + maxMB + ' MB</small>' +
    '<input type="file" id="file" multiple hidden></label>' +
    '<div class="row"><input type="text" id="note" placeholder="附言（可选）：这批文件是什么 / 用在哪里"></div>' +
    '<div class="queue" id="queue"></div>' +
    '<div class="hint">文件会直接保存到分享者的主机上，不会经过第三方网盘。</div>' +
    '</section>' +

    (feedbackOn
      ? '<section class="card"><h2><span class="dot"></span>意见与反馈</h2>' +
        '<div class="row"><input type="text" id="fname" placeholder="称呼（可选）" maxlength="40">' +
        '<input type="text" id="fcontact" placeholder="联系方式（可选）" maxlength="80"></div>' +
        '<div class="row"><textarea id="ftext" placeholder="使用体验、bug、希望增加的功能……" maxlength="4000"></textarea></div>' +
        '<div class="row"><button id="send">提交反馈</button></div></section>'
      : '') +

    '<footer id="stat"></footer>' +
    '</div><div class="toast" id="toast"></div>' +
    '<script>(function(){' +
    'var $=function(s){return document.querySelector(s)};' +
    'var q=$("#queue"),drop=$("#drop"),file=$("#file"),noteEl=$("#note"),toastEl=$("#toast");' +
    'var MAX=' + maxMB + '*1024*1024;' +
    'function toast(t){toastEl.textContent=t;toastEl.classList.add("on");clearTimeout(toast._t);toast._t=setTimeout(function(){toastEl.classList.remove("on")},2600)}' +
    'function size(n){if(n<1024)return n+" B";if(n<1048576)return (n/1024).toFixed(1)+" KB";return (n/1048576).toFixed(1)+" MB"}' +
    'function row(f){var el=document.createElement("div");el.className="item";' +
    'el.innerHTML=\'<div class="top"><span class="name"></span><span class="meta">等待中</span></div><div class="bar"><i></i></div>\';' +
    'el.querySelector(".name").textContent=f.name;q.appendChild(el);return el}' +
    'function put(f,el,done){var x=new XMLHttpRequest();x.open("PUT","/api/upload?name="+encodeURIComponent(f.name));' +
    'if(noteEl.value)x.setRequestHeader("x-note",encodeURIComponent(noteEl.value.slice(0,200)));' +
    'var meta=el.querySelector(".meta"),bar=el.querySelector("i");' +
    'x.upload.onprogress=function(e){if(!e.lengthComputable)return;var p=Math.round(e.loaded/e.total*100);bar.style.width=p+"%";meta.textContent=p+"%"};' +
    'x.onload=function(){if(x.status===200){el.classList.add("ok");bar.style.width="100%";meta.textContent="已上传";done(null)}' +
    'else{el.classList.add("err");meta.textContent="失败 "+x.status;done(new Error("HTTP "+x.status))}};' +
    'x.onerror=function(){el.classList.add("err");meta.textContent="网络错误";done(new Error("network"))};' +
    'x.send(f)}' +
    'function pick(list){var files=[].slice.call(list||[]);if(!files.length)return;' +
    'var ok=files.filter(function(f){if(f.size>MAX){toast(f.name+" 超过 ' + maxMB + ' MB");return false}return true});' +
    'if(!ok.length)return;' +
    'var i=0;(function next(){if(i>=ok.length){toast("上传完成");loadStat();return}' +
    'var f=ok[i++],el=row(f);put(f,el,function(err){if(err&&err.message==="network"){toast("网络中断，可重新选择继续")}next()})})()}' +
    'drop.addEventListener("click",function(e){if(e.target!==file)file.click()});' +
    'file.addEventListener("change",function(){pick(file.files);file.value=""});' +
    '["dragenter","dragover"].forEach(function(t){drop.addEventListener(t,function(e){e.preventDefault();drop.classList.add("on")})});' +
    '["dragleave","drop"].forEach(function(t){drop.addEventListener(t,function(e){e.preventDefault();drop.classList.remove("on")})});' +
    'drop.addEventListener("drop",function(e){pick(e.dataTransfer&&e.dataTransfer.files)});' +
    'var send=$("#send");if(send)send.addEventListener("click",function(){var t=$("#ftext").value.trim();if(!t){toast("请先写点内容");return}' +
    'send.disabled=true;fetch("/api/feedback",{method:"POST",headers:{"content-type":"application/json"},' +
    'body:JSON.stringify({name:$("#fname").value,contact:$("#fcontact").value,text:t})}).then(function(r){' +
    'if(!r.ok)throw new Error("HTTP "+r.status);return r.json()}).then(function(){toast("已收到，谢谢");' +
    '$("#ftext").value="";send.disabled=false;loadStat()}).catch(function(e){toast("提交失败："+e.message);send.disabled=false})});' +
    'function loadStat(){fetch("/api/public/stats").then(function(r){return r.json()}).then(function(s){' +
    '$("#stat").textContent="已收到 "+s.uploads+" 份文件 · "+s.feedback+" 条反馈"+(s.keyOn?" · 有口令保护":"")}).catch(function(){})}' +
    'loadStat();' +
    '})();<\/script></body></html>';
}

/* 口令输入页：没有正确口令时看到的就是它 */
function buildGate(opts) {
  const o = opts || {};
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow"><title>需要访问口令</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
    'background:linear-gradient(180deg,#f7f9fc,#eef2f8);color:#26303c;padding:20px}' +
    '.box{width:100%;max-width:360px;background:#fff;border:1px solid #e3e8ef;border-radius:16px;padding:26px 22px;' +
    'box-shadow:0 8px 28px rgba(37,53,74,.08)}h1{font-size:18px;margin:0 0 6px}p{color:#64748b;font-size:13px;margin:0 0 16px}' +
    'input{width:100%;font:inherit;padding:11px 13px;border:1px solid #dde4ee;border-radius:10px;outline:none;background:#fbfcfe}' +
    'input:focus{border-color:#8db3e8;box-shadow:0 0 0 3px rgba(91,143,217,.13)}' +
    'button{width:100%;margin-top:12px;font:inherit;border:0;border-radius:10px;padding:11px;background:#5b8fd9;color:#fff;cursor:pointer}' +
    '.err{color:#d05a5a;font-size:12.5px;margin-top:10px;display:none}</style></head><body><div class="box">' +
    '<h1>需要访问口令</h1><p>请输入分享者提供的口令后继续。</p>' +
    '<form method="get" action="/"><input type="text" name="k" placeholder="访问口令" autofocus autocomplete="off">' +
    '<button type="submit">进入</button></form>' +
    (o.bad ? '<div class="err" style="display:block">口令不正确，请重新输入。</div>' : '') +
    '</div></body></html>';
}

module.exports = { buildPage, buildGate, esc };
