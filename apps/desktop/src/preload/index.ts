import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type DesktopApi } from "../shared/contracts";

const api: DesktopApi = {
  system: {
    checkWorkerHealth: () => ipcRenderer.invoke(IPC_CHANNELS.checkWorkerHealth),
    restartWorker: () => ipcRenderer.invoke(IPC_CHANNELS.restartWorker),
  },
};

contextBridge.exposeInMainWorld("citeMind", api);
