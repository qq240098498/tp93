// 带错误码与出错位置的业务异常，页面据此把问题标到具体输入项上
// details 用于一次把多个卡点都带回去，例如启用前把关同时不过好几项
class ApiError extends Error {
  constructor(status, code, message, field, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field || '';
    this.details = Array.isArray(details) ? details : [];
  }
}

// 去掉首尾空白后的文本，非字符串一律当作空
function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = { ApiError, pickText };
