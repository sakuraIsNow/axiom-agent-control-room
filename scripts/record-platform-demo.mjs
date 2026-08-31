import { chromium } from "@playwright/test";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const outputDir = path.join(rootDir, "demo");
const recordingDir = path.join(outputDir, ".recordings");
const outputPath = path.join(outputDir, "axiom-platform-demo.webm");
const baseUrl = process.env.AXIOM_DEMO_URL ?? "http://127.0.0.1:4300";
const sessionId =
  process.env.AXIOM_DEMO_SESSION ?? "0d146766-a077-4795-bcb3-4936a9b1693f";
const taskId =
  process.env.AXIOM_DEMO_TASK ?? "23cd0788-8480-41ba-8366-52d447342153";

await mkdir(outputDir, { recursive: true });
await rm(recordingDir, { recursive: true, force: true });
await mkdir(recordingDir, { recursive: true });
await rm(outputPath, { force: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-webgl", "--use-angle=swiftshader"],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  recordVideo: {
    dir: recordingDir,
    size: { width: 1600, height: 900 },
  },
  colorScheme: "dark",
});

const page = await context.newPage();

const pause = (milliseconds) => page.waitForTimeout(milliseconds);
const openSection = async (name, view, waitMs = 3500) => {
  await page.getByRole("button", { name, exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("view") === view);
  await pause(waitMs);
};
const demonstrateTaskOrbit = async ({
  dragDurationMs,
  holdDurationMs,
  distance,
}) => {
  const stage = page.locator(".dash-orbit-stage");
  await stage.waitFor();
  await stage.evaluate(
    async (element, options) => {
      const bounds = element.getBoundingClientRect();
      const startX = bounds.x + bounds.width * 0.68;
      const y = bounds.y + bounds.height * 0.52;
      const steps = Math.max(1, Math.round(options.dragDurationMs / 35));
      const pointerId = 41;
      const dispatch = (type, clientX, buttons, button) => {
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId,
            pointerType: "mouse",
            isPrimary: true,
            clientX,
            clientY: y,
            buttons,
            button,
          }),
        );
      };
      const originalSetPointerCapture = element.setPointerCapture.bind(element);
      element.setPointerCapture = () => {};
      try {
        dispatch("pointerdown", startX, 1, 0);
        for (let step = 1; step <= steps; step += 1) {
          dispatch(
            "pointermove",
            startX - options.distance * (step / steps),
            1,
            -1,
          );
          await new Promise((resolve) => setTimeout(resolve, 35));
        }
        await new Promise((resolve) => setTimeout(resolve, options.holdDurationMs));
        dispatch("pointerup", startX - options.distance, 0, 0);
      } finally {
        element.setPointerCapture = originalSetPointerCapture;
      }
    },
    { dragDurationMs, holdDurationMs, distance },
  );
};

try {
  const url = new URL(baseUrl);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("view", "tasks");
  url.searchParams.set("task", taskId);

  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "任务管理", exact: true }).waitFor();
  await page.evaluate(() => {
    const heartbeat = document.createElement("span");
    heartbeat.setAttribute("aria-hidden", "true");
    heartbeat.style.cssText = [
      "position:fixed",
      "right:1px",
      "bottom:1px",
      "width:2px",
      "height:2px",
      "z-index:2147483647",
      "pointer-events:none",
      "background:rgba(255,255,255,.01)",
    ].join(";");
    document.body.append(heartbeat);
    heartbeat.animate(
      [
        { transform: "translateX(0)", opacity: 0.01 },
        { transform: "translateX(-2px)", opacity: 0.02 },
      ],
      { duration: 600, direction: "alternate", iterations: Infinity },
    );
    const recordingStyles = document.createElement("style");
    recordingStyles.textContent = `
      .dash-orbit-card { transition: none !important; will-change: transform, filter; }
      .dash-orbit-card-shell {
        -webkit-backdrop-filter: none !important;
        backdrop-filter: none !important;
      }
      .dash-orbit-card-text { transition: none !important; }
    `;
    document.head.append(recordingStyles);
  });
  await pause(300);
  await demonstrateTaskOrbit({ dragDurationMs: 0, holdDurationMs: 900, distance: 0 });

  await openSection("对话", "chat", 1200);
  const multiAgentSession = page
    .getByRole("button", { name: /^设计一个生产级多 Agent 服务/ })
    .first();
  await multiAgentSession.click();
  const agentGraph = page.getByLabel("当前对话 Agent Graph");
  await agentGraph.getByText("9", { exact: true }).waitFor({ timeout: 15_000 });
  await pause(4500);

  await openSection("Agent Nexus", "workflows", 1000);
  await page.getByText(/智能体枢纽/, { exact: false }).first().waitFor();
  await pause(4500);

  await openSection("插件", "plugins", 500);
  await page.getByRole("heading", { name: "插件", exact: true }).waitFor();
  await pause(700);
  await page.getByRole("button", { name: "Agent 创建", exact: true }).click();
  const pluginCreator = page.locator(".dash-plugin-shell-create");
  await pluginCreator.waitFor({ state: "visible" });
  await pluginCreator.scrollIntoViewIfNeeded();
  await page.getByPlaceholder("例如：实时天气").fill("实时天气");
  await page.getByPlaceholder("一句话说明用途").fill("展示城市当前天气和未来趋势");
  await page.getByRole("button", { name: "棱镜", exact: true }).click();
  await page.getByRole("button", { name: "创建空白插件", exact: true }).hover();
  await page.screenshot({ path: path.join(outputDir, "axiom-platform-demo-plugin-builder.jpg") });
  await pause(3200);
} finally {
  await context.close();
  await browser.close();
}

const recordingName = (await readdir(recordingDir)).find((name) =>
  name.endsWith(".webm"),
);
if (!recordingName) {
  throw new Error("Playwright did not create a video recording.");
}

await copyFile(path.join(recordingDir, recordingName), outputPath);
await rm(recordingDir, { recursive: true, force: true });
console.log(outputPath);
