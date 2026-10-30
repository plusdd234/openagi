/* 节点定义（架构改良 A）：一个节点 = 一次 registerNode
 *
 * 新增节点只需要在这个文件里追加一段 registerNode({...})，不需要再改
 * blueprint-core / desktop / blueprint-runtime / flow-validate / flow-gen。
 *
 * 字段说明见 node-registry.js 顶部注释。执行逻辑的 ctx 提供：
 *   n 节点 / input(引脚取值) / paramIn(参数取值) / setStatus(状态) / log(运行日志) / startedAt
 */

/* ============================ 输入 ============================ */

registerNode({
  type:'text', title:'文本 / 提示词', dot:'text', group:'输入', pure:true,
  desc:'固定文本、提示词或补充说明；参数节点，由下游按需读取',
  outputs:['text'],
  params:[ { key:'__content__', label:'内容', dataKey:'text', ctl:'textarea', ph:'文本内容', side:'out' } ],
  seed: () => ({ data:{ text:'' }, params:null }),
  run: async ({ n }) => { n.out.text = n.data.text || ''; }
});

registerNode({
  type:'numNode', title:'数值', dot:'logic', group:'输入', pure:true,
  desc:'输出整数 / 浮点，供数值参数引脚连线使用；参数节点，由下游按需读取',
  outputs:['int','float'],
  params:[
    { key:'float', label:'数值', dataKey:'value', ctl:'number', step:'any', default:0, side:'out' },
    { tip:'同一数值同时从两个引脚输出：整数引脚取整，浮点引脚保留小数' }
  ],
  seed: () => ({ data:{ value:0 }, params:null }),
  run: async ({ n }) => {
    const num = Number(n.data.value);
    const v = isFinite(num) ? num : 0;
    n.out.int = Math.trunc(v);
    n.out.float = v;
  }
});

registerNode({
  type:'boolNode', title:'布尔值', dot:'logic', group:'输入', pure:true,
  desc:'手动输出真 / 假；参数节点，由下游按需读取',
  outputs:['bool'],
  params:[ { key:'bool', label:'取值', ctl:'bool', default:true, side:'out' } ],
  seed: () => ({ data:{ bool:true }, params:null }),
  run: async ({ n }) => {
    // 旧流程存的是 data.value，保留兼容
    const raw = n.data.bool !== undefined ? n.data.bool : n.data.value;
    n.out.bool = raw !== false;
  }
});

registerNode({
  type:'imageIn', title:'图像输入', dot:'image', group:'输入', pure:true,
  desc:'载入一张图像；参数节点，由下游按需读取',
  outputs:['image'],
  params:[ { key:'__image__', ctl:'filePick' } ],
  seed: () => ({ data:{ image:'' }, params:null }),
  run: async ({ n }) => {
    if(!n.data.image) throw new Error('未选择图像');
    n.out.image = n.data.image;
  }
});

registerNode({
  type:'modelIn', title:'3D 模型输入', dot:'model', group:'输入', pure:true,
  desc:'导入 OBJ / GLB / STL 等模型；参数节点，由下游按需读取',
  outputs:['model'],
  params:[ { key:'__model__', ctl:'filePick' } ],
  seed: () => ({ data:{ model:'' }, params:null }),
  run: async ({ n }) => {
    if(!n.data.model) throw new Error('未导入 3D 模型');
    n.out.model = n.data.model;
  }
});

/* ============================ 分析任务 ============================ */

registerNode({
  type:'aiTask', title:'分析任务', dot:'text', group:'分析任务',
  desc:'按指令分析文本 / 图像，自定义输入输出引脚与超时。每次都真实调用模型，不跨运行复用上次结论',
  meta:{ cacheable:false },   // 分析任务不主动复用：输入图变了结论必须跟着变，复用反而掩盖差异
  execIn:true, execOut:['exec'],
  quiet:true,   // 自己会打一条带流式统计的完成日志，外壳不再重复打
  params:[
    { key:'instruction', ctl:'textarea', ph:'任务指令（例如：总结输入文本并列出风险点）' },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:0, max:3600, step:10, unit:'秒，0 表示不限时', default:TASK_TIMEOUT_DEFAULT },
    { key:'__taskPins__', ctl:'taskPins' }
  ],
  seed: () => ({ data:{
    instruction:'',
    timeout:TASK_TIMEOUT_DEFAULT,
    inputs:[seedPin('文本','string')],
    outputs:[seedPin('结果','string')]
  }, params:null }),
  pins: n => ({ in:(n.data.inputs||[]).map(p => ({ key:p.id, label:p.name, type:p.type })), out:(n.data.outputs||[]).map(p => ({ key:p.id, label:p.name, type:p.type })) }),
  /* 输入 / 输出引脚都不走左右列，全部由「输入引脚」「输出引脚」管理区渲染。
   * 输出曾经走右列，结果引脚飘在节点右上方（instruction 旁边），离它对应的
   * 「输出引脚」设置行隔了大半个节点，看起来像另一组无关的引脚。
   * 改成行内后，每个输出引脚就长在自己那一行的右边缘，和设置位置垂直对齐。 */
  render:{ in:false, out:false },
  run: async ({ n, input, paramIn, setStatus, log, startedAt }) => {
    const instruction = String((await paramIn('instruction')) || '').trim();
    const ins = n.data.inputs || [];
    const outs = n.data.outputs || [];
    const sections = [], images = [];
    let hasMaterial = false;
    for(const p of ins){
      const v = await input(p.id);
      if(v === undefined || v === null || v === '') continue;
      hasMaterial = true;
      if(p.type === 'image') images.push(v);
      else if(p.type === 'model') sections.push({ name:p.name || '模型', value:'已提供模型文件' });
      else sections.push({ name:p.name || '输入', value: typeof v === 'object' ? JSON.stringify(v) : String(v) });
    }
    if(!instruction && !hasMaterial) throw new Error('缺少任务指令或输入');
    const tSec = Number(await paramIn('timeout'));
    const limitMs = tSec > 0 ? Math.round(tSec * 1000) : 0;
    const live = log('分析任务：请求已发出，等待首段输出…', '', true);
    try{
      let rsn = '';
      n.out = await wfAiTask(instruction, sections, images, outs, (acc, piece, info) => {
        if(info && info.reasoning) rsn = info.reasoning;
        if(info && info.phase === 'thinking'){
          setStatus(n, '思考中 ' + rsn.length + ' 字', 'running');
          if(live) live.set('思考中 ' + rsn.length + ' 字 · …' + rsn.slice(-160));
          return;
        }
        setStatus(n, '生成中 ' + acc.length + ' 字', 'running');
        if(live) live.set('流式生成 ' + acc.length + ' 字 · …' + acc.slice(-200));
      }, limitMs);
      if(rsn) n.reasoning = rsn.slice(0, 4000);
    }catch(e){
      const stopped = !!(e && e._stopped);
      if(live) live.done(stopped ? '已手动停止' : ('分析任务失败 · ' + friendlyErr(e)), stopped ? 'warn' : 'error');
      if(e) e._bpLogged = true;
      throw e;
    }
    const first = outs.length ? n.out[outs[0].id] : '';
    if(live) live.done('分析任务完成 · ' + outs.length + ' 个输出 · ' + (Date.now() - startedAt) + 'ms · ' + bpPreview(first, 160), 'ok');
  },
  validate: (n, c) => {
    const out = [];
    if(!c.linked('instruction') && !String(n.data.instruction || '').trim()){
      out.push({ code:'W-REQ', message:'「分析任务」的指令未填写且未连线，运行时会退化成默认行为' });
    }
    if(!(n.data.inputs || []).length && !(n.data.outputs || []).length){
      out.push({ code:'W-DYNAMIC', message:'「分析任务」没有声明任何自定义输入 / 输出引脚' });
    }
    return out;
  },
  normalize: (n, raw, h) => {
    if(Array.isArray(raw.inputs)) n.data.inputs = h.normPins(raw.inputs, h.TASK_IN_TYPES, '输入');
    if(Array.isArray(raw.outputs)) n.data.outputs = h.normPins(raw.outputs, h.TASK_OUT_TYPES, '结果');
  }
});

/* ============================ 图像任务 ============================ */

