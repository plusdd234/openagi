/* 记忆页（P2）：版本快照 + 经验条目
 *
 * 两件事放在一页，因为它们本质都是「记忆」：
 *   版本 = 状态的记忆（能回到过去）；经验 = 判断的记忆（知道什么写法被采纳过）。
 */

function renderMemPane(){
  renderVersionList();
  renderLessonList();
}

function memEmpty(text){
  const e = document.createElement('div');
  e.className = 'run-empty';
  e.textContent = text;
  return e;
}

function renderVersionList(){
  const host = $('verList');
  if(!host) return;
  host.innerHTML = '';
  if(!bp){ host.appendChild(memEmpty('打开一个工作流后可以存快照。')); return; }
  flowVersionList(bp.id).then(list => {
    host.innerHTML = '';
    if(!list.length){
      host.appendChild(memEmpty('还没有快照。采用变体前会自动存一份，也可以点上方「存快照」。'));
      return;
    }
    list.forEach(v => {
      const row = document.createElement('div');
      row.className = 'ver-row';
      const l1 = document.createElement('div');
      l1.className = 'ver-l1';
      const time = document.createElement('span');
      time.className = 'ver-time';
      time.textContent = runTimeText(v.at);
      const reason = document.createElement('span');
      reason.className = 'ver-reason';
      reason.textContent = v.reason || '快照';
      l1.append(time, reason);
      const sub = document.createElement('div');
      sub.className = 'run-sub';
      sub.textContent = v.nodes + ' 节点 · ' + fmtBytes(v.size);
      const tools = document.createElement('div');
      tools.className = 'bench-tools';
      const back = document.createElement('button');
      back.type = 'button';
      back.textContent = '恢复';
      back.title = '恢复到这份快照（当前状态会先自动存一份）';
      back.addEventListener('click', ev => { ev.stopPropagation(); memRestoreVersion(v.id); });
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '删除';
      del.addEventListener('click', ev => {
        ev.stopPropagation();
        if(!confirm('删除这份快照？不影响当前流程。')) return;
        flowVersionDelete(v.id).then(() => renderVersionList());
      });
      tools.append(back, del);
      row.append(l1, sub, tools);
      host.appendChild(row);
    });
  });
}

function renderLessonList(){
  const host = $('memList');
  if(!host) return;
  host.innerHTML = '';
  flowMemoryList({}).then(list => {
    host.innerHTML = '';
    if(!list.length){
      host.appendChild(memEmpty('还没有经验。采用变体、或手动写入后，这里会积累「哪些写法被采纳过」。'));
      return;
    }
    list.forEach(m => {
      const row = document.createElement('div');
      row.className = 'mem-row';
      const l1 = document.createElement('div');
      l1.className = 'mem-l1';
      const type = document.createElement('span');
      type.className = 'mem-type';
      type.textContent = ((NODE_DEFS[m.nodeType] || {}).title) || m.nodeType;
      const key = document.createElement('span');
      key.className = 'mem-key';
      key.textContent = m.key;
      const src = document.createElement('span');
      src.className = 'mem-src';
      src.textContent = m.source === 'variant' ? '变体' : m.source === 'manual' ? '手动' : m.source;
      if(m.hits > 1){
        const hits = document.createElement('span');
        hits.className = 'mem-hits';
        hits.textContent = '×' + m.hits;
        src.appendChild(hits);
      }
      l1.append(type, key, src);
      const txt = document.createElement('div');
      txt.className = 'mem-txt';
      const full = String(m.to || '');
      txt.textContent = full.length > 110 ? full.slice(0, 110) + '…' : full;
      txt.title = full;
      row.append(l1, txt);
      const tools = document.createElement('div');
      tools.className = 'bench-tools';
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '删除';
      del.addEventListener('click', ev => {
        ev.stopPropagation();
        flowMemoryDelete(m.id).then(() => renderLessonList());
      });
      tools.appendChild(del);
      row.appendChild(tools);
      host.appendChild(row);
    });
  });
}

/* 手动存一份快照（容量上限由 flowVersionSave 统一兜住） */
function memSaveVersionNow(){
  if(!bp){ bpToast('请先打开一个工作流'); return; }
  flowVersionSave(snapshotBp(), { reason: '手动快照' }).then(r => {
    bpToast(r.ok ? '已存快照（' + fmtBytes(r.size) + '）' : '存快照失败：' + (r.error || '未知原因'));
    if(r.ok) renderVersionList();
  });
}

/* 恢复：先把当前状态存一份（回滚本身也要能回滚），再整体替换 */
function memRestoreVersion(id){
  flowVersionGet(id).then(snap => {
    if(!snap || !snap.flow){ bpToast('快照不存在或已损坏'); return; }
    const at = runTimeText(snap.at);
    if(!confirm('恢复到 ' + at + ' 的快照？当前状态会先自动存一份，可以再滚回来。')) return;
    const cur = snapshotBp();
    flowVersionSave(cur, { reason: '恢复前（' + at + '）' }).then(() => {
      const merged = flowVersionMerge(cur, snap.flow);
      const idx = FLOWS.findIndex(f => f.id === merged.id);
      if(idx >= 0) FLOWS[idx] = merged; else FLOWS.unshift(merged);
      persistFlows();
      openFlow(merged.id);
      bpToast('已恢复到 ' + at + ' 的快照');
      renderMemPane();
    });
  });
}

function memClearLessons(){
  if(!confirm('清空全部经验？只删经验条目，不影响工作流。')) return;
  flowMemoryClear().then(() => { renderLessonList(); bpToast('经验已清空'); });
}
