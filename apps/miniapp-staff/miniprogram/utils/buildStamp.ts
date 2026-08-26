/**
 * 构建标记。**不要手改这个文件** —— 发版脚本（tools/miniapp-ship.mjs）在 upload
 * 前把真值写进来、传完立刻还原成下面这份占位，所以 git 里它永远是 dev。
 *
 * 为什么不再用 me.ts 里那个手改常量：多个开发会话并行时，两边都要改同一行，
 * 后改的把先改的覆盖掉（2026-08-26 实际发生过：一个会话改成 d、另一个改成 g，
 * 最后传出去的是 g），于是「手机上的版本号」和「以为发的那份代码」对不上。
 * 现在版本号由脚本按当天第几次发版自动排，人不参与，抢不到一起去。
 *
 * COMMIT 是发版那一刻的 git 短 hash，直接显示在「我的」页版本号旁边：
 * 手机上看到什么 hash，就能在公众平台的版本备注里找到同一个 hash，
 * 再 git show 它就是那份代码。体验版排查「你发的到底是哪版」只看这个。
 */
export const BUILD_VERSION = 'dev';
export const BUILD_COMMIT = '';

/** 「1.0.20260826i · b3454a2」；开发版没上传过就只有 dev */
export function buildStampText(): string {
  return BUILD_COMMIT ? `${BUILD_VERSION} · ${BUILD_COMMIT}` : BUILD_VERSION;
}
