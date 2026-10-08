const { AsyncLocalStorage } = require('node:async_hooks');

const accountContext = new AsyncLocalStorage();
let manager;

function configureAccountSessions(value) { manager = value; }
function withAccountSession(provider, callback) {
  if (!manager || accountContext.getStore()) return callback();
  return manager.run(provider, callback);
}

module.exports = { accountContext, configureAccountSessions, withAccountSession };
