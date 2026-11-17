import { useEffect, useState } from "react";
import type { TranslationMessage } from "../../i18n/index.js";
import { ApiError, getApiKeyBalance } from "../../services/api/client.js";

export function useApiKeyBalance(
  apiKey: string | null,
  delay = 0,
  refreshOnFocus = false,
): TranslationMessage | null {
  const [result, setResult] = useState<{ apiKey: string; message: TranslationMessage } | null>(
    null,
  );

  useEffect(() => {
    if (!apiKey) return;
    let active: AbortController | undefined;
    const refresh = async () => {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const show = (message: TranslationMessage) => {
        if (!controller.signal.aborted) setResult({ apiKey, message });
      };
      show({ key: "manualApiKeyBalanceLoading" });
      try {
        const balances = await getApiKeyBalance(apiKey, controller.signal);
        const amounts = balances.map(
          ({ currency, total_balance }) => `${currency} ${total_balance}`,
        );
        show(
          amounts.length
            ? { key: "manualApiKeyBalance", params: { amount: amounts.join(" · ") } }
            : { key: "manualApiKeyBalanceUnavailable" },
        );
      } catch (error) {
        show({
          key:
            error instanceof ApiError && error.status === 401
              ? "manualApiKeyInvalid"
              : "manualApiKeyBalanceUnavailable",
        });
      }
    };
    const timer = window.setTimeout(() => void refresh(), delay);
    if (refreshOnFocus) {
      window.addEventListener("focus", refresh);
      window.addEventListener("deepseek-balance-changed", refresh);
    }
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("deepseek-balance-changed", refresh);
      active?.abort();
    };
  }, [apiKey, delay, refreshOnFocus]);

  return result?.apiKey === apiKey ? result.message : null;
}
