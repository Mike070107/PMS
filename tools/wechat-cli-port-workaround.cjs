/**
 * The Windows WeChat DevTools CLI hard-codes its local proxy to port 3799.
 * Hyper-V/WinNAT may reserve the surrounding port range, in which case the
 * CLI exits with EACCES before it can fall back to another port.  The ship
 * script preloads this file only for the CLI child process and moves that
 * one listen call to a high, non-reserved port.  The CLI still handles an
 * occupied fallback port itself by incrementing it.
 */
const net = require('node:net');

const originalListen = net.Server.prototype.listen;
const fallbackPort = Number(process.env.PMS_WECHAT_CLI_PORT || 47890);

net.Server.prototype.listen = function patchedListen(...args) {
  if (args[0] === 3799) {
    args[0] = fallbackPort;
  } else if (args[0] && typeof args[0] === 'object' && args[0].port === 3799) {
    args[0] = { ...args[0], port: fallbackPort };
  }
  return originalListen.apply(this, args);
};
