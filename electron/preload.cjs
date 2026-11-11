const { contextBridge, ipcRenderer } = require("electron");

// The only things the page may ask the shell for. main.cjs checks the sender's origin again.
contextBridge.exposeInMainWorld("gatherShell", {
  pickFolder: (defaultPath) => ipcRenderer.invoke("gather:pick-folder", defaultPath),
  openLogs: () => ipcRenderer.invoke("gather:open-logs"),
});