registerNode({
  type:'imageGen', title:'图像生成', dot:'gen', group:'图像任务',
  desc:'文生图或图生图', execIn:true, execOut:['exec'],
  inputs:['prompt','image'], outputs:['image'],
  params:[ { key:'__prompt__', label:'prompt', dataKey:'prompt', ctl:'textarea', ph:'提示词（未连线时使用）' } ],
  seed: () => ({ data:{ prompt:'' }, params:null }),
  run: async ({ n, input }) => {
    const p = ((await input('prompt')) || n.data.prompt || '').trim();
    if(!p) throw new Error('缺少提示词');
    n.out.image = await wfImage(p, await input('image'));
  },
  validate: (n, c) => (c.linked('prompt') || String(n.data.prompt || '').trim()) ? [] : [{ code:'W-REQ', message:'「图像生成」缺少提示词（可连线或就地填写）' }]
});

registerNode({
  type:'imageCompress', title:'压缩图像', dot:'image', group:'图像任务',
  desc:'缩放并压缩图像，降低分析 / 生成请求的数据量', execIn:true, execOut:['exec'],
  inputs:['image'], outputs:['image'],
  params:[
    { key:'maxEdge', label:'最长边', ctl:'number', type:'int', min:64, max:4096, step:64, unit:'px', default:1024 },
    { key:'quality', label:'质量', ctl:'number', type:'int', min:10, max:100, step:5, unit:'%', default:80 },
    { tip:'等比缩小到最长边限制，并转成 JPEG 输出' }
  ],
  seed: () => ({ data:{ maxEdge:1024, quality:80 }, params:null }),
  run: async ({ n, input, paramIn }) => {
    const src = await input('image');
    if(!src) throw new Error('缺少图像输入');
    const edge = Math.max(64, Math.min(4096, Math.trunc(Number(await paramIn('maxEdge')) || 0) || 1024));
    const q = Math.max(10, Math.min(100, Math.trunc(Number(await paramIn('quality')) || 0) || 80)) / 100;
    n.out = await wfCompressImage(src, edge, q);
  },
  validate: (n, c) => c.linked('image') ? [] : [{ code:'W-REQ', message:'「压缩图像」缺少待压缩图像（可连线）' }]
});

registerNode({
  type:'imageSplit', title:'图像拆分', dot:'image', group:'图像任务',
  desc:'AI 按提示词把图中多个视图 / 对象分别拆分出来；每个视图输出一张图 + 一个「是否有」布尔，视图可动态增减',
  execIn:true, execOut:['exec'],
  inputs:['image','prompt'], outputs:['text'],
  params:[
    { key:'prompt', label:'提示词', ctl:'textarea', ph:'拆分要求（例如：把图中角色的各个视图分别拆出来，背景忽略）' },
    { key:'output', label:'输出形式', ctl:'select', default:'cutout', options:[['cutout','抠图（透明背景）'],['crop','矩形裁剪'],['mask','蒙版图']] },
    { key:'feather', label:'边缘羽化', ctl:'number', type:'int', min:0, max:32, step:1, unit:'px', default:2 },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:10, max:600, step:10, unit:'秒', default:120 },
    { key:'__views__', ctl:'viewPins' },
    { tip:'每个视图输出两张引脚：图像（拆分结果，找不到时为空）+ 布尔（图中是否有该视图）。点「+ 添加视图」或常用视图标签动态增减。' }
  ],
  seed: () => ({ data:{ prompt:'', output:'cutout', feather:2, timeout:120, views:[seedView('正视图'), seedView('背视图')] }, params:null }),
  pins: n => ({ out:(n.data.views || []).reduce((acc, v) => acc.concat([
    { key:v.id, label:v.name, type:'image' },
    { key:v.id + '__has', label:'是否有' + v.name, type:'bool' }
  ]), []) }),
  render:{ out:false },   // 视图引脚由视图区块连控件一起渲染
  run: async ({ n, input, paramIn, setStatus, log, startedAt }) => {
    const src = await input('image');
    if(!src) throw new Error('缺少图像输入');
    const prompt = String((await input('prompt')) || n.data.prompt || '').trim();
    if(!prompt) throw new Error('缺少提示词（描述要拆分出的视图 / 对象）');
    const views = n.data.views || [];
    if(!views.length) throw new Error('还没有添加任何视图输出（在节点里点「+ 添加视图」）');
    const output = String(await paramIn('output') || 'cutout');
    const feather = Math.max(0, Math.min(32, Math.trunc(Number(await paramIn('feather')) || 0)));
    const tSec = Math.max(10, Math.min(600, Math.trunc(Number(await paramIn('timeout')) || 0) || 120));
    const live = log('图像拆分：请求已发出，等待模型分析…', '', true);
    try{
      let rsn = '';
      n.out = await wfImageSplit(src, prompt, views, { output, feather, timeoutSec: tSec }, (acc, piece, info) => {
        if(info && info.reasoning) rsn = info.reasoning;
        if(info && info.phase === 'thinking'){
          setStatus(n, '思考中 ' + rsn.length + ' 字', 'running');
          if(live) live.set('思考中 ' + rsn.length + ' 字 · …' + rsn.slice(-160));
          return;
        }
        setStatus(n, '分析中 ' + acc.length + ' 字', 'running');
        if(live) live.set('模型分析中 ' + acc.length + ' 字 · …' + acc.slice(-200));
      });
      if(rsn) n.reasoning = rsn.slice(0, 4000);
    }catch(e){
      const stopped = !!(e && e._stopped);
      if(live) live.done(stopped ? '已手动停止' : ('图像拆分失败 · ' + friendlyErr(e)), stopped ? 'warn' : 'error');
      if(e) e._bpLogged = true;
      throw e;
    }
    const found = views.filter(v => n.out[v.id + '__has']).length;
    if(live) live.done('图像拆分完成 · ' + views.length + ' 个视图中找到 ' + found + ' 个 · '
      + (Date.now() - startedAt) + 'ms · ' + bpPreview(n.out.text, 160), 'ok');
  },
  validate: (n, c) => {
    const out = [];
    if(!(n.data.views || []).length) out.push({ code:'W-DYNAMIC', message:'「图像拆分」没有视图，不会输出任何拆分结果' });
    if(!c.linked('image') && !c.linked('prompt') && !String(n.data.prompt || '').trim()){
      out.push({ code:'W-REQ', message:'「图像拆分」缺少必需的图像与提示词（可连线或就地填写）' });
    }
    return out;
  },
  normalize: (n, raw, h) => {
    if(Array.isArray(raw.views)){
      n.data.views = raw.views.map((v, j) => {
        const o = (v && typeof v === 'object') ? v : {};
        return {
          id: (typeof o.id === 'string' && o.id) ? o.id : h.uid(),
          name: o.name != null && String(o.name).trim() ? String(o.name).trim() : '视图' + (j + 1),
          hint: o.hint ? String(o.hint) : ''
        };
      });
    }
  }
});

registerNode({
  type:'featureExtract', title:'特征提取', dot:'image', group:'图像任务',
  desc:'按「工作要求」让 AI 自行定位并命名图中的特征区域，逐个裁切放大拼成 3×3 网格图，并输出「左上为图1人物的发髻，…」式标注。复核不通过的格子会自动追加特征补齐；特征不写死；最多 3 张输入图，共 9 格',
  meta:{ cacheable:false },   // 同分析任务：输入图变了，定位与拼图必须重做
  execIn:true, execOut:['exec'],
  inputs:['image','image2','image3'], outputs:['image','text'],
  params:[
    { key:'prompt', label:'工作要求', ctl:'textarea', ph:'例：定位人物的头部位（发髻 / 眼睛 / 眉毛 / 耳朵）与身体部位（衣领 / 胸部 / 手部 / 腰带 / 鞋部），每个部位一个区域。留空则由 AI 挑最值得关注的 9 个细节区域' },
    { key:'subject', label:'主体', ctl:'text', ph:'标注里的主体词，默认「人物」' },
    { key:'cell', label:'单元尺寸', ctl:'select', default:512, options:[[256,'256px'],[384,'384px'],[512,'512px']] },
    { key:'margin', label:'外扩边距', ctl:'number', type:'int', min:0, max:100, step:5, unit:'%', default:30 },
    { key:'verify', label:'复核', ctl:'select', default:'on', options:[['on','开启 · 逐格检查（多一次 AI 调用）'],['off','关闭']] },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:10, max:600, step:10, unit:'秒', default:180 },
    { tip:'特征由 AI 按工作要求自行决定并命名，不写死清单；每张图先压缩送视觉模型定位，再回原图裁切放大，按行优先填进 3×3 网格，没凑满的格子留空。' },
    { tip:'复核：裁切完成后把每张小图再发给模型逐张判断「是否确实是名字所指的部位」，判否的格子剔除——定位偶尔框到背景或邻近部位，宁缺毋滥。剔掉的格子会自动追加定位新特征来补齐（避开已试过的名字，最多补 2 轮），补齐成功标注会自动重排。' }
  ],
  seed: () => ({ data:{
    prompt:'', subject:'人物', cell:512, margin:30, verify:'on', timeout:180
  }, params:null }),
  run: async ({ n, input, paramIn, setStatus, log }) => {
    const srcs = [];
    for(const k of ['image','image2','image3']){
      const v = await input(k);
      if(v) srcs.push(v);
    }
    if(!srcs.length) throw new Error('缺少图像输入');
    const r = await wfFeatureExtract(srcs, {
      requirement: String(await paramIn('prompt') || ''),
      subject: String(await paramIn('subject') || '').trim() || '人物',
      cell: Number(await paramIn('cell')) || 512,
      margin: Number(await paramIn('margin')),
      verify: (String(await paramIn('verify') || 'on') !== 'off'),
      timeoutSec: Math.max(10, Math.min(600, Math.trunc(Number(await paramIn('timeout')) || 0)) || 180),
      onPhase: t => setStatus(n, t, 'running'),
      onNote: m => log('· ' + m, 'warn')
    });
    n.out.image = r.image;
    n.out.text = r.text;
    log('· ' + r.notes, 'warn');
  },
  validate: (n, c) => c.linked('image') ? [] : [{ code:'W-REQ', message:'「特征提取」缺少图像输入（可连线）' }]
});

