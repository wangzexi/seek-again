import { useTranslate } from "../../i18n/index.js";

export function ProjectLink({ className, iconSize }: { className: string; iconSize: number }) {
  const t = useTranslate();
  return (
    <a
      href="https://github.com/wangzexi/seek-again"
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      <img src="./icon-192.png" width={iconSize} height={iconSize} alt="" />
      {t("appName")}
    </a>
  );
}
