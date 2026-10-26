/* 预加载脚本：只暴露「查看版本 / 订阅内容更新」两件事。
 * 渲染层不需要 Node 能力，继续保持 nodeIntegration:false。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openagiDesktop', {
  versions: () => ipcRenderer.invoke('app:versions'),
  onContentUpdated: cb => {
    if(typeof cb !== 'function') return;
    ipcRenderer.on('content:updated', (_e, info) => cb(info));
  },
  onContentProgress: cb => {
    if(typeof cb !== 'function') return;
    ipcRenderer.on('content:progress', (_e, info) => cb(info));
  }
});
