import { useEffect, useRef, useState } from "react";
import { toDataURL } from "qrcode";
import { type TranslationKey, useTranslate } from "../../i18n/index.js";
import { setDeepSeekPlatformToken, useSettings } from "../../services/settings.js";
import { Button } from "../base/Button.js";
import { Modal } from "../base/Modal.js";
import { pollSetupAuthorization, setupRequest } from "./deepSeekSetupRequest.js";
import { useRechargeDialog } from "./settingsDialogState.js";
import styles from "./Settings.module.css";

const base = "/api/deepseek-top-up";
const rechargeAmounts = [1, 3, 5, 10] as const;

const rechargeRequest = (path: string, body: object, signal: AbortSignal, token?: string) =>
  fetch(base + path, {
    method: "POST",
    headers: {
      "x-deepseek-local": "1",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
    signal,
  });

type Order = { id: string; url: string; fallback: boolean };

export function RechargeDialog() {
  const open = useRechargeDialog((state) => state.open);
  return <RechargeContent open={open} />;
}

function RechargeContent({ open }: { open: boolean }) {
  const t = useTranslate();
  const [attempt, setAttempt] = useState(0);
  const [qr, setQr] = useState<string>();
  const token = useSettings((state) => state.deepSeekPlatformToken);
  const entry = useRechargeDialog((state) => state.entry);
  const [authError, setAuthError] = useState<TranslationKey>();
  const mobile =
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const [method, setMethod] = useState<"wechat" | "alipay">("alipay");
  const [amount, setAmount] = useState<(typeof rechargeAmounts)[number] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [orderError, setOrderError] = useState<TranslationKey>();
  const [order, setOrder] = useState<Order>();
  const [paymentQr, setPaymentQr] = useState<string>();
  const [paymentState, setPaymentState] = useState<"pending" | "paid" | "failed">("pending");
  const [checkingFailed, setCheckingFailed] = useState(false);
  const [unknownOrder, setUnknownOrder] = useState(false);
  const request = useRef<AbortController | null>(null);
  const paymentLink = method === "alipay" && (mobile || Boolean(order?.fallback));

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (!open || entry !== "scan" || token) return;
    const controller = new AbortController();
    const { signal } = controller;
    let url: string | undefined;
    let stopped: TranslationKey = "topUpUnavailable";
    setQr(undefined);
    setAuthError(undefined);
    const authorize = async () => {
      try {
        const response = await setupRequest("/qr", signal, { target: "platform" });
        const id = response.headers.get("x-wechat-qr-id");
        if (!response.ok || !id) throw new Error("qr");
        const image = await response.blob();
        signal.throwIfAborted();
        url = URL.createObjectURL(image);
        setQr(url);
        for (;;) {
          const poll = await pollSetupAuthorization("platform", id, signal);
          if (poll.status === 401) {
            stopped = "deepSeekImportWechatAuthorization";
            throw new Error("authorization");
          }
          if (!poll.ok) throw new Error("poll");
          const result = (await poll.json()) as { state?: string; token?: string };
          signal.throwIfAborted();
          if (result.state === "authorized" && result.token) {
            setDeepSeekPlatformToken(result.token);
            return;
          }
          if (result.state === "expired") break;
          await new Promise((resolve) => window.setTimeout(resolve, 750));
        }
        stopped = "topUpQrExpired";
        throw new Error("expired");
      } catch {
        if (!signal.aborted) {
          setQr(undefined);
          setAuthError(stopped);
        }
      }
    };
    void authorize();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [attempt, token, open, entry]);

  const createOrder = async () => {
    if (!token || amount === null || request.current || unknownOrder || order) return;
    const controller = new AbortController();
    request.current = controller;
    setSubmitting(true);
    setOrderError(undefined);
    setCheckingFailed(false);
    try {
      const response = await rechargeRequest(
        "/order",
        {
          amount,
          method: mobile && method === "alipay" ? "alipayMobile" : method,
          requestId: crypto.randomUUID(),
        },
        controller.signal,
        token,
      );
      if (response.status === 401) {
        if (useSettings.getState().deepSeekPlatformToken === token) setDeepSeekPlatformToken(null);
        return;
      }
      if (response.status === 403) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setOrderError(
          data?.error === "identityRequired" ? "topUpIdentityRequired" : "topUpRejected",
        );
        return;
      }
      if (response.status === 400 || response.status === 422 || response.status === 429) {
        setOrderError("topUpRejected");
        return;
      }
      if (!response.ok) throw new Error("order");
      const data = (await response.json()) as Order;
      if (typeof data.id !== "string" || typeof data.url !== "string") throw new Error("order");
      setOrder(data);
      setPaymentState("pending");
    } catch {
      if (!controller.signal.aborted) {
        setOrderError("topUpOrderUnknown");
        setUnknownOrder(true);
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!order || paymentLink) return;
    let active = true;
    void toDataURL(order.url, { width: 200, margin: 2 })
      .then((image) => {
        if (active) setPaymentQr(image);
      })
      .catch(() => {
        if (active) setOrderError("topUpUnavailable");
      });
    return () => {
      active = false;
    };
  }, [order, paymentLink]);

  useEffect(() => {
    if (!open || !order || !token || paymentState !== "pending") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (controller.signal.aborted) return;
      if (document.visibilityState !== "hidden") {
        try {
          const response = await rechargeRequest(
            "/status",
            { id: order.id },
            controller.signal,
            token,
          );
          if (response.status === 401) {
            if (useSettings.getState().deepSeekPlatformToken === token)
              setDeepSeekPlatformToken(null);
            return;
          }
          if (response.status === 403) {
            setCheckingFailed(true);
            return;
          }
          if (!response.ok) throw new Error("status");
          const result = (await response.json()) as { state?: string };
          if (controller.signal.aborted) return;
          setCheckingFailed(false);
          if (result.state === "paid" || result.state === "failed") {
            setPaymentState(result.state);
            if (result.state === "paid")
              window.dispatchEvent(new Event("deepseek-balance-changed"));
            return;
          }
        } catch {
          if (controller.signal.aborted) return;
          setCheckingFailed(true);
        }
      }
      timer = setTimeout(() => void poll(), 5000);
    };
    timer = setTimeout(() => void poll(), 5000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [order, token, paymentState, open]);

  const done = paymentState !== "pending";
  const close = () => {
    if (submitting) return;
    useRechargeDialog.setState({ open: false });
    if (!order || done) {
      setOrder(undefined);
      setPaymentQr(undefined);
      setPaymentState("pending");
      setAmount(null);
    }
  };

  if (!open) return null;
  if (entry === "website") {
    return (
      <Modal title={t("topUpWebsiteOption")} closable onClose={close}>
        <ol className={styles.instructionSteps}>
          <li>
            <a
              href="https://platform.deepseek.com/top_up"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("topUpOpenWebsite")}
            </a>{" "}
            {t("topUpWebsiteSignIn")}
          </li>
          <li>{t("topUpWebsiteAmount")}</li>
          <li>{t("topUpWebsiteReturn")}</li>
        </ol>
      </Modal>
    );
  }
  return (
    <Modal
      title={t("topUpTitle")}
      closable={!submitting}
      onClose={close}
      footer={
        !token && authError ? (
          <Button size="m" onClick={() => setAttempt((value) => value + 1)}>
            {t("retry")}
          </Button>
        ) : token && !order ? (
          <Button
            size="m"
            block
            disabled={amount === null || submitting || unknownOrder}
            onClick={() => void createOrder()}
          >
            {t(submitting ? "topUpOrdering" : "topUpCreateOrder")}
          </Button>
        ) : done ? (
          <Button size="m" onClick={close}>
            {t("close")}
          </Button>
        ) : undefined
      }
    >
      {!token ? (
        <>
          <p>{t("topUpSignIn")}</p>
          {qr ? (
            <img className={styles.rechargeQr} src={qr} alt={t("deepSeekQrAlt")} />
          ) : (
            <p role={authError ? "alert" : "status"}>{t(authError ?? "deepSeekQrLoading")}</p>
          )}
        </>
      ) : order ? (
        <>
          <p>{t("topUpOrderAmount", { amount: amount ?? "" })}</p>
          <div className={styles.rechargePayment}>
            {done ? (
              <p role="status">{t(paymentState === "paid" ? "topUpPaid" : "topUpPaymentFailed")}</p>
            ) : (
              <>
                {paymentQr && !paymentLink ? (
                  <>
                    <img className={styles.rechargeQr} src={paymentQr} alt={t("topUpPaymentQr")} />
                    {mobile && method === "wechat" ? (
                      <p>
                        <a href={paymentQr} download="deepseek-wechat-payment.png">
                          {t("topUpSavePaymentQr")}
                        </a>{" "}
                        {t("topUpWechatAlbum")}
                      </p>
                    ) : null}
                  </>
                ) : paymentLink ? (
                  <p>
                    <a href={order.url} target="_blank" rel="noopener noreferrer">
                      {t("topUpOpenAlipay")}
                    </a>
                  </p>
                ) : null}
                <p role="status">{t(checkingFailed ? "topUpStatusUnavailable" : "topUpWaiting")}</p>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <p>{t("topUpAccountHint")}</p>
          <fieldset disabled={submitting || unknownOrder} className={styles.rechargeMethods}>
            <legend>{t("topUpAmount")}</legend>
            {rechargeAmounts.map((option) => (
              <label key={option}>
                <input
                  type="radio"
                  name="top-up-amount"
                  value={option}
                  checked={amount === option}
                  onChange={() => {
                    setAmount(option);
                    setOrderError(undefined);
                  }}
                />
                <span>¥{option}</span>
              </label>
            ))}
          </fieldset>
          <fieldset disabled={submitting || unknownOrder} className={styles.rechargeProviders}>
            <legend>{t("topUpMethod")}</legend>
            {(["alipay", "wechat"] as const).map((provider) => (
              <label key={provider}>
                <input
                  type="radio"
                  name="top-up-method"
                  value={provider}
                  checked={method === provider}
                  onChange={() => setMethod(provider)}
                />
                <span>{t(provider === "wechat" ? "topUpWechat" : "topUpAlipay")}</span>
              </label>
            ))}
          </fieldset>
        </>
      )}
      {orderError ? (
        <p role="alert" className={styles.error}>
          {t(orderError)}
        </p>
      ) : null}
    </Modal>
  );
}
