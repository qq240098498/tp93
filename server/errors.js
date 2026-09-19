// 带错误码与出错位置的业务异常，页面据此把问题标到具体输入项上
// details 用来装启用把关这种一次要返回多项检查结果的错误
class ApiError extends Error {
  constructor(status, code, message, field, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field || '';
    this.details = details && typeof details === 'object' ? details : null;
  }
}

// 去掉首尾空白后的文本，非字符串一律当作空
function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = { ApiError, pickText };
