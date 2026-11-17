import type { TranslationMessage } from "../../i18n/index.js";
import type { HistoryImportResult } from "../../services/chat/types.js";

export function historyImportMessage({
  imported,
  updated,
  skipped,
}: HistoryImportResult): TranslationMessage {
  if (updated > 0) {
    return { key: "deepSeekImportMerged", params: { imported, updated, skipped } };
  }
  if (imported > 0) {
    return {
      key: skipped > 0 ? "deepSeekImportSucceededWithDuplicates" : "deepSeekImportSucceeded",
      params: { count: imported, skipped },
    };
  }
  return skipped > 0
    ? { key: "deepSeekImportAllDuplicates", params: { count: skipped } }
    : { key: "deepSeekImportEmpty" };
}
