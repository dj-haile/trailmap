// Trailmap — preload bridge. The ONLY doorway between renderer and platform (plan §6.3).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trailmap', {
  load: () => ipcRenderer.invoke('trailmap:load'),
  persist: (doc) => ipcRenderer.invoke('trailmap:persist', doc),
  exportToFile: () => ipcRenderer.invoke('trailmap:export'),          // M4
  importFromFile: () => ipcRenderer.invoke('trailmap:import'),        // M4
  listSnapshots: () => ipcRenderer.invoke('trailmap:list-snapshots'), // M2
  restoreSnapshot: (id) => ipcRenderer.invoke('trailmap:restore-snapshot', id), // M2
  openDataFolder: () => ipcRenderer.invoke('trailmap:open-data-folder'),        // M4
  onExternalChange: (cb) => {
    ipcRenderer.on('trailmap:external-change', (_e, doc) => cb(doc));
  },
});
