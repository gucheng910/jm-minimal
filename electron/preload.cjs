// 暴露桌面标记（用于跳过 SW 注册等 Web-only 行为）
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("__jmDesktop", true);
