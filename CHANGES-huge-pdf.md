# 超大 PDF（5.6GB）在线浏览支持 —— 改动清单

> 日期：2026-08-03
> 目标：`PDF合并5G.pdf`（5.63GB / 9190 页 / 30303 对象）在 pdf.js viewer 中 5 秒内打开首页、滚动条翻页可用。

## 验收结果

| 指标 | 目标 | 实测 |
|---|---|---|
| 首页渲染 | < 5s | **1.60s** |
| 跳转第 5000 页 | 可渲染 | **0.46s** |
| 打开所需流量 | — | **14.4MB**（修复前需下载全部 6041MB） |
| 单元测试 | 无回归 | 1544 个 spec，1535 通过（9 个失败均为环境原因，见下） |
| 多类型冒烟 | 无回归 | 15 份 PDF 14 通过（1 个为上游本就打不开的损坏样本，经原始代码对照确认） |

## 一、修改的仓库文件（4 个）

### 1. `src/core/chunked_stream.js`（核心，+142/-36）

**问题**：构造时 `new Uint8Array(length)` 预分配整个文件大小的连续 buffer，5.6GB 超出 V8 ArrayBuffer 上限（~4GB），加载 0.9 秒即抛 `Array buffer allocation failed`。

**改动**：
- 存储改为按 64KB 块稀疏存储 `_chunkMap: Map<chunkIndex, Uint8Array>`，只占用已下载块的内存；
- 新增 `_storeRange()`（支持非块对齐的渐进数据，块填满才标记 loaded）和 `_readRange()`（单块内返回零拷贝视图，跨块拷贝；缺块补零，与旧零初始化行为一致）；
- `getByte()` 带单块缓存，解析器顺序读取仍 O(1)；
- `this.bytes` 改为 `Object.defineProperty` 惰性 getter：仅在全部块加载后（GetData/Save 路径）才装配连续 buffer；未加载完访问抛明确错误；
- 私有方法用 `_` 前缀而非 `#`——`makeSubStream` 的 `Object.create(this)` 子流不是类实例，`#` 私有方法会在子流上抛 TypeError。

### 2. `src/core/worker.js`（1 行）

`DataLoaded` 消息：`stream.bytes.byteLength` → `stream.length`（避免仅为取长度就装配整文件 buffer）。

### 3. `src/core/evaluator.js`（1 处）

toUnicode CMap 哈希：`new Uint8Array(stream.bytes.buffer, stream.start, ...)` → `stream.getByteRange(stream.start, stream.end)`（对普通 Stream 语义相同，对稀疏 ChunkedStream 同样正确）。

### 4. `test/test.mjs`（2 处测试基建修复，非发布代码）

- `--noDownload` 标志原本解析了却从不生效（`main()` 无条件下载外链测试 PDF）→ 在 `ensurePDFsDownloaded()` 中接上判断；
- `startBrowsers()` 安装浏览器时无视 `--noChrome`/`--noFirefox` → 只安装实际要用的浏览器。

## 二、新增文件（未跟踪）

| 文件 | 用途 |
|---|---|
| `repair-xref-full.mjs` | 坏 xref 修复工具：顺序扫描定位全部对象头，在文件末尾**追加**全新 xref 段（增量更新式，不改原字节）。同类坏文件改文件名可复用 |
| `verify-5g.mjs` | 验收脚本：首页计时、跳页测试、网络流量统计、对照组 |
| `regression-smoke.mjs` | 回归冒烟：15 份多类型 PDF（注释/JBIG2/JPX/CID 字体/Type3/XFA 等） |
| `verify-5g-fixed.png` | 证据截图：第 5000/9190 页渲染效果 |

## 三、数据文件修改（`PDF合并5G.pdf`）

该文件 xref 表本身损坏（合并工具所致）：对象 1/2/3（Catalog/Pages根/Info）条目指向错误旧偏移，对象 10736 起条目全是垃圾（含负偏移）。修复方式：

