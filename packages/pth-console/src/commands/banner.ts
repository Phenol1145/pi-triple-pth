/**
 * commands/banner.ts —— pth 命令输出的统一横幅。
 * 不 import framework（PTL 侧）；版本由 pth-console 包自身声明。
 */

export const PTH_CONSOLE_VERSION = "1.4.0";

export function printPthBanner(): void {
  console.log("");
  console.log(`  \x1b[36m\x1b[1mPi-Triple PTH\x1b[0m \x1b[2mv${PTH_CONSOLE_VERSION}\x1b[0m`);
  console.log("");
}