registerNode({
  type:'textureSvg', title:'SVG 贴图绘制', dot:'tex', group:'3D 任务',
  desc:'把 AI 生成的 SVG（按 UV 坐标定位）光栅化成贴图，用于给 3D 模型上色。矢量无限清晰，不依赖参考图——AI 能精确说「在胸口画金五角星」；想要画到指定部位，先由「模型转四视图」+ UV pass 提供 UV 布局图。本节点只产出贴图，配到模型上由「贴图导出资产」节点完成',
  execIn:true, execOut:['exec'],
  inputs:['text'], outputs:['image'],
  params:[
    { key:'svg', label:'SVG（兜底）', ctl:'textarea', ph:'直接粘贴 SVG；连了「文本」引脚则优先用引脚。viewBox 设为 0 0 size size，按纹理像素坐标落笔' },
    { key:'size', label:'贴图尺寸', ctl:'select', default:1024, options:[[512,'512'],[1024,'1024（推荐）'],[2048,'2048']] },
    { key:'bg', label:'底色', ctl:'text', ph:'贴图底色，如 #222；留空透明' },
    { tip:'AI 用 SVG 原语（rect / circle / path / text…）直接画贴图，比投影照片更可控、更清晰。把「模型转四视图」的 UV 布局图给它，它就知道每面在哪。' }
  ],
  seed: () => ({ data:{ svg:'', size:1024, bg:'' }, params:null }),
  run: async ({ n, input, paramIn, setStatus, log }) => {
    let svg = await input('text');
    if(!svg) svg = String(await paramIn('svg') || '');
    if(!svg) throw new Error('缺少 SVG 输入');
    const size = Number(await paramIn('size')) || 1024;
    const bg = String(await paramIn('bg') || '').trim();
    if(!window.SvgTex) throw new Error('svgtex.js 未加载');
    const canvas = await window.SvgTex.rasterize(window.SvgTex.doc(svg, size, { bg }), size);
    n.out.image = canvas.toDataURL('image/png');
    log('· SVG 已光栅化为 ' + size + '×' + size + ' 贴图', 'warn');
  },
  validate: (n, c) => (c.linked('text') || (n.data && n.data.svg)) ? [] : [{ code:'W-REQ', message:'「SVG 贴图绘制」缺少 SVG 输入（文本引脚或参数）' }]
});

registerNode({
  type:'tripoImg', title:'Tripo 网页生图', dot:'gen', group:'图像任务',
  desc:'通过 Tripo 网页账号文生图 / 图生图，最多可传 3 张参考图。异步节点：开始出口在任务启动时触发，完成出口在拿到图片后才触发',
  asyncExec:true, execIn:true, execOut:['exec','done'],
  inputs:['prompt','image','image2','image3'], outputs:['image','text'],
  params:[
    { key:'prompt', label:'prompt', ctl:'textarea', ph:'提示词（未连线时使用）' },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:10, max:900, step:10, unit:'秒', default:240 },
    { key:'mode', label:'模式', ctl:'select', default:'auto', options:[['auto','自动（有参考图走图生图）'],['text','文生图'],['image','图生图']] },
    { key:'ratio', label:'比例', ctl:'select', default:'auto', options:[['auto','自动'],['1:1','1:1'],['16:9','16:9'],['9:16','9:16'],['4:3','4:3'],['3:4','3:4']] },
    { tip:'使用 Tripo 网页账号；运行时先自动切到文生图 / 图生图面板，参考图引脚可接图像。' },
    { tip:'最多可接 3 张参考图：图像 / 参考图2 / 参考图3，按引脚顺序一起上传；只接一张时与原来一致。' }
  ],
  seed: () => ({ data:{ prompt:'', timeout:240, ratio:'auto', mode:'auto' }, params:null }),
  run: async ({ n, input, paramIn }) => {
    const p = ((await input('prompt')) || n.data.prompt || '').trim();
    if(!p) throw new Error('缺少提示词');
    const refs = [];
    for(const k of ['image','image2','image3']){
      const v = await input(k);
      if(v) refs.push(v);
    }
    const timeoutSec = Math.max(10, Math.min(900, Math.trunc(Number(await paramIn('timeout')) || 0) || 240));
    const r = await wfTripoWebImage(p, refs, {
      timeoutSec,
      ratio: await paramIn('ratio'),
      mode: await paramIn('mode'),
      signal: runSignal()
    });
    n.out.image = r.url;
    const refNote = refs.length > 1 ? (' · ' + refs.length + ' 张参考图') : '';
    n.out.text = (r.file ? ('已保存：' + r.file) : r.url) + refNote;
  },
  validate: (n, c) => (c.linked('prompt') || String(n.data.prompt || '').trim()) ? [] : [{ code:'W-REQ', message:'「Tripo 网页生图」缺少提示词（可连线或就地填写）' }]
});

/* ============================ 3D 任务 ============================ */

registerNode({
  type:'model3d', title:'3D 生成', dot:'model', group:'3D 任务',
  desc:'图生 3D 模型（Tripo API 或网页账号）。异步节点：开始出口在任务启动时触发，完成出口在拿到模型后才触发',
  asyncExec:true, execIn:true, execOut:['exec','done'],
  inputs:['image'], outputs:['model'],
  params:[ { tip:'使用设置中的 Tripo 版本，输出 GLB 模型' } ],
  seed: () => ({ data:{}, params:null }),
  run: async ({ n, input }) => {
    const img = await input('image');
    if(!img) throw new Error('缺少图像输入');
    /* 取用顺序（2026-10-29 解耦后）：网页助手已连接 → 走网页账号；
       未连接（或状态过期）→ 现场再探一次，仍不通 → 走 API Key 兜底。 */
    let web = isTripoWeb();
    if(!web && typeof refreshTripoWebStatus === 'function'){
      try{ web = !!(await refreshTripoWebStatus(true)); }catch(_){}
    }
    if(web){
      n.out.model = (await wfTripoWebModel(img, { timeoutSec: 300, signal: runSignal() })).url;
    } else {
      n.out.model = await wf3D(img);
    }
  },
  validate: (n, c) => c.linked('image') ? [] : [{ code:'W-REQ', message:'「3D 生成」缺少参考图（可连线）' }]
});

