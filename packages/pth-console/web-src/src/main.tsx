import { render } from "preact";
import { App } from "./app";
import { bootstrapSession } from "./session";
import { initTheme } from "./theme";
import "./styles.css";

const mountPoint = document.getElementById("app");
if (!mountPoint) {
  throw new Error("operator-console: #app mount point missing");
}

initTheme();
// Fire-and-forget: the store drives banners/pills as the exchange settles.
void bootstrapSession();

render(<App />, mountPoint);
