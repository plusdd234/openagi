/* 单测：electron/media-store.js 的重命名与删除
 * 覆盖：普通改名 / 无扩展名沿用 / 字幕跟随 / 重名冲突 / 非法字符 /
 *       保留名 / 大小写改名 / 目录穿越 / 文件不存在 / 回收站优先。
 * 用法：node tools/media-store.js
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { createMediaStore } = require('../electron/media-store.js');

let pass = 0, fail = 0;
function ok(msg, cond){
  if(cond){ pass++; console.log(' ✅ ' + msg); }
  else{ fail++; console.log(' ❌ ' + msg); }
}
async function expectThrow(msg, fn, kw){
  try{ await fn(); fail++; console.log(' ❌ ' + msg + '（没有抛错）'); }
  catch(e){
    const m = String(e && e.message || e);
    if(kw && m.indexOf(kw) < 0){ fail++; console.log(' ❌ ' + msg + ' · 错误信息是：' + m); }
    else{ pass++; console.log(' ✅ ' + msg + ' · ' + m); }
  }
}
const exists = p => fsp.access(p).then(() => true, () => false);

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openagi-media-rename-'));
  const store = createMediaStore(root, {});
  await store.ensure();
  const dir = path.join(root, '某番剧');
  await fsp.mkdir(dir, { recursive: true });
  const write = async (rel, body) => {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body || 'x');
    return abs;
  };

  await write('某番剧/第01集.mp4', 'video');
  await write('某番剧/第01集.zh.vtt', 'WEBVTT');
  await write('某番剧/第01集.srt', 'sub');
  await write('某番剧/第02集.mp4', 'video');
  await write('某番剧/封面.png', 'img');

  // 1 普通改名 + 字幕跟随
  let r = await store.rename('某番剧/第01集.mp4', '第一话');
  ok('返回 ok 与新 id · ' + r.id, r.ok && r.id === '某番剧/第一话.mp4');
  ok('老文件已不在', !(await exists(path.join(dir, '第01集.mp4'))));
  ok('新文件已生成', await exists(path.join(dir, '第一话.mp4')));
  ok('无扩展名时沿用 .mp4', r.name === '第一话.mp4');
  const sc = r.sidecars.map(s => s.name).sort().join(',');
  ok('字幕 sidecar 跟着改名 · ' + sc, sc === '第一话.srt,第一话.zh.vtt');
  ok('旧字幕已不在', !(await exists(path.join(dir, '第01集.zh.vtt'))));

  // 2 重名冲突
  await expectThrow('改成同目录已存在的名字要报错', () => store.rename('某番剧/第一话.mp4', '第02集.mp4'), '同名');
  ok('冲突时原文件还在', await exists(path.join(dir, '第一话.mp4')));

  // 3 非法字符 / 保留名 / 空名
  await expectThrow('非法字符被拒', () => store.rename('某番剧/第一话.mp4', 'a:b'), '不能包含');
  await expectThrow('路径穿越被拒', () => store.rename('某番剧/第一话.mp4', '../跑出去.mp4'), '不能包含');
  await expectThrow('系统保留名被拒', () => store.rename('某番剧/第一话.mp4', 'CON.mp4'), '保留名');
  await expectThrow('空名被拒', () => store.rename('某番剧/第一话.mp4', '   '), '不能为空');
  await expectThrow('不支持的扩展名被拒', () => store.rename('某番剧/第一话.mp4', '第一话.exe'), '扩展名');

  // 4 大小写改名
  r = await store.rename('某番剧/第一话.mp4', '第一话.MP4');
  ok('只改扩展名大小写成功 · ' + r.name, r.ok && r.name === '第一话.MP4' && await exists(path.join(dir, '第一话.MP4')));

  // 5 只有扩展名大小写变化时 sidecar 不重复改
  ok('图片不会被当字幕动', await exists(path.join(dir, '封面.png')));

  // 6 同名（完全相同）→ unchanged
  r = await store.rename('某番剧/第一话.MP4', '第一话.MP4');
  ok('名字没变时返回 unchanged', r.ok && r.unchanged === true);

  // 7 文件不存在
  await expectThrow('文件不存在要报错', () => store.rename('某番剧/没有这一集.mp4', 'x.mp4'), '不存在');

  // 8 列表能扫到新名字
  const list = await store.list();
  const names = list.files.filter(f => f.folder === '某番剧').map(f => f.name).sort();
  ok('列表读回新名字 · ' + names.join(' | '), names.includes('第一话.MP4') && names.includes('第一话.zh.vtt') && names.includes('第一话.srt'));

  // 9 删除：默认走永久删除（deps 无 trash），并清理空目录
  const rmRes = await store.remove(['某番剧/第一话.MP4']);
  ok('删除返回 trashed=false · ' + JSON.stringify(rmRes), rmRes.ok && rmRes.trashed === false && rmRes.removed.length === 1);
  ok('文件已删', !(await exists(path.join(dir, '第一话.MP4'))));

  // 10 有 trash 依赖时调用它而不是 rm
  let trashed = null;
  const store2 = createMediaStore(root, { trash: async p => { trashed = p; } });
  await write('回收/片子.mp4', 'v');
  const rm2 = await store2.remove(['回收/片子.mp4']);
  ok('删除走 trashItem 回调', trashed && trashed.endsWith('片子.mp4') && rm2.trashed === true);
  ok('trash 回调模式文件仍在（模拟进回收站）', await exists(path.join(root, '回收/片子.mp4')));

  // 11 回收站失败不能假装成功
  const store3 = createMediaStore(root, { trash: async () => { throw new Error('设备被占用'); } });
  const rm3 = await store3.remove(['回收/片子.mp4']);
  ok('回收站失败返回 ok:false · ' + rm3.message, rm3.ok === false && /设备被占用/.test(rm3.message));
  ok('回收站失败时文件保留', await exists(path.join(root, '回收/片子.mp4')));

  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过') + '（通过 ' + pass + ' 项）');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