registerNode({
  type:'modelViews', title:'3D 模型转四视图', dot:'model', group:'3D 任务',
  desc:'把 3D 模型渲染为 2×2 四视图（前/后/左/右），可直接喂给生图 AI', execIn:true, execOut:['exec'],
  inputs:['model'], outputs:['image','text'],
  params: PARAM_PARAMS([
    { key:'画布尺寸', ctl:'select', default:2048, options:[[2048,'2048 (2K)'],[4096,'4096 (4K)']] },
    { key:'间距', ctl:'number', min:0, max:256, step:8, default:0 },
    { key:'线宽', ctl:'number', min:0.4, max:6, step:0.1, default:1.4 },
    { key:'线色', ctl:'color', default:'#2b2b2b' },
    { key:'填充色', ctl:'color', default:'#ffffff' },
    { key:'背景色', ctl:'color', default:'#ffffff' },
    { key:'背景不透明度', ctl:'number', min:0, max:1, step:0.05, default:1 },
    { key:'模式', ctl:'select', default:'line', options:[['line','线框'],['solid','实体']] }
  ]),
  seed: () => ({ data:{ params:[
    seedParam('画布尺寸','int',2048), seedParam('间距','int',0), seedParam('线宽','float',1.4),
    seedParam('线色','string','#2b2b2b'), seedParam('填充色','string','#ffffff'), seedParam('背景色','string','#ffffff'),
    seedParam('背景不透明度','float',1), seedParam('模式','string','line')
  ] }, params:null }),
  pins: n => ({ in:(n.data.params || []).map(p => ({ key:p.id, label:p.name, type:p.type })) }),
  render:{ in:false },   // 参数引脚由各自的参数控件渲染
  run: async ({ n, input }) => {
    const model = await input('model');
    if(!model) throw new Error('缺少 3D 模型输入');
    if(!window.Model3D) throw new Error('3D 模块未加载');
    if(!Model3D.ready()) throw new Error('3D 组件未就绪（缺少 three.js）');
    const P = n.data.params || [];
    const get = async (name, fallback) => {
      const p = P.find(x => x.name === name);
      if(!p) return fallback;
      const linked = await input(p.id);
      if(linked !== undefined && linked !== null && linked !== '') return linked;
      return (p.value === '' || p.value === null || p.value === undefined) ? fallback : p.value;
    };
    const sizeRaw = Number(await get('画布尺寸', 2048));
    const opts = {
      size: sizeRaw === 4096 ? 4096 : 2048,
      gap: Number(await get('间距', 0)) || 0,
      lineWidth: Number(await get('线宽', 1.4)) || 1.4,
      lineColor: String(await get('线色', '#2b2b2b')),
      fillColor: String(await get('填充色', '#ffffff')),
      bgColor: String(await get('背景色', '#ffffff')),
      bgOpacity: Math.max(0, Math.min(1, Number(await get('背景不透明度', 1)))),
      mode: String(await get('模式', 'line')) === 'solid' ? 'solid' : 'line'
    };
    n.out.image = await Model3D.quadViews(model, opts);
    n.out.text = '四视图已生成 · ' + opts.size + '×' + opts.size + ' · ' + (opts.mode === 'solid' ? '实体' : '线框');
  },
  validate: (n, c) => c.linked('model') ? [] : [{ code:'W-REQ', message:'「3D 模型转四视图」缺少 3D 模型（可连线）' }],
  normalize: (n, raw, h) => {
    if(Array.isArray(raw.params)){
      (n.data.params || []).forEach(p => {
        const hit = raw.params.find(x => x && (x.name === p.name || x.id === p.id));
        if(!hit) return;
        if(hit.value !== undefined) p.value = coerceByType(p.type, hit.value);
        if(typeof hit.id === 'string' && hit.id) p.id = hit.id;   // 保留引用 id，避免连线断开
      });
    }
  }
});

registerNode({
  type:'tripoModel', title:'Tripo 网页生成模型', dot:'model', group:'3D 任务',
  desc:'通过 Tripo 网页账号图生 3D 模型（单张参考图），可选智能网格 P2.0、拓扑 / 面数、数量、导出格式。异步节点：完成出口在拿到模型后才触发',
  asyncExec:true, execIn:true, execOut:['exec','done'],
  inputs:['image'], outputs:['model','text'],
  params:[
    { tip:'通过 Tripo 网页账号生成 3D 模型；参考图引脚接图像（未连线需页面里已上传）' },
    { key:'mode', label:'模式', ctl:'select', default:'smart', options:[['smart','智能网格'],['hd','高精度模型'],['','页面默认']] },
    { key:'version', label:'网格版本', ctl:'select', default:'P2.0', options:[['P2.0','P2.0'],['P1.0','P1.0'],['','页面默认']] },
    { key:'topology', label:'拓扑', ctl:'select', default:'', options:[['','页面默认'],['quad','四边面'],['tri','三角面']] },
    { key:'faceCount', label:'面数', ctl:'number', type:'int', min:0, max:25000, step:100, unit:'面（500–25000，0=默认）', default:0 },
    { key:'count', label:'数量', ctl:'select', type:'int', default:1, options:[[1,'1'],[2,'2'],[4,'4']] },
    { key:'format', label:'格式', ctl:'select', default:'', options:[['','页面默认'],['glb','GLB'],['obj','OBJ'],['fbx','FBX'],['stl','STL'],['usdz','USDZ']] },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:30, max:1800, step:30, unit:'秒', default:420 },
    { tip:'生成走网页自动化，会消耗网页账号积分；存在风控风险。' }
  ],
  seed: () => ({ data:{ mode:'smart', version:'P2.0', topology:'', faceCount:0, count:1, format:'', timeout:420 }, params:null }),
  run: async ({ n, input, paramIn }) => {
    const img = await input('image');
    if(!img) throw new Error('缺少参考图输入');
    const r = await wfTripoWebModel(img, {
      mode: await paramIn('mode'), version: await paramIn('version'), topology: await paramIn('topology'),
      faceCount: await paramIn('faceCount'), count: await paramIn('count'), format: await paramIn('format'),
      timeoutSec: await paramIn('timeout'), signal: runSignal()
    });
    n.out.model = r.url;
    n.out.text = '网页生成模型完成 · ' + (r.file || '模型已下载') + (r.size ? ' · ' + (r.size / 1024).toFixed(0) + ' KB' : '');
  },
  validate: (n, c) => c.linked('image') ? [] : [{ code:'W-REQ', message:'「Tripo 网页生成模型」缺少参考图（可连线）' }]
});

registerNode({
  type:'tripoModelMulti', title:'Tripo 网页多视图生成', dot:'model', group:'3D 任务',
  desc:'通过 Tripo 网页账号多视图生 3D 模型（前 / 左 / 右 / 后 四张参考图），可选智能网格 P2.0、拓扑 / 面数、数量、导出格式。异步节点：完成出口在拿到模型后才触发',
  asyncExec:true, execIn:true, execOut:['exec','done'],
  inputs:['front','left','right','back'], outputs:['model','text'],
  params:[
    { tip:'前 / 左 / 右 / 后 四个引脚各接一张参考图（至少接一个）；页面会自动切到多视图上传模式' },
    { key:'mode', label:'模式', ctl:'select', default:'smart', options:[['smart','智能网格'],['hd','高精度模型'],['','页面默认']] },
    { key:'version', label:'网格版本', ctl:'select', default:'P2.0', options:[['P2.0','P2.0'],['P1.0','P1.0'],['','页面默认']] },
    { key:'topology', label:'拓扑', ctl:'select', default:'', options:[['','页面默认'],['quad','四边面'],['tri','三角面']] },
    { key:'faceCount', label:'面数', ctl:'number', type:'int', min:0, max:25000, step:100, unit:'面（500–25000，0=默认）', default:0 },
    { key:'count', label:'数量', ctl:'select', type:'int', default:1, options:[[1,'1'],[2,'2'],[4,'4']] },
    { key:'format', label:'格式', ctl:'select', default:'', options:[['','页面默认'],['glb','GLB'],['obj','OBJ'],['fbx','FBX'],['stl','STL'],['usdz','USDZ']] },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:30, max:1800, step:30, unit:'秒', default:600 },
    { tip:'生成走网页自动化，会消耗网页账号积分；存在风控风险。' }
  ],
  seed: () => ({ data:{ mode:'smart', version:'P2.0', topology:'', faceCount:0, count:1, format:'', timeout:600 }, params:null }),
  run: async ({ n, input, paramIn }) => {
    const views = {
      front: await input('front'), left: await input('left'),
      right: await input('right'), back: await input('back')
    };
    if(!views.front && !views.left && !views.right && !views.back) throw new Error('至少需要一张参考图（前 / 左 / 右 / 后任一）');
    const r = await wfTripoWebModel(views.front || '', {
      multi: true, views,
      mode: await paramIn('mode'), version: await paramIn('version'),
      topology: await paramIn('topology'), faceCount: await paramIn('faceCount'),
      count: await paramIn('count'), format: await paramIn('format'),
      timeoutSec: await paramIn('timeout'), signal: runSignal()
    });
    n.out.model = r.url;
    const used = ['front','left','right','back'].filter(k => views[k]).length;
    n.out.text = '多视图生成完成 · ' + used + ' 张参考图 · ' + (r.file || '模型已下载') + (r.size ? ' · ' + (r.size / 1024).toFixed(0) + ' KB' : '');
  },
  validate: (n, c) => ['front','left','right','back'].some(k => c.linked(k)) ? [] : [{ code:'W-REQ', message:'「Tripo 网页多视图生成」至少需要连接一张参考图（前 / 左 / 右 / 后）' }]
});

