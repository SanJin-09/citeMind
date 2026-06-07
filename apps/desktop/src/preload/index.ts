import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type DesktopApi } from "../shared/contracts";

const api: DesktopApi = {
  system: {
    checkWorkerHealth: () => ipcRenderer.invoke(IPC_CHANNELS.checkWorkerHealth),
    restartWorker: () => ipcRenderer.invoke(IPC_CHANNELS.restartWorker),
  },
  seed: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getSeedStatus),
    saveCredential: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.saveSeedCredential, request),
    validateCredential: () =>
      ipcRenderer.invoke(IPC_CHANNELS.validateSeedCredential),
    deleteCredential: () =>
      ipcRenderer.invoke(IPC_CHANNELS.deleteSeedCredential),
  },
};

contextBridge.exposeInMainWorld("citeMind", api);
