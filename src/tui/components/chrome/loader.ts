/**
 * loader：pi-tui Loader + 主题色。pi-tui 的 stop() 只停动画不清文本，
 * 且 restartAnimation 内部会调 stop()——所以不能 override stop 来清文本，
 * 另提供 hide()（停动画 + 隐藏）；start() 时 updateDisplay 会恢复文本。
 */
import { Loader, type TUI } from "../../../../vendor/pi-tui/src/index.ts";
import { hex } from "../../theme/pi-tui-theme.ts";

export class ThemedLoader extends Loader {
  /** 停止动画并隐藏。 */
  hide(): void {
    super.stop();
    this.setText("");
  }
}

export function createLoader(tui: TUI): ThemedLoader {
  return new ThemedLoader(tui, hex("primary"), hex("textDim"), "Thinking...");
}
