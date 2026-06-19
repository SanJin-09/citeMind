import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type AgentRunEventRecord,
  type BackgroundJobRecord,
  type DesktopApi,
} from "../shared/contracts";

const api: DesktopApi = {
  system: {
    checkWorkerHealth: () => ipcRenderer.invoke(IPC_CHANNELS.checkWorkerHealth),
    restartWorker: () => ipcRenderer.invoke(IPC_CHANNELS.restartWorker),
    maintenanceStatus: () => ipcRenderer.invoke(IPC_CHANNELS.maintenanceStatus),
    cleanupStorage: () => ipcRenderer.invoke(IPC_CHANNELS.cleanupStorage),
  },
  seed: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getSeedStatus),
    saveCredential: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.saveSeedCredential, request),
    validateCredential: () =>
      ipcRenderer.invoke(IPC_CHANNELS.validateSeedCredential),
    deleteCredential: () =>
      ipcRenderer.invoke(IPC_CHANNELS.deleteSeedCredential),
    updateDefaults: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.updateSeedDefaults, request),
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
    onUpdated: (listener) => {
      const handler = (_event: unknown, payload: BackgroundJobRecord): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.backgroundJobUpdated, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.backgroundJobUpdated, handler);
      };
    },
  },
  agentRuns: {
    list: (knowledgeBaseId, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.listAgentRuns, {
        knowledgeBaseId,
        ...options,
      }),
    get: (runId) => ipcRenderer.invoke(IPC_CHANNELS.getAgentRun, runId),
    create: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.createAgentRun, request),
    updatePlan: (runId, plan, summary) =>
      ipcRenderer.invoke(IPC_CHANNELS.updateAgentRunPlan, {
        runId,
        plan,
        summary,
      }),
    recordStage: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordAgentRunStage, request),
    recordSkillLoaded: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordAgentRunSkillLoaded, request),
    transition: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.transitionAgentRun, request),
    pause: (runId) => ipcRenderer.invoke(IPC_CHANNELS.pauseAgentRun, runId),
    resume: (runId) => ipcRenderer.invoke(IPC_CHANNELS.resumeAgentRun, runId),
    cancel: (runId, reason) =>
      ipcRenderer.invoke(IPC_CHANNELS.cancelAgentRun, { runId, reason }),
    retry: (runId) => ipcRenderer.invoke(IPC_CHANNELS.retryAgentRun, runId),
    recover: () => ipcRenderer.invoke(IPC_CHANNELS.recoverAgentRuns),
    startToolCall: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.startAgentRunToolCall, request),
    recordToolOutput: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordAgentRunToolOutput, request),
    finishToolCall: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.finishAgentRunToolCall, request),
    requestConfirmation: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.requestAgentRunConfirmation, request),
    resolveConfirmation: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.resolveAgentRunConfirmation, request),
    recordDelegation: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordAgentRunDelegation, request),
    saveOutput: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.saveAgentRunOutput, request),
    onTraceEvent: (listener) => {
      const handler = (_event: unknown, payload: AgentRunEventRecord): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.agentRunTraceEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.agentRunTraceEvent, handler);
      };
    },
  },
  agentSkills: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.listAgentSkills),
    get: (skillId, version) =>
      ipcRenderer.invoke(IPC_CHANNELS.getAgentSkill, { skillId, version }),
    run: (request) => ipcRenderer.invoke(IPC_CHANNELS.runAgentSkill, request),
    invokeTool: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.invokeAgentTool, request),
  },
  sources: {
    importFiles: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.importSourceFiles, knowledgeBaseId),
    importWeb: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.importWebSource, request),
    parseChecks: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.listParseChecks, knowledgeBaseId),
    delete: (sourceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.deleteSource, sourceId),
    resolveDuplicate: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.resolveDuplicate, request),
    checkWebAll: (knowledgeBaseId, dueOnly = false) =>
      ipcRenderer.invoke(IPC_CHANNELS.checkAllWebSources, {
        knowledgeBaseId,
        dueOnly,
      }),
    checkWeb: (sourceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.checkWebSource, sourceId),
    versions: (sourceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.listSourceVersions, sourceId),
    versionDiff: (sourceId, versionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.getSourceVersionDiff, {
        sourceId,
        versionId,
      }),
    decideVersion: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.decideSourceVersion, request),
    updateMaintenance: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.updateSourceMaintenance, request),
    decideSuggestion: (sourceId, decision) =>
      ipcRenderer.invoke(IPC_CHANNELS.decideSourceSuggestion, {
        sourceId,
        decision,
      }),
    organization: (sourceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.getSourceOrganization, sourceId),
    classify: (sourceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.classifySource, sourceId),
    suggestTags: (sourceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.suggestSourceTags, sourceId),
    decideTag: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.decideSourceTag, request),
    decideRelation: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.decideSourceRelation, request),
  },
  indexes: {
    build: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.buildIndex, knowledgeBaseId),
    delete: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.deleteIndex, knowledgeBaseId),
    rebuild: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.rebuildIndex, knowledgeBaseId),
    status: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.getIndexStatus, knowledgeBaseId),
    list: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.listIndexVersions, knowledgeBaseId),
    estimate: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.estimateIndex, knowledgeBaseId),
    rollback: (knowledgeBaseId, indexVersionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.rollbackIndex, {
        knowledgeBaseId,
        indexVersionId,
      }),
    retry: (knowledgeBaseId, indexVersionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.retryIndex, {
        knowledgeBaseId,
        indexVersionId,
      }),
  },
  retrieval: {
    hybridSearch: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.hybridSearch, request),
  },
  conversations: {
    list: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.listConversations, knowledgeBaseId),
    messages: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.conversationMessages, conversationId),
    delete: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.deleteConversation, conversationId),
    setModel: (conversationId, modelId) =>
      ipcRenderer.invoke(IPC_CHANNELS.setConversationModel, {
        conversationId,
        modelId,
      }),
    answer: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.answerConversation, request),
    exportMarkdown: (conversationId, messageId) =>
      ipcRenderer.invoke(IPC_CHANNELS.exportConversationMarkdown, {
        conversationId,
        messageId,
      }),
    usageSummary: (knowledgeBaseId) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.conversationUsageSummary,
        knowledgeBaseId,
      ),
  },
  writing: {
    list: (knowledgeBaseId) =>
      ipcRenderer.invoke(IPC_CHANNELS.listWritingProjects, knowledgeBaseId),
    project: (projectId) =>
      ipcRenderer.invoke(IPC_CHANNELS.getWritingProject, projectId),
    create: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.createWritingProject, request),
    runSection: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.runWritingSection, request),
    updateSection: (sectionId, content) =>
      ipcRenderer.invoke(IPC_CHANNELS.updateWritingSection, {
        sectionId,
        content,
      }),
    auditSection: (sectionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.auditWritingSection, sectionId),
    exportWord: (projectId) =>
      ipcRenderer.invoke(IPC_CHANNELS.exportWritingWord, projectId),
  },
};

contextBridge.exposeInMainWorld("citeMind", api);
