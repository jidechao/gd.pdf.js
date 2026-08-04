import puppeteer from "puppeteer";

// URL 路径打开 xref 损坏的 5.6GB PDF，验证 HybridRangeTransport：
// open() 检测到损坏后自动全量扫描重建，然后按需打开（含修复段）。
const VIEWER =
  "http://localhost:8888/web/viewer.html?file=/PDF%E5%90%88%E5%B9%B65G-broken.pdf";
const TARGET_PAGE = 5000;

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const errors = [];
let repairLogged = false;
page.on("pageerror", err => errors.push(`${err.name}: ${err.message}\n${err.stack ?? ""}`));
page.on("console", msg => {
  const t = msg.text();
  if (msg.type() === "error" || msg.type() === "warn") {
    console.log(`[console.${msg.type()}]`, t.slice(0, 200));
  }
  if (/xref is broken/i.test(t)) {
    repairLogged = true;
  }
});

console.log("== URL 路径打开损坏文件（应触发自动修复）==");
const t0 = Date.now();
await page.goto(VIEWER, { waitUntil: "domcontentloaded", timeout: 60000 });

let firstRender = null;
for (let i = 0; i < 900; i++) {
  await new Promise(r => setTimeout(r, 100));
  if (errors.length > 0) {
    break;
  }
  const done = await page.evaluate(() => {
    const c = document.querySelector(".page canvas");
    return !!c && c.width > 0;
  });
  if (done) {
    firstRender = (Date.now() - t0) / 1000;
    break;
  }
}
if (firstRender === null) {
  console.log("FAIL: 90s 内首页未渲染");
  console.log("errors:", errors);
  await browser.close();
  process.exit(1);
}
const info = await page.evaluate(
  () => window.PDFViewerApplication?.pdfDocument?.numPages
);
console.log(`首页渲染完成: ${firstRender.toFixed(2)}s (含自动修复扫描)  总页数: ${info}`);
console.log(`检测到修复日志: ${repairLogged}`);

console.log(`\n== 跳转到第 ${TARGET_PAGE} 页 ==`);
const jumpStart = Date.now();
await page.evaluate(p => {
  window.PDFViewerApplication.page = p;
}, TARGET_PAGE);
let jumped = false;
for (let i = 0; i < 200; i++) {
  await new Promise(r => setTimeout(r, 100));
  const state = await page.evaluate(p => {
    const app = window.PDFViewerApplication;
    const container = document.querySelector(`[data-page-number="${p}"] canvas`);
    return { current: app?.page, rendered: !!container && container.width > 0 };
  }, TARGET_PAGE);
  if (state.current === TARGET_PAGE && state.rendered) {
    console.log(`第 ${TARGET_PAGE} 页渲染完成: ${((Date.now() - jumpStart) / 1000).toFixed(2)}s`);
    jumped = true;
    break;
  }
}

const metrics = await page.metrics();
console.log(`\nJSHeapUsed: ${(metrics.JSHeapUsedSize / 1e6).toFixed(0)} MB`);
console.log("页面错误:", errors.length ? errors : "无");

await browser.close();
const pass = firstRender < 120 && jumped && repairLogged && errors.length === 0;
console.log(pass ? "\n>>> URL 自动修复验收通过 <<<" : "\n>>> 存在未达标项 <<<");
process.exit(pass ? 0 : 1);
