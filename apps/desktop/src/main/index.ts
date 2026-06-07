import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { registerIpcHandlers } from "./ipc";
import { logger } from "./logger";
import { PythonWorkerManager } from "./python-worker-manager";

const workerManager = new PythonWorkerManager();
let allowQuit = false;

app.setName("citeMind");

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return window;
}

app.whenReady().then(async () => {
  registerIpcHandlers(workerManager);
  await workerManager
    .start()
    .catch((error) => logger.error("Python Worker startup failed", error));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", (event) => {
  if (allowQuit) {
    return;
  }

  event.preventDefault();
  void workerManager.stop().finally(() => {
    allowQuit = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