/* ============================ 模型贴图（经验固化 2026-10-30） ============================ */

registerNode({
  type:'modelIslands', title:'模型 UV 岛分析', dot:'tex', group:'3D 任务',
  desc:'把模型按共享 UV 边切成「UV 岛」，输出岛色块图（可带编号）与岛元数据 JSON（质心 / 包围盒 / UV 面积 / UV 包围盒）。写上色规则前先跑这个——部位判定全靠元数据，一个大岛跨多个部位时质心会误导，先看图再定规则',
  execIn:true, execOut:['exec'],
  inputs:['model'], outputs:['image','text'],
  params:[
    { key:'size', label:'贴图尺寸', ctl:'select', default:1024, options:[[512,'512'],[1024,'1024（推荐）'],[2048,'2048']] },
    { key:'labels', label:'岛编号标注', ctl:'select', default:'on', options:[['on','图上标编号（可寻址）'],['off','只出色块']] },
    { key:'topN', label:'元数据条数', ctl:'number', type:'int', min:10, max:200, step:10, default:60, unit:'条（按 UV 面积降序）' },
    { tip:'文本输出的元数据直接喂给「分析任务」，让它对照参考图写出「模型区域上色」的规则 JSON；uvBBox 是归一化 UV 坐标，可用来写细节规则或 SVG 落笔位置。' }
  ],
  seed: () => ({ data:{ size:1024, labels:'on', topN:60 }, params:null }),
  run: async ({ n, input, paramIn, log }) => {
    const model = await input('model');
    if(!model) throw new Error('缺少 3D 模型输入');
    if(!window.ModelTex) throw new Error('modeltex.js 未加载');
    const size = Number(await paramIn('size')) || 1024;
    const labels = String(await paramIn('labels') || 'on') !== 'off';
    const topN = Math.max(10, Math.min(200, Math.trunc(Number(await paramIn('topN')) || 0)) || 60);
    const a = await ModelTex.analyze(model);
    const atlas = ModelTex.islandAtlas(a, size, { labels });
    n.out.image = ModelTex.previewGrid(a, atlas, {
      compare:false, paintedLabel:'岛图', angles:[0, 35, 180],
      texLabel:'岛色块图（数字 = 岛编号）', cell:400
    });
    n.out.text = JSON.stringify({
      islands: a.islands.length,
      triangles: a.parts.reduce((s, p) => s + p.tri, 0),
      bounds: {
        min: [a.box.min.x, a.box.min.y, a.box.min.z].map(v => +v.toFixed(2)),
        max: [a.box.max.x, a.box.max.y, a.box.max.z].map(v => +v.toFixed(2))
      },
      top: a.islands.slice(0, topN).map(o => ({
        id: o.id, tris: o.tris.length, area: +o.area.toFixed(4),
        centroid: o.centroid.map(v => +v.toFixed(2)), bbox: o.bbox.map(v => +v.toFixed(2)),
        uvBBox: o.uvBBox.map(v => +v.toFixed(4))
      }))
    });
    log('· 共 ' + a.islands.length + ' 个 UV 岛 · 元数据输出前 ' + topN + ' 条' + (labels ? ' · 图上已标编号' : ''), 'warn');
  },
  validate: (n, c) => c.linked('model') ? [] : [{ code:'W-REQ', message:'「模型 UV 岛分析」缺少 3D 模型（可连线）' }]
});

registerNode({
  type:'modelColorize', title:'模型区域上色', dot:'tex', group:'3D 任务',
  desc:'按「区域规则」给模型上色：规则是 JSON 数组（部位名 + 颜色 + 位置条件），按顺序首个命中生效，未命中用底色。判定粒度可选「整岛」或「逐三角形」（逐三角可解决大 UV 岛横跨多部位）；还可叠加「细节规则」逐 texel 落笔（宝石、蕾丝、金边这类 3D 条件细节）。规则可用「模型 UV 岛分析」的元数据让 AI 生成——AI 出规则（创作期），确定性上色重放（执行期）。输出上色前后对比图 + UV 贴图',
  execIn:true, execOut:['exec'],
  inputs:['model','text'], outputs:['image','texture','text'],
  params:[
    { key:'matchBy', label:'判定粒度', ctl:'select', default:'island', options:[['island','整岛（默认）'],['triangle','逐三角形（跨部位大岛更准）']] },
    { key:'rules', label:'区域规则（兜底）', ctl:'textarea', ph:'JSON 数组；连了「文本」引脚则优先用引脚。例：[{"name":"头发","color":"#8fd2e6","yMin":91}]' },
    { key:'detail', label:'细节规则（兜底）', ctl:'textarea', ph:'JSON 数组，逐 texel 覆盖底色。例：[{"name":"宝石","color":"#b53a30","yMin":77.6,"yMax":80.4,"zMin":28}]' },
    { key:'base', label:'底色', ctl:'text', ph:'未命中规则的岛用这个颜色，默认 #f4f7fb' },
    { key:'size', label:'贴图尺寸', ctl:'select', default:1024, options:[[512,'512'],[1024,'1024（推荐）'],[2048,'2048']] },
    { key:'compare', label:'对比图', ctl:'select', default:'on', options:[['on','上排原始 / 下排上色'],['off','只出上色']] },
    { tip:'条件字段（都是可选项，模型的自身坐标单位）：yMin/yMax 质心高度 · xAbsMin/xAbsMax 质心 |X|（左右对称部位用）· zMin/zMax 质心深度 · areaMin/areaMax UV 面积 · trisMin 三角数下限 · ring:true 抓扁环（光环/腰带圈，Y 厚<4% 高且 XZ 宽>5% 高）。逐三角形模式下面积/扁环/三角数条件仍按所属岛判定，位置条件按三角形判定——粒度一变条件语义也变，切到逐三角后要按新边界重调规则，别直接套整岛预设。' },
    { tip:'细节规则同样吃上面的位置字段，但按每个 texel 的 3D 坐标判定，可加 wave:{axis:"x"|"z", freq, amp} 让上边界起伏（蕾丝/花边）。文本引脚也可给对象 { rules:[…], detail:[…], base:"#…", matchBy:"triangle" }。' },
    { tip:'默认规则按蓝发少女模型调好（Y 0–100）：光环金 / 脚手肤色 / 裤袜淡紫 / 袖口腰封黑 / 脸肤 / 头发青蓝 / 宝石红 / 胸饰金 / 裙摆藏青。换模型先跑「模型 UV 岛分析」再改。' }
  ],
  seed: () => ({ data:{ matchBy:'island', detail:'', rules: JSON.stringify([
    { name:'光环', color:'#e6c45c', ring:true, yMax:22 },
    { name:'脚', color:'#f3d8c6', yMax:6 },
    { name:'裤袜', color:'#b6a4d6', yMax:34, areaMin:0.02 },
    { name:'手', color:'#f3d8c6', xAbsMin:35 },
    { name:'袖口', color:'#1c2130', xAbsMin:30 },
    { name:'袖子', color:'#f4f7fb', xAbsMin:16, xAbsMax:30, yMin:58 },
    { name:'脸', color:'#f3d8c6', yMin:91, xAbsMax:2.6, zMin:24 },
    { name:'头发', color:'#8fd2e6', yMin:91 },
    { name:'宝石', color:'#b53a30', yMin:83, yMax:90, zMin:25, xAbsMax:4 },
    { name:'胸饰', color:'#e6c45c', yMin:77, yMax:91, zMin:21, xAbsMax:13 },
    { name:'裙摆', color:'#2c3a63', yMax:66 },
    { name:'腰封', color:'#1c2130', yMax:70 }
  ]), base:'#f4f7fb', size:1024, compare:'on' }, params:null }),
  run: async ({ n, input, paramIn, log }) => {
    const model = await input('model');
    if(!model) throw new Error('缺少 3D 模型输入');
    if(!window.ModelTex) throw new Error('modeltex.js 未加载');
    let rulesSrc = await input('text');
    if(rulesSrc === undefined || rulesSrc === null || String(rulesSrc).trim() === ''){
      rulesSrc = await paramIn('rules');
    }
    const base = String(await paramIn('base') || '').trim() || '#f4f7fb';
    const size = Number(await paramIn('size')) || 1024;
    const compare = String(await paramIn('compare') || 'on') !== 'off';
    let matchBy = String(await paramIn('matchBy') || 'island') === 'triangle' ? 'triangle' : 'island';
    let detail = [];
    const dtxt = String(await paramIn('detail') || '').trim();
    if(dtxt){
      try { detail = JSON.parse(dtxt); } catch(e){ throw new Error('细节规则不是合法 JSON：' + e.message); }
      if(!Array.isArray(detail)) throw new Error('细节规则需要是数组');
    }
    let rules = null;
    const txt = String(rulesSrc || '').trim();
    if(txt){
      let j;
      try { j = JSON.parse(txt); } catch(e){ throw new Error('区域规则不是合法 JSON：' + e.message); }
      rules = Array.isArray(j) ? j : (Array.isArray(j.rules) ? j.rules : null);
      if(!rules) throw new Error('区域规则需要是数组，或 { rules:[…], base:"#…", detail:[…], matchBy:"…" } 对象');
      rules.forEach((r, i) => { if(!r || !r.color) throw new Error('第 ' + (i + 1) + ' 条规则缺少 color'); });
      if(!Array.isArray(j)){
        if(j.base) base = String(j.base);
        if(Array.isArray(j.detail) && !dtxt) detail = j.detail;
        if(j.matchBy === 'triangle') matchBy = 'triangle';
      }
    }
    detail.forEach((r, i) => { if(!r || !r.color) throw new Error('第 ' + (i + 1) + ' 条细节规则缺少 color'); });
    const a = await ModelTex.analyze(model);
    const painted = ModelTex.paint(a, rules, base, size, { matchBy, detail });
    n.out.texture = painted.canvas.toDataURL('image/png');
    n.out.image = ModelTex.previewGrid(a, painted.canvas, {
      compare, cell:400, angles:[0, 35, 180], texLabel:'UV 贴图 ' + size + '×' + size
    });
    n.out.text = JSON.stringify({
      islands: a.islands.length, matchBy,
      regions: painted.counts, detail: painted.detail ? painted.detail.counts : {}, base
    });
    const reg = Object.keys(painted.counts).map(k => k + '×' + painted.counts[k]).join(' · ');
    const det = painted.detail ? Object.keys(painted.detail.counts).map(k => k + '×' + painted.detail.counts[k]).join(' · ') : '';
    log('· ' + (rules ? rules.length + ' 条规则' : '无规则（整模底色）') + ' · ' + (matchBy === 'triangle' ? '逐三角' : '整岛') +
      ' · ' + reg + (det ? ' · 细节 ' + det : ''), 'warn');
  },
  validate: (n, c) => {
    const out = [];
    if(!c.linked('model')) out.push({ code:'W-REQ', message:'「模型区域上色」缺少 3D 模型（可连线）' });
    if(!c.linked('text') && !String((n.data && n.data.rules) || '').trim()){
      out.push({ code:'W-REQ', message:'「模型区域上色」没有规则（文本引脚或规则参数至少有一个，否则整模只剩底色）' });
    }
    return out;
  }
});

