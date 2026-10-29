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
