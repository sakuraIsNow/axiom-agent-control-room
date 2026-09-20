const apiBase = process.env.AXIOM_API_BASE || 'http://127.0.0.1:8787';

const readChat = async (content, options = {}) => {
  const response = await fetch(`${apiBase}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }], ...options }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`chat request failed (${response.status}): ${body.slice(0, 300)}`);
  const events = body.split(/\r?\n\r?\n/).flatMap((block) => {
    const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim();
    const raw = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
    if (!event || !raw) return [];
    try { return [{ event, data: JSON.parse(raw) }]; } catch { return []; }
  });
  let text = '';
  for (const item of events) {
    if (item.event === 'reset') text = '';
    if (item.event === 'token') text += item.data.content || '';
  }
  return {
    body,
    text,
    statuses: events.filter((item) => item.event === 'status').map((item) => item.data.message || ''),
    complete: events.filter((item) => item.event === 'complete').at(-1)?.data,
  };
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const healthResponse = await fetch(`${apiBase}/api/health`, { signal: AbortSignal.timeout(5_000) });
const health = await healthResponse.json();
assert(health.nativeSearch?.enabled === true, 'DeepSeek native search capability should be exposed by health');
assert(health.nativeSearch?.model === 'deepseek-v4-flash', 'native search should default to deepseek-v4-flash');
assert(health.nativeSearch?.api === '/responses', 'native search should use the Responses API');
assert(health.visionModel === 'deepseek-v4-flash-vision-exp', 'image analysis should keep the dedicated vision model');

const weather = await readChat('\u641c\u7d22\u4e00\u4e0b\u4eca\u5929\u5317\u4eac\u5929\u6c14', {
  provider: { apiUrl: 'https://custom-provider.invalid/v1', apiKey: 'sk-qa-placeholder-not-a-real-key', model: 'custom-chat' },
});
assert(weather.statuses.some((message) => /搜索 Agent 正在连接检索服务/.test(message)), 'weather must activate the Search Agent');
assert(weather.complete?.route === 'deepseek-native-search', `weather returned an invalid search route: ${weather.complete?.route}`);
assert(weather.complete?.agentRole === 'search-agent', 'weather must be assigned to the search Agent');
assert(weather.complete?.model === 'deepseek-v4-flash', 'weather native search must use the dedicated search model');
assert(!weather.body.includes('custom-provider.invalid'), 'search must not fall back to the custom conversation Provider');
assert(!/Open-Meteo|Bing|DuckDuckGo/i.test(weather.text), 'weather must not use a non-DeepSeek search source');
assert(!/DeepSeek 原生搜索：|服务端检索时间|来源页面的发布时间或数据时间优先于本次检索时间/.test(weather.text), 'weather answer must not expose search implementation metadata');
assert(/https?:\/\//i.test(weather.text)
  || /本次检索未返回可点击来源链接/.test(weather.text),
'weather without source links must expose a concise evidence limitation');

const projects = await readChat('有哪些值得参考的开源游戏 GitHub 项目？请按类型列出项目、仓库链接和一句话特点。');
assert(projects.statuses.some((message) => /搜索 Agent 正在连接检索服务/.test(message)), 'GitHub research must activate the Search Agent');
assert(projects.complete?.route === 'deepseek-native-search', `GitHub research returned an invalid search route: ${projects.complete?.route}`);
assert(projects.complete?.agentRole === 'github-research-agent', 'GitHub query must be assigned to the GitHub research Agent');
assert(/github\.com\//i.test(projects.text)
  || /本次检索未返回可点击来源链接/.test(projects.text),
`agent project answer must include GitHub links or expose the native evidence limitation: ${projects.text.slice(-800)}`);
assert(!/当前可用的 Agent 由运行时注册表/.test(projects.text), 'agent project query must not be routed to the internal catalog');
assert(!/DeepSeek 原生搜索：|服务端检索时间|来源页面的发布时间或数据时间优先于本次检索时间/.test(projects.text), 'GitHub answer must not expose search implementation metadata');
assert(!/\[[^\]]*$/.test(projects.text.trim()), `GitHub answer ended with an unfinished Markdown link: ${projects.text.slice(-300)}`);
assert((projects.text.match(/```/g)?.length ?? 0) % 2 === 0, 'GitHub answer ended with an unclosed code fence');

const failedNative = await readChat('\u4eca\u5929\u5317\u4eac\u5929\u6c14\u5982\u4f55', {
  provider: { apiUrl: 'https://api.deepseek.com', apiKey: 'sk-qa-invalid-native-search-key', model: 'deepseek-v4-flash' },
});
assert(failedNative.complete?.route === 'deepseek-native-search-failed', 'a native search failure must remain on the DeepSeek search route');
assert(failedNative.complete?.fallbackDisabled === true, 'a native search failure must explicitly disable fallback');
assert(/搜索 Agent 暂时无法取得可靠结果/.test(failedNative.text), 'native failure must return a concise user-facing message');
assert(!/DeepSeek|web_search|Open-Meteo|Bing|DuckDuckGo|GitHub API|服务端检索时间/i.test(failedNative.text), 'native failure must not expose provider or fallback implementation details');
assert(!/controlled-search-fallback/.test(failedNative.body), 'native failure must not execute a controlled search fallback');

const catalog = await readChat('\u4f60\u6709\u54ea\u4e9b\u5b50\u667a\u80fd\u4f53');
assert(catalog.complete?.route === 'agent-registry', 'sub-agent query must be answered from the live registry context');
assert(catalog.complete?.agentRole === 'registry-agent', 'sub-agent query must be assigned to the registry Agent');
assert(/规划|planner/i.test(catalog.text), 'live Agent answer should include the planner when it is present');
assert(!/当前可用的 Agent 由运行时注册表提供，共 6 个/.test(catalog.text), 'Agent answer must not use the old fixed catalog paragraph');
assert(catalog.text.length < 900, `live Agent catalog answer should remain compact (received ${catalog.text.length} characters; route=${catalog.complete?.route}; model=${catalog.complete?.model})`);

console.log(JSON.stringify({ ok: true, weatherRoute: weather.complete.route, projectRoute: projects.complete.route, failedNativeRoute: failedNative.complete.route, catalogRoute: catalog.complete.route, catalogCharacters: catalog.text.length }));
