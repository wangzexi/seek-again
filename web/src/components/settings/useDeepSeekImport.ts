import { useCallback, useEffect, useRef, useState } from "react";
import type { TranslationKey, TranslationMessage } from "../../i18n/index.js";
import {
  setAccessToken,
  setDeepSeekChatToken,
  setDeepSeekPlatformToken,
  useSettings,
} from "../../services/settings.js";
import { importHistory } from "../../services/chat/backup.js";
import type { HistoryImportResult } from "../../services/chat/types.js";
import type { ArchiveSessionProgress } from "../../services/chat/history/importArchive.js";

import type { DeepSeekSetupMode } from "./settingsDialogState.js";

import { pause, pollSetupAuthorization, readSetup, setupRequest } from "./deepSeekSetupRequest.js";

const errors: Record<string, TranslationKey> = {
  browser: "deepSeekImportBrowserError",
  loginTimeout: "deepSeekImportExpired",
  unauthorized: "deepSeekImportUnauthorized",
  wechatAuthorization: "deepSeekImportWechatAuthorization",
  rateLimit: "deepSeekImportRateLimit",
  exportRateLimit: "deepSeekExportRateLimit",
  upstream: "deepSeekImportUpstream",
  unexpected: "deepSeekImportUpstream",
  download: "deepSeekImportDownloadFailed",
  save: "deepSeekImportSaveFailed",
  platformKey: "deepSeekPlatformKeyFailed",
  platformSignIn: "deepSeekPlatformSignInFailed",
  platformList: "deepSeekPlatformListFailed",
  platformDelete: "deepSeekPlatformDeleteFailed",
  platformIdentity: "deepSeekPlatformIdentityRequired",
  platformKeyLimit: "deepSeekPlatformKeyLimit",
};

type ImportStatus = TranslationMessage & { error?: boolean };
type ArchiveProgress = { received: number; size?: number };

