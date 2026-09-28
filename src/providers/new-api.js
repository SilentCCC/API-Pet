const { notConfigured } = require('./base');

module.exports = {
  id: 'new-api',
  label: 'New API',
  async getBalance() {
    return notConfigured('New API', '管理端余额接口、请求方法、响应字段路径');
  }
};
