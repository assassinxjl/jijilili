// 调试版：回传 event 的真实类型和结构，用于定位 FC 3.0 事件函数的 event 格式
exports.handler = function (event, context, callback) {
  const info = {
    eventType: typeof event,
    isBuffer: Buffer.isBuffer(event),
    isString: typeof event === 'string',
    isObject: typeof event === 'object' && !Buffer.isBuffer(event),
  };

  if (Buffer.isBuffer(event)) {
    info.rawLength = event.length;
    try {
      const parsed = JSON.parse(event.toString('utf8'));
      info.parsedKeys = Object.keys(parsed);
      info.httpMethod = parsed.httpMethod;
      info.body = parsed.body;
      info.isBase64Encoded = parsed.isBase64Encoded;
      info.path = parsed.path;
      info.headers = parsed.headers;
    } catch (e) {
      info.parseError = e.message;
      info.rawPreview = event.toString('utf8').substring(0, 500);
    }
  } else if (typeof event === 'string') {
    info.rawLength = event.length;
    try {
      const parsed = JSON.parse(event);
      info.parsedKeys = Object.keys(parsed);
      info.httpMethod = parsed.httpMethod;
      info.body = parsed.body;
      info.isBase64Encoded = parsed.isBase64Encoded;
    } catch (e) {
      info.parseError = e.message;
      info.rawPreview = event.substring(0, 500);
    }
  } else if (typeof event === 'object') {
    info.keys = Object.keys(event);
    info.httpMethod = event.httpMethod;
    info.body = event.body;
    info.isBase64Encoded = event.isBase64Encoded;
    info.path = event.path;
    info.headers = event.headers;
  }

  const resp = {
    isBase64Encoded: false,
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(info, null, 2),
  };

  // 尝试 callback 方式
  try {
    callback(null, resp);
  } catch (e) {
    // 如果 callback 不工作，尝试直接 return（FC 3.0 async handler）
    return resp;
  }
};
