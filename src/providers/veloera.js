const { notConfigured } = require('./base');

module.exports = {
  id: 'veloera',
  label: 'Veloera',
  async getBalance() {
    return notConfigured('Veloera', '管理端余额接口、请求方法、响应字段路径');
  }
};
