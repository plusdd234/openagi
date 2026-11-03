/* 图像转 SVG：多层测试夹具（F）
 *
 * 目的：在没有真实插画、也不调用模型的情况下，稳定复现「多层 / 遮挡 / 细线 / 文字 /
 * 透明底 / 渐变」六种结构，并给出**分层真值**（每层画到的像素、包围盒、颜色、
 * 以及被更高层盖住的比例）。测试脚本拿它和模型产物比，就能看出是工具坏了还是模型不行。
 *
 * 为什么用 canvas 现画而不是放 PNG：
 *   1) 真值是分层画布的 alpha，不必再维护一套标注文件；
 *   2) 同输入多次运行结果一致（同一浏览器内 canvas 绘制是确定的）；
 *   3) 夹具可以按任意尺寸重建，不会因为仓库里塞二进制而走样。
 *
 * 暴露：SVG_FIXTURES / svgFixtureTruth(id) / svgFixtureImage(id)
 */
(function (global) {
  'use strict';

  const LAYER_IDS = ['layer-background', 'layer-subject', 'layer-detail', 'layer-text'];

  function mk(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.lineCap = 'round';
    g.lineJoin = 'round';
    return { canvas: c, ctx: g };
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  /* ---------------- 夹具定义 ----------------
   * draw(ctx, w, h) 只画自己这一层，坐标一律按比例算（换尺寸也不会歪）。 */
  const FIXTURES = [
    {
      id: 'flat-occlusion',
      name: '平涂 + 遮挡',
      w: 320, h: 240,
      layers: [
        {
          id: 'layer-background',
          draw: (g, w, h) => {
            g.fillStyle = '#e9eef7'; g.fillRect(0, 0, w, h);
            g.fillStyle = '#cfdaeb'; g.fillRect(0, h * 0.62, w, h * 0.38);
            g.fillStyle = '#dde6f2'; g.fillRect(0, h * 0.62, w, 4);
          }
        },
        {
          id: 'layer-subject',
          draw: (g, w, h) => {
            g.fillStyle = '#2f6fb3';
            roundRect(g, w * 0.22, h * 0.30, w * 0.34, h * 0.46, 12); g.fill();
            g.beginPath(); g.arc(w * 0.62, h * 0.40, h * 0.15, 0, Math.PI * 2); g.fill();
            g.fillStyle = '#eef4fb';
            g.beginPath(); g.arc(w * 0.62, h * 0.40, h * 0.072, 0, Math.PI * 2); g.fill();
          }
        },
        {
          id: 'layer-detail',
          draw: (g, w, h) => {
            g.strokeStyle = '#ffffff'; g.lineWidth = 2;
            for (let i = 0; i < 4; i++) {
              const y = h * 0.36 + i * h * 0.10;
              g.beginPath(); g.moveTo(w * 0.26, y); g.lineTo(w * 0.52, y); g.stroke();
            }
            g.fillStyle = '#f2c94c';
            for (let i = 0; i < 6; i++) {
              g.beginPath();
              g.arc(w * 0.26 + i * w * 0.045, h * 0.86, 5, 0, Math.PI * 2);
              g.fill();
            }
            g.strokeStyle = '#1d4c80'; g.lineWidth = 1.5;
            g.beginPath(); g.arc(w * 0.62, h * 0.40, h * 0.15, 0, Math.PI * 2); g.stroke();
          }
        },
        {
          id: 'layer-text',
          text: 'SEED',
          draw: (g, w, h) => {
            g.fillStyle = '#233240';
            g.font = 'bold 30px sans-serif';
            g.textBaseline = 'alphabetic';
            g.fillText('SEED', w * 0.30, h * 0.965);
          }
        }
      ]
    },
    {
      id: 'gradient-lines',
      name: '渐变 + 细线',
      w: 360, h: 260,
      layers: [
        {
          id: 'layer-background',
          draw: (g, w, h) => {
            const grd = g.createLinearGradient(0, 0, 0, h);
            grd.addColorStop(0, '#fde9c8');
            grd.addColorStop(1, '#8db6d8');
            g.fillStyle = grd; g.fillRect(0, 0, w, h);
          }
        },
        {
          id: 'layer-subject',
          draw: (g, w, h) => {
            g.fillStyle = '#e0592e';
            g.beginPath(); g.arc(w * 0.5, h * 0.44, h * 0.30, 0, Math.PI * 2); g.fill();
          }
        },
        {
          id: 'layer-detail',
          draw: (g, w, h) => {
            g.strokeStyle = '#ffffff';
            for (let i = 0; i < 12; i++) {
              g.lineWidth = 2;
              const y = h * 0.80 + (i % 3) * 6;
              g.beginPath(); g.moveTo(w * 0.08, y); g.lineTo(w * 0.92, y); g.stroke();
            }
            g.strokeStyle = '#733016'; g.lineWidth = 1.5;
            g.beginPath(); g.arc(w * 0.5, h * 0.44, h * 0.30, 0, Math.PI * 2); g.stroke();
          }
        }
      ]
    },
    {
      id: 'cutout-alpha',
      name: '透明底 + 挖洞',
      w: 280, h: 280,
      layers: [
        { id: 'layer-background', draw: () => { /* 故意留空：测试缺内容图层 */ } },
        {
          id: 'layer-subject',
          draw: (g, w, h) => {
            g.fillStyle = '#3b8f6b';
            g.beginPath(); g.arc(w * 0.5, h * 0.5, h * 0.38, 0, Math.PI * 2); g.fill();
            g.globalCompositeOperation = 'destination-out';
            g.beginPath(); g.arc(w * 0.5, h * 0.5, h * 0.19, 0, Math.PI * 2); g.fill();
            g.globalCompositeOperation = 'source-over';
          }
        },
        {
          id: 'layer-detail',
          draw: (g, w, h) => {
            g.fillStyle = '#f2c94c';
            for (let i = 0; i < 16; i++) {
              const a = i / 16 * Math.PI * 2;
              g.beginPath();
              g.arc(w * 0.5 + Math.cos(a) * h * 0.26, h * 0.5 + Math.sin(a) * h * 0.26, 5, 0, Math.PI * 2);
              g.fill();
            }
          }
        },
        {
          id: 'layer-text',
          text: 'A',
          draw: (g, w, h) => {
            g.fillStyle = '#12301f';
            g.font = 'bold 44px sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText('A', w * 0.5, h * 0.5);
          }
        }
      ]
    },
    {
      id: 'line-art',
      name: '线稿 + 细笔画',
      w: 300, h: 300,
      layers: [
        {
          id: 'layer-background',
          draw: (g, w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
        },
        {
          id: 'layer-subject',
          draw: (g, w, h) => {
            g.strokeStyle = '#33513f'; g.lineWidth = 7;
            g.beginPath();
            g.moveTo(w * 0.5, h * 0.90);
            g.bezierCurveTo(w * 0.46, h * 0.66, w * 0.56, h * 0.46, w * 0.5, h * 0.18);
            g.stroke();
          }
        },
        {
          id: 'layer-detail',
          draw: (g, w, h) => {
            g.strokeStyle = '#4d7a5c'; g.lineWidth = 2.5;
            for (let i = 0; i < 6; i++) {
              const t = 0.22 + i * 0.12;
              const dir = i % 2 ? 1 : -1;
              g.beginPath();
              g.moveTo(w * 0.5, h * (1 - t));
              g.quadraticCurveTo(w * (0.5 + dir * 0.16), h * (1 - t - 0.06),
                w * (0.5 + dir * 0.22), h * (1 - t - 0.14));
              g.stroke();
            }
          }
        },
        {
          id: 'layer-text',
          text: 'seed',
          draw: (g, w, h) => {
            g.fillStyle = '#33513f';
            g.font = '18px monospace';
            g.textBaseline = 'alphabetic';
            g.fillText('seed', w * 0.40, h * 0.985);
          }
        }
      ]
    }
  ];

  /* ---------------- 真值计算 ---------------- */
  function maskOf(canvas) {
    const w = canvas.width, h = canvas.height;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const m = new Uint8Array(w * h);
    let painted = 0, minx = w, miny = h, maxx = -1, maxy = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] < 24) continue;
        m[y * w + x] = 1;
        painted++;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
    return {
      mask: m, painted: painted, data: data,
      bbox: maxx < 0 ? null : { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 }
    };
  }

  function colorsOf(data, painted) {
    const bins = new Map();
    for (let o = 0; o < data.length; o += 4) {
      if (data[o + 3] < 24) continue;
      const k = (data[o] >> 4) + ',' + (data[o + 1] >> 4) + ',' + (data[o + 2] >> 4);
      let e = bins.get(k);
      if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; bins.set(k, e); }
      e.n++; e.r += data[o]; e.g += data[o + 1]; e.b += data[o + 2];
    }
    return Array.from(bins.values())
      .sort((a, b) => b.n - a.n)
      .slice(0, 4)
      .map(e => ({
        hex: '#' + [e.r / e.n, e.g / e.n, e.b / e.n].map(v => {
          const s = Math.round(v).toString(16);
          return s.length === 1 ? '0' + s : s;
        }).join(''),
        share: painted ? Math.round(e.n / painted * 1000) / 1000 : 0
      }));
  }

  const cache = new Map();

  function build(def) {
    const w = def.w, h = def.h;
    const layerCanvas = {};
    const masks = {};
    const layers = [];

    def.layers.forEach(l => {
      const box = mk(w, h);
      l.draw(box.ctx, w, h);
      layerCanvas[l.id] = box.canvas;
      const m = maskOf(box.canvas);
      masks[l.id] = m.mask;
      layers.push({
        id: l.id,
        text: l.text || '',
        painted: m.painted,
        ratio: Math.round(m.painted / (w * h) * 1000) / 1000,
        bbox: m.bbox,
        colors: colorsOf(m.data, m.painted),
        layerPng: box.canvas.toDataURL('image/png')
      });
    });

    // 合成：按 LAYER_IDS 顺序叠，透明层自然透出下层
    const out = mk(w, h);
    LAYER_IDS.forEach(id => {
      if (layerCanvas[id]) out.ctx.drawImage(layerCanvas[id], 0, 0);
    });

    /* 遮挡真值用和运行时同一个函数算：定义一致，数值差异才只反映绘制差异 */
    const occlusion = typeof global.svgOcclusionOf === 'function'
      ? global.svgOcclusionOf(masks, LAYER_IDS)
      : [];

    return {
      id: def.id, name: def.name, w: w, h: h,
      dataUrl: out.canvas.toDataURL('image/png'),
      layers: layers,
      occlusion: occlusion,
      layerOrder: LAYER_IDS.slice()
    };
  }

  function svgFixtureTruth(id) {
    if (cache.has(id)) return JSON.parse(JSON.stringify(cache.get(id)));
    const def = FIXTURES.find(f => f.id === id);
    if (!def) throw new Error('未知夹具：' + id);
    const t = build(def);
    cache.set(id, t);
    return JSON.parse(JSON.stringify(t));
  }

  function svgFixtureImage(id) {
    const t = svgFixtureTruth(id);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('夹具图解码失败：' + id));
      img.src = t.dataUrl;
    });
  }

  global.SVG_FIXTURES = FIXTURES;
  global.svgFixtureTruth = svgFixtureTruth;
  global.svgFixtureImage = svgFixtureImage;
})(window);
