const zhCN = {
  ok: true,
  name: 'vertex-api-cloudflare-worker',
  endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/messages'],
  rootDescription: 'Vertex API 代理 Workers 运行中',
  health: {
    provider: 'vertex',
    configured: '已配置',
    notConfigured: '未配置',
    projectId: '项目 ID',
    location: '区域',
    models: '模型列表'
  },
  errors: {
    notFound: '未找到',
    notFoundType: 'not_found_error',
    invalidApiKey: 'API 密钥无效',
    invalidJson: '请求体 JSON 格式错误',
    vertexNotConfigured: 'Vertex AI 未配置。请设置 VERTEX_SERVICE_ACCOUNT_JSON 或 VERTEX_PROJECT_ID、VERTEX_CLIENT_EMAIL 和 VERTEX_PRIVATE_KEY。',
    modelNotConfigured: (model) => `模型 '${model}' 未配置。请设置 VERTEX_MODELS 或启用 ALLOW_ANY_VERTEX_MODEL。`,
    internalError: '服务器内部错误',
    timeout: '请求超时（180 秒）'
  },
  html: {
    title: 'Vertex API Worker',
    running: 'Vertex API Worker 运行中。请使用 /health 或 /v1 端点。'
  }
};

const enUS = {
  ok: true,
  name: 'vertex-api-cloudflare-worker',
  endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/messages'],
  rootDescription: 'Vertex API Proxy Worker is running',
  health: {
    provider: 'vertex',
    configured: 'Configured',
    notConfigured: 'Not configured',
    projectId: 'Project ID',
    location: 'Location',
    models: 'Models'
  },
  errors: {
    notFound: 'Not found',
    notFoundType: 'not_found_error',
    invalidApiKey: 'Invalid API key',
    invalidJson: 'Invalid JSON request body',
    vertexNotConfigured: 'Vertex AI is not configured. Set VERTEX_SERVICE_ACCOUNT_JSON or VERTEX_PROJECT_ID, VERTEX_CLIENT_EMAIL, and VERTEX_PRIVATE_KEY.',
    modelNotConfigured: (model) => `Model '${model}' is not configured. Set VERTEX_MODELS or enable ALLOW_ANY_VERTEX_MODEL.`,
    internalError: 'Internal server error',
    timeout: 'Timeout reached (180s)'
  },
  html: {
    title: 'Vertex API Worker',
    running: 'Vertex API Worker is running. Use /health or /v1 endpoints.'
  }
};

const SUPPORTED = {
  'zh-CN': zhCN,
  'zh': zhCN,
  'zh-TW': zhCN,
  'zh-HK': zhCN,
};

export function getLocale(request) {
  const acceptLanguage = request?.headers?.get('Accept-Language') || '';
  for (const lang of acceptLanguage.split(',')) {
    const code = lang.trim().split(';')[0];
    if (SUPPORTED[code]) return SUPPORTED[code];
    const base = code.split('-')[0];
    if (SUPPORTED[base]) return SUPPORTED[base];
  }
  return zhCN;
}