registerNode({
  type:'modelTextureSet', title:'贴图导出资产', dot:'tex', group:'3D 任务',
  desc:'把贴图配到模型上，导出可直接加载的 OBJ + MTL + PNG 三件套（同目录放置即可在任何查看器 / 引擎加载）。OBJ 文本由网格实时写出，OBJ / GLB / glTF 输入通吃；「模型」引脚输出带贴图引用的 OBJ，下游按模型渲染外形',
  execIn:true, execOut:['exec'],
  inputs:['model','texture'], outputs:['obj','mtl','texture','text'],
  params:[
    { key:'download', label:'自动下载', ctl:'select', default:'off', options:[['off','关闭'],['on','下载三件套到本地']] },
    { tip:'大模型（数万顶点）导出的 OBJ 会有几十 MB，三件套走「模型 / 材质 / 贴图」三个引脚接「结果输出」或存盘。' }
  ],
  seed: () => ({ data:{ download:'off' }, params:null }),
  run: async ({ n, input, paramIn, log }) => {
    const model = await input('model');
    const tex = await input('texture');
    if(!model) throw new Error('缺少 3D 模型输入');
    if(!tex) throw new Error('缺少贴图输入（接「模型区域上色」或「SVG 贴图绘制」的贴图）');
    if(!window.ModelTex) throw new Error('modeltex.js 未加载');
    const a = await ModelTex.analyze(model);
    const t = ModelTex.objTrio(a);
    n.out.obj = ModelTex.toDataURL(t.objText);
    n.out.mtl = ModelTex.toDataURL(t.mtlText);
    n.out.texture = tex;
    const kb = Math.round(t.objText.length / 1024);
    n.out.text = '三件套已生成 · body.obj ' + kb + ' KB + body.mtl + texture.png（MTL 引用 texture.png，三个文件同目录放置）· '
      + a.parts.length + ' 个网格 · ' + a.islands.length + ' 岛';
    log('· OBJ 文本 ' + kb + ' KB · 贴图来自上游', 'warn');
    if(String(await paramIn('download') || 'off') === 'on'){
      ModelTex.download('body.obj', t.objText, 'text/plain');
      ModelTex.download('body.mtl', t.mtlText, 'text/plain');
      ModelTex.download('texture.png', tex);
      log('· 已触发浏览器下载 3 个文件', 'warn');
    }
  },
  validate: (n, c) => (c.linked('model') && c.linked('texture'))
    ? [] : [{ code:'W-REQ', message:'「贴图导出资产」需要模型与贴图各连一条（贴图来自上色 / SVG 绘制节点）' }]
});

registerNode({
  type:'modelStage', title:'模型取景摆拍', dot:'tex', group:'3D 任务',
  desc:'把模型按「模型笔刷上色」的相机公式渲染一张正面取景图，并输出视口元数据（view 尺寸 / 相机参数 / 笔画 JSON 格式说明）。给分析任务用：取景图 + 元数据喂给模型，模型看着图出笔画坐标——坐标与笔刷视口像素级对齐。底图引脚可接「模型区域上色」的贴图，让 AI 看着已铺大色的模型出修边笔画',
  execIn:true, execOut:['exec'],
  inputs:['model','texture'], outputs:['image','text'],
  params:[
    { key:'view', label:'视口边长', ctl:'number', type:'int', min:256, max:1024, step:16, default:720, unit:'px' },
    { key:'az', label:'方位角', ctl:'number', type:'float', min:-360, max:360, step:5, default:0, unit:'°' },
    { key:'el', label:'仰角', ctl:'number', type:'float', min:-89, max:89, step:1, default:4, unit:'°' },
    { tip:'输出的 text 是 JSON：{view,fov,camera:{az,el,dist},center,radius,height,islands(top120 岛元数据),screen(岛id→像素映射),hint}。图上黄字是岛编号，screen 让 AI 零投影计算直接拿到部位像素坐标；hint 里带笔画格式说明，分析任务的提示词让它「原样遵守 hint」即可。' }
  ],
  seed: () => ({ data:{ view:720, az:0, el:4 }, params:null }),
  validate: (n, c) => c.linked('model') ? [] : [{ code:'W-REQ', message:'「模型取景摆拍」需要连一个 3D 模型' }],
  run: async ({ n, input, paramIn, log }) => {
    const model = await input('model');
    if(!model) throw new Error('缺少 3D 模型输入');
    if(!window.ModelTex || !window.TexBrush) throw new Error('modeltex.js / texbrush.js 未加载');
    const a = await ModelTex.analyze(model);
    const baseSrc = await input('texture');
    const base = baseSrc ? await TexBrush.loadImage(baseSrc) : null;
    const r = await TexBrush.stage({
      a, base, size: 1024,
      view: Number(await paramIn('view')) || 720,
      az: Number(await paramIn('az')) || 0,
      el: await paramIn('el') === '' || await paramIn('el') == null ? 4 : Number(await paramIn('el'))
    });
    n.out.image = r.image;
    n.out.text = JSON.stringify(r.meta);
    log('· 取景 ' + r.meta.view + '×' + r.meta.view + ' · az ' + r.meta.camera.az + '° el ' + r.meta.camera.el + '° · dist ' + r.meta.camera.dist, 'warn');
  }
});

