// 回归冒烟测试：覆盖多种 PDF 特性（字体/图像/注释/表单/CJK/JBIG2/JPX/加密等）
import puppeteer from "puppeteer";

const PDFS = [
  // [文件, 说明]
  ["tracemonkey.pdf", "普通文本论文"],
  ["annotation-as.pdf", "注释(外观流)"],
  ["annotation_hidden_noview.pdf", "隐藏注释"],
  ["jbig2_file_header.pdf", "JBIG2 图像"],
  ["bug_jpx.pdf", "JPX/JPEG2000"],
  ["ArabicCIDTrueType.pdf", "阿拉伯文 CID 字体"],
  ["Embedded_font.pdf", "嵌入字体"],
  ["90ms_rksj_h_sample.pdf", "韩文竖排"],
  ["160F-2019.pdf", "表格表单"],
  ["simpletype3font.pdf", "Type3 字体"],
  ["ContentStreamNoCycleType3insideType3.pdf", "Type3 嵌套"],
  ["IndexedCS_negative_and_high.pdf", "索引色彩空间"],
  ["bug1020226.pdf", "图案填充"],
  ["xfa_bug1716047.pdf", "XFA 表单"],
  ["ZapfDingbats.pdf", "符号字体"],
];

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 850 });

let pass = 0, fail = 0;
const failures = [];
for (const [pdf, desc] of PDFS) {
  const errors = [];
  const onErr = err => errors.push(String(err.message || err).slice(0, 120));
  page.on("pageerror", onErr);
  const t0 = Date.now();
  let ok = false;
  try {
    await page.goto(
      `http://localhost:8888/web/viewer.html?file=/test/pdfs/${pdf}`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 100));
      ok = await page.evaluate(() => {
        const c = document.querySelector(".page canvas");
        return !!c && c.width > 0;
      });
      if (ok) break;
    }
  } catch (e) {
    errors.push("goto: " + String(e.message).slice(0, 100));
  }
  page.off("pageerror", onErr);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (ok) {
    pass++;
    console.log(`PASS  ${pdf.padEnd(42)} ${desc}  ${secs}s`);
  } else {
    fail++;
    failures.push(pdf);
    console.log(`FAIL  ${pdf.padEnd(42)} ${desc}  ${errors.join("; ") || "timeout"}`);
  }
}
console.log(`\n合计: ${pass} 通过 / ${fail} 失败`);
if (failures.length) console.log("失败:", failures.join(", "));
await browser.close();
process.exit(fail ? 1 : 0);
