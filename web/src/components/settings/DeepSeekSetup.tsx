import { useEffect, useState } from "react";
import type { TranslationKey } from "../../i18n/index.js";
import { useTranslate } from "../../i18n/index.js";
import { ApiError, getApiKeyBalance } from "../../services/api/client.js";
import { useSettings } from "../../services/settings.js";
import platformKeyName from "../../../../shared/platformKeyName.json" with { type: "json" };
import { Button } from "../base/Button.js";
import { Modal } from "../base/Modal.js";
import { pause } from "./deepSeekSetupRequest.js";
import { DeepSeekQr } from "./DeepSeekQr.js";
import {
  closeDeepSeekSetup,
  openRechargeDialog,
  useDeepSeekSetupDialog,
  type DeepSeekSetupMode,
} from "./settingsDialogState.js";
import { useDeepSeekImport } from "./useDeepSeekImport.js";
import { historyImportMessage } from "./historyImportMessage.js";
import styles from "./DeepSeekSetup.module.css";

const steps = [
  { id: 1, title: "deepSeekSetupLogin" },
  { id: 2, title: "deepSeekSetupPlatformLogin" },
] as const satisfies ReadonlyArray<{ id: number; title: TranslationKey }>;

const balanceStepMessages = {
  checking: "manualApiKeyBalanceLoading",
  funded: "deepSeekSetupBalanceFound",
  unavailable: "manualApiKeyBalanceUnavailable",
  suggested: "deepSeekSetupTopUpSuggested",
  skipped: "deepSeekSetupTopUpSkipped",
  paid: "topUpPaid",
} as const;

async function checkBalance(key: string, signal: AbortSignal) {
  const balances = await getApiKeyBalance(key, signal);
  if (
    !balances.length ||
    !balances.every(
      ({ total_balance }) =>
        typeof total_balance === "string" &&
        total_balance.trim() !== "" &&
        Number.isFinite(Number(total_balance)),
    )
  ) {
    throw new ApiError("protocol", "Invalid DeepSeek balance amounts");
  }
  return balances;
}

async function checkNewKeyBalance(
  key: string,
  signal: AbortSignal,
  setCountdown: (seconds: number) => void,
) {
  const start = Date.now();
  const schedule = [3_000, 6_000, 9_000];
  for (const [index, offset] of schedule.entries()) {
    const next = start + offset;
    const updateCountdown = () => setCountdown(Math.max(0, Math.ceil((next - Date.now()) / 1000)));
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 250);
    try {
      await pause(Math.max(0, next - Date.now()), signal);
    } finally {
      window.clearInterval(timer);
    }
    signal.throwIfAborted();
    setCountdown(0);
    const remaining = start + (schedule[index + 1] ?? 10_000) - Date.now();
    if (remaining <= 0) continue;
    try {
      return await checkBalance(key, AbortSignal.any([signal, AbortSignal.timeout(remaining)]));
    } catch (error) {
      signal.throwIfAborted();
      if (index === schedule.length - 1) throw error;
    }
  }
  throw new Error("DeepSeek balance check timed out");
}