async function receiveArchive(
  archive: Response,
  signal: AbortSignal,
  onProgress: (progress: ArchiveProgress) => void,
  relayed = true,
) {
  try {
    if (!archive.ok || !archive.body) {
      await archive.body?.cancel();
      throw new Error("download");
    }
    const length = relayed ? Number(archive.headers.get("X-Archive-Size")) : undefined;
    const size =
      length !== undefined && Number.isSafeInteger(length) && length > 0 ? length : undefined;
    let received = 0;
    let lastUpdate = 0;
    onProgress({ received, size });
    const stream = archive.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          const now = performance.now();
          if (now - lastUpdate >= 100 || received === size) {
            onProgress({ received, size });
            lastUpdate = now;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    const zip = await new Response(stream).blob();
    signal.throwIfAborted();
    if (size !== undefined && received !== size) {
      throw new Error("download");
    }
    return new File([zip], "deepseek-history.zip");
  } catch {
    throw new Error("download");
  }
}

async function downloadArchive(
  token: string,
  directUrl: string,
  signal: AbortSignal,
  onProgress: (progress: ArchiveProgress) => void,
) {
  try {
    if (directUrl) {
      const target = URL.parse(directUrl);
      if (target?.protocol === "https:") {
        try {
          const archive = await fetch(target, {
            signal,
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
            cache: "no-store",
          });
          const file = await receiveArchive(archive, signal, onProgress, false);
          const signature = await file.slice(0, 4).arrayBuffer();
          if (signature.byteLength !== 4 || new DataView(signature).getUint32(0) !== 0x504b0304) {
            throw new Error("download");
          }
          return file;
        } catch {
          signal.throwIfAborted();
          // Some official storage hosts do not allow cross-origin downloads.
        }
      }
    }
    return await receiveArchive(
      await setupRequest("/archive", signal, undefined, token),
      signal,
      onProgress,
    );
  } catch {
    throw new Error("download");
  }
}

export function useDeepSeekImport(mode: DeepSeekSetupMode) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "running" | "saving" | "complete">("idle");
  const [step, setStep] = useState<1 | 2>(mode === "api" ? 2 : 1);
  const [transfer, setTransfer] = useState<ArchiveProgress | null>(null);
  const [parsing, setParsing] = useState<ArchiveSessionProgress | null>(null);
  const [importResult, setImportResult] = useState<HistoryImportResult | null>(null);
  const [qr, setQr] = useState<{ image?: string; expired: boolean } | null>(null);
  const [historySkipped, setHistorySkipped] = useState(false);
  const [apiSkipped, setApiSkipped] = useState(false);
  const request = useRef<AbortController | null>(null);
  const refresh = useRef<(() => void) | null>(null);
  const creatingKey = useRef(false);

  const start = useCallback(
    async (platformOnly = mode === "api") => {
      if (request.current) {
        return;
      }
      const controller = new AbortController();
      const { signal } = controller;
      request.current = controller;
      setStep(platformOnly ? 2 : 1);
      setPhase("running");
      setStatus(platformOnly ? { key: "deepSeekPlatformChecking" } : null);
      if (!platformOnly) {
        setImportResult(null);
      }

      const signIn = async (target: "chat" | "platform") => {
        setStatus(null);
        for (;;) {
          setQr({ expired: false });
          const response = await setupRequest("/qr", signal, { target });
          if (!response.ok) {
            await readSetup(response);
          }
          const id = response.headers.get("x-wechat-qr-id");
          if (!id) {
            throw new Error("upstream");
          }
          const blob = await response.blob();
          signal.throwIfAborted();
          const image = URL.createObjectURL(blob);
          setQr({ image, expired: false });
          try {
            for (;;) {
              const poll = await readSetup<{ state: string; token?: string }>(
                await pollSetupAuthorization(target, id, signal),
              );
              signal.throwIfAborted();
              if (poll.state === "authorized" && poll.token) {
                setQr(null);
                return poll.token;
              }
              if (poll.state === "expired") {
                break;
              }
              if (poll.state !== "pending") {
                throw new Error("upstream");
              }
              await pause(750, signal);
            }
            setQr({ image, expired: true });
            await new Promise<void>((resolve, reject) => {
              const abort = () => {
                refresh.current = null;
                reject(signal.reason);
              };
              refresh.current = () => {
                refresh.current = null;
                signal.removeEventListener("abort", abort);
                resolve();
              };
              signal.addEventListener("abort", abort, { once: true });
            });
          } finally {
            URL.revokeObjectURL(image);
          }
          signal.throwIfAborted();
        }
      };

      const prepareExport = async (token: string) => {
        setStatus({ key: "deepSeekImportExporting" });
        const check = async (path: string) =>
          readSetup<{ archiveUrl?: string }>(await setupRequest(path, signal, undefined, token));
        let info = await check("/export");
        const deadline = Date.now() + 45 * 60_000;
        while (!info.archiveUrl) {
          if (Date.now() >= deadline) {
            throw new Error("loginTimeout");
          }
          await pause(5000, signal);
          info = await check("/export/status");
        }
        return info.archiveUrl;
      };

      try {
        let chatToken = useSettings.getState().deepSeekChatToken;
        if (!platformOnly) {
          let archiveUrl: string | undefined;
          if (chatToken) {
            try {
              archiveUrl = await prepareExport(chatToken);
            } catch (error) {
              if (!(error instanceof Error) || error.message !== "unauthorized") {
                throw error;
              }
              setDeepSeekChatToken(null);
              chatToken = null;
            }
          }
          if (!chatToken) {
            chatToken = await signIn("chat");
            setDeepSeekChatToken(chatToken);
          }
          archiveUrl ??= await prepareExport(chatToken);
          setPhase("saving");
          setStatus({ key: "deepSeekImportDownloading" });
          const file = await downloadArchive(chatToken, archiveUrl, signal, setTransfer);
          setTransfer(null);
          signal.throwIfAborted();
          setStatus({ key: "deepSeekImportPreparingLocal" });
          let lastProgressAt = -Infinity;
          const result = await importHistory(
            file,
            "append",
            (progress) => {
              const now = performance.now();
              if (!signal.aborted && now - lastProgressAt >= 100) {
                setParsing(progress);
                lastProgressAt = now;
              }
            },
            () => {
              if (!signal.aborted) {
                setParsing(null);
                setStatus({ key: "deepSeekImportSaving" });
              }
            },
          ).catch(() => {
            throw new Error("save");
          });
          signal.throwIfAborted();
          setImportResult(result);
          if (mode === "history") {
            setStatus(null);
            setPhase("complete");
            return;
          }
          setStep(2);
          setPhase("running");
        }

        const createKey = async (token: string) => {
          creatingKey.current = true;
          setStatus({ key: "deepSeekPlatformCreating" });
          try {
            const { apiKey } = await readSetup<{ apiKey: string }>(
              await setupRequest("/key", signal, undefined, token),
            );
            signal.throwIfAborted();
            if (!apiKey?.startsWith("sk-")) {
              throw new Error("platformKey");
            }
            setAccessToken(apiKey);
            setDeepSeekPlatformToken(token);
          } finally {
            creatingKey.current = false;
          }
        };

        const cached = useSettings.getState().deepSeekPlatformToken;
        let configured = false;
        for (const token of new Set([cached, chatToken])) {
          if (!token) {
            continue;
          }
          try {
            await createKey(token);
            configured = true;
            break;
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "platformSignIn") {
              throw error;
            }
            if (token === cached) {
              setDeepSeekPlatformToken(null);
            }
          }
        }
        if (!configured) {
          const token = await signIn("platform");
          setDeepSeekPlatformToken(token);
          await createKey(token);
        }
        signal.throwIfAborted();
        setPhase("complete");
        setStatus(null);
      } catch (error) {
        if (!signal.aborted) {
          const code = error instanceof Error ? error.message : "";
          setStatus({ key: errors[code] ?? "deepSeekImportUnavailable", error: true });
        }
      } finally {
        if (request.current === controller) {
          request.current = null;
          setQr(null);
          setTransfer(null);
          setParsing(null);
          setPhase((phase) => (phase === "complete" ? phase : "idle"));
        }
      }
    },
    [mode],
  );

  useEffect(() => {
    const close = () => request.current?.abort();
    const timer = window.setTimeout(() => void start(), 0);
    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) close();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", onPageHide);
      close();
    };
  }, [start]);

  const skipHistory = () => {
    if (step !== 1 || phase === "saving") {
      return;
    }
    request.current?.abort();
    request.current = null;
    setQr(null);
    setHistorySkipped(true);
    void start(true);
  };

  const skipApi = () => {
    if (step !== 2 || creatingKey.current) {
      return;
    }
    request.current?.abort();
    setApiSkipped(true);
    setQr(null);
    setStatus(null);
    setPhase("complete");
  };

  return {
    retry: () => void start(step === 2),
    skipHistory,
    skipApi,
    apiSkipped,
    historySkipped,
    phase,
    step,
    status,
    qr,
    refreshQr: () => refresh.current?.(),
    importResult,
    transfer,
    parsing,
  };
}
