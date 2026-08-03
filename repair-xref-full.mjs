// 全量重建 PDF合并5G.pdf 的 xref：
// 1. 顺序扫描 6GB 定位所有真实 "N 0 obj" 对象头
// 2. 在文件末尾追加一段全新 xref + trailer（增量更新式，/Prev 指回旧表）
// 安全：不改动原文件任何已有字节；回滚 = 截断到原大小。
import fs from "fs";

const FILE = "PDF合并5G.pdf";
const OLD_STARTXREF = 6040677471;
const OLD_SIZE_HINT = 30304;

const fd = fs.openSync(FILE, "r+");
const fileSize = fs.fstatSync(fd).size;
console.log(`文件大小: ${fileSize}`);

// ---- 1. 提取旧 trailer 的 /ID ----
const tailBuf = Buffer.alloc(2048);
fs.readSync(fd, tailBuf, 0, 2048, fileSize - 2048); // 旧 trailer 在文件末尾
const tailStr = tailBuf.toString("latin1");
const trailerPos = tailStr.indexOf("trailer");
const idMatch = /\/ID\s*\[.*?\]/.exec(tailStr.slice(trailerPos));
const idPart = idMatch ? idMatch[0].replaceAll(/\s+/g, "") : "";
console.log(`旧 trailer /ID: ${idPart || "(无)"}`);

// ---- 2. 顺序扫描全部对象头 ----
console.log("扫描 6GB 对象头...");
const t0 = Date.now();
const CHUNK = 128 * 1024 * 1024;
const buf = Buffer.alloc(CHUNK + 128);
const OBJ_RE = /(?<![0-9.])(\d{1,7}) (\d{1,5}) obj(?![0-9])/g;
const locations = new Map(); // num -> [offsets...]
let objstmCount = 0;
for (let off = 0; off < fileSize; off += CHUNK) {
  const n = fs.readSync(fd, buf, 0, Math.min(CHUNK + 128, fileSize - off), off);
  const s = buf.toString("latin1", 0, n);
  if (s.includes("/ObjStm")) {
    objstmCount += (s.match(/\/ObjStm/g) || []).length;
  }
  OBJ_RE.lastIndex = 0;
  let m;
  while ((m = OBJ_RE.exec(s)) !== null) {
    const absPos = off + m.index;
    // 对象头必须在行首，且 obj 后应紧跟对象内容起始符
    const before = absPos > 0 ? s[m.index - 1] : "\n";
    const after = s.slice(m.index + m[0].length).replace(/^[\r\n ]+/, "")[0];
    if (before !== "\n" && before !== "\r") continue;
    if (!"<[/(-+.0123456789tfn".includes(after)) continue;
    const num = parseInt(m[1], 10);
    (locations.get(num) || locations.set(num, []).get(num)).push(absPos);
  }
}
console.log(`扫描完成 ${((Date.now() - t0) / 1000).toFixed(1)}s，对象号数: ${locations.size}，/ObjStm 出现: ${objstmCount}`);

// 重复对象号报告
let dups = 0;
for (const [num, offs] of locations) {
  if (offs.length > 1) {
    dups++;
    if (dups <= 10) console.log(`重复对象号 ${num}: ${offs.join(", ")}`);
  }
}
console.log(`重复对象号总数: ${dups}`);

// ---- 3. 组装新 xref 条目 ----
const maxNum = Math.max(OLD_SIZE_HINT - 1, ...locations.keys());
const entries = [];
let found = 0;
for (let n = 0; n <= maxNum; n++) {
  const offs = locations.get(n);
  if (offs && offs.length > 0) {
    // 重复时取最后一次出现（增量更新语义；本文件的 1/2/3 正是末尾追加的）
    const offset = offs[offs.length - 1];
    entries.push(`${String(offset).padStart(10, "0")} 00000 n\r\n`);
    found++;
  } else {
    entries.push("0000000000 65535 f\r\n");
  }
}
console.log(`新表对象: ${found} 在用 / ${maxNum + 1} 总条目`);

// ---- 4. 末尾追加新 xref 段 ----
const newStartXref = fileSize;
const newSection =
  `xref\r\n0 ${maxNum + 1}\r\n` +
  entries.join("") +
  `trailer\r\n<</Size ${maxNum + 1}/Root 1 0 R/Info 3 0 R${idPart ? "/" + idPart.slice(1) : ""}/Prev ${OLD_STARTXREF}>>\r\n` +
  `startxref\r\n${newStartXref}\r\n%%EOF\r\n`;
fs.writeSync(fd, Buffer.from(newSection, "latin1"), 0, Buffer.byteLength(newSection, "latin1"), fileSize);
fs.closeSync(fd);
console.log(`已追加 ${(Buffer.byteLength(newSection, "latin1") / 1024).toFixed(0)}KB，新 startxref=${newStartXref}`);
console.log(`回滚命令: 截断文件到 ${fileSize} 字节`);
