/* 模型商店目录（阶段 E）：一份「点一下就能装」的模型清单。
 *
 * 为什么要有这份静态清单：
 *   Ollama 官方 registry 没有「热门模型」接口，ComfyUI 那边更没有——
 *   让用户自己记住 `qwen2.5:7b`、自己找 .safetensors 的下载地址，等于把门槛留在原地。
 *   这里把经过实测的条目写死：名称、体积、显存门槛、以及**生图模型的推荐采样参数**
 *   （SDXL-Turbo 用默认的 20 步 / cfg 7 只会出一团糊，必须按模型给参数）。
 *
 * 体积均为实测值（Ollama registry manifest 里各层之和 / HuggingFace x-linked-size），
 * 不是估算——商店里写「约 4 GB」而实际下 8 GB，是最伤信任的那种错误。
 * 下载地址优先 hf-mirror.com（国内直连可用），HuggingFace 官方作为第二源由下载器择优。
 */
const MODEL_CATALOG = [
  /* ---------------- 对话 / 语言模型（Ollama） ---------------- */
  {
    id: 'qwen3:8b', kind: 'llm', engine: 'ollama', name: 'Qwen3 8B', org: '阿里通义',
    params: '8B', sizeGB: 4.9, vramGB: 6, ramGB: 8, ollama: 'qwen3:8b',
    tags: ['中文', '通用', '推荐'],
    desc: '中英双语与推理兼顾，8 GB 显存这一档最稳的通用选择。'
  },
  {
    id: 'qwen2.5:7b', kind: 'llm', engine: 'ollama', name: 'Qwen2.5 7B', org: '阿里通义',
    params: '7B', sizeGB: 4.4, vramGB: 5.5, ramGB: 8, ollama: 'qwen2.5:7b',
    tags: ['中文', '通用', '成熟'],
    desc: '生态最成熟的一档，指令跟随稳定，插件与工具调用兼容性好。'
  },
  {
    id: 'qwen2.5:3b', kind: 'llm', engine: 'ollama', name: 'Qwen2.5 3B', org: '阿里通义',
    params: '3B', sizeGB: 1.8, vramGB: 3, ramGB: 6, ollama: 'qwen2.5:3b',
    tags: ['轻量', '低配'],
    desc: '只有 1.8 GB，核显 / 8 GB 内存的机器也能跑，适合先验证链路是否通。'
  },
  {
    id: 'deepseek-r1:7b', kind: 'llm', engine: 'ollama', name: 'DeepSeek-R1 7B', org: '深度求索',
    params: '7B', sizeGB: 4.4, vramGB: 5.5, ramGB: 8, ollama: 'deepseek-r1:7b',
    tags: ['中文', '推理'],
    desc: '会先输出思考过程再给结论，写方案、拆步骤时明显更细。'
  },
  {
    id: 'qwen2.5-coder:7b', kind: 'llm', engine: 'ollama', name: 'Qwen2.5 Coder 7B', org: '阿里通义',
    params: '7B', sizeGB: 4.4, vramGB: 5.5, ramGB: 8, ollama: 'qwen2.5-coder:7b',
    tags: ['代码'],
    desc: '专攻代码补全与解释，同一体积下写代码比通用模型准。'
  },
  {
    id: 'llama3.1:8b', kind: 'llm', engine: 'ollama', name: 'Llama 3.1 8B', org: 'Meta',
    params: '8B', sizeGB: 4.6, vramGB: 6, ramGB: 8, ollama: 'llama3.1:8b',
    tags: ['英文', '通用'],
    desc: '英文写作与问答的基准模型，英文任务表现稳定。'
  },
  {
    id: 'gemma3:4b', kind: 'llm', engine: 'ollama', name: 'Gemma 3 4B', org: 'Google',
    params: '4B', sizeGB: 3.1, vramGB: 4, ramGB: 6, ollama: 'gemma3:4b',
    tags: ['轻量', '多语'],
    desc: '3.1 GB、门槛低，多语言表现不错，适合日常问答。'
  },
  {
    id: 'qwen2.5:14b', kind: 'llm', engine: 'ollama', name: 'Qwen2.5 14B', org: '阿里通义',
    params: '14B', sizeGB: 8.4, vramGB: 10, ramGB: 16, ollama: 'qwen2.5:14b',
    tags: ['中文', '高质量'],
    desc: '明显更强的中文长文与复杂指令能力，需要 10 GB 以上显存（或 16 GB 内存走 CPU）。'
  },
  /* ---------------- 识图 / 多模态（Ollama，kind 单列一类） ----------------
   * 为什么单列 kind：用户来商店找「识图模型」时，把一个 5 GB 的视觉模型
   * 混在「对话模型」列表里，等于让他自己去猜哪个能读图。单列一类才能一眼选。
   *
   * 体积是 registry.ollama.ai 各层之和（与拉取时进度条的总量一致）；
   * 显存门槛比同体积纯文本模型高 1-2 GB——视觉编码器常驻，且高分辨率图
   * 会切出大量 image token 撑大 KV cache，按文本模型的门槛配会当场 OOM 降级。 */
  {
    id: 'qwen3-vl:2b', kind: 'vision', engine: 'ollama', name: 'Qwen3-VL 2B', org: '阿里通义',
    params: '2B', sizeGB: 1.89, vramGB: 3, ramGB: 6, ollama: 'qwen3-vl:2b', vision: true,
    tags: ['看图', '轻量', '低配', '推荐'],
    desc: '1.9 GB，核显和 8 GB 内存的机器也能跑。识图明显强于同体积老模型，适合先验证链路、或做批量粗筛。'
  },
  {
    id: 'qwen3-vl:4b', kind: 'vision', engine: 'ollama', name: 'Qwen3-VL 4B', org: '阿里通义',
    params: '4B', sizeGB: 3.34, vramGB: 5, ramGB: 8, ollama: 'qwen3-vl:4b', vision: true,
    tags: ['看图', '中英', '性价比'],
    desc: '同档位里识图最划算的一只：中英混排、截图、图表都能读。6 GB 显存可整体进显存，4 GB 卡会卸载少量层到 CPU。'
  },
  {
    id: 'qwen3-vl:8b', kind: 'vision', engine: 'ollama', name: 'Qwen3-VL 8B', org: '阿里通义',
    params: '8B', sizeGB: 6.19, vramGB: 8, ramGB: 10, ollama: 'qwen3-vl:8b', vision: true,
    tags: ['看图', '高质量', 'OCR', '推荐'],
    desc: '当前开源识图第一梯队：小字 OCR、表格还原、界面元素定位都稳。8 GB 显存最佳，16 GB 内存走 CPU 也能用（慢 3-5 倍）。'
  },
  {
    id: 'qwen3-vl:30b', kind: 'vision', engine: 'ollama', name: 'Qwen3-VL 30B（MoE）', org: '阿里通义',
    params: '30B-A3B', sizeGB: 19.6, vramGB: 22, ramGB: 24, ollama: 'qwen3-vl:30b', vision: true,
    tags: ['看图', '最强', '大显存'],
    desc: '专家混合，每 token 只激活 3B，比同体积稠密模型快得多。需要 24 GB 级显存，笔记本独显基本跑不动——列出来是因为它确实是目前本地识图的上限。'
  },
  {
    id: 'minicpm-v:8b', kind: 'vision', engine: 'ollama', name: 'MiniCPM-V 8B', org: '面壁智能',
    params: '8B', sizeGB: 5.47, vramGB: 7, ramGB: 9, ollama: 'minicpm-v:8b', vision: true,
    tags: ['看图', 'OCR', '中文文档'],
    desc: '专攻中文文档与截图：密集小字、票据、表格还原比通用视觉模型更准，适合从图片里抄文字。'
  },
  {
    id: 'gemma3:12b', kind: 'vision', engine: 'ollama', name: 'Gemma 3 12B', org: 'Google',
    params: '12B', sizeGB: 8.16, vramGB: 10, ramGB: 16, ollama: 'gemma3:12b', vision: true,
    tags: ['看图', '长上下文', '多语'],
    desc: '原生多模态但不是纯识图模型：文本能力与看图兼顾，长上下文强。适合「平时聊天、偶尔甩张图」的用法。'
  },
  {
    id: 'llava:7b', kind: 'vision', engine: 'ollama', name: 'LLaVA 7B（上一代）', org: 'LLaVA',
    params: '7B', sizeGB: 4.73, vramGB: 5, ramGB: 8, ollama: 'llava:7b', vision: true,
    tags: ['看图', '旧版'],
    desc: '2023 年的方案，识图细节和中文 OCR 都明显落后于 Qwen3-VL。留着是因为很多人已经装了——要更好的识别效果请换上面任一只。'
  },

  /* ---------------- 语音合成（系统语音，零下载） ----------------
   * 本项目的 TTS 一律走浏览器 / 系统的 speechSynthesis，不引第三方引擎，
   * 所以这一类的「模型」= 系统已安装的语音包。voice 是用来在
   * speechSynthesis.getVoices() 里认出对应音色的匹配规则；匹配不到时
   * 商店显示「系统未安装」，并提示去 Windows 语音设置里补装，而不是给一个
   * 永远下不完的假进度条。sizeGB / vramGB 为 0 是事实，不是占位值。 */
  {
    id: 'tts-xiaoxiao', kind: 'tts', engine: 'system', name: '晓晓 · 中文女声', org: 'Microsoft',
    params: 'Neural', sizeGB: 0, vramGB: 0, ramGB: 0, lang: 'zh-CN', voice: /xiaoxiao|晓晓/i,
    sample: '你好，我是晓晓。需要我帮你朗读这段文字吗？',
    tags: ['中文', '女声', '自然', '推荐'],
    desc: '微软神经网络音色，语调自然、停顿接近真人，适合长文朗读与数字人对话。随系统语音包提供，无需下载权重。'
  },
  {
    id: 'tts-yunxi', kind: 'tts', engine: 'system', name: '云希 · 中文男声', org: 'Microsoft',
    params: 'Neural', sizeGB: 0, vramGB: 0, ramGB: 0, lang: 'zh-CN', voice: /yunxi|云希|yunye|云野/i,
    sample: '你好，我是云希。接下来由我为你播报。',
    tags: ['中文', '男声', '自然'],
    desc: '偏年轻的男声，新闻播报与教程旁白都合适。与晓晓同属系统神经网络语音，切换即可试听。'
  },
  {
    id: 'tts-huihui', kind: 'tts', engine: 'system', name: '慧慧 · 中文女声', org: 'Microsoft',
    params: 'Desktop', sizeGB: 0, vramGB: 0, ramGB: 0, lang: 'zh-CN', voice: /huihui|慧慧/i,
    sample: '你好，我是慧慧。很高兴为你朗读。',
    tags: ['中文', '女声', '兼容'],
    desc: 'Windows 经典中文语音，几乎每台中文系统都有。音质不如神经网络音色，但断网、离线场景最稳。'
  },
  {
    id: 'tts-yaoyao', kind: 'tts', engine: 'system', name: '瑶瑶 · 中文女声', org: 'Microsoft',
    params: 'Desktop', sizeGB: 0, vramGB: 0, ramGB: 0, lang: 'zh-CN', voice: /yaoyao|瑶瑶/i,
    sample: '你好，我是瑶瑶。今天想听点什么？',
    tags: ['中文', '女声', '经典'],
    desc: '另一只经典中文女声，语速偏慢、吐字清楚，适合有声书与提示播报。'
  },
  {
    id: 'tts-hsiaochen', kind: 'tts', engine: 'system', name: '曉臻 · 繁体女声', org: 'Microsoft',
    params: 'Neural', sizeGB: 0, vramGB: 0, ramGB: 0, lang: 'zh-TW', voice: /hsiaochen|曉臻|晓臻/i,
    sample: '你好，我是曉臻。很高興為你朗讀。',
    tags: ['繁体', '女声', '台湾'],
    desc: '台湾普通话女声，读繁体文本时用词与发音更自然。系统未安装时可在语言设置中添加。'
  },
  {
    id: 'tts-aria', kind: 'tts', engine: 'system', name: 'Aria · English', org: 'Microsoft',
    params: 'Neural', sizeGB: 0, vramGB: 0, ramGB: 0, lang: 'en-US', voice: /aria/i,
    sample: 'Hi, I am Aria. I can read English text with a natural intonation.',
    tags: ['英文', '女声', '自然'],
    desc: '英文神经网络女声，适合英文文档朗读与双语对话。'
  },
  {
    id: 'tts-jenny', kind: 'tts', engine: 'system', name: 'Jenny · English', org: 'Microsoft',
    params: 'Neural', sizeGB: 0, vramGB: 0, ramGB: 0, lang: 'en-US', voice: /jenny|珍妮/i,
    sample: 'Hello, I am Jenny. Let me read this passage for you.',
    tags: ['英文', '女声', '对话'],
    desc: '英文对话型女声，语气轻松，适合数字人日常闲聊。'
  },

  /* ---------------- 高级本地语音（Piper ONNX，需要下载） ----------------
   * 和上面的系统语音不是一回事：这里是真的要下权重（.onnx + .onnx.json），
   * 下完由本地引擎桥调用 piper.exe 在 CPU 上合成，断网可用、也不依赖系统语音包。
   * 体积是 HF 上 Content-Length 的实测值（不是估算）；engine:'piper' 让商店层
   * 走「下载 / 卸载」而不是「选系统音色」。 */
  {
    id: 'piper-zh-huayan-medium', kind: 'tts', engine: 'piper', name: '华言 · 中文女声（Piper）',
    org: 'Piper / Rhasspy', params: 'ONNX · CPU', sizeGB: 0.06, vramGB: 0, ramGB: 4,
    lang: 'zh-CN', voiceFile: 'zh_CN-huayan-medium.onnx', voiceJson: 'zh_CN-huayan-medium.onnx.json',
    sample: '你好，我是华言。这是本地神经网络语音，断网也能朗读。',
    tags: ['中文', '女声', '离线', '推荐'],
    desc: 'Piper 中文神经网络音色，约 60 MB，纯 CPU 推理。断网、离线都能用，不受系统语音包限制；适合长文朗读与数字人。',
    urls: [
      'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx',
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx'
    ],
    jsonUrls: [
      'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json',
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json'
    ]
  },
  {
    id: 'piper-zh-huayan-xlow', kind: 'tts', engine: 'piper', name: '华言轻量 · 中文女声（Piper）',
    org: 'Piper / Rhasspy', params: 'ONNX · CPU', sizeGB: 0.02, vramGB: 0, ramGB: 2,
    lang: 'zh-CN', voiceFile: 'zh_CN-huayan-x_low.onnx', voiceJson: 'zh_CN-huayan-x_low.onnx.json',
    sample: '你好，我是华言的轻量版。体积小、速度更快，低配机器也能流畅朗读。',
    tags: ['中文', '女声', '离线', '低配'],
    desc: 'Piper 轻量中文音色，仅约 20 MB，合成速度最快。音质略逊于 medium，适合低配机器、提示播报与批量朗读。',
    urls: [
      'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx',
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx'
    ],
    jsonUrls: [
      'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx.json',
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx.json'
    ]
  },
  {
    id: 'piper-en-lessac-high', kind: 'tts', engine: 'piper', name: 'Lessac · English（Piper High）',
    org: 'Piper / Rhasspy', params: 'ONNX · CPU', sizeGB: 0.106, vramGB: 0, ramGB: 4,
    lang: 'en-US', voiceFile: 'en_US-lessac-high.onnx', voiceJson: 'en_US-lessac-high.onnx.json',
    sample: 'Hello, I am Lessac. This is a high quality local neural voice, running fully offline.',
    tags: ['英文', '女声', '高质量', '离线'],
    desc: 'Piper 英文高质量女声，约 109 MB。发音清晰、连读自然，适合英文文档朗读与双语播报；CPU 即可实时合成。',
    urls: [
      'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high/en_US-lessac-high.onnx',
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high/en_US-lessac-high.onnx'
    ],
    jsonUrls: [
      'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high/en_US-lessac-high.onnx.json',
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high/en_US-lessac-high.onnx.json'
    ]
  },
  {
    id: 'piper-en-ryan-high', kind: 'tts', engine: 'piper', name: 'Ryan · English（Piper High）',
    org: 'Piper / Rhasspy', params: 'ONNX · CPU', sizeGB: 0.112, vramGB: 0, ramGB: 4,
    lang: 'en-US', voiceFile: 'en_US-ryan-high.onnx', voiceJson: 'en_US-ryan-high.onnx.json',
    sample: 'Hi, I am Ryan. I can read English text with a natural local voice.',
    tags: ['英文', '男声', '高质量', '离线'],
    desc: 'Piper 英文高质量男声，约 115 MB。语气沉稳，适合旁白与教程；与 Lessac 搭配可覆盖英文男女声。',
    urls: [
      'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx',
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx'
    ],
    jsonUrls: [
      'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json',
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json'
    ]
  },

  /* ---------------- 超自然语音（Kokoro-82M int8，需要下载） ----------------
   * 和 Piper 的区别：Kokoro 是同一份 126 MB 模型 + 一张声纹表（voices.bin），
   * 不同音色只是 --sid 不同，所以「装一次，所有 Kokoro 音色都能用」。
   * 引擎是 sherpa-onnx 的单文件 exe（26 MB），与模型分开下载、共享。
   * sizeGB 写的是首次启用要下的大致总量（引擎 26 + 模型 126 ≈ 160 MB），
   * 卡片上会额外标注「共享」，避免用户以为每只音色都要重下 160 MB。 */
  {
    id: 'kokoro-zh-xiaoxiao', kind: 'tts', engine: 'kokoro', sid: 47,
    name: '晓晓 · 超自然中文女声（Kokoro）', org: 'Kokoro / sherpa-onnx',
    params: '82M · int8', sizeGB: 0.16, vramGB: 0, ramGB: 4, lang: 'zh-CN', shared: 'kokoro',
    sample: '你好，我是晓晓。这是接近真人的本地神经网络语音，断网也能朗读。',
    tags: ['中文', '女声', '超自然', '推荐'],
    desc: 'Kokoro-82M 是目前开源里最接近真人的一档：语调起伏、停顿和换气感明显强于 Piper。int8 量化后纯 CPU 推理，适合数字人对话与长文朗读；共享模型下载一次，所有 Kokoro 音色通用。'
  },
  {
    id: 'kokoro-zh-xiaoyi', kind: 'tts', engine: 'kokoro', sid: 48,
    name: '晓伊 · 超自然中文女声（Kokoro）', org: 'Kokoro / sherpa-onnx',
    params: '82M · int8', sizeGB: 0.16, vramGB: 0, ramGB: 4, lang: 'zh-CN', shared: 'kokoro',
    sample: '你好，我是晓伊。很高兴用这么自然的声音和你聊天。',
    tags: ['中文', '女声', '超自然'],
    desc: '与晓晓同一模型的不同声纹：音色更轻、更年轻，适合陪伴型数字人与轻松对话。'
  },
  {
    id: 'kokoro-zh-yunxi', kind: 'tts', engine: 'kokoro', sid: 50,
    name: '云希 · 超自然中文男声（Kokoro）', org: 'Kokoro / sherpa-onnx',
    params: '82M · int8', sizeGB: 0.16, vramGB: 0, ramGB: 4, lang: 'zh-CN', shared: 'kokoro',
    sample: '你好，我是云希。接下来由我为你播报。',
    tags: ['中文', '男声', '超自然', '推荐'],
    desc: '沉稳的男声，新闻播报与教程旁白的语气自然，长句不会出现机械的平均停顿。'
  },
  {
    id: 'kokoro-zh-yunyang', kind: 'tts', engine: 'kokoro', sid: 52,
    name: '云扬 · 超自然中文男声（Kokoro）', org: 'Kokoro / sherpa-onnx',
    params: '82M · int8', sizeGB: 0.16, vramGB: 0, ramGB: 4, lang: 'zh-CN', shared: 'kokoro',
    sample: '你好，我是云扬。需要我帮你把这段文字读出来吗？',
    tags: ['中文', '男声', '超自然'],
    desc: '偏明亮的男声，语气更接近日常对话，适合客服播报与数字人闲聊。'
  },
  {
    id: 'kokoro-en-heart', kind: 'tts', engine: 'kokoro', sid: 3,
    name: 'Heart · 超自然 English（Kokoro）', org: 'Kokoro / sherpa-onnx',
    params: '82M · int8', sizeGB: 0.16, vramGB: 0, ramGB: 4, lang: 'en-US', shared: 'kokoro',
    sample: 'Hi, I am Heart. This is a natural local neural voice that works fully offline.',
    tags: ['英文', '女声', '超自然', '推荐'],
    desc: 'Kokoro 最受欢迎的英文女声，连读、重音和句尾语调都很接近真人录音。'
  },
  {
    id: 'kokoro-en-michael', kind: 'tts', engine: 'kokoro', sid: 16,
    name: 'Michael · 超自然 English（Kokoro）', org: 'Kokoro / sherpa-onnx',
    params: '82M · int8', sizeGB: 0.16, vramGB: 0, ramGB: 4, lang: 'en-US', shared: 'kokoro',
    sample: 'Hello, I am Michael. Let me read this passage for you with a natural voice.',
    tags: ['英文', '男声', '超自然'],
    desc: '英文男声，音色厚实、语速平稳，适合英文文档朗读与双语音色搭配。'
  },

  /* ---------------- 生图模型（ComfyUI checkpoints） ----------------
   * tune 是该模型的推荐采样参数：不给的话一律 20 步 / cfg 7，
   * SDXL-Turbo 那样必须 cfg=1、6 步的模型会直接糊掉，用户会以为「本地生图不能用」。 */
  {
    id: 'sd15-fp16', kind: 'image', engine: 'comfyui', name: 'Stable Diffusion 1.5（fp16）',
    org: 'Runway / Stability', sizeGB: 2.0, vramGB: 4, ramGB: 8,
    file: 'v1-5-pruned-emaonly-fp16.safetensors',
    tune: { steps: 20, cfg: 7, size: '512x512' },
    tags: ['通用', '低配', '推荐'],
    desc: '2 GB 就能出图，4 GB 显存的笔记本显卡首选；512×512 约十几秒一张。',
    urls: [
      'https://hf-mirror.com/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors',
      'https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors'
    ]
  },
  {
    id: 'sd15-fp32', kind: 'image', engine: 'comfyui', name: 'Stable Diffusion 1.5（fp32）',
    org: 'Runway / Stability', sizeGB: 4.0, vramGB: 5, ramGB: 8,
    file: 'v1-5-pruned-emaonly.safetensors',
    tune: { steps: 20, cfg: 7, size: '512x512' },
    tags: ['通用', '原版权重'],
    desc: '官方全精度权重，兼容性最好（老工作流 / 老 LoRA 认这个文件名）。',
    urls: [
      'https://hf-mirror.com/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly.safetensors',
      'https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly.safetensors'
    ]
  },
  {
    id: 'sdxl-base', kind: 'image', engine: 'comfyui', name: 'Stable Diffusion XL Base',
    org: 'Stability AI', sizeGB: 6.5, vramGB: 8, ramGB: 16,
    file: 'sd_xl_base_1.0.safetensors',
    tune: { steps: 25, cfg: 7, size: '1024x1024' },
    tags: ['高质量', '1024'],
    desc: '原生 1024×1024，构图与细节明显强于 SD1.5；8 GB 显存起步，出图慢一倍。',
    urls: [
      'https://hf-mirror.com/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
      'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors'
    ]
  },
  {
    id: 'sdxl-turbo', kind: 'image', engine: 'comfyui', name: 'Stable Diffusion XL Turbo',
    org: 'Stability AI', sizeGB: 6.5, vramGB: 8, ramGB: 16,
    file: 'sd_xl_turbo_1.0_fp16.safetensors',
    tune: { steps: 6, cfg: 1, size: '1024x1024' },
    tags: ['快速', '1024'],
    desc: '6 步就能出 1024×1024，比 XL Base 快三四倍；cfg 必须为 1，否则颜色发灰。',
    urls: [
      'https://hf-mirror.com/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors',
      'https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors'
    ]
  }
];

