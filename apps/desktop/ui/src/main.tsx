import { render } from "solid-js/web";
import { App } from "./App";
import { inDesktopShell } from "./shell";
import "./theme.css";

render(() => <App />, document.getElementById("root")!);

// The window is created hidden. Showing it before this paint is what put a
// native title bar on a black webview, and then took the title bar away once
// the page caught up. Two frames: the first applies layout, the second has
// pixels, and only then does the window appear.
//
// This is a fast path only. A hidden window's frames do not tick, so this
// callback does not run until the window is on screen — which is why the shell
// shows the window itself if this has not happened shortly after boot. The
// shell is what guarantees the window appears; this only beats it to the paint
// on the platforms where the callback does fire.
if (inDesktopShell()) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
      });
    });
  });
}
