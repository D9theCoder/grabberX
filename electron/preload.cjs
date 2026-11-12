const { contextBridge, ipcRenderer } = require("electron");

// The only things the page may ask the shell for. main.cjs checks the sender's origin again.
contextBridge.exposeInMainWorld("gatherShell", {
  pickFolder: (defaultPath) => ipcRenderer.invoke("gather:pick-folder", defaultPath),
  openLogs: () => ipcRenderer.invoke("gather:open-logs"),
  trashItem: (filePath) => ipcRenderer.invoke("gather:trash-item", filePath),
  showItem: (filePath) => ipcRenderer.invoke("gather:show-item", filePath),
  openItem: (filePath) => ipcRenderer.invoke("gather:open-item", filePath),
  setTheme: (theme) => ipcRenderer.invoke("gather:set-theme", theme),
  getUpdateState: () => ipcRenderer.invoke("gather:update-state"),
  checkForUpdate: () => ipcRenderer.invoke("gather:check-update"),
  installUpdate: () => ipcRenderer.invoke("gather:install-update"),
  onUpdateState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("gather:update-state", handler);
    return () => ipcRenderer.removeListener("gather:update-state", handler);
  },
});
