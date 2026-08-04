// Node 单测 web/pdf_xref_repair.js 的 probeXref / rebuildXrefSection。
// 运行: node test-xref-repair.mjs
import fs from "fs";
import { probeXref, rebuildXrefSection } from "./web/pdf_xref_repair.js";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
}

function fileReader(buf) {
  return async (begin, end) => buf.subarray(begin, end);
}

// ---- 1. 好文件: tracemonkey.pdf 应判 ok ----
const good = fs.readFileSync("test/pdfs/tracemonkey.pdf");
const probeGood = await probeXref(fileReader(good), good.length);
check("好文件判定 ok", probeGood.status === "ok", `(${probeGood.status}, ${probeGood.reason ?? ""})`);

// ---- 2. 非 PDF 内容应判 unknown（放行）----
const junk = Buffer.from("<html><body>not a pdf</body></html>");
const probeJunk = await probeXref(fileReader(junk), junk.length);
check("非 PDF 判定 unknown", probeJunk.status === "unknown");

// ---- 3. 破坏 xref 后应判 broken，修复后再 probe 应 ok ----
// 破坏方式: 把 startxref 数值改成一个指向文件中间的垃圾位置
const corrupted = Buffer.from(good);
const tailStr = corrupted.toString("latin1", corrupted.length - 4096);
const sxIdx = tailStr.lastIndexOf("startxref");
const sxm = /startxref\s+(\d+)/.exec(tailStr.slice(sxIdx));
const realStartXref = parseInt(sxm[1], 10);
const fakeStartXref = 50000; // 指向文件中间某处
const tailAbs = corrupted.length - 4096 + sxIdx;
const sxLine = `startxref\n${realStartXref}`;
const sxPos = corrupted.indexOf(sxLine, tailAbs);
corrupted.write(`startxref\n${fakeStartXref}`, sxPos, "latin1");

const probeBad = await probeXref(fileReader(corrupted), corrupted.length);
check("坏文件判定 broken", probeBad.status === "broken", `(${probeBad.status}, ${probeBad.reason ?? ""})`);

// ---- 4. 重建 xref 段并虚拟拼接, 再 probe 应 ok ----
let progressCalls = 0;
const section = await rebuildXrefSection(
  fileReader(corrupted),
  corrupted.length,
  probeBad,
  () => progressCalls++
);
check("重建段生成", section instanceof Uint8Array && section.length > 0,
  section ? `(${section.length} bytes, progress×${progressCalls})` : "(null)");

if (section) {
  const repaired = Buffer.concat([corrupted, Buffer.from(section)]);
  const probeFixed = await probeXref(fileReader(repaired), repaired.length);
  check("修复后再判定 ok", probeFixed.status === "ok", `(${probeFixed.status}, ${probeFixed.reason ?? ""})`);

  // 新段 startxref 必须等于原文件大小
  const newTail = repaired.toString("latin1", repaired.length - 2048);
  const nm = /startxref\s+(\d+)/g;
  let lastM, m;
  while ((m = nm.exec(newTail)) !== null) lastM = m;
  check("新 startxref 指向拼接点", parseInt(lastM[1], 10) === corrupted.length,
    `(${lastM[1]} vs ${corrupted.length})`);
}

// ---- 5. 条目偏移损坏(真实坏文件模式)应判 broken, 修复后 ok ----
// 破坏方式: 把 xref 表第一条在用条目的偏移改成一个错误值
{
  const corr2 = Buffer.from(good);
  const t2 = corr2.toString("latin1", corr2.length - 4096);
  const sx2 = /startxref\s+(\d+)/.exec(t2.slice(t2.lastIndexOf("startxref")));
  const xrefPos = parseInt(sx2[1], 10);
  // 找到第一个 "nnnnnnnnnn ggggg n" 条目并改写偏移
  const xrefHead = corr2.toString("latin1", xrefPos, xrefPos + 65536);
  const em = /(\d{10}) (\d{5}) n/.exec(xrefHead);
  const badOffset = String(Math.min(50000, corr2.length - 100)).padStart(10, "0");
  corr2.write(badOffset, xrefPos + em.index, "latin1");

  const p2 = await probeXref(fileReader(corr2), corr2.length);
  check("条目偏移损坏判定 broken", p2.status === "broken", `(${p2.status}, ${p2.reason ?? ""})`);
  if (p2.status === "broken") {
    const sec2 = await rebuildXrefSection(fileReader(corr2), corr2.length, p2, null);
    const repaired2 = Buffer.concat([corr2, Buffer.from(sec2)]);
    const p2f = await probeXref(fileReader(repaired2), repaired2.length);
    check("修复后再判定 ok", p2f.status === "ok", `(${p2f.status})`);
  }
}

// ---- 6. startxref 指向垃圾位置时 trailer 从 tail 兜底解析 ----
// (上面 case 3/4 已覆盖: startxref=50000 处无 xref, trailer 来自 tail)

// ---- 6. 找一个含对象流的测试 PDF, 验证重建安全回退 (null) ----
const candidates = fs.readdirSync("test/pdfs").filter(f => f.endsWith(".pdf"));
let objstmFile = null;
for (const f of candidates) {
  const buf = fs.readFileSync("test/pdfs/" + f);
  if (buf.length < 5 * 1024 * 1024 && buf.includes("/ObjStm")) {
    objstmFile = { name: f, buf };
    break;
  }
}
if (objstmFile) {
  const p = await probeXref(fileReader(objstmFile.buf), objstmFile.buf.length);
  const sec = await rebuildXrefSection(
    fileReader(objstmFile.buf), objstmFile.buf.length, p, null
  );
  check("ObjStm 文件重建回退 null", sec === null, `(${objstmFile.name}, probe=${p.status})`);
} else {
  console.log("SKIP  ObjStm 文件重建回退 (未找到含对象流的小 PDF)");
}

console.log(failures ? `\n>>> ${failures} 个失败 <<<` : "\n>>> 全部通过 <<<");
process.exit(failures ? 1 : 0);
