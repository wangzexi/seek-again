import clsx from "clsx";
import { useRef, useState, type ReactNode } from "react";
import {
  IconCheckOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconSettingsOutline16,
} from "../base/icons.js";
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from "../../services/chat/backup.js";
import { useChatStore } from "../../services/chat/store.js";
import { regionCodes, getRegionName, provinces } from "../../services/location.js";
import {
  isChineseBrowser,
  setAccessToken,
  setDeepSeekChatToken,
  setDeepSeekPlatformToken,
  setLocale,
  setLocation,
  setSystemPrompt,
  setThemePreference,
  setTtsVoice,
  useSettings,
} from "../../services/settings.js";
import { useTranslate, type TranslationKey, type TranslationMessage } from "../../i18n/index.js";
import { ApiKeyField } from "./ApiKeyField.js";
import { Button } from "../base/Button.js";
import { Modal } from "../base/Modal.js";
import { Select } from "../base/Select.js";
import { showToast } from "../base/toastState.js";
import {
  closeSettings,
  openDeepSeekSetupFor,
  openRechargeDialog,
  useSettingsDialog,
  type SettingsSection,
} from "./settingsDialogState.js";
import { setupRequest } from "./deepSeekSetupRequest.js";
import { historyImportMessage } from "./historyImportMessage.js";
import { useApiKeyBalance } from "./useApiKeyBalance.js";
import styles from "./Settings.module.css";

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（登录迁移、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open);
  return open ? <SettingsContent /> : null;
};

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  { value: "data", label: "settingDialogAsideDataOptionLabel", icon: <IconDataOutline16 /> },
  {
    value: "general",
    label: "settingDialogAsideGeneralOptionLabel",
    icon: <IconSettingsOutline16 />,
  },
];

