import { useEffect, useRef, useState } from "react";
import { useTranslate, type TranslationKey } from "../../i18n/index.js";
import { ApiError, registerApiKey } from "../../services/api/client.js";
import { setAccessToken, useSettings } from "../../services/settings.js";
import { Button } from "../base/Button.js";
import { Modal } from "../base/Modal.js";
import { showToast } from "../base/toastState.js";
import { useApiKeyBalance } from "./useApiKeyBalance.js";
import styles from "./Settings.module.css";

export function ApiKeyField({ onClose }: { onClose: () => void }) {
  const t = useTranslate();
  const savedKey = useSettings((state) => state.accessToken);
  const [value, setValue] = useState(() => (savedKey?.startsWith("sk-") ? savedKey : ""));
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const request = useRef<AbortController | null>(null);
  const title = t("manualApiKeyTitle");

  useEffect(() => () => request.current?.abort(), []);

  const apiKey = value.trim();
  const balance = useApiKeyBalance(/^sk-[A-Za-z0-9_-]{24,253}$/.test(apiKey) ? apiKey : null, 350);

  const save = async () => {
    if (!apiKey || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setVerifying(true);
    setError(null);
    try {
      const token = await registerApiKey(apiKey, controller.signal);
      controller.signal.throwIfAborted();
      setAccessToken(token);
      showToast({ key: "manualApiKeySaved" });
      onClose();
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof ApiError && (cause.status === 400 || cause.status === 401)
          ? "manualApiKeyInvalid"
          : "manualApiKeyFailed",
      );
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setVerifying(false);
    }
  };

  return (
    <Modal
      title={title}
      closable
      onClose={onClose}
      footer={
        <>
          {savedKey ? (
            <Button
              variant="dangerOutlined"
              size="m"
              disabled={verifying}
              onClick={() => {
                setAccessToken(null);
                onClose();
              }}
            >
              {t("dataApiKeyClear")}
            </Button>
          ) : null}
          <Button size="m" disabled={verifying || !value.trim()} onClick={() => void save()}>
            {t(verifying ? "manualApiKeyVerifying" : "manualApiKeySave")}
          </Button>
        </>
      }
    >
      <ol className={styles.instructionSteps}>
        <li>
          {t("manualApiKeyStepOpenBefore")}{" "}
          <a
            href="https://platform.deepseek.com/api_keys"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("manualApiKeyPlatform")}
          </a>
          {t("manualApiKeyStepOpenAfter")}
        </li>
        <li>{t("manualApiKeyStepCreate")}</li>
        <li>{t("manualApiKeyStepPaste")}</li>
      </ol>
      <input
        className={styles.apiKeyInput}
        type="password"
        aria-label="DeepSeek API Key"
        placeholder="sk-…"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        disabled={verifying}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) void save();
        }}
      />
      {balance ? (
        <p className={styles.description} role="status">
          {t(balance.key, balance.params)}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {t(error)}
        </p>
      ) : null}
    </Modal>
  );
}
