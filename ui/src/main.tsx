import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyReading, readReading } from "./reading";
import { setLangSetting } from "./i18n";
import "./index.css";

// Before the first render, so a stored reading setting never flashes the default look, and <html
// lang> names the language the first render uses (index.html ships "en").
const reading = readReading();
applyReading(reading);
setLangSetting(reading.lang);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
