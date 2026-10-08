module.exports = {
  'new-api': require('./new-api'),
  'one-api': require('./one-api'),
  veloera: require('./veloera'),
  sub2api: require('./sub2api'),
  aihub: require('./aihub'),
  custom: require('./custom')
};

const { withAccountSession } = require('../account-session-context');
for (const id of ['new-api', 'sub2api', 'aihub']) {
  const adapter = module.exports[id];
  for (const method of ['detect', 'getBalance', 'getApiKeys']) {
    if (typeof adapter[method] !== 'function') continue;
    const original = adapter[method];
    adapter[method] = (provider, ...args) => withAccountSession(provider, () => original.call(adapter, provider, ...args));
  }
}
