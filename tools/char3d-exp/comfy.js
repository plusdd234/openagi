#!/usr/bin/env node
/* 极小的 ComfyUI HTTP 客户端：只做本实验要的四件事。
 *
 *   run(wf, opts)         提交 API 格式工作流 → 轮询 → 返回输出文件名
 *   txt2img / img2img / inpaint   三个工作流构造器（同一套采样参数）
 *
 * 采样参数固定成一份，对照组之间只有「条件」不同——不然差异说不清是谁造成的。
 * 输出全部落在 ComfyUI/output/<prefix>/，本模块负责读回 Buffer。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.COMFY_PORT || 8188);
const CKPT = process.env.COMFY_CKPT || 'v1-5-pruned-emaonly-fp16.safetensors';
/* ComfyUI 的 LoadImage 只认自己的 input 目录；写入这里的是本实验的临时输入 */
const COMFY_INPUT = process.env.COMFY_INPUT ||
  'C:\\Users\\30297\\ComfyUI_windows_portable\\ComfyUI\\input';
const COMFY_OUTPUT = process.env.COMFY_OUTPUT ||
  'C:\\Users\\30297\\ComfyUI_windows_portable\\ComfyUI\\output';

const BASE = { steps: 26, cfg: 7.5, sampler: 'dpmpp_2m', scheduler: 'karras' };

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: HOST, port: PORT, path: urlPath, method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {}
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + txt.slice(0, 400)));
        try { resolve(JSON.parse(txt)); } catch (e) { resolve(txt); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 提交并等待；返回 [{filename, subfolder, type}] */
async function run(wf, opts) {
  opts = opts || {};
  const clientId = 'c3-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const r = await request('POST', '/prompt', { prompt: wf, client_id: clientId });
  if (!r || !r.prompt_id) throw new Error('提交失败：' + JSON.stringify(r).slice(0, 300));
  const id = r.prompt_id;
  const t0 = Date.now();
  for (;;) {
    await sleep(700);
    const h = await request('GET', '/history/' + id);
    const item = h && h[id];
    if (item) {
      if (item.status && item.status.status_str === 'error') {
        throw new Error('执行失败：' + JSON.stringify(item.status).slice(0, 500));
      }
      const outs = item.outputs || {};
      const imgs = [];
      for (const k of Object.keys(outs)) {
        if (outs[k] && Array.isArray(outs[k].images)) imgs.push(...outs[k].images);
      }
      if (imgs.length) return { id, ms: Date.now() - t0, images: imgs };
    }
    if (Date.now() - t0 > (opts.timeout || 8 * 60 * 1000)) throw new Error('超时：' + id);
  }
}

/* 把本地图片放进 ComfyUI 的 input 目录，返回 LoadImage 用的名字 */
function pushInput(file, name) {
  fs.mkdirSync(COMFY_INPUT, { recursive: true });
  const dst = path.join(COMFY_INPUT, name);
  fs.copyFileSync(file, dst);
  return name;
}

function readOutput(img) {
  const p = path.join(COMFY_OUTPUT, img.subfolder || '', img.filename);
  return fs.readFileSync(p);
}

function baseGraph(positive, negative, seed) {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    ks: (denoise, latent) => ({
      class_type: 'KSampler',
      inputs: {
        seed: seed == null ? 20261113 : seed, steps: BASE.steps, cfg: BASE.cfg,
        sampler_name: BASE.sampler, scheduler: BASE.scheduler, denoise: denoise,
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: latent
      }
    })
  };
}

function txt2img({ positive, negative, w, h, seed, prefix }) {
  const g = baseGraph(positive, negative, seed);
  g.lat = { class_type: 'EmptyLatentImage', inputs: { width: w || 512, height: h || 512, batch_size: 1 } };
  g.sample = g.ks(1, ['lat', 0]);
  g.dec = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['1', 2] } };
  g.save = { class_type: 'SaveImage', inputs: { images: ['dec', 0], filename_prefix: prefix } };
  delete g.ks;
  return g;
}

