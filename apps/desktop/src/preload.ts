import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopBridge,
  ImportOptions
} from "@email-client/shared";

const bridge: DesktopBridge = {
  getRuntimeConfig: () => ipcRenderer.invoke("runtime:get-config"),
  selectAndImport: (options: ImportOptions, accessToken: string) => {
    return ipcRenderer.invoke("archive:select-and-import", options, accessToken);
  },
  cancelImport: (jobId: string, accessToken: string) => ipcRenderer.invoke("import:cancel", jobId, accessToken),
  resumeImport: (jobId: string, accessToken: string) => ipcRenderer.invoke("import:resume", jobId, accessToken),
  removeArchive: (archiveId: string, accessToken: string) => ipcRenderer.invoke("archive:remove", archiveId, accessToken),
  setSharingEnabled: (enabled: boolean, accessToken: string) => {
    return ipcRenderer.invoke("sharing:set-enabled", enabled, accessToken);
  }
};

contextBridge.exposeInMainWorld("emailClient", bridge);
