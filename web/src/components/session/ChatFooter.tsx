import { useEffect, useState } from "react";
import { useTranslate } from "../../i18n/index.js";
import { pricingPeriod } from "../../services/api/pricingPeriod.js";
import styles from "./ChatFooter.module.css";

const pricingLabels = {
  peak: "apiPricingPeak",
  offPeak: "apiPricingOffPeak",
  unknown: "apiPricingSchedule",
} as const;

export function ChatFooter() {
  const t = useTranslate();
  const [period, setPeriod] = useState(() => pricingPeriod(new Date()));

  useEffect(() => {
    let timer: number;
    const update = () => {
      window.clearTimeout(timer);
      setPeriod(pricingPeriod(new Date()));
      timer = window.setTimeout(update, 60_000 - (Date.now() % 60_000));
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return (
    <div className={styles.footer}>
      <span>{t("contentCaveat")}</span>
      <a
        href="https://api-docs.deepseek.com/quick_start/pricing/"
        target="_blank"
        rel="noopener noreferrer"
      >
        {t(pricingLabels[period])}
      </a>
    </div>
  );
}