const SettingsContent = () => {
  const t = useTranslate();
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section);
  const [editingKey, setEditingKey] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const apiKey = useSettings((state) => state.accessToken);
  const signedInToDeepSeek = useSettings((state) =>
    Boolean(state.deepSeekChatToken || state.deepSeekPlatformToken),
  );
  const balance = useApiKeyBalance(section === "data" && !editingKey ? apiKey : null, 0, true);
  const balanceAmount = balance?.key === "manualApiKeyBalance" ? balance.params : undefined;
  const historyDelete = useHistoryDelete();
  const replacingHistory = useChatStore((state) => state.importingHistory);
  const historyBusy = historyDelete.busy || replacingHistory;
  const signOut = async () => {
    const { deepSeekPlatformToken } = useSettings.getState();
    setConfirmingSignOut(false);
    setSigningOut(true);
    setAccessToken(null);
    setDeepSeekChatToken(null);
    setDeepSeekPlatformToken(null);

    let revokeFailed = false;
    try {
      if (deepSeekPlatformToken) {
        const response = await setupRequest(
          "/revoke-key",
          AbortSignal.timeout(30_000),
          undefined,
          deepSeekPlatformToken,
        );
        revokeFailed = !response.ok;
      }
    } catch {
      revokeFailed = true;
    } finally {
      setSigningOut(false);
      showToast({ key: revokeFailed ? "dataDeepSeekRevokeFailed" : "dataDeepSeekSignedOut" });
    }
  };
  return (
    <>
      <Modal
        title={t("settings")}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings();
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === "general" ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
              <SystemPromptSetting />
            </>
          ) : (
            <>
              <ImportHistory disabled={historyBusy} />
              <SettingCell
                label={t("dataApiKey")}
                className={styles.dataCard}
                status={null}
                action={
                  apiKey ? (
                    <button
                      type="button"
                      className={clsx(styles.dataTextButton, styles.dataKeyReady)}
                      aria-label={t("dataApiKeyConfigured")}
                      onClick={() => setEditingKey(true)}
                    >
                      <IconCheckOutline16 />
                      {t("dataApiKeyFilled")}
                    </button>
                  ) : (
                    <div className={styles.dataActions}>
                      <button
                        type="button"
                        className={styles.dataTextButton}
                        onClick={() => setEditingKey(true)}
                      >
                        {t("dataEnterKey")}
                      </button>
                      <Button
                        variant="outlined"
                        size="s"
                        aria-label={t("dataScanApi")}
                        onClick={() => openDeepSeekSetupFor("api")}
                      >
                        {t("dataScanAction")}
                      </Button>
                    </div>
                  )
                }
              />
              <SettingCell
                label={
                  balanceAmount ? t("dataApiBalanceAmount", balanceAmount) : t("dataApiBalance")
                }
                className={styles.dataCard}
                status={balanceAmount ? null : balance}
                action={
                  <div className={styles.dataActions}>
                    <button
                      type="button"
                      className={styles.dataTextButton}
                      onClick={() => openRechargeDialog("website")}
                    >
                      {t("topUpWebsiteOption")}
                    </button>
                    <Button variant="outlined" size="s" onClick={() => openRechargeDialog("scan")}>
                      {t("topUpScanOption")}
                    </Button>
                  </div>
                }
              />
              <section className={styles.dataCleanup}>
                <ExportHistory disabled={historyBusy} />
                <SettingCell
                  label={t("dataDeleteLocal")}
                  status={null}
                  action={
                    <Button
                      variant="dangerOutlined"
                      size="m"
                      disabled={historyBusy}
                      onClick={historyDelete.open}
                    >
                      {t("delete")}
                    </Button>
                  }
                />
                <SettingCell
                  label={t("dataDeepSeekSignOut")}
                  status={null}
                  action={
                    <Button
                      variant="outlined"
                      size="m"
                      disabled={signingOut || (!signedInToDeepSeek && !apiKey)}
                      onClick={() => setConfirmingSignOut(true)}
                    >
                      {t("dataDeepSeekSignOutAction")}
                    </Button>
                  }
                />
              </section>
            </>
          )}
        </div>
      </Modal>
      {editingKey ? <ApiKeyField onClose={() => setEditingKey(false)} /> : null}
      {confirmingSignOut ? (
        <Modal
          title={t("dataDeepSeekSignOut")}
          className={styles.confirmDialog}
          onClose={() => setConfirmingSignOut(false)}
          footer={
            <div className={styles.confirmActions}>
              <Button variant="outlined" autoFocus onClick={() => setConfirmingSignOut(false)}>
                {t("cancel")}
              </Button>
              <Button variant="danger" onClick={() => void signOut()}>
                {t("dataDeepSeekSignOutAction")}
              </Button>
            </div>
          }
        >
          <ul className={styles.instructionSteps}>
            <li>{t("dataDeepSeekSignOutLocal")}</li>
            <li>{t("dataDeepSeekSignOutRevoke")}</li>
            <li>{t("dataDeepSeekSignOutKeep")}</li>
          </ul>
        </Modal>
      ) : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  );
};

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>;
}) => {
  const t = useTranslate();
  return (
    <Modal
      title={t("deleteAllSessionsModalTitle")}
      className={styles.confirmDialog}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.confirmActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t("cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? "historyDeleting" : "deleteAllSessions")}
          </Button>
        </div>
      }
    >
      {t("deleteAllSessionsModalDescription")}
    </Modal>
  );
};

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const deleting = useRef(false);

  const confirm = async () => {
    if (deleting.current) {
      return;
    }
    deleting.current = true;
    setBusy(true);
    try {
      await clearHistory();
      setOpened(false);
      showToast({ key: "historyDeleted" });
    } catch {
      showToast({ key: "historyDeleteFailed", type: "error" });
    } finally {
      deleting.current = false;
      setBusy(false);
    }
  };

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false);
      }
    },
    confirm,
  };
};

const LocationSetting = () => {
  const t = useTranslate();
  const locale = useSettings((state) => state.locale);
  const location = useSettings((state) => state.location);
  const province =
    location?.region === "CN"
      ? provinces.find((item) => item.code === location.province)
      : undefined;

  return (
    <SettingCell
      label={t("settingsLocation")}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t("settingsLocationProvince")}
                className={styles.provinceSelect}
                value={province?.code ?? ""}
                placeholder={t("settingsLocationProvince")}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: "CN", province: value });
                  }
                }}
              />
              <Select
                ariaLabel={t("settingsLocationCity")}
                className={styles.citySelect}
                value={province ? (location?.city ?? "") : ""}
                disabled={!province?.cities.length}
                placeholder={t("settingsLocationCity")}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: "CN", province: province.code, city: value });
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t("settingsLocationRegion")}
              className={styles.regionSelect}
              value={location?.region ?? ""}
              placeholder={t("settingsLocationRegion")}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  );
};

const SystemPromptSetting = () => {
  const t = useTranslate();
  const systemPrompt = useSettings((state) => state.systemPrompt);
  return (
    <div className={clsx(styles.cell, styles.promptCell)}>
      <label className={styles.label} htmlFor="global-system-prompt">
        {t("settingsSystemPrompt")}
      </label>
      <textarea
        id="global-system-prompt"
        className={styles.promptInput}
        value={systemPrompt}
        placeholder={t("settingsSystemPromptPlaceholder")}
        onChange={(event) => setSystemPrompt(event.target.value)}
        rows={4}
      />
    </div>
  );
};

