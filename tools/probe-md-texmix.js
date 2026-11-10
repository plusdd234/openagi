/* 探针：建模 App · 绘画工具箱的「纹理混合」
 * 用法：node tools/probe-md-texmix.js
 *
 * 覆盖：
 *   1) 绘画页签里出现纹理混合面板，插槽选择 / 加层入口可点
 *   2) 上传一张纯红贴图 → 材质上挂的是「合成图」，像素验证确实是红色
 *   3) 拖比例滑杆 → 合成图随之变化（不是只改了配置没重烘）
 *   4) 撤销两次 → 配置回到空、视口回到基础贴图
 *   5) 全程无 pageerror
 *
 * 注意这里刻意不依赖资产库桥：网页版上传的层是「本次会话内有效」，
 * 所以用页面内的 file input 走真实上传路径，不直接改内存配置。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const TMP_PNG = path.join(__dirname, '_texmix-probe.png');

let pass = 0, fail = 0;
const check = (name, ok, info) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  → ' + info : '')); }
};

/* 纯色 PNG：不依赖任何现成素材，跑完就删 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function writePNG(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]));
}

(async () => {
  writePNG(TMP_PNG, 64, 64, [255, 0, 0]);
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  try {
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
    await page.waitForTimeout(600);
    await page.evaluate(() => window.openDeskApp('modeldesk'));
    await page.waitForTimeout(1600);
    await page.evaluate(() => {
      const b = document.querySelector('[data-md-tbk="paint"]');
      if (b) b.click();
    });
    await page.waitForTimeout(300);

    const ui0 = await page.evaluate(() => {
      const box = document.getElementById('mdMixBox');
      return {
        box: !!box,
        head: !!(box && box.querySelector('.md-mix-head')),
        add: !!(box && Array.from(box.querySelectorAll('button')).find(x => x.textContent.indexOf('＋ 贴图') === 0)),
        rows: box ? box.querySelectorAll('.md-mix-row').length : -1
      };
    });
    check('绘画页签出现纹理混合面板（标题 / 加层按钮都在）', ui0.head && ui0.add, JSON.stringify(ui0));
    check('初始没有混合层', ui0.rows === 0, 'rows=' + ui0.rows);

    /* 真上传：点「＋ 贴图」→ 接住 filechooser → 塞纯红 PNG */
    const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#mdMixBox button')).find(x => x.textContent.indexOf('＋ 贴图') === 0);
      if (b) b.click();
    });
    const fc = await chooser;
    check('点「＋ 贴图」能打开文件选择', !!fc);
    if (fc) await fc.setFiles(TMP_PNG);
    await page.waitForTimeout(900);

    const afterAdd = await page.evaluate(() => {
      const d = window.modelDesk.__debug();
      let m = null;
      if (d.pivot) d.pivot.traverse(o => { if (!m && o.userData && o.userData.mdPart === 'solid') m = o; });
      const mat = m && (Array.isArray(m.material) ? m.material[0] : m.material);
      const img = mat && mat.map && mat.map.image;
      let px = null;
      if (img && img.getContext) {
        const c = img.getContext('2d');
        px = Array.from(c.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data);
      }
      return {
        rows: document.querySelectorAll('#mdMixBox .md-mix-row').length,
        w: img ? img.width : 0, h: img ? img.height : 0, px
      };
    });
    check('上传后出现 1 个混合层卡片', afterAdd.rows === 1, JSON.stringify(afterAdd));
    check('材质上挂的是合成图，中心像素是纯红', !!afterAdd.px && afterAdd.px[0] > 250 && afterAdd.px[1] < 10 && afterAdd.px[2] < 10,
      JSON.stringify(afterAdd.px));

    /* 比例滑杆：100 → 30，再等一帧重合成 */
    await page.evaluate(() => {
      const r = document.querySelector('#mdMixBox .md-mix-row input[type=range]');
      if (r) {
        r.value = '30';
        r.dispatchEvent(new Event('input', { bubbles: true }));
        r.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForTimeout(500);
    const afterOpacity = await page.evaluate(() => {
      const d = window.modelDesk.__debug();
      let m = null;
      if (d.pivot) d.pivot.traverse(o => { if (!m && o.userData && o.userData.mdPart === 'solid') m = o; });
      const mat = m && (Array.isArray(m.material) ? m.material[0] : m.material);
      const img = mat && mat.map && mat.map.image;
      if (!img || !img.getContext) return null;
      const c = img.getContext('2d');
      return Array.from(c.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data);
    });
    check('拖比例滑杆后合成图真的重烘了（不再纯红）',
      !!afterOpacity && afterOpacity[1] > 80 && afterOpacity[2] > 80, JSON.stringify(afterOpacity));

    /* 手绘遮罩：弹层打开 → 在画布上涂一笔 → 保存 */
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#mdMixBox button')).find(x => x.textContent === '手绘');
      if (b) b.click();
    });
    await page.waitForTimeout(250);
    const maskOpen = await page.evaluate(() => !!document.querySelector('.md-mix-maskpop canvas.md-mix-maskdraw'));
    check('手绘遮罩弹层可打开', maskOpen);
    if (maskOpen) {
      const bb = await page.evaluate(() => {
        const r = document.querySelector('.md-mix-maskdraw').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      await page.mouse.move(bb.x + bb.w * 0.5, bb.y + bb.h * 0.5);
      await page.mouse.down();
      await page.mouse.move(bb.x + bb.w * 0.7, bb.y + bb.h * 0.6, { steps: 8 });
      await page.mouse.up();
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.md-mix-maskpop button')).find(x => x.textContent === '保存为遮罩');
        if (b) b.click();
      });
      await page.waitForTimeout(700);
    }
    const maskChip = await page.evaluate(() => {
      const m = document.querySelector('#mdMixBox .md-mix-mask');
      return m ? m.textContent : '';
    });
    check('手绘遮罩保存后出现遮罩标签', /遮罩/.test(maskChip), maskChip);

    /* 模型表面画遮罩：进入模式 → 在视口涂一笔 → 取消（不落历史） */
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#mdMixBox button')).find(x => x.textContent === '模型画');
      if (b) b.click();
    });
    await page.waitForTimeout(300);
    const viewPaint = await page.evaluate(() => {
      const bar = document.querySelector('.md-maskbar');
      const cv = document.getElementById('mdCanvas');
      if (!bar || !cv) return null;
      const r = cv.getBoundingClientRect();
      return { bar: !!bar, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    check('「模型画」进入遮罩绘制模式', !!viewPaint && viewPaint.bar === true, JSON.stringify(viewPaint));
    if (viewPaint) {
      await page.mouse.move(viewPaint.x, viewPaint.y);
      await page.mouse.down();
      await page.mouse.move(viewPaint.x + 40, viewPaint.y + 20, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const bar = document.querySelector('.md-maskbar');
        const b = bar && Array.from(bar.querySelectorAll('button')).find(x => x.textContent === '取消');
        if (b) b.click();
      });
      await page.waitForTimeout(300);
    }
    const viewPaintExit = await page.evaluate(() => ({
      bar: !!document.querySelector('.md-maskbar'),
      rows: document.querySelectorAll('#mdMixBox .md-mix-row').length,
      mask: (document.querySelector('#mdMixBox .md-mix-mask') || {}).textContent || ''
    }));
    check('取消后退出遮罩绘制且状态还原',
      viewPaintExit.bar === false && viewPaintExit.rows === 1 && /遮罩/.test(viewPaintExit.mask),
      JSON.stringify(viewPaintExit));

    /* 烘焙：图层清空、底层变烘焙贴图 */
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#mdMixBox button')).find(x => x.textContent === '烘焙');
      if (b) b.click();
    });
    await page.waitForTimeout(800);
    const baked = await page.evaluate(() => {
      const chip = document.querySelector('#mdMixBox .md-mix-chip');
      return {
        chip: chip ? chip.textContent : '',
        rows: document.querySelectorAll('#mdMixBox .md-mix-row').length
      };
    });
    check('烘焙后图层清空且底层显示烘焙贴图',
      baked.rows === 0 && /烘焙/.test(baked.chip), JSON.stringify(baked));

    /* 撤销：烘焙 → 遮罩 → 比例 → 加层（共 4 步） */
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.modelDesk.undo());
      await page.waitForTimeout(250);
    }
    const afterUndo = await page.evaluate(() => ({
      rows: document.querySelectorAll('#mdMixBox .md-mix-row').length,
      status: (document.getElementById('mdStatus') || {}).textContent || ''
    }));
    check('撤销四次后混合层清空', afterUndo.rows === 0, JSON.stringify(afterUndo));

    /* 材质槽（P5）：新增 → 改名 → 删除 → 连撤三步 */
    await page.evaluate(() => {
      const b = document.querySelector('[data-md-tbk="props"]');
      if (b) b.click();
    });
    await page.waitForTimeout(300);
    const slot0 = await page.evaluate(() => {
      const doc = window.modelDesk.getDocument();
      return {
        rows: document.querySelectorAll('.md-slot').length,
        names: (doc.materials.slotNames || []).slice(),
        assignDisabled: !!document.querySelector('.md-slot-a[disabled]')
      };
    });
    check('属性编辑器列出材质槽（默认 1 个）', slot0.rows === 1 && slot0.names.length === 1, JSON.stringify(slot0));
    check('未选面时「指派」按钮禁用', slot0.assignDisabled === true);

    await page.evaluate(() => document.querySelector('[data-md-act="slot-add"]').click());
    await page.waitForTimeout(300);
    const slot1 = await page.evaluate(() => ({
      rows: document.querySelectorAll('.md-slot').length,
      names: (window.modelDesk.getDocument().materials.slotNames || []).slice()
    }));
    check('点「＋ 新槽」后变成 2 个槽', slot1.rows === 2 && slot1.names.length === 2, JSON.stringify(slot1));

    await page.evaluate(() => {
      const inp = document.querySelectorAll('.md-slot-n')[1];
      inp.value = '涂层';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    const slot2 = await page.evaluate(() => ({
      names: (window.modelDesk.getDocument().materials.slotNames || []).slice(),
      inp: (document.querySelectorAll('.md-slot-n')[1] || {}).value || ''
    }));
    check('改名写回文档', slot2.names[1] === '涂层' && slot2.inp === '涂层', JSON.stringify(slot2));

    await page.evaluate(() => document.querySelectorAll('[data-md-act="slot-del"]')[1].click());
    await page.waitForTimeout(300);
    const slot3 = await page.evaluate(() => (window.modelDesk.getDocument().materials.slotNames || []).length);
    check('删除槽后只剩 1 个', slot3 === 1, 'count=' + slot3);

    await page.evaluate(() => window.modelDesk.undo());
    await page.waitForTimeout(300);
    const slot4 = await page.evaluate(() => (window.modelDesk.getDocument().materials.slotNames || []).slice());
    check('撤销删除后恢复 2 个槽且名字还在',
      slot4.length === 2 && slot4[1] === '涂层', JSON.stringify(slot4));

    await page.evaluate(() => window.modelDesk.undo());
    await page.waitForTimeout(300);
    const slot5 = await page.evaluate(() => (window.modelDesk.getDocument().materials.slotNames || []).slice());
    check('撤销改名后回到默认名', slot5.length === 2 && slot5[1] === '插槽 2', JSON.stringify(slot5));

    await page.evaluate(() => window.modelDesk.undo());
    await page.waitForTimeout(300);
    const slot6 = await page.evaluate(() => (window.modelDesk.getDocument().materials.slotNames || []).length);
    check('撤销新增后回到 1 个槽', slot6 === 1, 'count=' + slot6);

    /* 3D 遮罩绘制提交：再叠一层 → 在模型表面涂 → 完成后红色区域仍可见 */
    await page.evaluate(() => {
      const b = document.querySelector('[data-md-tbk="paint"]');
      if (b) b.click();
    });
    await page.waitForTimeout(300);
    const chooser2 = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#mdMixBox button')).find(x => x.textContent.indexOf('＋ 贴图') === 0);
      if (b) b.click();
    });
    const fc2 = await chooser2;
    if (fc2) await fc2.setFiles(TMP_PNG);
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#mdMixBox button')).find(x => x.textContent === '模型画');
      if (b) b.click();
    });
    await page.waitForTimeout(300);
    const vp = await page.evaluate(() => {
      const cv = document.getElementById('mdCanvas');
      const r = cv.getBoundingClientRect();
      const rg = document.querySelector('.md-maskbar input[type=range]');
      if (rg) { rg.value = rg.max; rg.dispatchEvent(new Event('input', { bubbles: true })); }
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    });
    const pts = [[0, 0], [-0.16, 0], [0.16, 0], [0, -0.16], [0, 0.16], [0.18, 0.16]];
    for (const p of pts) {
      await page.mouse.move(vp.x + vp.w * p[0], vp.y + vp.h * p[1]);
      await page.mouse.down();
      await page.mouse.move(vp.x + vp.w * p[0] + 12, vp.y + vp.h * p[1] + 8, { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => {
      const bar = document.querySelector('.md-maskbar');
      const b = bar && Array.from(bar.querySelectorAll('button')).find(x => x.textContent === '完成');
      if (b) b.click();
    });
    await page.waitForTimeout(1200);
    const committed = await page.evaluate(() => {
      const d = window.modelDesk.__debug();
      let m = null;
      if (d.pivot) d.pivot.traverse(o => { if (!m && o.userData && o.userData.mdPart === 'solid') m = o; });
      const mat = m && (Array.isArray(m.material) ? m.material[0] : m.material);
      const img = mat && mat.map && mat.map.image;
      let red = 0, total = 0;
      if (img && img.getContext) {
        const c = img.getContext('2d');
        const data = c.getImageData(0, 0, img.width, img.height).data;
        for (let i = 0; i < data.length; i += 16) {
          total++;
          if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80) red++;
        }
      }
      return {
        chip: (document.querySelector('#mdMixBox .md-mix-mask') || {}).textContent || '',
        bar: !!document.querySelector('.md-maskbar'),
        red, total
      };
    });
    check('模型表面绘制遮罩后红色区域仍可见',
      committed.bar === false && /遮罩/.test(committed.chip) && committed.red > 0,
      JSON.stringify(committed));

    check('全程无 pageerror', errors.length === 0, errors.join(' | '));
  } catch (e) {
    fail++;
    console.log('  ✗ 探针崩了：' + (e && e.stack || e));
  } finally {
    await browser.close().catch(() => {});
    try { fs.unlinkSync(TMP_PNG); } catch (e) {}
  }
  console.log('\n' + (fail ? '❌ ' + fail + ' 项失败 / ' + pass + ' 项通过' : '✅ 全部通过（' + pass + ' 项）'));
  process.exit(fail ? 1 : 0);
})();
