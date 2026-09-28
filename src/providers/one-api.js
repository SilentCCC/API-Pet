const { notConfigured } = require('./base');

module.exports = {
  id: 'one-api',
  label: 'One API',
  async getBalance() {
    return notConfigured('One API', '管理端余额接口、请求方法、响应字段路径');
  }
};
