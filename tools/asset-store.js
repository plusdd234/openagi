/* 资产库（磁盘文件 + 索引）测试
 *
 * 这一层是所有资产的地基：图库、模型库、流程里的图片都读它。
 * 出错的表现是「图片打开是空的」「删了还能点开」「重装后全丢」，
 * 而且都不像是资产层的问题，所以每条不变量都单独钉住。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAssetStore, parseDataURL } = require('../electron/asset-store.js');

let pass = 0, fail = 0;
function ok(cond, label, extra){
  if(cond){ pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  [' + extra + ']' : '')); }
}
function eq(a, b, label){
  if(a === b){ pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '  期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'assetstore-'));
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  console.log('\n=== A. dataURL 解析 ===');
  {
    const r = parseDataURL(PNG_1PX);
    ok(r && r.buf.length > 0, '解析出字节', String(r && r.buf.length));
    eq(r && r.ext, 'png', 'PNG 的扩展名');
    eq(r && r.mime, 'image/png', '带出 MIME');
    eq(parseDataURL('not a dataurl'), null, '非 dataURL 返回 null');
    const jpg = parseDataURL('data:image/jpeg;base64,/9j/4AAQ');
    eq(jpg && jpg.ext, 'jpg', 'jpeg 归一成 jpg（Windows 认这个）');
    const glb = parseDataURL('data:model/gltf-binary;base64,AAAA');
    eq(glb && glb.ext, 'glb', 'glb 的 MIME 能识别');
  }

  console.log('\n=== B. 写入与读回 ===');
  const store = createAssetStore(path.join(TMP, 'assets'));
  {
    const a = await store.put({ kind: 'image', name: '测试图.png', data: PNG_1PX, source: 'upload' });
    ok(!!a.id, '分配了 id');
    eq(a.kind, 'image', '类型记对');
    eq(a.ext, 'png', '扩展名记对');
    ok(a.size > 0, '记录了大小', String(a.size));
    ok(fs.existsSync(store.fileOf(a)), '文件真的落在磁盘上（不是只写了索引）');

    const back = await store.read(a.id);
    eq(back.ok, true, '能读回来');
    ok(/^data:image\/png;base64,/.test(back.dataURL || ''), '读回的是可直接给 <img> 用的 dataURL');
    eq(back.size, a.size, '读回的字节数和写入一致');

    const list = await store.list();
    eq(list.count, 1, '列表里有 1 条');
    eq(list.assets[0].missing, false, '文件在，不标缺失');
  }

  console.log('\n=== C. 指定 id（流程存根要用稳定 id） ===');
  {
    const a1 = await store.put({ id: 'stable-001', kind: 'image', data: PNG_1PX });
    eq(a1.id, 'stable-001', '用传入的 id 当文件名');
    const a2 = await store.put({ id: 'stable-001', kind: 'image', data: PNG_1PX });
    eq(a2.created, a1.created, '同 id 重存不重置创建时间（排序会乱跳）');
    ok(a2.updated >= a1.updated, '更新时间往前走');
    const list = await store.list();
    eq(list.count, 2, '重存不会多出一条');
  }

  console.log('\n=== D. 同一 id 换扩展名 ===');
  {
    const a = await store.put({ id: 'swap', kind: 'image', ext: 'png', data: Buffer.from('aaa') });
    const oldFile = store.fileOf(a);
    const b = await store.put({ id: 'swap', kind: 'image', ext: 'webp', data: Buffer.from('bbb') });
    ok(!fs.existsSync(oldFile), '旧扩展名的文件被清掉了（否则会留一个幽灵文件占空间）');
    ok(fs.existsSync(store.fileOf(b)), '新文件在');
    eq(b.ext, 'webp', '索引跟着更新');
  }

  console.log('\n=== E. 删除进回收站 ===');
  {
    const a = await store.put({ kind: 'model', name: 'dragon.glb', data: Buffer.from('glTF-fake') , ext: 'glb' });
    const r = await store.remove([a.id]);
    eq(r.moved.length, 1, '搬走了 1 个');
    eq((await store.list()).assets.find(x => x.id === a.id), undefined, '索引里没有了');
    ok(fs.existsSync(r.trashDir), '回收站目录建出来了');
    const trashed = fs.readdirSync(r.trashDir);
    ok(trashed.some(n => n.startsWith(a.id)), '文件在回收站里还找得到（误删能捞回来）');

    const r2 = await store.remove([a.id]);
    ok(r2.failed.length === 1, '重复删除会明确报「不存在」，不静默');
  }

  console.log('\n=== F. 索引与磁盘对账 ===');
  {
    // 磁盘上被外部删掉一个
    const a = await store.put({ kind: 'image', name: 'gone.png', data: PNG_1PX });
    fs.rmSync(store.fileOf(a));
    const l1 = await store.list();
    eq(l1.assets.find(x => x.id === a.id).missing, true, '文件没了要标 missing（界面不能假装能打开）');

    // 外部丢进来一个文件
    const drop = path.join(store.root, 'images', 'outside-file.png');
    fs.writeFileSync(drop, Buffer.from('external'));
    const rec = await store.reconcile();
    ok(rec.added.indexOf('outside-file') >= 0, '扫描补回外部放进去的文件');
    ok(rec.dropped.indexOf(a.id) >= 0, '剔除文件已消失的条目');
    const l2 = await store.list();
    ok(l2.assets.find(x => x.id === 'outside-file'), '补回的条目能列出来');
    eq(l2.assets.find(x => x.id === a.id), undefined, '幽灵条目被清掉');
  }

  console.log('\n=== G. 占用统计 ===');
  {
    const s = await store.stat();
    ok(s.totalBytes > 0, '总大小有数', String(s.totalBytes));
    ok(s.byKind.image && s.byKind.image.count >= 1, '按类型分开统计');
    ok(typeof s.trashBytes === 'number', '回收站单独算（那里常堆着几个 GB 被人忘掉）');
    ok(s.trashBytes > 0, '回收站大小不为零', String(s.trashBytes));
  }

  console.log('\n=== H. 并发写入不互相覆盖 ===');
  {
    const s2 = createAssetStore(path.join(TMP, 'assets2'));
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      s2.put({ kind: 'image', name: 'p' + i + '.png', data: PNG_1PX })));
    const l = await s2.list();
    eq(l.count, 12, '12 个并发写入全部保留（索引写入必须串行化）');
  }

  console.log('\n=== I. 空内容 / 坏索引 ===');
  {
    let err = '';
    try{ await store.put({ kind: 'image', data: '' }); }catch(e){ err = String(e.message); }
    ok(/为空/.test(err), '空内容直接拒绝，不写一个 0 字节的幽灵资产', err);

    fs.writeFileSync(path.join(TMP, 'assets', 'index.json'), '{ 这不是 json');
    const s3 = createAssetStore(path.join(TMP, 'assets'));
    const st = await s3.stat();
    eq(st.ok, true, '索引损坏时不能崩');
    const rec = await s3.reconcile();
    ok(rec.added.length > 0, '坏索引能靠扫描磁盘重建（文件才是真相）', String(rec.added.length));
  }

  console.log('\n=== J. 导出 ===');
  {
    const exp = createAssetStore(path.join(TMP, 'assets3'));
    const a = await exp.put({ kind: 'image', name: '拿得出手.png', data: PNG_1PX });
    const out = path.join(TMP, 'exported');
    const r = await exp.exportTo([a.id], out);
    eq(r.files.length, 1, '导出 1 个文件');
    ok(fs.existsSync(path.join(out, '拿得出手.png')), '导出后保留可读的文件名（能直接给别人）');
  }

  console.log('\n=== K. 3D 缩略图 ===');
  {
    const s = createAssetStore(path.join(TMP, 'thumb-test'));
    const a = await s.put({ kind: 'model', name: 'm.glb', ext: 'glb', data: Buffer.from('fake-glb') });
    const none = await s.readThumb(a.id);
    eq(none.ok, false, '没渲染过时返回 ok:false（调用方据此决定要不要现场渲染一张）');

    const saved = await s.saveThumb(a.id, PNG_1PX);
    eq(saved.ok, true, '能存缩略图');
    const back = await s.readThumb(a.id);
    eq(back.ok, true, '能读回来');
    ok(/^data:image\/png;base64,/.test(back.dataURL || ''), '读回 dataURL，直接给 <img> 用');

    const bad = await s.saveThumb(a.id, 'not-a-dataurl');
    eq(bad.ok, false, '不是 dataURL 直接拒绝');

    await s.remove([a.id]);
    eq((await s.readThumb(a.id)).ok, false, '资产删了缩略图跟着走（否则 thumbs/ 会一直变大）');
  }

  console.log('\n=== L. 缩略图孤儿对账 ===');
  {
    const s = createAssetStore(path.join(TMP, 'thumb-orphan'));
    const a = await s.put({ kind: 'model', data: Buffer.from('abc'), ext: 'glb' });
    await s.saveThumb(a.id, PNG_1PX);
    ok(fs.existsSync(s.thumbFile(a.id)), '缩略图确实写到了磁盘');
    // 模拟「用户在外面把模型文件删了」
    fs.rmSync(s.fileOf(a));
    const rec = await s.reconcile();
    ok(typeof rec.thumbsDropped === 'number', '对账结果里报出缩略图清理数', String(rec.thumbsDropped));
    ok(!fs.existsSync(s.thumbFile(a.id)), '孤儿缩略图被清掉');
  }

  try{ fs.rmSync(TMP, { recursive: true, force: true }); }catch(e){}

  console.log('\n结果：' + pass + ' / ' + (pass + fail) + ' 通过');
  if(fail) process.exit(1);
})();