registerNode({
  type:'modelPaint', title:'模型笔刷上色', dot:'tex', group:'3D 任务',
  desc:'交互式 3D 笔刷：视口里直接在模型表面画，收笔即烘进 UV 贴图（屏空间草稿层 + 投影烘焙，自动遮挡剔除、跨 UV 岛）。运行时弹「笔刷上色」视口：左键画 · 右键转视角 · 滚轮缩放 · Ctrl+Z 撤销 · 擦除只擦笔画层。也支持「笔画回放」：把笔画 JSON 数组接到文本引脚（或填参数）即可确定性重放——AI 看渲染图后出 [{"cam":{"az":0,"el":0},"pts":[[x,y],…],"color":"#e0533f","radius":24,"hardness":0.7}]，坐标是视口像素（左上原点，view 大小会随统计输出）。底图可接「模型区域上色」的贴图：先铺大色、笔刷修细节。产出贴图接「贴图导出资产」',
  execIn:true, execOut:['exec'],
  inputs:['model','texture','text'], outputs:['texture','image','text'],
  params:[
    { key:'mode', label:'运行方式', ctl:'select', default:'interactive', options:[['interactive','弹笔刷视口（人工画）'],['strokes','笔画回放（确定性）']] },
    { key:'strokes', label:'笔画 JSON（兜底）', ctl:'textarea', ph:'连了「文本」引脚则优先用引脚。例：[{"cam":{"az":0,"el":0},"pts":[[360,300],[364,300]],"color":"#e0533f","radius":24}]' },
    { key:'color', label:'默认颜色', ctl:'text', ph:'#e0533f' },
    { key:'radius', label:'默认半径', ctl:'number', type:'int', min:2, max:120, step:1, default:24, unit:'px' },
    { key:'hardness', label:'默认硬度', ctl:'number', type:'float', min:0, max:1, step:0.05, default:0.7 },
    { key:'size', label:'贴图尺寸', ctl:'select', default:1024, options:[[512,'512'],[1024,'1024（推荐）'],[2048,'2048']] },
    { tip:'视口是正方形，笔画坐标按「统计文本里输出的 view 大小」换算；az=0 正对模型正面、el 向上为正（缺省 4，与「模型取景摆拍」一致）、dist 缺省自动取。底图引脚可接「模型区域上色」或「SVG 贴图绘制」的贴图，笔刷在其上叠加。' }
  ],
  seed: () => ({ data:{ mode:'interactive', strokes:'', color:'#e0533f', radius:24, hardness:0.7, size:1024 }, params:null }),
  run: async ({ n, input, paramIn, log }) => {
    const model = await input('model');
    if(!model) throw new Error('缺少 3D 模型输入');
    if(!window.ModelTex) throw new Error('modeltex.js 未加载');
    if(!window.TexBrush) throw new Error('texbrush.js 未加载');
    const size = Number(await paramIn('size')) || 1024;
    const a = await ModelTex.analyze(model);
    const baseSrc = await input('texture');
    const base = baseSrc ? await TexBrush.loadImage(baseSrc) : null;

    let strokeSrc = await input('text');
    if(strokeSrc === undefined || strokeSrc === null || String(strokeSrc).trim() === ''){
      strokeSrc = await paramIn('strokes');
    }
    const mode = String(await paramIn('mode') || 'interactive');
    const stxt = String(strokeSrc || '').trim();

    if(mode === 'strokes' || stxt){
      if(!stxt) throw new Error('笔画回放模式需要笔画 JSON（文本引脚或参数）');
      let list;
      try { list = JSON.parse(stxt); } catch(e){ throw new Error('笔画 JSON 不合法：' + e.message); }
      if(!Array.isArray(list)) throw new Error('笔画需要是数组');
      const host = document.createElement('div');   // 离屏挂载：渲染器不进文档也能跑
      const ctl = TexBrush.mount(host, {
        a, size, view: 720,
        base,
        baseColor: '#f4f7fb',
        color: await paramIn('color'),
        radius: await paramIn('radius'),
        hardness: await paramIn('hardness')
      });
      let stats;
      try {
        stats = await ctl.applyStrokes(list);
      } catch (e) {
        ctl.dispose();
        throw e;
      }
      n.out.texture = ctl.exportPNG();
      n.out.image = ModelTex.previewGrid(a, ctl.viewCanvas, {
        compare:false, paintedLabel:'笔刷上色', angles:[0, 35, 180],
        texLabel:'UV 贴图 ' + size + '×' + size, cell:400
      });
      n.out.text = JSON.stringify({ strokes: stats.strokes, view: stats.view, textureSize: stats.size });
      ctl.dispose();
      log('· 回放 ' + stats.strokes + ' 笔 · 视口 ' + stats.view[0] + '×' + stats.view[1] + ' · 贴图 ' + size, 'warn');
    } else {
      if(!window.TexBrush.openInteractive || !document.getElementById('paintBackdrop')){
        throw new Error('当前环境没有笔刷视口（交互模式只在应用内可用）——接笔画 JSON 走确定性回放，或把「运行方式」切到笔画回放');
      }
      const r = await TexBrush.openInteractive({
        a, size, view: 720, base,
        color: await paramIn('color'),
        radius: await paramIn('radius'),
        hardness: await paramIn('hardness')
      });
      n.out.texture = r.texture;
      n.out.image = ModelTex.previewGrid(a, await TexBrush.loadImage(r.texture), {
        compare:false, paintedLabel:'笔刷上色', angles:[0, 35, 180],
        texLabel:'UV 贴图 ' + size + '×' + size, cell:400
      });
      n.out.text = JSON.stringify({ strokes: r.strokes, view: [720, 720], textureSize: size });
      log('· 人工绘制 ' + r.strokes + ' 笔 · 贴图已交回流程', 'warn');
    }
  },
  validate: (n, c) => {
    const out = [];
    if(!c.linked('model')) out.push({ code:'W-REQ', message:'「模型笔刷上色」缺少 3D 模型（可连线）' });
    if(!c.linked('text') && !String((n.data && n.data.strokes) || '').trim() && String((n.data && n.data.mode) || 'interactive') === 'strokes'){
      out.push({ code:'W-REQ', message:'「模型笔刷上色」笔画回放模式需要笔画 JSON（文本引脚或参数）' });
    }
    return out;
  }
});

/* ============================ 逻辑 ============================ */

registerNode({
  type:'branch', title:'条件分支', dot:'logic', group:'逻辑',
  desc:'按布尔值走真 / 假执行线', execIn:true, execOut:['true','false'],
  inputs:['bool'],
  params:[ { tip:'按布尔引脚的值决定走「真」或「假」执行线' } ],
  seed: () => ({ data:{}, params:null }),
  run: async ({ n, input }) => {
    const v = await input('bool');
    if(v === undefined) throw new Error('条件引脚未连接布尔值');
    n.out.bool = toBool(v);
  }
});

