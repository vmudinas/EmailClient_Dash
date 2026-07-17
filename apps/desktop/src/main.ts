import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session
} from "electron";
import {
  importOptionsSchema,
  type ImportOptions
} from "@email-client/shared";
import {
  startServer,
  type StartedApi
} from "@email-client/api";

let startedApi: StartedApi | null = null;
let mainWindow: BrowserWindow | null = null;
let shuttingDown = false;

await app.whenReady();

const staticDir = app.isPackaged
  ? join(process.resourcesPath, "web")
  : join(app.getAppPath(), "..", "web", "dist");

startedApi = await startServer({
  dataDir: app.getPath("userData"),
  host: "0.0.0.0",
  port: 0,
  staticDir,
  devAuthBypass: false,
  logger: !app.isPackaged
});

registerIpc(startedApi);
configureSession();
mainWindow = createWindow(startedApi);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && startedApi) {
    mainWindow = createWindow(startedApi);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shuttingDown || !startedApi) return;
  event.preventDefault();
  shuttingDown = true;
  void startedApi.runtime.close().finally(() => app.quit());
});

function createWindow(api: StartedApi): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: "#f4f5f2",
    title: "Archive Mail",
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void import("electron").then(({ shell }) => shell.openExternal(url));
    return { action: "deny" };
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void window.loadURL(devServer);
  else void window.loadURL(api.url);
  return window;
}

function registerIpc(api: StartedApi): void {
  ipcMain.handle("runtime:get-config", () => ({
    apiBaseUrl: api.url,
    accessToken: "",
    platform: "desktop" as const
  }));

  ipcMain.handle("archive:select-and-import", async (_event, rawOptions: ImportOptions, accessToken: string) => {
    return api.runtime.runDesktopAction(accessToken, "desktop.archive.select_and_import", async () => {
      const options = importOptionsSchema.parse(rawOptions);
      const selected = await dialog.showOpenDialog(mainWindow!, {
        title: "Import email archive",
        buttonLabel: "Import archive",
        properties: ["openFile"],
        filters: [
          { name: "Email archives", extensions: ["pst", "mbox", "mbx"] },
          { name: "All files", extensions: ["*"] }
        ]
      });
      if (selected.canceled || !selected.filePaths[0]) return null;
      return api.runtime.imports.startImport(selected.filePaths[0], options);
    });
  });

  ipcMain.handle("import:cancel", (_event, jobId: string, accessToken: string) => {
    return api.runtime.runDesktopAction(accessToken, "desktop.import.cancel", () => {
      return api.runtime.imports.cancelImport(jobId);
    });
  });
  ipcMain.handle("import:resume", (_event, jobId: string, accessToken: string) => {
    return api.runtime.runDesktopAction(accessToken, "desktop.import.resume", () => {
      return api.runtime.imports.resumeImport(jobId);
    });
  });
  ipcMain.handle("archive:remove", async (_event, archiveId: string, accessToken: string) => {
    await api.runtime.runDesktopAction(accessToken, "desktop.archive.remove", () => {
      return api.runtime.removeArchive(archiveId);
    });
  });
  ipcMain.handle("sharing:set-enabled", (_event, enabled: boolean, accessToken: string) => {
    return api.runtime.runDesktopAction(accessToken, "desktop.sharing.set_enabled", () => {
      return api.runtime.setSharingEnabled(Boolean(enabled));
    }, true);
  });
}

function configureSession(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' http://127.0.0.1:*; frame-src blob:; object-src 'none'; base-uri 'none'"
        ]
      }
    });
  });
}
