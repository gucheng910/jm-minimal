// 暴露桌面标记 + 内置 DNS 清洗桥（渲染层通过 window.jmDns 使用）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__jmDesktop", true);

contextBridge.exposeInMainWorld("jmDns", {
  // 开关清洗（true=启用本地 DoH 解析代理，false=回系统 DNS）
  set: (enabled) => ipcRenderer.invoke("jm:dns:set", Boolean(enabled)),
  // 注册待清洗域名根（如 cdnhjk.net），main 进程维护域名池并刷新 PAC
  sync: (roots) => ipcRenderer.send("jm:dns:sync", Array.isArray(roots) ? roots : []),
  get: () => ipcRenderer.invoke("jm:dns:get"),
  // 状态推送订阅，返回取消函数
  onStatus: (cb) => {
    const listener = (_ev, state) => { try { cb(state); } catch { /* ignore */ } };
    ipcRenderer.on("jm:dns-status", listener);
    return () => ipcRenderer.removeListener("jm:dns-status", listener);
  }
});

contextBridge.exposeInMainWorld("jmUpdate", {
  // 检查更新（NSIS 安装版走 electron-updater；便携版查 GitHub 最新版）
  check: () => ipcRenderer.invoke("jm:update:check"),
  // 主动作：安装版下载完成后退出并安装；便携版打开下载页
  act: () => ipcRenderer.invoke("jm:update:act"),
  // 在文件夹里定位已下载的安装包（自动安装失败时手动装的兜底入口）
  reveal: () => ipcRenderer.invoke("jm:update:reveal"),
  // 状态推送订阅，返回取消函数
  onState: (cb) => {
    const listener = (_ev, state) => { try { cb(state); } catch { /* ignore */ } };
    ipcRenderer.on("jm:update-state", listener);
    return () => ipcRenderer.removeListener("jm:update-state", listener);
  }
});
