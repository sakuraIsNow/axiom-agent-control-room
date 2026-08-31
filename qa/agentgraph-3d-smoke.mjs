import { chromium } from '@playwright/test';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:4300';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(baseUrl, { waitUntil: 'networkidle' });
await page.locator('.axiom-dashboard').waitFor({ state: 'visible', timeout: 20_000 });

const result = await page.evaluate(() => {
  const dashboard = document.querySelector('.axiom-dashboard');
  if (!dashboard) return { ok: false, reason: 'dashboard-not-mounted' };

  const stage = document.createElement('div');
  stage.className = 'dash-agent-graph-stage';
  stage.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:500px;display:block;';
  const world = document.createElement('div');
  world.className = 'dash-agent-graph-world';
  world.style.setProperty('--dash-graph-yaw-inverse', '-88deg');
  world.style.setProperty('--dash-graph-pitch-inverse', '-18deg');
  world.style.transform = 'rotateX(18deg) rotateY(88deg)';
  stage.append(world);
  dashboard.append(stage);

  const variants = [0, 1, 2, 3, 4].map((variant, index) => {
    const node = document.createElement('button');
    node.className = `dash-agent-signal-node variant-${variant}`;
    node.style.left = `${12 + index * 19}%`;
    node.style.top = '50%';
    node.style.setProperty('--dash-node-depth', `${(index - 2) * 12}px`);
    node.innerHTML = '<span class="dash-agent-sphere"><i class="dash-agent-eye eye-left"></i><i class="dash-agent-eye eye-right"></i><span class="dash-agent-mouth"></span></span><span class="dash-agent-node-meta"><em>测试智能体</em></span>';
    world.append(node);
    const sphere = node.querySelector('.dash-agent-sphere');
    const rect = node.getBoundingClientRect();
    return {
      variant,
      width: Number(rect.width.toFixed(2)),
      height: Number(rect.height.toFixed(2)),
      clipPath: sphere ? getComputedStyle(sphere).clipPath : '',
      preserve3d: getComputedStyle(node).transformStyle === 'preserve-3d',
    };
  });

  return {
    ok: variants.every((item) => item.width > 24 && item.height > 24 && item.preserve3d),
    variants,
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
if (!result.ok) process.exitCode = 1;

