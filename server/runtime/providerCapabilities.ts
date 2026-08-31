export type ProviderCapability =
  | 'text'
  | 'vision'
  | 'web_search'
  | 'function_call'
  | 'responses_stream'
  | 'json_output'
  | 'file_image';

export type ProviderCapabilityInfo = {
  capability: ProviderCapability;
  native: boolean;
  endpoint?: string;
  model?: string;
  note: string;
};

export const deepSeekCapabilityInfo = (options: {
  baseUrl: string;
  textModel: string;
  visionModel: string;
  searchEnabled: boolean;
  searchModel: string;
  filesEnabled?: boolean;
}): ProviderCapabilityInfo[] => {
  const isDeepSeek = (() => {
    try {
      const hostname = new URL(options.baseUrl).hostname.toLowerCase();
      return hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com');
    } catch {
      return false;
    }
  })();

  if (!isDeepSeek) {
    return [{
      capability: 'text',
      native: false,
      model: options.textModel,
      note: '自定义 Provider 的能力必须通过实际握手或配置声明确认。',
    }];
  }

  return [
    { capability: 'text', native: true, endpoint: '/chat/completions', model: options.textModel, note: '文本对话。' },
    { capability: 'vision', native: true, endpoint: '/chat/completions 或 /responses', model: options.visionModel, note: '图片理解、截图文字和图表分析。' },
    { capability: 'web_search', native: options.searchEnabled, endpoint: '/responses', model: options.searchModel, note: '服务端受控联网搜索，不是浏览器自动化。' },
    { capability: 'function_call', native: true, endpoint: '/chat/completions 或 /responses', model: options.textModel, note: '模型生成函数调用，实际执行由 Axiom Tool Registry 负责。' },
    { capability: 'responses_stream', native: true, endpoint: '/responses', model: options.textModel, note: '语义 SSE 事件和增量输出。' },
    { capability: 'json_output', native: true, endpoint: '/chat/completions', model: options.textModel, note: 'JSON Output；业务仍需 schema 校验。' },
    { capability: 'file_image', native: options.filesEnabled !== false, endpoint: '/files', model: options.visionModel, note: 'Files API 当前用于图片 file_id，不是通用文档输入。' },
  ];
};
