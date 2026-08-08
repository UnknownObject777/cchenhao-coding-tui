/**
 * VirtualTerminal 测试底座：把组件挂进真实 TUI 渲染管线，
 * 断言 xterm 仿真后的视口内容（而非 render() 的原始字符串）。
 */
import { afterEach } from "vitest";

import { TUI } from "../../vendor/pi-tui/src/index.ts";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";

export interface TuiHarness {
  tui: TUI;
  terminal: VirtualTerminal;
  /** 触发一次渲染并等 16ms 节流过后的视口稳定。 */
  render(): Promise<void>;
  /** 当前视口文本（行数组 join，不含 ANSI）。 */
  viewport(): string;
  stop(): void;
}

// 断言失败会跳过后续 h.stop()，统一在 afterEach 兜底，避免渲染节流悬挂 vitest。
const liveStops: Array<() => void> = [];
afterEach(() => {
  while (liveStops.length > 0) liveStops.pop()?.();
});

export function createTuiHarness(width = 80, height = 24): TuiHarness {
  const terminal = new VirtualTerminal(width, height);
  const tui = new TUI(terminal);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    tui.stop();
  };
  liveStops.push(stop);
  return {
    tui,
    terminal,
    render: async () => {
      tui.requestRender(true);
      await terminal.waitForRender();
    },
    viewport: () => terminal.getViewport().join("\n"),
    stop,
  };
}
