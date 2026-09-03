import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PluginDeclaredPermission, PluginRelease, UserPlugin } from './contracts.js';

export const PLUGIN_SCHEMA_VERSION = 1 as const;
export const PLUGIN_PLATFORM_VERSION = '1.1.0';
export const MIN_PLUGIN_SIGNING_KEY_LENGTH = 32;

type CatalogTool = {
  name: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
};

export type PluginCompatibilityReport = {
  compatible: boolean;
  errors: string[];
  warnings: string[];
  permissions: PluginDeclaredPermission[];
  integrity: string;
  releaseState: 'draft' | 'unsigned' | 'signed' | 'invalid';
  signatureRequired: boolean;
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
};

const releasePayload = (plugin: UserPlugin) => stableValue({
  id: plugin.id,
  tenantId: plugin.tenantId,
  name: plugin.name,
  description: plugin.description,
  icon: plugin.icon ?? '',
  kind: plugin.kind,
  visibility: plugin.visibility,
  version: plugin.version,
  definition: plugin.definition,
});

export const pluginIntegrity = (plugin: UserPlugin) => `sha256:${createHash('sha256')
  .update(JSON.stringify(releasePayload(plugin)))
  .digest('hex')}`;

const signaturePayload = (
  plugin: UserPlugin,
  integrity: string,
  permissions: PluginDeclaredPermission[],
  signedAt: string,
  signedBy: string,
) => JSON.stringify(stableValue({
  pluginId: plugin.id,
  tenantId: plugin.tenantId,
  pluginVersion: plugin.version,
  integrity,
  permissions,
  signedAt,
  signedBy,
}));

const sign = (
  plugin: UserPlugin,
  integrity: string,
  permissions: PluginDeclaredPermission[],
  signedAt: string,
  signedBy: string,
  signingKey: string,
) => `hmac-sha256:${createHmac('sha256', signingKey)
  .update(signaturePayload(plugin, integrity, permissions, signedAt, signedBy))
  .digest('hex')}`;

const signaturesEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const declaredPermissions = (plugin: UserPlugin, catalog: CatalogTool[]): PluginDeclaredPermission[] => {
  const tools = new Map(catalog.map((tool) => [tool.name, tool]));
  const permissions: PluginDeclaredPermission[] = [];
  if ('agentEnabled' in plugin.definition && plugin.definition.agentEnabled) {
    permissions.push({ id: 'platform-agent', label: '调用平台 Agent', kind: 'platform-agent', risk: 'medium' });
  }
  for (const name of [...new Set(plugin.definition.toolNames ?? [])].sort()) {
    const tool = tools.get(name);
    permissions.push({ id: `tool:${name}`, label: name, kind: 'tool', risk: tool?.risk ?? 'high' });
  }
  return permissions;
};

