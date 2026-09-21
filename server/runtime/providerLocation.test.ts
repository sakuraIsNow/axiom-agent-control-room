import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultProviderLocation, isLocalProviderHostname, normalizeProviderBaseUrl } from './providerLocation.js';
import { OpenAICompatibleModelClient } from './modelClient.js';

const withLocalModelHosts = (value: string | undefined, callback: () => void) => {
  const previous = process.env.AXIOM_LOCAL_MODEL_HOSTS;
  if (value === undefined) delete process.env.AXIOM_LOCAL_MODEL_HOSTS;
  else process.env.AXIOM_LOCAL_MODEL_HOSTS = value;
  try { callback(); }
  finally {
    if (previous === undefined) delete process.env.AXIOM_LOCAL_MODEL_HOSTS;
    else process.env.AXIOM_LOCAL_MODEL_HOSTS = previous;
  }
};

test('classifies loopback, LAN, Docker, and public model hosts', () => {
  for (const hostname of ['localhost', '127.0.0.1', '10.0.0.8', '172.20.0.2', '192.168.1.5', 'host.docker.internal', 'model-server', 'ollama.local', '::1', 'fd12::1']) {
    assert.equal(isLocalProviderHostname(hostname), true, hostname);
  }
  assert.equal(isLocalProviderHostname('api.deepseek.com'), false);
  assert.equal(isLocalProviderHostname('models.example.com'), false);
});

test('enforces the selected provider location and normalizes the trailing slash', () => {
  assert.equal(normalizeProviderBaseUrl('http://127.0.0.1:11434/v1/', '', 'local'), 'http://127.0.0.1:11434/v1');
  assert.equal(normalizeProviderBaseUrl('https://api.deepseek.com/', '', 'internet'), 'https://api.deepseek.com');
  assert.throws(() => normalizeProviderBaseUrl('http://127.0.0.1:11434/v1', '', 'internet'), /本地服务/);
  assert.throws(() => normalizeProviderBaseUrl('https://api.deepseek.com', '', 'local'), /本地服务/);
  assert.throws(() => normalizeProviderBaseUrl('file:///models', '', 'local'), /http or https/);
});

test('server defaults infer local services while explicit user locations remain strict', () => {
  for (const value of ['http://127.0.0.1:9000', 'http://video:9000', 'http://192.168.1.10:9000']) {
    assert.equal(defaultProviderLocation(value), 'local');
    assert.equal(normalizeProviderBaseUrl(value, '', defaultProviderLocation(value)), value);
    assert.throws(() => normalizeProviderBaseUrl(value, '', 'internet'), /本地服务/);
  }
  assert.equal(defaultProviderLocation('https://api.deepseek.com'), 'internet');
});

test('server-only host allowlist identifies exact private FQDNs across provider defaults and keyed model clients', () => {
  withLocalModelHosts(' LLM.Corp.Example , vision.corp.example, llm.corp.example ', () => {
    for (const hostname of ['llm.corp.example', 'LLM.CORP.EXAMPLE', 'vision.corp.example']) {
      assert.equal(isLocalProviderHostname(hostname), true);
      const url = `https://${hostname}/v1`;
      assert.equal(defaultProviderLocation(url), 'local');
      assert.equal(normalizeProviderBaseUrl(url, '', 'local'), url);
      assert.throws(() => normalizeProviderBaseUrl(url, '', 'internet'));
      const model = new OpenAICompatibleModelClient({ apiBase: url, apiKey: 'fixture-private-model-key', apiKeyOptional: false });
      assert.equal(model.location, 'local');
    }
  });
});

test('private hostname allowlist is exact, not a suffix, substring or implicit subdomain rule', () => {
  withLocalModelHosts('llm.corp.example', () => {
    for (const hostname of ['corp.example', 'sub.llm.corp.example', 'llm.corp.example.evil.test',
      'prefix-llm.corp.example', 'llm.corp.examples', 'llm-corp.example', 'api.deepseek.com']) {
      assert.equal(isLocalProviderHostname(hostname), false, hostname);
      assert.equal(defaultProviderLocation(`https://${hostname}/v1`), 'internet', hostname);
    }
  });
});

test('wildcards, URLs, paths, ports and malformed labels never become configured model hosts', () => {
  withLocalModelHosts('*.corp.example,https://url.corp.example,path.corp.example/v1,port.corp.example:443,'
    + 'user@auth.corp.example,query.corp.example?key=x,fragment.corp.example#x,back.corp.example\\v1,'
    + '.leading.example,double..example,-bad.example,bad-.example,space name.example,valid.corp.example', () => {
    for (const hostname of ['*.corp.example', 'other.corp.example', 'url.corp.example', 'path.corp.example',
      'port.corp.example', 'auth.corp.example', 'query.corp.example', 'fragment.corp.example', 'back.corp.example',
      '.leading.example', 'double..example', '-bad.example', 'bad-.example', 'space name.example',
      'single/path', '*.local', 'path.local/v1', '', 'http://localhost', 'host?query', '[invalid]', '[localhost]', '[::1', '::1]']) {
      assert.equal(isLocalProviderHostname(hostname), false, hostname);
    }
    assert.equal(isLocalProviderHostname('valid.corp.example'), true);
  });
});

test('empty or invalid allowlists do not change the established local and internet defaults', () => {
  for (const value of [undefined, '', ' , , ', '*', 'https://llm.corp.example', 'a'.repeat(64) + '.example']) {
    withLocalModelHosts(value, () => {
      assert.equal(defaultProviderLocation('https://llm.corp.example/v1'), 'internet');
      assert.equal(defaultProviderLocation('https://api.deepseek.com'), 'internet');
      for (const hostname of ['localhost', '127.0.0.1', '10.0.0.8', '172.20.0.2', '192.168.1.5', 'model-server',
        'host.docker.internal', 'ollama.local', '::1', '[::1]', 'fd12::1']) {
        assert.equal(isLocalProviderHostname(hostname), true, hostname);
      }
    });
  }
});