function img2img({ positive, negative, image, denoise, seed, prefix }) {
  const g = baseGraph(positive, negative, seed);
  g.img = { class_type: 'LoadImage', inputs: { image } };
  g.enc = { class_type: 'VAEEncode', inputs: { pixels: ['img', 0], vae: ['1', 2] } };
  g.sample = g.ks(denoise == null ? 0.6 : denoise, ['enc', 0]);
  g.dec = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['1', 2] } };
  g.save = { class_type: 'SaveImage', inputs: { images: ['dec', 0], filename_prefix: prefix } };
  delete g.ks;
  return g;
}

/* 掩膜内重绘：轮廓外像素由原图原样保留（VAEEncodeForInpaint 的语义）。
 * grow 是掩膜外扩像素，给轮廓漂移留余量。 */
function inpaint({ positive, negative, image, mask, denoise, seed, prefix, grow }) {
  const g = baseGraph(positive, negative, seed);
  g.img = { class_type: 'LoadImage', inputs: { image } };
  g.mask = { class_type: 'LoadImageMask', inputs: { image: mask, channel: 'red' } };
  g.grow = { class_type: 'GrowMask', inputs: { mask: ['mask', 0], expand: grow == null ? 6 : grow, tapered_corners: true } };
  g.enc = { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['img', 0], vae: ['1', 2], mask: ['grow', 0], grow_mask_by: 6 } };
  g.sample = g.ks(denoise == null ? 0.85 : denoise, ['enc', 0]);
  g.dec = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['1', 2] } };
  g.save = { class_type: 'SaveImage', inputs: { images: ['dec', 0], filename_prefix: prefix } };
  delete g.ks;
  return g;
}

/* ControlNet：结构图在**每一步**采样里注入，而不是像 img2img 那样只在初始 latent
 * 里投喂一次。支持双路叠加（lineart + depth），各自带权重与生效步区间。
 * latent=true 走 img2img 编码（底图另给 base），否则纯 txt2img + CN。 */
