import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IS_PHONE } from "./api";
import { App } from "./App";
import "./styles.css";

const root = createRoot(document.getElementById("root"));
if (IS_PHONE) {
  import("./phone/PhoneGate").then(({ PhoneGate }) => root.render(<StrictMode><PhoneGate /></StrictMode>));
} else {
  root.render(<StrictMode><App /></StrictMode>);
}
