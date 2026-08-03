import puppeteer from "puppeteer";

const FILE = "/PDF%E5%90%88%E5%B9%B65G.pdf";
const URL = `http://localhost:8888/web/viewer.html?file=${FILE}#disableStream=true&disableAutoFetch=true`;
const TARGET_PAGE = 5000;

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const t0 = Date.now();
const t = () => ((Date.now() - t0) / 1000).toFixed(2);
const errors = [];
page.on("pageerror", err => errors.push(`${err.name}: ${err.message}`));

const net = { range: 0, full: 0, bytes: 0 };
const client = await page.createCDPSession();
await client.send("Network.enable");
const active = new Set();
client.on("Network.requestWillBeSent", e => {
  if (!e.request.url.includes("5G.pdf")) {
    return;
  }
  if (e.request.headers?.Range) {
    net.range++;
  } else {
    net.full++;
  }
});
client.on("Network.responseReceived", e => {
  if (e.response.url.includes("5G.pdf")) {
    active.add(e.requestId);
  }
});
client.on("Network.dataReceived", e => {
  if (active.has(e.requestId)) {
    net.bytes += e.dataLength;
  }
});

console.log("== 打开 5.6GB PDF ==");
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

let firstRender = null;
for (let i = 0; i < 300; i++) {
  await new Promise(r => setTimeout(r, 100));
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
  console.log("FAIL: 30s 内首页未渲染");
  console.log("errors:", errors);
  await browser.close();
  process.exit(1);
}
const info = await page.evaluate(
  () => window.PDFViewerApplication?.pdfDocument?.numPages
);
console.log(`首页渲染完成: ${firstRender.toFixed(2)}s (目标 < 5s)  总页数: ${info}`);

console.log(`\n== 滚动条翻页测试: 跳转到第 ${TARGET_PAGE} 页 ==`);
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
    return {
      current: app?.page,
      rendered: !!container && container.width > 0,
    };
  }, TARGET_PAGE);
  if (state.current === TARGET_PAGE && state.rendered) {
    console.log(
      `第 ${TARGET_PAGE} 页渲染完成: ${((Date.now() - jumpStart) / 1000).toFixed(2)}s`
    );
    jumped = true;
    break;
  }
}
if (!jumped) {
  console.log(`FAIL: 第 ${TARGET_PAGE} 页 20s 内未渲染`);
}

await page.screenshot({ path: "verify-5g-fixed.png" });

console.log("\n== 网络汇总 ==");
console.log(`range 请求: ${net.range}  全量请求: ${net.full}  传输量: ${(net.bytes / 1e6).toFixed(1)} MB`);
console.log("页面错误:", errors.length ? errors : "无");

// ---- 对照组: 普通小 PDF ----
console.log("\n== 对照组: tracemonkey.pdf ==");
const t1 = Date.now();
await page.goto("http://localhost:8888/web/viewer.html?file=/test/pdfs/tracemonkey.pdf", {
  waitUntil: "domcontentloaded",
});
let controlOk = false;
for (let i = 0; i < 100; i++) {
  await new Promise(r => setTimeout(r, 100));
  const done = await page.evaluate(() => {
    const c = document.querySelector(".page canvas");
    return !!c && c.width > 0;
  });
  if (done) {
    controlOk = true;
    break;
  }
}
const pages = await page.evaluate(
  () => window.PDFViewerApplication?.pdfDocument?.numPages
);
console.log(
  controlOk
    ? `对照组正常: ${((Date.now() - t1) / 1000).toFixed(2)}s, ${pages} 页`
    : "FAIL: 对照组渲染失败"
);

await browser.close();
const pass = firstRender < 5 && jumped && controlOk && errors.length === 0;
console.log(pass ? "\n>>> 全部验收通过 <<<" : "\n>>> 存在未达标项 <<<");
process.exit(pass ? 0 : 1);