function controlnet({ positive, negative, image, cnet, strength, start, end,
  denoise, seed, prefix, latent, w, h, base, image2, cnet2, strength2, start2, end2, parts }) {
  const g = baseGraph(positive, negative, seed);
  g.img = { class_type: 'LoadImage', inputs: { image } };
  g.cn = { class_type: 'ControlNetLoader', inputs: { control_net_name: cnet } };
  /* 语义部位强化：每个部件一条提示词，用 ConditioningSetMask 限定在它的掩膜里，
   * 再 ConditioningCombine 合到全局提示词上——同一个采样步里，头部区域听头部的词，
   * 腿部区域听腿部的词，避免「全身一个 prompt」把裙子画到腿上。
   * parts: [{ prompt, mask(ComfyUI input 名), strength }] */
  let cond = ['2', 0];
  if (parts && parts.length) {
    parts.forEach((p, i) => {
      const k = 'pt' + i;
      g[k + '_img'] = { class_type: 'LoadImage', inputs: { image: p.mask } };
      g[k + '_txt'] = { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['1', 1] } };
      g[k + '_msk'] = { class_type: 'ImageToMask', inputs: { image: [k + '_img', 0], channel: 'red' } };
      g[k + '_set'] = {
        class_type: 'ConditioningSetMask',
        inputs: {
          conditioning: [k + '_txt', 0], mask: [k + '_msk', 0],
          strength: p.strength == null ? 0.75 : p.strength, set_cond_area: 'mask bounds'
        }
      };
      g[k + '_comb'] = {
        class_type: 'ConditioningCombine',
        inputs: { conditioning_1: cond, conditioning_2: [k + '_set', 0] }
      };
      cond = [k + '_comb', 0];
    });
  }
  g.app = {
    class_type: 'ControlNetApplyAdvanced',
    inputs: {
      positive: cond, negative: ['3', 0], control_net: ['cn', 0], image: ['img', 0],
      strength: strength == null ? 0.8 : strength,
      start_percent: start == null ? 0 : start,
      end_percent: end == null ? 1 : end
    }
  };
  let pos = ['app', 0], neg = ['app', 1];
  if (cnet2) {
    g.img2 = { class_type: 'LoadImage', inputs: { image: image2 } };
    g.cn2 = { class_type: 'ControlNetLoader', inputs: { control_net_name: cnet2 } };
    g.app2 = {
      class_type: 'ControlNetApplyAdvanced',
      inputs: {
        positive: pos, negative: neg, control_net: ['cn2', 0], image: ['img2', 0],
        strength: strength2 == null ? 0.6 : strength2,
        start_percent: start2 == null ? 0 : start2,
        end_percent: end2 == null ? 1 : end2
      }
    };
    pos = ['app2', 0]; neg = ['app2', 1];
  }
  let lat;
  if (latent) {
    /* img2img 底图与 ControlNet 条件图分开：底图负责起手构图，条件图负责逐步纠偏 */
    g.base = { class_type: 'LoadImage', inputs: { image: base || image } };
    g.enc = { class_type: 'VAEEncode', inputs: { pixels: ['base', 0], vae: ['1', 2] } };
    lat = ['enc', 0];
  } else {
    g.lat = { class_type: 'EmptyLatentImage', inputs: { width: w || 512, height: h || 512, batch_size: 1 } };
    lat = ['lat', 0];
  }
  g.sample = {
    class_type: 'KSampler',
    inputs: {
      seed: seed == null ? 20261113 : seed, steps: BASE.steps, cfg: BASE.cfg,
      sampler_name: BASE.sampler, scheduler: BASE.scheduler, denoise: denoise == null ? 1 : denoise,
      model: ['1', 0], positive: pos, negative: neg, latent_image: lat
    }
  };
  g.dec = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['1', 2] } };
  g.save = { class_type: 'SaveImage', inputs: { images: ['dec', 0], filename_prefix: prefix } };
  delete g.ks;
  return g;
}

/* 双图合成：把精修后的 crop 贴回底图（掩膜羽化由 ImageBlur 完成）。
 * 依赖节点的具体入参在首次调用时会由 /object_info 校验，出错信息可直接对照。 */
function composite({ base, over, mask, x, y, feather, prefix }) {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: base } },
    '2': { class_type: 'LoadImage', inputs: { image: over } },
    '3': { class_type: 'LoadImageMask', inputs: { image: mask, channel: 'red' } },
    '4': { class_type: 'ImageBlur', inputs: { image: ['3', 0], blur_radius: feather == null ? 6 : feather, sigma: 2 } },
    '5': { class_type: 'ImageToMask', inputs: { image: ['4', 0], channel: 'red' } },
    '6': { class_type: 'ImageCompositeMasked', inputs: { destination: ['1', 0], source: ['2', 0], x: x || 0, y: y || 0, resize_source: false, mask: ['5', 0] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: prefix } }
  };
}

module.exports = { run, txt2img, img2img, inpaint, composite, controlnet, pushInput, readOutput, request, BASE, COMFY_INPUT, COMFY_OUTPUT };

/* 直接跑本文件 = 冒烟测试：一张 512 纯文本生图，打印耗时与文件大小 */
if (require.main === module) {
  (async () => {
    const t = await run(txt2img({
      positive: 'anime illustration, 1girl, green hair, deer antlers, white background, full body',
      negative: 'lowres, blurry, text, watermark',
      w: 512, h: 512, prefix: 'c3_smoke/test'
    }));
    const buf = readOutput(t.images[0]);
    console.log('ok', t.id, t.ms + 'ms', buf.length + 'B');
  })().catch(e => { console.error(e.message); process.exit(1); });
}
