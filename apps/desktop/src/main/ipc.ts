import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../shared/contracts";
import type { PythonWorkerManager } from "./python-worker-manager";

export function registerIpcHandlers(workerManager: PythonWorkerManager): void {
  ipcMain.removeHandler(IPC_CHANNELS.checkWorkerHealth);
  ipcMain.removeHandler(IPC_CHANNELS.restartWorker);

  ipcMain.handle(IPC_CHANNELS.checkWorkerHealth, () => workerManager.health());
  ipcMain.handle(IPC_CHANNELS.restartWorker, () => workerManager.restart());
}
