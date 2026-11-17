import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { setupTheme } from "./app/theme.js";
import { ensureKatex } from "./services/markdown/katex.js";
import "./app/theme.css";
import "./app/global.css";

ensureKatex();
setupTheme();

createRoot(document.getElementById("root") as HTMLElement).render(<App />);

if (
  process.env.NODE_ENV === "production" &&
  window.isSecureContext &&
  location.protocol !== "file:" &&
  "serviceWorker" in navigator
) {
  void navigator.serviceWorker.register("./service-worker.js").catch(() => undefined);
}
