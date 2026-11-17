export function setupRequest(path: string, signal: AbortSignal, body?: object, token?: string) {
  return fetch("/api/deepseek-import" + path, {
    method: "POST",
    headers: {
      "x-deepseek-local": "1",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "omit",
    cache: "no-store",
    signal,
  });
}

export async function readSetup<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "unavailable");
  }
  return data;
}

export function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function waitUntilVisible(signal: AbortSignal): Promise<void> | void {
  signal.throwIfAborted();
  if (!document.hidden) {
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", resume);
      signal.removeEventListener("abort", abort);
    };
    const resume = () => {
      if (!document.hidden) {
        cleanup();
        resolve();
      }
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    document.addEventListener("visibilitychange", resume);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// Only the status lookup is retried. The authorization code is exchanged once.
export async function pollSetupAuthorization(
  target: "chat" | "platform",
  id: string,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  let scan: { state: string; code?: string } | undefined;
  for (let attempt = 0; ; attempt++) {
    await waitUntilVisible(signal);
    try {
      response = await setupRequest("/authorize", signal, { target, id });
      const interrupted =
        [502, 503, 504].includes(response.status) &&
        !response.headers.get("content-type")?.includes("application/json");
      if (!interrupted || attempt === 2) {
        if (response.ok) scan = await response.clone().json();
        break;
      }
      await response.body?.cancel();
    } catch (error) {
      if (signal.aborted || !(error instanceof TypeError) || attempt === 2) {
        throw error;
      }
    }
    await waitUntilVisible(signal);
    await pause(750 * (attempt + 1), signal);
  }
  if (scan?.state !== "scanned") {
    return response;
  }
  if (!scan.code) {
    throw new Error("upstream");
  }
  await waitUntilVisible(signal);
  return setupRequest("/exchange", signal, { target, code: scan.code });
}
