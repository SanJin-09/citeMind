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
  knowledgeBases: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.listKnowledgeBases),
    create: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.createKnowledgeBase, request),
    rename: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.renameKnowledgeBase, request),
    delete: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.deleteKnowledgeBase, knowledgeBaseId),
    listSources: (knowledgeBaseId) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.listKnowledgeBaseSources,
        knowledgeBaseId,
      ),
  },
  jobs: {
    list: (options) => ipcRenderer.invoke(IPC_CHANNELS.listJobs, options),
    listUnfinished: () => ipcRenderer.invoke(IPC_CHANNELS.listUnfinishedJobs),
    create: (request) => ipcRenderer.invoke(IPC_CHANNELS.createJob, request),
    update: (request) => ipcRenderer.invoke(IPC_CHANNELS.updateJob, request),
    pause: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.pauseJob, jobId),
    resume: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.resumeJob, jobId),
    cancel: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.cancelJob, jobId),
    retry: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.retryJob, jobId),
    recover: () => ipcRenderer.invoke(IPC_CHANNELS.recoverJobs),
  },
  sources: {
    importFiles: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.importSourceFiles, knowledgeBaseId),
    importWeb: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.importWebSource, request),
    parseChecks: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.listParseChecks, knowledgeBaseId),
  },
  indexes: {
    build: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.buildIndex, knowledgeBaseId),
    status: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.getIndexStatus, knowledgeBaseId),
  },
};

contextBridge.exposeInMainWorld("citeMind", api);
