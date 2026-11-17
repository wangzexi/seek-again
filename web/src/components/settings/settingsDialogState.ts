import { create } from "zustand";
import { useSettings } from "../../services/settings.js";

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = "general" | "data";

/** 设置弹窗：侧边栏底部、未登录时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: "data" as SettingsSection,
}));

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section });

export const closeSettings = () => useSettingsDialog.setState({ open: false });

export type DeepSeekSetupMode = "all" | "api" | "history";

export const useDeepSeekSetupDialog = create(() => ({
  open: false,
  mode: "all" as DeepSeekSetupMode,
}));

export const openDeepSeekSetupFor = (mode: DeepSeekSetupMode) => {
  closeSettings();
  useDeepSeekSetupDialog.setState({ open: true, mode });
};

export const openDeepSeekSetup = () => openDeepSeekSetupFor("all");

export const closeDeepSeekSetup = () => useDeepSeekSetupDialog.setState({ open: false });

/** 未登录时打开向导。 */
export const ensureAccessToken = (mode: DeepSeekSetupMode = "all") => {
  if (useSettings.getState().accessToken) {
    return true;
  }
  openDeepSeekSetupFor(mode);
  return false;
};

type RechargeEntry = "website" | "scan";

export const useRechargeDialog = create(() => ({
  open: false,
  entry: "scan" as RechargeEntry,
}));

export const openRechargeDialog = (entry: RechargeEntry) =>
  useRechargeDialog.setState({ open: true, entry });