const LocaleSetting = () => {
  const t = useTranslate();
  const locale = useSettings((state) => state.locale);
  return (
    <SettingCell
      label={t("settingsLocalePreference")}
      status={null}
      action={
        <Select
          ariaLabel={t("settingsLocalePreference")}
          value={locale}
          options={[
            { value: "zh-CN", label: t("settingsLocaleZhCN"), lang: "zh-CN" },
            { value: "en-US", label: t("settingsLocaleEnUS"), lang: "en" },
          ]}
          onChange={setLocale}
        />
      }
    />
  );
};

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate();
  const ttsVoice = useSettings((state) => state.ttsVoice);
  return (
    <SettingCell
      label={t("settingsTtsVoice")}
      status={null}
      action={
        <Select
          ariaLabel={t("settingsTtsVoice")}
          value={ttsVoice}
          options={[
            { value: "stella", label: t("settingsTtsVoiceStella") },
            { value: "tide", label: t("settingsTtsVoiceTide") },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  );
};

const ThemeSetting = () => {
  const t = useTranslate();
  const themePreference = useSettings((state) => state.themePreference);
  const label = t("avatarMenuSettingsDialogThemeItemLabel");

  return (
    <SettingCell
      label={label}
      status={null}
      action={
        <Select
          ariaLabel={label}
          value={themePreference}
          options={[
            { value: "light", label: t("avatarMenuSettingsDialogThemeSelectLightOption") },
            { value: "dark", label: t("avatarMenuSettingsDialogThemeSelectDarkOption") },
            { value: "system", label: t("avatarMenuSettingsDialogThemeSelectSystemOption") },
          ]}
          onChange={setThemePreference}
        />
      }
    />
  );
};

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null;

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
});

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string;
  description?: string;
  status: Status;
  action: ReactNode;
  className?: string;
}) => {
  const t = useTranslate();
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div
            className={clsx(styles.description, status?.error && styles.error)}
            role={status ? (status.error ? "alert" : "status") : undefined}
          >
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  );
};

const ImportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate();
  const input = useRef<HTMLInputElement>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const onImport = async (file: File) => {
    setBusy(true);
    setStatus({ key: "deepSeekImportPreparingLocal" });
    try {
      setStatus(historyImportMessage(await importHistory(file, "append")));
      setOpened(false);
    } catch (error) {
      setStatus(errorStatus("historyImportFailed", error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingCell
        label={t("dataHistoryTitle")}
        className={styles.dataCard}
        status={opened ? null : status}
        action={
          <div className={styles.dataActions}>
            <button
              type="button"
              className={styles.dataTextButton}
              disabled={disabled || busy}
              onClick={() => {
                setStatus(null);
                setOpened(true);
              }}
            >
              {t("historyImportChoose")}
            </button>
            <Button
              variant="outlined"
              size="s"
              disabled={disabled || busy}
              onClick={() => openDeepSeekSetupFor("history")}
            >
              {t("dataScanHistory")}
            </Button>
          </div>
        }
      />
      {opened ? (
        <Modal
          title={t("historyImport")}
          closable={!busy}
          onClose={() => {
            if (!busy) setOpened(false);
          }}
          footer={
            <Button size="m" disabled={busy || disabled} onClick={() => input.current?.click()}>
              {t(busy ? "deepSeekImportPreparingLocal" : "historyImportPickZip")}
            </Button>
          }
        >
          <ol className={styles.instructionSteps}>
            <li>
              {t("historyImportStepOpen")}{" "}
              <a href="https://chat.deepseek.com/" target="_blank" rel="noopener noreferrer">
                {t("historyImportWebsite")}
              </a>
              {t("historyImportStepSignIn")}
            </li>
            <li>{t("historyImportStepExport")}</li>
            <li>{t("historyImportStepChoose")}</li>
          </ol>
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void onImport(file);
            }}
          />
          {status?.error ? (
            <p className={styles.error} role="alert">
              {t(status.key, status.reason ? { message: t(status.reason) } : status.params)}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
};

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate();
  const empty = useChatStore((state) => state.sessions.length === 0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const onExport = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const { name, blob } = await exportHistory();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setStatus(errorStatus("historyExportFailed", error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingCell
      label={t("exportAllLabel")}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t("exportAllDownload")}
        </Button>
      }
    />
  );
};