- 先就地修补了 3 个条目（旧值：obj1→1745710126, obj2→1745709044, obj3→1745710103）；
- 再全量重建：30303 个对象（无重复、无对象流），在文件末尾追加 592KB 新 xref 段，新 startxref=6041289460。
- **回滚**：截断文件到 6041289460 字节（去除追加段）；如需完全复原，再把上述 3 个条目写回旧偏移。

## 四、正确用法（重要）

打开超大 PDF 必须用 **hash 传参**（`#` 不是 `&`）关闭全量流式和自动预取：

```
http://localhost:8888/web/viewer.html?file=/PDF合并5G.pdf#disableStream=true&disableAutoFetch=true
```

viewer 的 disable* 选项只从 URL hash 通道读取（web/app.js:401-407）。不加时 pdf.js 会在后台把整个文件流式拉进 worker（6GB），拖死按需请求。

注意：viewer「打开文件」菜单（blob: URL → XHR 流 → `isHttp=false` → Range 被协议禁用）对大文件仍然慢，这是与 URL 路径不同的加载机制。**该问题已于 2026-08-03 修复，见「六」。**

## 五、已知事项

- 单测 9 个失败均与本次改动无关：8 个是外链测试 PDF 未下载（404），1 个是日期解析的时区问题（UTC+8）。
- `test/pdfs/issue9186.pdf.link` 在 git status 中恒显示 modified：上游 blob 是 CRLF 而 `.gitattributes` 要求 LF，全新克隆亦如此，属上游固有现象。
- 会话期间 `.git`/`.github` 被误删，已通过重新克隆官方仓库拷回元数据恢复（基线 ae976b924 未变，改动无损失）；改动文件另有备份在 `D:\project\changes-backup\`。

## 六、「打开文件」菜单超大 PDF 秒开（2026-08-03，第二次改动）

**问题**：viewer「打开文件」菜单把 File 转成 `URL.createObjectURL(file)`（blob: URL）走 URL 加载；`isValidFetchUrl` 只认 http/https → blob: 落到 XHR 流 → `isHttp=false` → Range 被禁用 → worker 全量顺序下载并拼接 5.6GB，必崩/极慢。

**改动**（2 个文件）：

1. **新增 `web/blob_range_transport.js`**：`BlobRangeTransport extends PDFDataRangeTransport`，`requestDataRange(begin, end)` 用 `blob.slice(begin, end).arrayBuffer()` 按需读取本地文件，`abort()` 置标志位丢弃迟到结果。不调 `onDataProgressiveRead`——纯按需，无后台全量流。
2. **`web/app.js` 的 `onFileInputChange`**：handler 改 async，按文件大小阈值分流——
   - ≤ 32MB：原有 blob URL 路径，一行不动（零行为变化）；
   - \> 32MB：预读首 64KB 作 `initialData`，构造 `BlobRangeTransport`，以 `{ url: blob URL（仅标题/下载回退）, range, rangeChunkSize: 65536, disableStream: true, disableAutoFetch: true }` 调 `open()`。args 在 `getDocument({...apiParams, ...args})` 中后展开，只影响本次加载，不改全局 AppOptions。

**验收结果**（Puppeteer 驱动真实文件选择框，脚本 `verify-menu-5g.mjs`）：

| 指标 | 目标 | 实测 |
|---|---|---|
| 菜单路径首页渲染 | < 5s | **3.13s** |
| 跳转第 5000 页 | 可渲染 | **1.33s** |
| JS 堆占用 | — | **29MB**（修复前需装配 5.6GB 必然失败） |
| 页面错误 | 无 | 无 |
| 小文件对照（tracemonkey.pdf，脚本 `verify-menu-small.mjs`） | 菜单/URL 渲染一致 | 14 页、canvas 1019x1319，两路径完全一致 |

**明确不改**：小文件路径、http URL 路径、全局选项；`getData()` 导出整个 5.6GB 仍失败（固有约束），下载按钮有 blob URL 回退（浏览器流式写盘，不经 pdf.js 缓冲）。
