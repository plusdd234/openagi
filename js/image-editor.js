/* 图片编辑器
 *
 * 双击图库里的图片打开。定位是「快速修正」，不是替代 Photoshop：
 * 转正、翻转、调亮、缩一缩，然后存回去——这几件事占了日常资产处理的九成。
 *
 * 三个设计决定：
 *   ① **非破坏性**：所有操作只改一组参数，每次从头重绘。用户随时能「重置」回原图，
 *      不需要撤销栈，也不会因为连续操作累积画质损失。
 *   ② **滤镜用 ctx.filter**：亮度/对比度/饱和度交给浏览器，比自己写像素循环快得多，
 *      而且所见即所得（预览就是最终结果）。
 *   ③ **保存默认另存为**：覆盖原图是不可逆的，手滑一下原资产就没了。
 *      想覆盖得显式点「覆盖原图」。
 */
const ieState = {
  id: '', name: '', src: '', img: null,
  rot: 0, flipH: false, flipV: false,
  bright: 100, contrast: 100, saturate: 100, scale: 100,
  busy: '', error: '', note: '', dirty: false
};

function ieEsc(s){
  if(typeof mcEsc === 'function') return mcEsc(s);
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function ieDesk(){
  const d = window.openagiDesktop;
  return (d && typeof d.assetPut === 'function') ? d : null;
}

function iePaintSide(){
  const side = $('ieSide');
  if(!side) return;
  const s = ieState;
  const slider = (key, label, min, max, val) =>
    '<label class="ie-row"><span>' + label + '</span>' +
      '<input type="range" min="' + min + '" max="' + max + '" value="' + val + '" data-ie-k="' + key + '">' +
      '<b>' + val + '%</b></label>';

  side.innerHTML =
    '<div class="ie-sec">' +
      '<div class="ie-h">方向</div>' +
      '<div class="ie-btns">' +
        '<button type="button" class="btn sm" data-ie-act="rotL">向左转 90°</button>' +
        '<button type="button" class="btn sm" data-ie-act="rotR">向右转 90°</button>' +
        '<button type="button" class="btn sm' + (s.flipH ? ' primary' : '') + '" data-ie-act="flipH">水平翻转</button>' +
        '<button type="button" class="btn sm' + (s.flipV ? ' primary' : '') + '" data-ie-act="flipV">垂直翻转</button>' +
      '</div>' +
    '</div>' +
    '<div class="ie-sec">' +
      '<div class="ie-h">调整</div>' +
      slider('bright', '亮度', 20, 200, s.bright) +
      slider('contrast', '对比度', 20, 200, s.contrast) +
      slider('saturate', '饱和度', 0, 200, s.saturate) +
      slider('scale', '缩放', 10, 100, s.scale) +
    '</div>' +
    '<div class="ie-size" id="ieSize"></div>' +
    (s.error ? '<div class="cf-err">' + ieEsc(s.error) + '</div>' : '') +
    (s.note ? '<div class="lib-note">' + ieEsc(s.note) + '</div>' : '') +
    '<div class="ie-sec">' +
      '<div class="ie-h">保存</div>' +
      '<div class="ie-btns">' +
        '<button type="button" class="btn sm primary" data-ie-act="saveAs"' + (s.busy ? ' disabled' : '') + '>' +
          (s.busy || '另存为新资产') + '</button>' +
        '<button type="button" class="btn sm" data-ie-act="save"' + (s.busy ? ' disabled' : '') + '>覆盖原图</button>' +
        '<button type="button" class="btn sm" data-ie-act="reset"' + (s.busy ? ' disabled' : '') + '>重置</button>' +
      '</div>' +
    '</div>';

  side.querySelectorAll('[data-ie-act]').forEach(b => {
    b.addEventListener('click', () => ieAction(b.dataset.ieAct));
  });
  side.querySelectorAll('[data-ie-k]').forEach(inp => {
    inp.addEventListener('input', () => {
      const k = inp.dataset.ieK;
      ieState[k] = Number(inp.value) || 0;
      ieState.dirty = true;
      const b = inp.parentNode.querySelector('b');
      if(b) b.textContent = ieState[k] + '%';
      ieDraw();
    });
  });
}

function ieDraw(){
  const canvas = $('ieCanvas');
  if(!canvas || !ieState.img) return;
  const img = ieState.img;
  const s = ieState;
  const sc = s.scale / 100;
  const rotated = (s.rot % 180) !== 0;
  const baseW = rotated ? img.naturalHeight : img.naturalWidth;
  const baseH = rotated ? img.naturalWidth : img.naturalHeight;
  const cw = Math.max(1, Math.round(baseW * sc));
  const ch = Math.max(1, Math.round(baseH * sc));

  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  ctx.save();
  ctx.filter = 'brightness(' + s.bright + '%) contrast(' + s.contrast + '%) saturate(' + s.saturate + '%)';
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(s.rot * Math.PI / 180);
  ctx.scale(s.flipH ? -1 : 1, s.flipV ? -1 : 1);
  ctx.drawImage(img, -img.naturalWidth * sc / 2, -img.naturalHeight * sc / 2,
    img.naturalWidth * sc, img.naturalHeight * sc);
  ctx.restore();

  const sizeEl = $('ieSize');
  if(sizeEl){
    const changed = cw !== img.naturalWidth || ch !== img.naturalHeight;
    sizeEl.innerHTML = '输出尺寸 <b>' + cw + ' × ' + ch + '</b>' +
      (changed ? '（原图 ' + img.naturalWidth + ' × ' + img.naturalHeight + '）' : '');
  }
}

async function ieAction(a){
  if(!ieState.img) return;
  if(a === 'rotL'){ ieState.rot = (ieState.rot + 270) % 360; ieState.dirty = true; ieDraw(); iePaintSide(); return; }
  if(a === 'rotR'){ ieState.rot = (ieState.rot + 90) % 360; ieState.dirty = true; ieDraw(); iePaintSide(); return; }
  if(a === 'flipH'){ ieState.flipH = !ieState.flipH; ieState.dirty = true; ieDraw(); iePaintSide(); return; }
  if(a === 'flipV'){ ieState.flipV = !ieState.flipV; ieState.dirty = true; ieDraw(); iePaintSide(); return; }
  if(a === 'reset'){
    Object.assign(ieState, { rot: 0, flipH: false, flipV: false, bright: 100, contrast: 100, saturate: 100, scale: 100, dirty: false, note: '', error: '' });
    ieDraw(); iePaintSide();
    return;
  }
  if(a === 'save' || a === 'saveAs') await ieSave(a === 'save');
}

async function ieSave(overwrite){
  const d = ieDesk();
  const canvas = $('ieCanvas');
  if(!d || !canvas || ieState.busy) return;
  ieState.busy = '保存中';
  ieState.error = '';
  ieState.note = '';
  iePaintSide();
  try{
    const dataURL = canvas.toDataURL('image/png');
    const baseName = String(ieState.name || 'image').replace(/\.[^.]+$/, '');
    if(overwrite){
      const r = await d.assetPut({ id: ieState.id, kind: 'image', data: dataURL, name: ieState.name, source: 'editor', ext: 'png' });
      if(!r || !r.ok) throw new Error((r && r.message) || '写入失败');
      ieState.note = '已覆盖原图';
      ieState.dirty = false;
    } else {
      const r = await d.assetPut({ kind: 'image', data: dataURL, name: baseName + ' 编辑副本.png', source: 'editor', ext: 'png' });
      if(!r || !r.ok) throw new Error((r && r.message) || '写入失败');
      ieState.note = '已另存为「' + baseName + ' 编辑副本.png」';
      // 另存后把编辑对象换成新资产，继续编辑不会误覆盖原图
      if(r.asset && r.asset.id){
        ieState.id = r.asset.id;
        ieState.name = r.asset.name;
        const t = $('imgEditTitle');
        if(t) t.textContent = '图片编辑器 · ' + ieState.name;
      }
    }
    // 覆盖时缩略图缓存必须失效，否则图库还显示旧图
    if(typeof libForgetThumb === 'function') libForgetThumb(overwrite ? ieState.id : '');
    if(typeof libRefresh === 'function') libRefresh();
  }catch(e){
    ieState.error = '保存失败：' + ((e && e.message) || e);
  }finally{
    ieState.busy = '';
    iePaintSide();
  }
}

function ieResetState(){
  Object.assign(ieState, {
    id: '', name: '', src: '', img: null,
    rot: 0, flipH: false, flipV: false,
    bright: 100, contrast: 100, saturate: 100, scale: 100,
    busy: '', error: '', note: '', dirty: false
  });
}

/* 打开编辑器。image 元素要等 onload 之后才能画，所以整段是异步的。 */
function openImageEditor(id, asset, dataURL){
  const win = $('imgEditWin');
  if(!win || !dataURL) return false;
  ieResetState();
  ieState.id = id;
  ieState.name = (asset && asset.name) || (id + '.png');
  ieState.src = dataURL;
  const t = $('imgEditTitle');
  if(t) t.textContent = '图片编辑器 · ' + ieState.name;
  win.classList.remove('hidden');
  ieState.busy = '载入中';
  iePaintSide();

  const img = new Image();
  img.onload = () => {
    ieState.img = img;
    ieState.busy = '';
    ieDraw();
    iePaintSide();
  };
  img.onerror = () => {
    ieState.busy = '';
    ieState.error = '图片解码失败（文件可能已损坏）';
    iePaintSide();
  };
  img.src = dataURL;
  return true;
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { ieState, openImageEditor, ieDraw, ieSave };
}
