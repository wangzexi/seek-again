import { create } from "zustand";
import type { TtsVoice } from "./api/speech.js";
import { normalizeLocation, type UserLocation } from "./location.js";

export const apiKeyPattern = /^sk-[A-Za-z0-9_-]{1,253}$/;

export type Locale = "zh-CN" | "en-US";

/** 主题偏好；默认跟随系统 */
export type ThemePreference = "light" | "dark" | "system";

/** 本机设置，存 localStorage：应用访问凭证、语言、主题、位置、系统提示词等 */
type Settings = {
  accessToken: string | null;
  deepSeekChatToken: string | null;
  deepSeekPlatformToken: string | null;
  systemPrompt: string;
  locale: Locale;
  themePreference: ThemePreference;
  location: UserLocation | null;
  ttsVoice: TtsVoice;
  thinking: boolean;
  search: boolean;
  siderCollapsed: boolean;
};

const KEYS = {
  accessToken: "chat-demo:access-token",
  deepSeekChatToken: "chat-demo:deepseek-chat-token",
  deepSeekPlatformToken: "chat-demo:deepseek-platform-token",
  systemPrompt: "chat-demo:system-prompt",
  locale: "chat-demo:locale",
  location: "chat-demo:location",
  themePreference: "chat-demo:theme-preference",
  ttsVoice: "chat-demo:tts-voice",
  thinking: "chat-demo:thinking",
  search: "chat-demo:search",
  siderCollapsed: "chat-demo:sider-collapsed",
} as const;

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
};

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (globalThis.navigator?.language ?? "zh").toLowerCase().startsWith("zh");

const initialAccessToken = (): string | null => {
  const saved = read(KEYS.accessToken);
  if (saved === null || apiKeyPattern.test(saved)) return saved;
  write(KEYS.accessToken, null);
  return null;
};

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale);
  if (saved === "zh-CN" || saved === "en-US") {
    return saved;
  }
  return isChineseBrowser() ? "zh-CN" : "en-US";
};

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? "null"));
    if (!location) {
      return null;
    }
    return isChineseBrowser()
      ? location.region === "CN" && location.province
        ? location
        : null
      : { region: location.region };
  } catch {
    return null;
  }
};

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference);
  return saved === "light" || saved === "dark" ? saved : "system";
};

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === "tide" ? "tide" : "stella");

export const useSettings = create<Settings>(() => ({
  accessToken: initialAccessToken(),
  deepSeekChatToken: read(KEYS.deepSeekChatToken),
  deepSeekPlatformToken: read(KEYS.deepSeekPlatformToken),
  systemPrompt: read(KEYS.systemPrompt) ?? "你是助手 DeepSeek，由深度求索公司创造。",
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === "true",
  search: read(KEYS.search) === "true",
  siderCollapsed: read(KEYS.siderCollapsed) === "true",
}));

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale);
  useSettings.setState({ locale });
};

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value);
  write(KEYS.location, location ? JSON.stringify(location) : null);
  useSettings.setState({ location });
};

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference);
  useSettings.setState({ themePreference });
};

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice);
  useSettings.setState({ ttsVoice });
};

export const setDeepSeekChatToken = (deepSeekChatToken: string | null) => {
  write(KEYS.deepSeekChatToken, deepSeekChatToken);
  useSettings.setState({ deepSeekChatToken });
};

export const setDeepSeekPlatformToken = (deepSeekPlatformToken: string | null) => {
  write(KEYS.deepSeekPlatformToken, deepSeekPlatformToken);
  useSettings.setState({ deepSeekPlatformToken });
};

export const setAccessToken = (accessToken: string | null) => {
  if (accessToken !== useSettings.getState().accessToken) setDeepSeekPlatformToken(null);
  write(KEYS.accessToken, accessToken);
  useSettings.setState({ accessToken });
};

export const setSystemPrompt = (systemPrompt: string) => {
  write(KEYS.systemPrompt, systemPrompt || null);
  useSettings.setState({ systemPrompt });
};

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking));
  useSettings.setState({ thinking });
};

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search));
  useSettings.setState({ search });
};

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed));
  useSettings.setState({ siderCollapsed });
};