export const inspectPluginCompatibility = (
  plugin: UserPlugin,
  catalog: CatalogTool[],
  options: { signingKey?: string; signatureRequired?: boolean } = {},
): PluginCompatibilityReport => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const signingKey = options.signingKey?.trim();
  const signingKeyIsWeak = Boolean(signingKey && signingKey.length < MIN_PLUGIN_SIGNING_KEY_LENGTH);
  if (signingKeyIsWeak) errors.push(`插件签名密钥至少需要 ${MIN_PLUGIN_SIGNING_KEY_LENGTH} 个字符。`);
  const configuredTools = new Set(catalog.map((tool) => tool.name));
  const fields = plugin.definition.inputSchema?.fields ?? [];
  const duplicateField = fields.find((field, index) => fields.findIndex((candidate) => candidate.id === field.id) !== index);
  if (duplicateField) errors.push(`输入字段 ID 重复：${duplicateField.id}`);
  for (const toolName of plugin.definition.toolNames ?? []) {
    if (!configuredTools.has(toolName)) errors.push(`工具当前不可用：${toolName}`);
  }

  const isMiniApp = 'htmlContent' in plugin.definition;
  if ((plugin.kind === 'mini-app') !== isMiniApp) errors.push('插件类型与运行定义不一致。');
  if ('htmlContent' in plugin.definition) {
    const html = plugin.definition.htmlContent;
    if (!/<html(?:\s|>)/iu.test(html) || !/<body(?:\s|>)/iu.test(html)) errors.push('Mini App 必须包含完整的 html 和 body 结构。');
    if (/(?:fetch\s*\(|new\s+WebSocket\s*\(|new\s+EventSource\s*\(|XMLHttpRequest\s*\()/iu.test(html)) {
      errors.push('Mini App 不能直接联网，请改用平台 Agent 桥。');
    }
    if (/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//iu.test(html) || /url\(\s*["']?\s*(?:https?:)?\/\//iu.test(html)) {
      errors.push('Mini App 不能依赖外部脚本、样式、字体或图片。');
    }
    if (plugin.definition.agentEnabled && !plugin.definition.agentInstructions?.trim()) warnings.push('已启用平台 Agent，但尚未说明 Agent 的职责边界。');
    if (plugin.definition.agentEnabled && !/axiom\.plugin\.agent\.request/u.test(html)) warnings.push('已声明平台 Agent 权限，但当前 HTML 尚未调用 Agent 桥。');
  } else if (!plugin.definition.promptPrefix?.trim()) {
    errors.push('提示词插件发布前必须填写处理说明。');
  }

  const permissions = declaredPermissions(plugin, catalog);
  if (permissions.some((permission) => permission.risk === 'high' || permission.risk === 'critical')) {
    warnings.push('此插件包含高风险工具，运行时仍需遵守人工审批策略。');
  }
  const integrity = pluginIntegrity(plugin);
  let releaseState: PluginCompatibilityReport['releaseState'] = plugin.status === 'published' ? 'unsigned' : 'draft';
  if (plugin.release) {
    const integrityMatches = plugin.release.pluginVersion === plugin.version && plugin.release.integrity === integrity;
    const permissionsMatch = JSON.stringify(stableValue(plugin.release.permissions)) === JSON.stringify(stableValue(permissions));
    if (plugin.release.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
      releaseState = 'invalid';
      errors.push('插件发布证明版本不受当前平台支持，请重新发布。');
    }
    else if (!integrityMatches) {
      releaseState = 'invalid';
      errors.push('发布证明与当前插件内容不一致，请重新发布。');
    }
    else if (!permissionsMatch) {
      releaseState = 'invalid';
      errors.push('插件权限或风险等级已变化，请确认后重新发布。');
    }
    else if (!plugin.release.signature) releaseState = 'unsigned';
    else if (!signingKey) {
      releaseState = 'invalid';
      errors.push('此插件带有发布签名，但服务端缺少验签密钥。');
    }
    else if (signingKeyIsWeak) releaseState = 'invalid';
    else {
      const expected = sign(
        plugin,
        integrity,
        permissions,
        plugin.release.signedAt,
        plugin.release.signedBy,
        signingKey,
      );
      releaseState = signaturesEqual(plugin.release.signature, expected) ? 'signed' : 'invalid';
      if (releaseState === 'invalid') errors.push('插件发布签名校验失败，请确认签名密钥或重新发布。');
    }
  }
  if (options.signatureRequired && !signingKey) errors.push('部署要求插件签名，但服务端尚未配置签名密钥。');
  if (options.signatureRequired && plugin.status === 'published' && releaseState !== 'signed') errors.push('此部署只允许运行已签名且校验有效的插件。');

  return {
    compatible: errors.length === 0,
    errors,
    warnings,
    permissions,
    integrity,
    releaseState,
    signatureRequired: options.signatureRequired === true,
  };
};

export const createPluginRelease = (
  plugin: UserPlugin,
  report: PluginCompatibilityReport,
  signedBy: string,
  signingKey?: string,
): PluginRelease => {
  if (!report.compatible) throw new Error('Incompatible plugins cannot be published.');
  const normalizedSigningKey = signingKey?.trim();
  if (normalizedSigningKey && normalizedSigningKey.length < MIN_PLUGIN_SIGNING_KEY_LENGTH) {
    throw new Error(`Plugin signing key must contain at least ${MIN_PLUGIN_SIGNING_KEY_LENGTH} characters.`);
  }
  const signedAt = new Date().toISOString();
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    platformVersion: PLUGIN_PLATFORM_VERSION,
    pluginVersion: plugin.version,
    integrity: report.integrity,
    ...(normalizedSigningKey ? { signature: sign(plugin, report.integrity, report.permissions, signedAt, signedBy, normalizedSigningKey) } : {}),
    signedAt,
    signedBy,
    permissions: report.permissions,
    warnings: report.warnings,
  };
};