function ImportCountdown() {
  const t = useTranslate();
  const [seconds, setSeconds] = useState(60);

  useEffect(() => {
    const deadline = Date.now() + 60_000;
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return seconds > 0 ? (
    <p className={styles.status}>{t("deepSeekImportCountdown", { seconds })}</p>
  ) : (
    <p className={styles.status} role="status">
      {t("deepSeekImportLongWait")}
    </p>
  );
}

export function DeepSeekSetup() {
  const open = useDeepSeekSetupDialog((state) => state.open);
  const mode = useDeepSeekSetupDialog((state) => state.mode);
  return open ? <SetupContent key={mode} mode={mode} /> : null;
}

function SetupContent({ mode }: { mode: DeepSeekSetupMode }) {
  const t = useTranslate();
  const {
    retry,
    skipHistory,
    skipApi,
    apiSkipped,
    historySkipped,
    phase,
    step,
    status,
    qr,
    refreshQr,
    importResult,
    transfer,
    parsing,
  } = useDeepSeekImport(mode);
  const close = () => {
    if (phase !== "saving") closeDeepSeekSetup();
  };
  const complete = phase === "complete";
  const [topUp, setTopUp] = useState<keyof typeof balanceStepMessages>("checking");
  const [checkedBalance, setCheckedBalance] = useState("");
  const [balanceCountdown, setBalanceCountdown] = useState(0);
  const includesBalance = mode !== "history";
  const checkTopUp = complete && !apiSkipped && includesBalance;
  const balancePending = topUp === "checking" || topUp === "suggested";
  const balanceDone = topUp === "funded" || topUp === "paid";
  const finished = complete && !(checkTopUp && balancePending);

  useEffect(() => {
    if (!checkTopUp) return;
    const key = useSettings.getState().accessToken;
    if (!key?.startsWith("sk-")) {
      setTopUp("unavailable");
      return;
    }
    const controller = new AbortController();
    const load = async (afterPayment = false) => {
      try {
        const balances = afterPayment
          ? await checkBalance(key, controller.signal)
          : await checkNewKeyBalance(key, controller.signal, setBalanceCountdown);
        if (controller.signal.aborted) return;
        const needsTopUp = balances.every(({ total_balance }) => Number(total_balance) === 0);
        setCheckedBalance(
          balances.map(({ currency, total_balance }) => `${currency} ${total_balance}`).join(" · "),
        );
        if (afterPayment) {
          if (!needsTopUp) setTopUp((current) => (current === "suggested" ? "paid" : current));
        } else {
          setTopUp(needsTopUp ? "suggested" : "funded");
        }
      } catch {
        if (!controller.signal.aborted && !afterPayment) setTopUp("unavailable");
      }
    };
    const refresh = () => void load(true);
    window.addEventListener("deepseek-balance-changed", refresh);
    void load();
    return () => {
      controller.abort();
      window.removeEventListener("deepseek-balance-changed", refresh);
    };
  }, [checkTopUp]);

  const canSkipHistory =
    mode === "all" && !historySkipped && step === 1 && (phase === "idle" || phase === "running");
  const canSkipApi =
    mode === "all" &&
    !complete &&
    step === 2 &&
    phase !== "saving" &&
    status?.key !== "deepSeekPlatformCreating";
  const canRetry = phase === "idle" && status?.error;
  const importSummary = importResult && historyImportMessage(importResult);
  return (
    <Modal
      title={t(
        finished
          ? apiSkipped
            ? "deepSeekSetupFinished"
            : "deepSeekSetupReady"
          : mode === "history"
            ? "dataScanHistory"
            : "deepSeekSetupTitle",
      )}
      className={styles.dialog}
      mainClassName={styles.body}
      onClose={close}
      closable={phase !== "saving"}
      footer={
        finished ? (
          <Button key="ready" variant="primary" size="m" autoFocus onClick={closeDeepSeekSetup}>
            {t(apiSkipped || mode === "history" ? "deepSeekSetupFinish" : "deepSeekSetupStartChat")}
          </Button>
        ) : checkTopUp && topUp === "suggested" ? (
          <>
            <Button variant="outlined" size="m" onClick={() => setTopUp("skipped")}>
              {t("deepSeekSetupSkipStep")}
            </Button>
            <Button size="m" onClick={() => openRechargeDialog("scan")}>
              {t("deepSeekSetupScanTopUp")}
            </Button>
          </>
        ) : canSkipHistory || canSkipApi || canRetry ? (
          <>
            {canSkipHistory ? (
              <Button variant="outlined" size="m" onClick={skipHistory}>
                {t("deepSeekSetupSkipStep")}
              </Button>
            ) : null}
            {canSkipApi ? (
              <Button variant="outlined" size="m" onClick={skipApi}>
                {t("deepSeekSetupSkipStep")}
              </Button>
            ) : null}
            {canRetry ? (
              <Button variant="primary" size="m" autoFocus onClick={retry}>
                {t("retry")}
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {!complete && mode === "all" ? (
        <p className={styles.intro}>{t("deepSeekSetupIntro")}</p>
      ) : null}
      <ol className={styles.steps}>
        {steps.map(({ id, title }) => {
          if ((mode === "api" && id === 1) || (mode === "history" && id === 2)) return null;
          const skipped = id === 1 ? historySkipped : apiSkipped;
          const done = complete || id < step;
          const current = !complete && id === step;
          return (
            <li key={id} className={styles.step} aria-current={current ? "step" : undefined}>
              <span
                className={styles.marker}
                data-complete={done && !skipped ? "" : undefined}
                aria-hidden="true"
              >
                {skipped ? (
                  <span className={styles.skipMark} />
                ) : done ? (
                  "✓"
                ) : mode === "all" ? (
                  id
                ) : (
                  1
                )}
              </span>
              <div className={styles.detail}>
                <span className={styles.stepTitle}>{t(title)}</span>
                {id === 1 ? (
                  <p
                    className={styles.status}
                    role={skipped || importSummary ? "status" : undefined}
                  >
                    {skipped
                      ? t("deepSeekSetupHistorySkipped")
                      : importSummary
                        ? t(importSummary.key, importSummary.params)
                        : t("deepSeekSetupHistoryDescription")}
                  </p>
                ) : null}
                {id === 2 && complete && !apiSkipped ? (
                  <p className={styles.status} role="status">
                    {t("deepSeekSetupKeyCreated", { name: platformKeyName })}
                  </p>
                ) : null}
                {id === 2 && apiSkipped ? (
                  <p className={styles.status} role="status">
                    {t("deepSeekSetupApiSkipped")}
                  </p>
                ) : null}
                {id === 2 && !complete && !(current && status) ? (
                  <p className={styles.status}>{t("deepSeekSetupKeyDescription")}</p>
                ) : null}
                {id === 1 && current && parsing && !status?.error ? (
                  <div className={styles.parsing}>
                    <p>{t("deepSeekImportParsing", { count: parsing.count })}</p>
                    <p>{parsing.title || t("untitledChat")}</p>
                  </div>
                ) : current && status ? (
                  <p className={styles.status} role={status.error ? "alert" : "status"}>
                    {t(status.key, status.params)}
                  </p>
                ) : null}
                {id === 1 && current && transfer ? (
                  <div className={styles.transfer}>
                    <progress
                      aria-label={t("deepSeekImportTransfer")}
                      max={transfer.size}
                      value={transfer.size === undefined ? undefined : transfer.received}
                    />
                    <span>
                      {transfer.size
                        ? t("deepSeekImportTransferPercent", {
                            percent: Math.min(
                              100,
                              Math.floor((transfer.received / transfer.size) * 100),
                            ),
                          })
                        : t("deepSeekImportTransferSize", {
                            megabytes: (transfer.received / 1_000_000).toFixed(1),
                          })}
                    </span>
                  </div>
                ) : null}
                {id === 1 && current && status?.key === "deepSeekImportExporting" ? (
                  <ImportCountdown />
                ) : null}
              </div>
              {current && (qr || (phase === "idle" && !status && !historySkipped)) ? (
                <div className={styles.stepQr}>
                  <DeepSeekQr
                    image={qr?.image}
                    expired={qr?.expired ?? false}
                    refresh={refreshQr}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
        {includesBalance ? (
          <li
            className={styles.step}
            aria-current={checkTopUp && balancePending ? "step" : undefined}
          >
            <span
              className={styles.marker}
              data-complete={balanceDone ? "" : undefined}
              aria-hidden="true"
            >
              {balanceDone ? (
                "✓"
              ) : apiSkipped || !balancePending ? (
                <span className={styles.skipMark} />
              ) : mode === "all" ? (
                3
              ) : (
                2
              )}
            </span>
            <div className={styles.detail}>
              <span className={styles.stepTitle}>{t("deepSeekSetupTopUp")}</span>
              {checkTopUp ? (
                <p className={styles.status} role="status">
                  {topUp === "checking" && balanceCountdown > 0
                    ? t("deepSeekSetupBalanceCountdown", { seconds: balanceCountdown })
                    : t(balanceStepMessages[topUp], { amount: checkedBalance })}
                </p>
              ) : null}
            </div>
          </li>
        ) : null}
      </ol>
    </Modal>
  );
}
