export interface WorkerHealth {
  status: "ok";
  service: "citemind-worker";
  protocolVersion: "2.0";
  pid: number;
  storage?: {
    ready: boolean;
    schemaVersion: number;
    fts5Enabled: boolean;
    vectorDimension: number;
  };
}

export interface DesktopApi {
  system: {
    checkWorkerHealth: () => Promise<WorkerHealth>;
    restartWorker: () => Promise<WorkerHealth>;
  };
}

export const IPC_CHANNELS = {
  checkWorkerHealth: "citemind:system:check-worker-health",
  restartWorker: "citemind:system:restart-worker",
} as const;