registerNode({
  type:'smartBranch', title:'智能分支', dot:'logic', group:'逻辑', execIn:true, execOutFrom:'branches',
  desc:'输入引脚可任意定义（名称与类型），让语言模型据此挑一条执行线；出口可动态增减',
  outputs:['text'],
  params:[
    { key:'instruction', label:'选择依据', ctl:'textarea', ph:'让 AI 据此挑一条出口（例如：按画面内容与描述判断该走哪条路）' },
    { key:'timeout', label:'超时', ctl:'number', type:'int', min:10, max:600, step:10, unit:'秒', default:120 },
    { key:'__inputs__', ctl:'inPins' },
    { key:'__branches__', ctl:'branchPins' },
    { tip:'左侧引脚可自定义名称与类型（整数/浮点/字符串/布尔/图像/模型），全部会随「选择依据」一起送给模型。每个出口一条执行线，AI 只会走其中一条；标了「兜底」的出口在模型选不出时生效。' }
  ],
  seed: () => ({ data:{ instruction:'', timeout:120, inputs:[seedPin('文本','string'), seedPin('图像','image')], branches:[seedBranch('分支 A'), seedBranch('分支 B')] }, params:null }),
  pins: n => ({ in:(n.data.inputs || []).map(p => ({ key:p.id, label:p.name, type:p.type })) }),
  run: async ({ n, input, paramIn, setStatus, log, startedAt }) => {
    const branches = n.data.branches || [];
    if(!branches.length) throw new Error('还没有添加任何出口（在节点里点「+ 添加出口」）');
    const instruction = String((await paramIn('instruction')) || '').trim();
    const pinList = n.data.inputs || [];
    if(!pinList.length) throw new Error('还没有添加任何输入引脚（在节点里点「+ 添加输入」）');
    const sections = [], images = [];
    for(const p of pinList){
      const v = await input(p.id);
      if(v === undefined || v === null || v === '') continue;
      if(p.type === 'image'){ images.push({ name: p.name || '图像', url: v }); continue; }
      if(p.type === 'model'){ sections.push({ name: p.name || '模型', value: '已提供 3D 模型' }); continue; }
      sections.push({ name: p.name || '输入', value: String(v) });
    }
    if(!instruction && !sections.length && !images.length){
      throw new Error('缺少判断依据：至少连一个输入引脚，或填写「选择依据」');
    }
    const tSec = Math.max(10, Math.min(600, Math.trunc(Number(await paramIn('timeout')) || 0) || 120));
    const live = log('智能分支：请求已发出，等待模型选择…', '', true);
    let picked, note = '';
    try{
      let rsn = '';
      const r = await wfAiBranch(instruction, branches, { sections, images }, tSec, (acc, piece, info) => {
        if(info && info.reasoning) rsn = info.reasoning;
        if(info && info.phase === 'thinking'){
          setStatus(n, '思考中 ' + rsn.length + ' 字', 'running');
          if(live) live.set('思考中 ' + rsn.length + ' 字 · …' + rsn.slice(-160));
          return;
        }
        setStatus(n, '判断中 ' + acc.length + ' 字', 'running');
        if(live) live.set('模型判断中 ' + acc.length + ' 字 · …' + acc.slice(-160));
      });
      if(rsn) n.reasoning = rsn.slice(0, 4000);
      picked = r.matched ? branches.find(b => b.id === r.id) : null;
      if(!picked){
        // 模型没给出可识别出口：走标了「兜底」的那条，否则走第一条
        picked = branches.find(b => b.fallback) || branches[0];
        note = r.name ? '（模型给的「' + r.name + '」不在出口清单中，已回退）' : '（模型未给出可识别出口，已回退）';
        log('· 智能分支未匹配到出口，回退到「' + picked.name + '」', 'warn');
      }
      n.out.choice = picked.id;
      n.out.text = '已选择「' + picked.name + '」' + (r.reason ? ' · ' + r.reason : '') + note;
    }catch(e){
      const stopped = !!(e && e._stopped);
      if(live) live.done(stopped ? '已手动停止' : ('智能分支失败 · ' + friendlyErr(e)), stopped ? 'warn' : 'error');
      if(e) e._bpLogged = true;
      throw e;
    }
    if(live) live.done('智能分支选择「' + picked.name + '」· ' + (Date.now() - startedAt) + 'ms' + note, 'ok');
  },
  validate: (n, c) => {
    const out = [];
    if(!c.linked('instruction') && !String(n.data.instruction || '').trim()){
      out.push({ code:'W-REQ', message:'「智能分支」的选择依据未填写且未连线' });
    }
    if(!(n.data.branches || []).length) out.push({ code:'W-DYNAMIC', message:'「智能分支」没有出口，无法继续执行流' });
    if(!(n.data.inputs || []).length) out.push({ code:'W-DYNAMIC', message:'「智能分支」没有输入引脚，模型只会按「选择依据」判断' });
    return out;
  },
  normalize: (n, raw, h) => {
    if(Array.isArray(raw.inputs)) n.data.inputs = h.normPins(raw.inputs, h.TASK_IN_TYPES, '输入');
    if(Array.isArray(raw.branches)){
      n.data.branches = raw.branches.map((b, j) => {
        const o = (b && typeof b === 'object') ? b : {};
        return {
          id: (typeof o.id === 'string' && o.id) ? o.id : h.uid(),
          name: o.name != null && String(o.name).trim() ? String(o.name).trim() : '出口' + (j + 1),
          hint: o.hint ? String(o.hint) : '',
          fallback: o.fallback === true
        };
      });
    }
  }
});

/* ============================ 流程 ============================ */

registerNode({
  type:'start', title:'任务开始', dot:'start', group:'流程', execOut:['exec'],
  desc:'定义工作流输入参数',
  params:[ { key:'__params__', ctl:'paramList' } ],
  seed: () => ({ data:{}, params:[] }),
  pins: n => ({ out:(n.params || []).map(p => ({ key:p.id, label:p.name, type:p.type, kind:'param' })) }),
  run: async ({ n }) => {
    (n.params || []).forEach(p => { n.out[p.id] = paramValue(p); });
  },
  validate: (n) => (n.params || []).length ? [] : [{ code:'W-NO-INPUT', message:'「任务开始」没有输入参数，流程将没有可传入的数据' }]
});

registerNode({
  type:'end', title:'任务结束', dot:'end', group:'流程', execIn:true,
  desc:'收集工作流输出参数',
  params:[ { key:'__params__', ctl:'paramList' }, { tip:'运行结束时汇总各引脚收到的值' } ],
  seed: () => ({ data:{}, params:[] }),
  pins: n => ({ in:(n.params || []).map(p => ({ key:p.id, label:p.name, type:p.type, kind:'endParam' })) }),
  run: async ({ n, input }) => {
    const values = [];
    for(const p of (n.params || [])){
      const v = await input(p.id);
      if(v !== undefined) p.value = v;
      n.out[p.id] = v;
      values.push({ id:p.id, name:p.name, type:p.type, value:v });
    }
    n.out.values = values;
    if(bp) bp.lastRun = { at: Date.now(), values };
  }
});

/* ============================ 输出 ============================ */

registerNode({
  type:'result', title:'结果输出', dot:'out', group:'输出', execIn:true,
  desc:'汇总文本、图像与模型结果',
  inputs:['text','image','model'],
  params:[ { tip:'连接文本、图像或模型，运行后在此汇总结果' } ],
  seed: () => ({ data:{}, params:null }),
  run: async ({ n, input }) => {
    const text = await input('text');
    const image = await input('image');
    const model = await input('model');
    if(text !== undefined) n.out.text = text;
    if(image !== undefined) n.out.image = image;
    if(model !== undefined) n.out.model = model;
    if(!n.out.text && !n.out.image && !n.out.model) throw new Error('没有连接任何结果');
  }
});

/* ============================ 其他 ============================ */

registerNode({
  type:'varGet', title:'获取变量', dot:'var', pure:true,
  desc:'读取变量当前值',
  pins: (n, vars) => {
    const v = (vars || []).find(x => x.id === (n.data || {}).varId);
    return v ? { out:[{ key:v.id, label:v.name, type:v.type }] } : {};
  },
  run: async ({ n }) => {
    const v = varOf(n.data.varId);
    if(!v) throw new Error('变量已删除');
    n.out[v.id] = paramValue(v);
  },
  normalize: (n, raw, h) => {
    const vid = raw.varId != null ? String(raw.varId) : '';
    if(vid) h.addVar(vid);
    n.data.varId = vid;
  }
});

registerNode({
  type:'varSet', title:'设置变量', dot:'var', execIn:true, execOut:['exec'],
  desc:'把输入值写入变量',
  params:[ { tip:'运行到此处时，把「值」引脚的数据写入该变量' } ],
  pins: (n, vars) => {
    const v = (vars || []).find(x => x.id === (n.data || {}).varId);
    return v ? { in:[{ key:v.id, label:v.name, type:v.type }] } : {};
  },
  run: async ({ n, input }) => {
    const v = varOf(n.data.varId);
    if(!v) throw new Error('变量已删除');
    const val = await input(v.id);
    if(val === undefined) throw new Error('未连接要写入的值');
    v.value = coerceVar(v, val);
    if(v.type !== 'model' && v.type !== 'image') v.fileName = '';
    n.out[v.id] = v.value;
    renderNodes();
  },
  validate: (n) => (n.data && n.data.varId) ? [] : [{ code:'W-REQ', message:'「设置变量」没有选择变量' }],
  normalize: (n, raw, h) => {
    const vid = raw.varId != null ? String(raw.varId) : '';
    if(vid) h.addVar(vid);
    n.data.varId = vid;
  }
});
