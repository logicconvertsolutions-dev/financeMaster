import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IS_WEB } from "./api";
import { App } from "./App";
import "./styles.css";

const root = createRoot(document.getElementById("root"));
if (IS_WEB) {
  import("./web/WebGate").then(({ WebGate }) => root.render(<StrictMode><WebGate /></StrictMode>));
} else {
  root.render(<StrictMode><App /></StrictMode>);
}