function catalogOf(kind){
  return MODEL_CATALOG.filter(m => m.kind === kind);
}
function catalogGet(id){
  return MODEL_CATALOG.find(m => m.id === id) || null;
}
/* 生图按 checkpoint 文件名反查推荐参数；商店外的模型（用户自己放的）返回 null，走默认值 */
function comfyTuningFor(file){
  const m = MODEL_CATALOG.find(x => x.kind === 'image' && x.file && x.file === String(file || ''));
  return m && m.tune ? m.tune : null;
}

/* 本机跑不跑得动。
 * LLM 和生图的门槛不同：显存不够的 LLM 还能退回 CPU（慢但能出结果），
 * 生图退回 CPU 是几十分钟一张，等于不能用——所以生图只看显存。 */
function catalogFit(item, hw){
  if(!item) return { level: 'unknown', note: '' };
  /* 语音合成：系统语音不占显存、不用下载；Piper ONNX 要下几十 MB，但同样纯 CPU 推理。
   * 两者都判可用，真正的可用性由商店层判断（系统音色在不在 / 权重装没装）。 */
  if(item.kind === 'tts'){
    return item.engine === 'system'
      ? { level: 'good', note: '系统语音，无需下载，不占显存' }
      : { level: 'good', note: 'CPU 推理即可，不占显存' };
  }
  const gpu = (hw && hw.gpu) || {};
  const vramGB = gpu.vramMB ? (gpu.vramMB / 1024) : 0;
  const ramGB = (hw && hw.memory && hw.memory.deviceMemoryGB) || 0;
  if(item.engine === 'ollama'){
    if(vramGB >= item.vramGB) return { level: 'good', note: '可整体放进显存，速度最快' };
    /* ⚠️ 实测（RTX 3050 Laptop 4 GB / 16 GB）：
     * 视觉模型显存不够时，Ollama 在**加载阶段**就 CUDA OOM 直接失败
     * （"llama-server startup failed before projector CPU offload retry"），
     * 不会像纯文本模型那样把层卸到 CPU 活着跑。所以这里绝不能写
     * 「会走 CPU 推理（较慢但可用）」——那句话会让用户以为能跑，
     * 实际上每次调用都 500。这正是「识图能力不够」最常见的真实原因：
     * 模型早就装了，但从来没成功推理过一次。
     *
     * 差 20% 以内留一线（少数层卸载通常能挤过去），差更多就判死。 */
    if(item.kind === 'vision'){
      if(vramGB >= item.vramGB * 0.8){
        return { level: 'cpu', note: '显存偏紧（当前 ' + Math.round(vramGB) + ' / 需约 ' + item.vramGB +
          ' GB）：识图模型比纯文本更吃显存，可能加载失败，失败就换小一档' };
      }
      return { level: 'no', note: '显存不够（需约 ' + item.vramGB + ' GB，当前 ' +
        (vramGB ? Math.round(vramGB) + ' GB' : '无独显') + '）：识图模型显存不足会在加载时直接失败，' +
        '不会自动降级。换 2B / 4B 这一档' };
    }
    /* 纯文本模型显存不够时，Ollama 会把部分层卸到 CPU 继续跑。
     * 这里分两档而不是笼统写「走 CPU」：
     *   显存放得下六成以上 → 只是少数层在 CPU，慢一点；
     *   放不下六成 → 大部分层在 CPU，慢一个量级。
     * 4 GB 卡跑 7B（需 6 GB）和跑 14B 是完全不同的体验。 */
    // 内存门槛留 2 GB 余量：系统本身要占 3-4 GB，卡着名义下限算会把 8 GB 机器判成能跑 8B
    if(ramGB >= item.ramGB + 2){
      if(vramGB <= 0){
        return { level: 'cpu', note: '没有可用显存，走 CPU 推理（较慢但可用）' };
      }
      const head = '显存装不下全部（当前 ' + Math.round(vramGB) + ' / 需约 ' + item.vramGB + ' GB）';
      if(vramGB >= item.vramGB * 0.6) return { level: 'cpu', note: head + '，少数层卸载到 CPU，稍慢' };
      return { level: 'cpu', note: head + '，大部分层要走 CPU，明显变慢' };
    }
    return { level: 'no', note: '需要约 ' + item.vramGB + ' GB 显存，或 ' + (item.ramGB + 2) + ' GB 以上内存走 CPU' };
  }
  if(vramGB >= item.vramGB) return { level: 'good', note: '显存够用' };
  if(vramGB > 0) return { level: 'no', note: '需要约 ' + item.vramGB + ' GB 显存，当前 ' + Math.round(vramGB) + ' GB' };
  return { level: 'unknown', note: '没检测到独立显卡，本地生图会非常慢' };
}

/* 所有走 Ollama 的条目（对话 + 识图）。
 * 卸载后要「自动切到另一个还能用的模型」时不能只查 catalogOf('llm')：
 * 用户可能只装了视觉模型，那样会被判成「没有备选」而退回云端。 */
function catalogOllama(){
  return MODEL_CATALOG.filter(m => m.engine === 'ollama');
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { MODEL_CATALOG, catalogOf, catalogGet, catalogOllama, comfyTuningFor, catalogFit };
}
