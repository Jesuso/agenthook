import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyReading, readReading } from "./reading";
import "./index.css";

// Before the first render, so a stored reading setting never flashes the default look.
applyReading(readReading());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
