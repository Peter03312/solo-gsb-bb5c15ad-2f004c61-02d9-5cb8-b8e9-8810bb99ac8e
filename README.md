# range-plan-api — HTTP 字节范围响应规划服务

基于 **Node.js + Fastify + range-parser** 构建的字节范围（byte-range）响应规划
API，遵循 [RFC 9110 §14](https://www.rfc-editor.org/rfc/rfc9110.html#section-14)。

服务**不传输真实文件内容**：客户端提交资源总字节数与 `Range` 请求头，服务返回
一份“响应规划”——应当使用的 HTTP 状态码、响应头、每段的偏移/长度、每段头部，
以及多段时确定性的 `multipart/byteranges` 边界和实际线上传输字节核算。

另提供 `POST /resume-plan` 断点续传缺口规划接口：上报已持久化的字节区间，
返回还需请求的 Range 分片清单（见下文）。

`POST /multipart-check` 则用于**核验**真实的 `multipart/byteranges` 响应
报文：传入资源大小、期望区间与原始报文，返回实收、缺失、预期外的字节区间。

`POST /assemble-response` 走相反方向：客户端提交 `Range` 请求头与稀疏缓存
片段（各含起始偏移与 base64 字节），服务复用 `/plan` 的规划规则算出选中
区间，校验片段一致性与覆盖完整性后，**只从缓存字节**拼出源站应有的原始
响应体（单段或 `multipart/byteranges`），连同状态码与响应头一并返回。

`POST /cache-integrity-check` 用于校验稀疏缓存的**完整性**：提交资源
`size`、`blockBytes`、按块顺序排列的每块 SHA-256 十六进制摘要，以及与
`/assemble-response` 同结构的稀疏片段；服务合并片段（重叠处字节必须一致），
逐块判定为 `verified` / `missing` / `corrupt`，并返回需重新下载的字节
闭区间 `refetchRanges`（见下文）。

`POST /cache-retention-plan` 解决缓存淘汰规划：上报已有缓存区间、预计访问
区间（各带正整数权重）与字节预算，重叠缓存只计一次、重叠访问权重按字节
累加，仅保留缓存中**正价值**的字节，按"每字节累计权重降序、偏移升序"选满
预算（允许在区间内部截断），返回归并后的保留区间与字节核算（见下文）。

`POST /shared-fetch-plan` 面向多客户端**共享回源**：同一资源被多个客户端
并行请求时，提交资源总字节数、各客户端标识与其所需闭区间、单次回源字节
上限和允许跨越的最大空隙；服务先跨客户端归并重叠/相邻需求并按上限拆块，
再自左向右合并候选（仅在间隙不超过阈值且合并后不超上限时跨隙），输出
升序互不重叠的回源闭区间、可直接使用的 `Range` 值、每个客户端被各次回源
覆盖的字节，以及去重需求 / 实际回源 / 额外获取的字节核算（见下文）。

## 单条启动命令

```bash
docker compose up --build -d
```

启动后服务监听：

```
http://localhost:3000
```

健康检查：

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

> 不想用 Docker 时：`npm ci && npm start`（需要 Node.js ≥ 20），
> 同样监听 `http://localhost:3000`。

## 接口

### `POST /plan`（主接口）

`Range` 以真实请求头携带，与源站收到的请求完全一致；资源信息放在 JSON 体里。

请求体：

| 字段             | 类型    | 必填 | 说明                                   |
| ---------------- | ------- | ---- | -------------------------------------- |
| `size`           | integer | 是   | 资源总字节数，非负安全整数（≥ 0）       |
| `contentType`    | string  | 否   | 资源媒体类型，默认 `application/octet-stream` |
| `etag`           | string  | 否   | 资源当前的实体标签（entity-tag），如 `"v1-abc"` 或 `W/"v1-abc"` |
| `lastModified`   | string  | 否   | 资源当前的 `Last-Modified`，必须是合法 HTTP-date（IMF-fixdate / RFC 850 / asctime 三种标准格式之一），如 `Wed, 21 Oct 2015 07:28:00 GMT` |

可另带可选的 `If-Range` 请求头（单个**强 ETag** 或单个 **HTTP-date**），按
[RFC 9110 §13.1.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.3)
评估后再决定是否执行 Range 规划：

- `If-Range` 与当前 `etag` **逐字节相同且都是强验证器**（`"…"`，`W/` 前缀一律不匹配），或
- `If-Range` 是不早于 `lastModified` 的 HTTP-date（相等也算通过），

才返回 `206` 分片规划；否则（验证器不匹配、缺失对应资源元数据、验证器格式
无效、弱验证器、日期早于 Last-Modified）**忽略 Range**，返回 `200` 的完整
传输规划（`decision: "full"`，`Content-Length=size`）。注意此时 Range 头
根本不会被解析，因此 Range 本身语法错误也仍然得到 200。

另有等价的 `GET /plan?size=...&contentType=...&etag=...&lastModified=...`，
便于直接用浏览器/curl 探测。服务默认监听本机 **3000 端口**，即
`http://localhost:3000`（可用 `PORT` 环境变量或 compose 端口映射修改）。

`If-Range` / `lastModified` 的日期统一按 RFC 9110 §5.6.7 的 **HTTP-date**
严格解析，三种标准格式都接受：

| 格式 | 示例 | 说明 |
| --- | --- | --- |
| IMF-fixdate | `Wed, 21 Oct 2015 07:28:00 GMT` | 现代格式，4 位年份 |
| RFC 850 | `Wednesday, 21-Oct-15 08:49:37 GMT` | 旧式格式，完整星期名、两位年份 |
| asctime | `Wed Oct 21 07:28:00 2015` | 旧式格式，单位数日期前补空格，如 `Sun Nov  6 08:49:37 1994` |

RFC 850 的两位年份按**接收时的 UTC 年份**解释：落在当前世纪对应位置，若
结果在未来超过 50 年则回拨 100 年（例如 2026 年收到 `94` → 1994，
`26` → 2026）。三种格式都会校验星期与真实日历是否一致、日历日期与时间
字段是否合法；比较时统一使用解析后的时刻，所以混用格式也能正确判定。

快速验证：

```bash
# 单区间（206 + 单段头部规划）
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99' \
  -d '{"size":10000,"contentType":"video/mp4"}'

# 多区间（206 + multipart/byteranges 规划）
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99, 500-599' \
  -d '{"size":10000}'

# If-Range 命中当前 ETag -> 206 分片
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99' \
  -H 'If-Range: "v1-abc"' \
  -d '{"size":10000,"etag":"\"v1-abc\""}'

# If-Range 过期（ETag 不匹配）-> 200 完整规划
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99' \
  -H 'If-Range: "stale"' \
  -d '{"size":10000,"etag":"\"v1-abc\""}'

# 等价 GET
curl 'http://localhost:3000/plan?size=10000' -H 'Range: bytes=-500'

# If-Range 使用旧式 RFC 850 日期（两位年份）-> 与 Last-Modified 同一时刻，仍返回 206
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99' \
  -H 'If-Range: Wednesday, 21-Oct-15 07:28:00 GMT' \
  -d '{"size":10000,"lastModified":"Wed, 21 Oct 2015 07:28:00 GMT"}'

# If-Range 使用 asctime 日期（单位数日期前补一个空格）-> 同样 206
curl -X POST http://localhost:3000/plan \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-99' \
  -H 'If-Range: Sun Nov  6 08:49:37 1994' \
  -d '{"size":10000,"lastModified":"Sun, 06 Nov 1994 08:49:37 GMT"}'

# 旧式日期同样可作为资源元数据（GET 版，注意空格需要 %20 编码）
curl 'http://localhost:3000/plan?size=10000&lastModified=Wednesday,%2021-Oct-15%2007:28:00%20GMT' \
  -H 'Range: bytes=0-99'
```

### `POST /resume-plan`（断点续传缺口规划）

面向断点续传场景：客户端上报**已持久化**的字节区间，服务先归并（乱序、
重叠、相邻的区间都会合并），计算尚缺字节，再按偏移升序把缺口拆成不超过
`chunkBytes` 的 Range 请求清单，最多返回 `limit` 条。全部参数在 JSON 体内，
不涉及 `Range` 请求头。

请求体：

| 字段         | 类型    | 必填 | 说明                                                         |
| ------------ | ------- | ---- | ------------------------------------------------------------ |
| `size`       | integer | 是   | 资源总字节数，非负安全整数（≥ 0）                             |
| `completed`  | array   | 是   | 已持久化区间数组，每项 `{"start":…,"end":…}` 为**闭区间**（起止端点均含）；可乱序、重叠或相邻 |
| `chunkBytes` | integer | 是   | 单次请求最大字节数，正安全整数（≥ 1）                         |
| `limit`      | integer | 是   | 本次最多返回的请求条数，正安全整数，上限 10000                |

校验严格（独立于 `/plan`，不做类型强转）：所有数值必须是安全整数——字符串
`"1000"`、小数、负数、超过 `Number.MAX_SAFE_INTEGER` 的值一律 `400`；区间需
满足 `0 ≤ start ≤ end < size`；`completed` 最多 10000 项；不允许多余字段。

响应（`200`）字段：

| 字段             | 说明                                                         |
| ---------------- | ------------------------------------------------------------ |
| `completedBytes` | 归并后的已完成字节数（重叠部分不重复计算）                    |
| `remainingBytes` | 尚缺字节数（`size − completedBytes`）                         |
| `hasMore`        | 本次返回的请求未覆盖全部缺口时为 `true`，可再次调用继续规划   |
| `requestsCount`  | 本次返回的请求条数                                            |
| `requests[]`     | 每条含 `index`、`start`/`end`（闭区间起止偏移）、`bytes`、`rangeHeader`（可直接用作 `Range` 请求头值，如 `bytes=300-549`） |

空资源（`size: 0`）和已完整下载的资源都返回空 `requests`、`remainingBytes: 0`、
`hasMore: false`。

示例：

```bash
# 已持久化 [0,299]，每次最多 250 字节，本次取 2 条
curl -X POST http://localhost:3000/resume-plan \
  -H 'Content-Type: application/json' \
  -d '{"size":1000,"completed":[{"start":0,"end":299}],"chunkBytes":250,"limit":2}'
```

响应：

```json
{
  "statusCode": 200,
  "resource": { "size": 1000 },
  "completedBytes": 300,
  "remainingBytes": 700,
  "hasMore": true,
  "requestsCount": 2,
  "requests": [
    { "index": 1, "start": 300, "end": 549, "bytes": 250, "rangeHeader": "bytes=300-549" },
    { "index": 2, "start": 550, "end": 799, "bytes": 250, "rangeHeader": "bytes=550-799" }
  ]
}
```

`hasMore: true` 表示仍有缺口未列出；把新完成的区间并入 `completed` 后再次
调用即可取得后续分片，直到 `hasMore: false`。区间归并示例：上报
`[{"start":40,"end":59},{"start":10,"end":19},{"start":30,"end":49},{"start":0,"end":9}]`
会归并为 `[0,19]` 与 `[30,59]` 再计算缺口。

### `POST /multipart-check`（multipart/byteranges 报文核验）

核验一份真实的 `multipart/byteranges` 响应报文是否结构合法，并对照客户端
**期望收到**的区间核算字节：实收区间（归并）、期望但未收的区间、预期外的
区间。典型用途是校验下载客户端/代理拼出的分片报文。

请求体：

| 字段          | 类型    | 必填 | 说明                                                         |
| ------------- | ------- | ---- | ------------------------------------------------------------ |
| `size`        | integer | 是   | 资源总字节数，非负安全整数（`size ≥ 0`）                     |
| `expected`    | array   | 是   | 期望区间数组（≤ 16 项），每项 `{"start":…,"end":…}` 为**闭区间**，须满足 `0 ≤ start ≤ end < size`；可乱序、重叠、相邻 |
| `contentType` | string  | 是   | 报文的媒体类型，必须是 `multipart/byteranges` 且带一个 `boundary` 参数（可加引号，如 `boundary="abc-1"`）；boundary 为 1～70 位字母数字或连字符 |
| `bodyBase64`  | string  | 是   | 原始报文的标准 base64 编码（含规范 `=` 填充）；解码后 **≤ 1 MiB** |

报文必须严格采用规范封装：全部以 **CRLF** 分隔，**无前言（preamble）、无
尾声（epilogue）**，以 `--boundary` 开头、以 `--boundary--` 加 CRLF 收尾；
每段含**唯一一个** `Content-Range` 头（形如 `bytes 0-99/1000`，总大小须等于
`size`，端点须落在资源内），段数据长度必须等于 `end-start+1`；各段的
Content-Range 不得重复；段数 ≤ 16。数据中即使出现与边界相似的字节序列，
只要不构成合法的边界分隔行（前导 CRLF + `--boundary` + CRLF/`--`），就不会
截断分段。

任何非法输入（类型/数值不合法、多余字段）或非法结构都返回 `400`（如
`INVALID_BOUNDARY`、`MALFORMED_MULTIPART`、`MISSING_CONTENT_RANGE`、
`DUPLICATE_CONTENT_RANGE`、`PART_BYTE_LENGTH_MISMATCH`、`MESSAGE_TOO_LARGE`
等）。

响应（`200`）：

| 字段       | 说明                                                         |
| ---------- | ------------------------------------------------------------ |
| `received` | 归并后的实收区间（重叠/相邻合并），按起点升序                |
| `missing`  | 期望但未收的区间（`expected − received`），归并后按起点升序  |
| `extra`    | 预期外字节区间（`received − expected`），归并后按起点升序    |
| `complete` | `missing` 与 `extra` 均为空时为 `true`                       |

示例（实收两段合并覆盖 `0-49`，`30-59` 中有 10 字节属于预期外）：

```bash
python3 - <<'PY'
import base64, json, urllib.request
CRLF = "\r\n"
boundary = "bnd-123"
def part(start, end, size, data):
    return f"--{boundary}{CRLF}Content-Range: bytes {start}-{end}/{size}{CRLF}{CRLF}" + data + CRLF
body = (part(0, 29, 100, "a"*30) + part(30, 59, 100, "b"*30) + f"--{boundary}--{CRLF}").encode()
payload = {"size": 100, "expected": [{"start": 0, "end": 49}],
           "contentType": f"multipart/byteranges; boundary={boundary}",
           "bodyBase64": base64.b64encode(body).decode()}
req = urllib.request.Request("http://localhost:3000/multipart-check",
                             data=json.dumps(payload).encode(),
                             headers={"Content-Type": "application/json"})
print(urllib.request.urlopen(req).read().decode())
PY
```

响应：

```json
{
  "statusCode": 200,
  "received": [{ "start": 0, "end": 59 }],
  "missing": [],
  "extra": [{ "start": 50, "end": 59 }],
  "complete": false
}
```

### `POST /assemble-response`（稀疏缓存拼装响应）

客户端持有资源的**稀疏缓存字节**（如断点续传留下的分片），以真实 `Range`
请求头（与 `/plan` 完全一致，必填、拒绝重复头）加 JSON 体提交缓存片段。
服务复用 `/plan` 的区间归并与限额规则（解析、夹取、合并、段数/传输字节
守卫）算出选中区间，再依次校验片段、检查重叠冲突与覆盖空洞，全部通过后
**只从缓存字节**拼出源站应有的原始响应体并 base64 返回。本接口不评估
`If-Range`。

请求体：

| 字段          | 类型    | 必填 | 说明                                                         |
| ------------- | ------- | ---- | ------------------------------------------------------------ |
| `size`        | integer | 是   | 资源总字节数，非负安全整数（≥ 0）                             |
| `contentType` | string  | 否   | 资源媒体类型，默认 `application/octet-stream`                |
| `fragments`   | array   | 是   | 缓存片段数组（≤ 1024 项），每项 `{"start":…,"dataBase64":…}`：`start` 为片段起始偏移（非负安全整数），`dataBase64` 为自该偏移起的连续字节（标准 base64、规范 `=` 填充，解码后 ≥ 1 字节） |

处理顺序与失败语义：

1. **片段校验（400）**：每个片段必须完整落在资源内（`start + 字节数 ≤ size`），
   base64 必须规范；全部片段解码后合计 **≤ 1 MiB**。错误码：
   `INVALID_FRAGMENT`、`INVALID_FRAGMENT_BASE64`、`FRAGMENT_OUT_OF_BOUNDS`、
   `FRAGMENTS_TOO_LARGE`、`TOO_MANY_FRAGMENTS`。
2. **区间规划**：规则与 `/plan` 完全相同；`400`（Range 缺失/语法/单位）、
   `416`（不可满足）、`422`（`TOO_MANY_SEGMENTS` / `TRANSFER_LIMIT_EXCEEDED`）
   结果原样透传。
3. **重叠冲突（409）**：片段重叠位置的字节必须一致，否则返回
   `FRAGMENT_CONFLICT` 与 `conflicts`——归并后的冲突区间（相邻差异合并为一
   段）；即使冲突落在选中区间之外也照样失败。
4. **覆盖检查（409）**：选中区间存在缓存空洞时返回 `INCOMPLETE_COVERAGE`
   与 `missing`——缺失区间（归并后按起点升序）。
5. **拼装（206）**：按规划顺序从可跨片段的缓存取数。单段时响应体即该段原始
   字节；多段时生成规范 `multipart/byteranges` 报文（与 `/plan` 相同的确定性
   边界，封装格式正是 `/multipart-check` 接受的形式，可互相验证）。拼装后的
   响应体同样 **≤ 1 MiB**，超出返回 `422 ASSEMBLED_TOO_LARGE`。

响应（`206`）在 `/plan` 规划结果的基础上增加两个字段：

| 字段         | 说明                                                         |
| ------------ | ------------------------------------------------------------ |
| `bodyBase64` | 拼装出的原始响应体（标准 base64）：单段字节或完整 multipart 报文 |
| `bodyBytes`  | 解码后的体长度；`responseHeaders['Content-Length']` 恒等于它  |

示例：

```bash
# 单区间：缓存 [0,9]（10 个 'a'），请求 bytes=0-9 -> 206，bodyBase64 即这 10 字节
curl -X POST http://localhost:3000/assemble-response \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-9' \
  -d '{"size":1000,"contentType":"video/mp4","fragments":[{"start":0,"dataBase64":"YWFhYWFhYWFhYQ=="}]}'

# 多区间：缓存 [0,9] 与 [100,109] -> 206 multipart/byteranges 原始报文
curl -X POST http://localhost:3000/assemble-response \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-9, 100-109' \
  -d '{"size":1000,"fragments":[{"start":0,"dataBase64":"YWFhYWFhYWFhYQ=="},{"start":100,"dataBase64":"YmJiYmJiYmJiYg=="}]}'

# 重叠冲突：两片在 [5,9] 字节不一致 -> 409
curl -X POST http://localhost:3000/assemble-response \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-9' \
  -d '{"size":1000,"fragments":[{"start":0,"dataBase64":"YWFhYWFhYWFhYQ=="},{"start":5,"dataBase64":"WFhYWFg="}]}'
# {"statusCode":409,"code":"FRAGMENT_CONFLICT","error":"Conflict",
#  "message":"overlapping fragments carry different bytes in 1 interval",
#  "conflicts":[{"start":5,"end":9}]}

# 覆盖空洞：缓存只覆盖 [0,4] 与 [10,14] -> 409
curl -X POST http://localhost:3000/assemble-response \
  -H 'Content-Type: application/json' \
  -H 'Range: bytes=0-14' \
  -d '{"size":1000,"fragments":[{"start":0,"dataBase64":"YWFhYWE="},{"start":10,"dataBase64":"YmJiYmI="}]}'
# {"statusCode":409,"code":"INCOMPLETE_COVERAGE","error":"Conflict",
#  "message":"cached fragments leave 1 hole in the selected ranges",
#  "missing":[{"start":5,"end":9}]}
```

单区间 206 响应示例（节选）：

```json
{
  "statusCode": 206,
  "decision": "partial",
  "segmentsCount": 1,
  "responseHeaders": {
    "Accept-Ranges": "bytes",
    "Content-Type": "video/mp4",
    "Content-Range": "bytes 0-9/1000",
    "Content-Length": "10"
  },
  "bodyBytes": 10,
  "bodyBase64": "YWFhYWFhYWFhYQ=="
}
```

多区间时 `multipart` 字段给出确定性边界，`bodyBase64` 解码后即为完整
`multipart/byteranges` 报文（`--boundary` CRLF 段头 CRLF 数据 CRLF …
`--boundary--` CRLF），段顺序与规划顺序一致（保持各区间首次出现的顺序，
不一定是偏移升序）。

### `POST /cache-integrity-check`（稀疏缓存完整性校验）

客户端持有资源的**稀疏缓存字节**，并知道资源按固定大小分块后**每块的
SHA-256 摘要**。服务合并片段（规则与 `/assemble-response` 相同），逐块
判定缓存可信、缺失或损坏，并给出需要重新下载的字节区间。本接口不涉及
`Range` 请求头。

请求体：

| 字段         | 类型    | 必填 | 说明                                                         |
| ------------ | ------- | ---- | ------------------------------------------------------------ |
| `size`       | integer | 是   | 资源总字节数，非负安全整数，且 **≤ 1 MiB**（1048576）        |
| `blockBytes` | integer | 是   | 块大小（字节），正安全整数（≥ 1）；除最后一块外每块均为该大小，最后一块为剩余字节 |
| `digests`    | array   | 是   | 按块顺序排列的 SHA-256 摘要，数量必须**恰好等于** `ceil(size/blockBytes)`；每项为 **64 位小写十六进制**字符串（如 `"9f86d081…"`，不接受大写） |
| `fragments`  | array   | 是   | 缓存片段数组（≤ 1024 项），结构与 `/assemble-response` 完全相同：每项 `{"start":…,"dataBase64":…}`，`dataBase64` 为规范标准 base64（规范 `=` 填充、非空）；片段必须**完整落在资源内**，全部解码后合计 **≤ 1 MiB** |

片段合并与冲突规则与 `/assemble-response` 相同：重叠处字节相同可共存
（相邻片段自动拼接）；重叠处**字节不同**则把冲突位置涉及的**每个块**记为
`corrupt`（即使该块缓存完整也不再计算摘要）。

逐块分类（块 `i` 覆盖字节 `[i*blockBytes, min((i+1)*blockBytes, size) - 1]`）：

1. **corrupt（损坏）**：片段冲突区间触及该块；或缓存完整覆盖该块，但算出的
   SHA-256 与提交的摘要不一致。
2. **missing（缺失）**：无冲突触及，但缓存**未覆盖**该块的每个字节（不足一
   整块，无法计算摘要）。
3. **verified（已验证）**：完整覆盖、无冲突且 SHA-256 与摘要一致。

响应（`200`）字段：

| 字段            | 说明                                                         |
| --------------- | ------------------------------------------------------------ |
| `blocksCount`   | 块总数，恒等于 `ceil(size/blockBytes)`                       |
| `verified`      | 已验证块的**索引**数组（升序）                               |
| `missing`       | 缺失块的索引数组（升序）                                     |
| `corrupt`       | 损坏块的索引数组（升序）                                     |
| `refetchRanges` | 由全部 `missing` / `corrupt` 块的字节区间合并而成的**闭区间**（相邻块合并为一段，按起点升序、互不相交），可直接据此发起 Range 重新下载 |

空资源（`size: 0`）要求 `digests: []`，返回 `blocksCount: 0`、各状态数组与
`refetchRanges` 均为空。

任何非法字段或数值都返回 `400`，错误码包括：`INVALID_SIZE`、
`RESOURCE_TOO_LARGE`（size 超过 1 MiB）、`INVALID_BLOCK_BYTES`、
`INVALID_DIGESTS`、`INVALID_DIGEST_COUNT`（数量不等于
`ceil(size/blockBytes)`）、`INVALID_DIGEST`（不是 64 位小写十六进制）、
`INVALID_FRAGMENT`、`INVALID_FRAGMENT_BASE64`、`FRAGMENT_OUT_OF_BOUNDS`、
`FRAGMENTS_TOO_LARGE`、`TOO_MANY_FRAGMENTS`、`INVALID_FRAGMENTS`；多余字段
同样 `400`（严格校验器，不做类型强转）。

示例（300 字节资源、3 个 100 字节块；块 0 完整且摘要相符 → verified，块 1
完整但提交的摘要不符 → corrupt，块 2 无任何片段 → missing；后两块相邻，
`refetchRanges` 合并为 `[100,299]`）：

```bash
python3 - <<'PY'
import base64, hashlib, json, urllib.request

def span(start, length):
    return bytes((start + i) % 251 for i in range(length))

size, block = 300, 100
data = span(0, 200)                      # 只缓存 [0,199]
digests = [
    hashlib.sha256(span(0, 100)).hexdigest(),  # 块 0：正确摘要
    "a" * 64,                                  # 块 1：错误摘要
    "b" * 64,                                  # 块 2：缓存缺失，摘要不会被使用
]
payload = {"size": size, "blockBytes": block, "digests": digests,
           "fragments": [{"start": 0, "dataBase64": base64.b64encode(data).decode()}]}
req = urllib.request.Request("http://localhost:3000/cache-integrity-check",
                             data=json.dumps(payload).encode(),
                             headers={"Content-Type": "application/json"})
print(urllib.request.urlopen(req).read().decode())
PY
```

响应：

```json
{
  "statusCode": 200,
  "blocksCount": 3,
  "verified": [0],
  "missing": [2],
  "corrupt": [1],
  "refetchRanges": [{ "start": 100, "end": 299 }]
}
```

重叠片段字节冲突的例子：两片在字节 50 处不一致，冲突区间 `[50,50]` 落在
块 0 内，于是块 0 直接记为 corrupt（不再比对摘要）：

```bash
curl -s -X POST http://localhost:3000/cache-integrity-check \
  -H 'Content-Type: application/json' \
  -d '{"size":400,"blockBytes":100,"digests":["<sha256(block0)>","<sha256(block1)>","<sha256(block2)>","<sha256(block3)>"],"fragments":[{"start":0,"dataBase64":"..."},{"start":50,"dataBase64":"..."}]}'
```

非法输入示例（摘要数量应为 `ceil(100/64)=2`，此处为空 → 400）：

```bash
curl -i -X POST http://localhost:3000/cache-integrity-check \
  -H 'Content-Type: application/json' \
  -d '{"size":100,"blockBytes":64,"digests":[],"fragments":[]}'
# HTTP/1.1 400 Bad Request
# {"statusCode":400,"code":"INVALID_DIGEST_COUNT",...}
```

### `POST /cache-retention-plan`（缓存保留规划）

面向缓存淘汰场景：客户端上报**已有缓存**的字节区间、**预计访问**的区间
（各带一个正整数权重）以及保留预算 `budgetBytes`，服务算出预算内最值得
保留的缓存字节。全部参数在 JSON 体内，不涉及 `Range` 请求头。

请求体：

| 字段          | 类型    | 必填 | 说明                                                         |
| ------------- | ------- | ---- | ------------------------------------------------------------ |
| `size`        | integer | 是   | 资源总字节数，非负安全整数（≥ 0）                             |
| `cached`      | array   | 是   | 已有缓存区间数组（≤ 1000 项），每项 `{"start":…,"end":…}` 为**闭区间**（起止端点均含），须满足 `0 ≤ start ≤ end < size`；可乱序、重叠、相邻 |
| `accesses`    | array   | 是   | 预计访问区间数组（≤ 1000 项），每项 `{"start":…,"end":…,"weight":…}` 为**闭区间**加正整数权重（1～1000000），区间边界规则同 `cached` |
| `budgetBytes` | integer | 是   | 保留预算字节数，非负安全整数（≥ 0）                           |

计算规则：

1. **缓存去重**：重叠或相邻的缓存区间先归并，重叠部分只计一次。
2. **权重累加**：每个字节的"价值"是覆盖它的所有访问区间权重之和。
3. **正价值筛选**：只有被缓存**且**累计权重大于 0 的字节才参与保留。
4. **预算填充**：按每字节累计权重**降序**、偏移**升序**依次选入，直到
   预算耗尽；允许在区间内部截断（截断时保留该段的低偏移前缀）。
5. **归并输出**：选中字节重新归并为互不相交的升序闭区间（相邻选择合并
   为一段）。

响应（`200`）字段：

| 字段            | 说明                                                         |
| --------------- | ------------------------------------------------------------ |
| `retained`      | 保留区间数组（闭区间、按起点升序、互不相交）                  |
| `retainedBytes` | 实际保留的字节数（恒 ≤ `budgetBytes`）                        |
| `unusedBytes`   | 未用掉的预算（`budgetBytes − retainedBytes`）；正价值缓存字节不足填满预算时大于 0 |

校验与 `/resume-plan` 同样严格（严格校验器，不做类型强转）：所有数值必须
是安全整数——字符串 `"1000"`、小数、负数、超过 `Number.MAX_SAFE_INTEGER`
的值一律 `400`；区间端点必须落在资源内；`cached` / `accesses` 各最多
1000 项；权重上限 100 万；不允许多余字段。

示例：缓存 `[0,199]` 与 `[100,299]`（归并后 `[0,299]`），访问 `[50,149]`
权重 2、`[100,249]` 权重 3 —— 于是 `[50,99]` 价值 2、`[100,149]` 价值 5、
`[150,249]` 价值 3；预算 120 先取价值 5 的 `[100,149]`（50 字节），再从
价值 3 的段截取 70 字节 `[150,219]`，两段相邻合并为一段：

```bash
curl -X POST http://localhost:3000/cache-retention-plan \
  -H 'Content-Type: application/json' \
  -d '{"size":1000,"cached":[{"start":0,"end":199},{"start":100,"end":299}],"accesses":[{"start":50,"end":149,"weight":2},{"start":100,"end":249,"weight":3}],"budgetBytes":120}'
```

响应：

```json
{
  "statusCode": 200,
  "retained": [{ "start": 100, "end": 219 }],
  "retainedBytes": 120,
  "unusedBytes": 0
}
```

同样的输入把预算加大到 500 时，正价值缓存字节（共 200）全部保留，剩余
预算退回：

```json
{
  "statusCode": 200,
  "retained": [{ "start": 50, "end": 249 }],
  "retainedBytes": 200,
  "unusedBytes": 300
}
```

### `POST /shared-fetch-plan`（共享回源规划）

同一资源被多个客户端并行请求时，代理/客户端可把各自的需求合并成一份
**共享回源计划**，避免多个客户端各拉各的、重复回源。全部参数在 JSON 体内，
不涉及 `Range` 请求头：

| 字段            | 类型    | 必填 | 说明                                                         |
| --------------- | ------- | ---- | ------------------------------------------------------------ |
| `size`          | integer | 是   | 资源总字节数，非负安全整数（≥ 0）                             |
| `clients`       | array   | 是   | 客户端数组（≤ 1000 项），每项 `{"id":…,"ranges":…}`：`id` 为非空字符串（≤ 255 字节、不含 CR/LF），同一请求内不得重复；`ranges` 为该客户端所需闭区间数组（≤ 10000 项），每项 `{"start":…,"end":…}` 须满足 `0 ≤ start ≤ end < size`，可乱序、重叠、相邻 |
| `maxFetchBytes` | integer | 是   | 单次回源字节上限，正安全整数（≥ 1）                           |
| `maxGapBytes`   | integer | 是   | 允许跨越的最大空隙（字节），非负安全整数（≥ 0）               |

规划算法严格按两步执行：

1. **归并需求并拆块**：把所有客户端的区间合在一起，重叠或相邻（间隔为 0）
   的需求先归并为跨客户端的去重需求；再自左向右按 `maxFetchBytes` 切成
   候选块（每块长度 ≤ 上限）。
2. **自左向右跨隙合并**：维护当前回源段，依次考察右侧候选块；只有当
   **间隙 ≤ `maxGapBytes`** 且**合并后长度 ≤ `maxFetchBytes`** 时才把该块
   并入当前段（间隙字节也一并拉取），否则另起一段。算法只向右看、不回溯
   合并。

校验与 `/resume-plan` 同样严格（严格校验器，不做类型强转）：所有数值必须
是安全整数——字符串 `"1000"`、小数、负数、超过 `Number.MAX_SAFE_INTEGER`
的值一律 `400`；区间倒置（`start > end`）或越界（`end ≥ size`）返回
`400 INVALID_CLIENT_RANGE` / `400 CLIENT_RANGE_OUT_OF_BOUNDS`；重复或空
标识返回 `400 DUPLICATE_CLIENT_ID` / `400 INVALID_CLIENT_ID`；
`maxFetchBytes` / `maxGapBytes` 非法返回 `400 INVALID_MAX_FETCH_BYTES` /
`400 INVALID_MAX_GAP_BYTES`；不允许多余字段。空资源（`size: 0`）或无客户端
（`clients: []`）返回空计划（`fetches: []`、各字节核算为 0）。

响应（`200`）字段：

| 字段             | 说明                                                         |
| ---------------- | ------------------------------------------------------------ |
| `limits`         | 回显本次使用的 `maxFetchBytes` / `maxGapBytes`                |
| `clientsCount`   | 参与规划的客户端数量                                          |
| `fetchesCount`   | 规划出的回源次数                                              |
| `fetches[]`      | 每次回源：`index`、`start`/`end`（**升序、互不重叠**的闭区间）、`bytes`、`rangeHeader`（可直接作为 `Range` 请求头值，如 `bytes=300-544`）、`demandBytes`（该次回源覆盖的去重需求字节）、`extraBytes`（为跨隙多拉的空隙字节，`bytes − demandBytes`） |
| `clients[]`      | 按提交顺序排列的每个客户端：`id`、`requestedBytes`（其自身需求归并后的字节数）、`servedBytes`、`missingBytes`（正常规划恒为 0）、`coverage[]`——逐次回源列出覆盖该客户端的闭区间 `ranges`（一次回源可覆盖该客户端的多个分离区间）、对应 `fetchIndex` 与 `bytes` |
| `bytes.demand`   | **去重需求字节数**：跨所有客户端归并后的需求字节总和          |
| `bytes.fetched`  | **实际回源字节数**：所有回源区间长度之和                      |
| `bytes.extra`    | **额外获取字节数**（`fetched − demand`，全部是跨隙填充的空隙字节） |
| `bytes.resource` | 资源总字节数（即 `size`）                                     |

示例：客户端 `a` 需要 `[0,449]`（按 300 上限拆成 `[0,299]` 与
`[300,449]`），客户端 `b` 需要 `[455,544]`；尾块与 b 之间只有 5 字节
空隙（450–454），不超过 `maxGapBytes: 10`，且 `150 + 5 + 90 = 245 ≤ 300`，
于是尾块跨隙与 b 合并为一次回源，额外拉取 5 字节：

```bash
curl -X POST http://localhost:3000/shared-fetch-plan \
  -H 'Content-Type: application/json' \
  -d '{"size":1000,"clients":[{"id":"a","ranges":[{"start":0,"end":449}]},{"id":"b","ranges":[{"start":455,"end":544}]}],"maxFetchBytes":300,"maxGapBytes":10}'
```

响应：

```json
{
  "statusCode": 200,
  "resource": { "size": 1000 },
  "limits": { "maxFetchBytes": 300, "maxGapBytes": 10 },
  "clientsCount": 2,
  "fetchesCount": 2,
  "fetches": [
    { "index": 1, "start": 0, "end": 299, "bytes": 300,
      "rangeHeader": "bytes=0-299", "demandBytes": 300, "extraBytes": 0 },
    { "index": 2, "start": 300, "end": 544, "bytes": 245,
      "rangeHeader": "bytes=300-544", "demandBytes": 240, "extraBytes": 5 }
  ],
  "clients": [
    { "id": "a", "requestedBytes": 450, "servedBytes": 450, "missingBytes": 0,
      "coverage": [
        { "fetchIndex": 1, "ranges": [{ "start": 0, "end": 299 }], "bytes": 300 },
        { "fetchIndex": 2, "ranges": [{ "start": 300, "end": 449 }], "bytes": 150 }
      ] },
    { "id": "b", "requestedBytes": 90, "servedBytes": 90, "missingBytes": 0,
      "coverage": [
        { "fetchIndex": 2, "ranges": [{ "start": 455, "end": 544 }], "bytes": 90 }
      ] }
  ],
  "bytes": { "demand": 540, "fetched": 545, "extra": 5, "resource": 1000 }
}
```

参数错误示例（同一 `id` 出现两次 → 400）：

```bash
curl -i -X POST http://localhost:3000/shared-fetch-plan \
  -H 'Content-Type: application/json' \
  -d '{"size":100,"clients":[{"id":"a","ranges":[]},{"id":"a","ranges":[]}],"maxFetchBytes":10,"maxGapBytes":0}'
# HTTP/1.1 400 Bad Request
# {"statusCode":400,"code":"DUPLICATE_CLIENT_ID",...}
```

服务默认监听本机 **3000 端口**（`http://localhost:3000`），用
`docker compose up --build -d` 一条命令即可启动（见上文"单条启动命令"）。

## 响应语义

每个规划结果带 `decision` 字段：

- `"partial"` —— 执行 Range 规划：`206`（含 `416`/`422` 这类仍针对分片
  请求的结果）。
- `"full"` —— 忽略 Range、返回完整表示规划：仅 `200`。

| 情况 | 状态码 | `decision` | 说明 |
| --- | --- | --- | --- |
| 一个区间（合并后） | `206` | `partial` | `responseHeaders` 给出 `Content-Range`、`Content-Length`、`Accept-Ranges: bytes` |
| 多个区间 | `206` | `partial` | `responseHeaders` 给出 `Content-Type: multipart/byteranges; boundary=…` 与含封装开销的 `Content-Length`；`segments[].partHeaderBlock` 给出每段头部原文（CRLF） |
| 全部区间不可满足 | `416` | `partial` | 带 `Content-Range: bytes */<size>` |
| `If-Range` 未通过（或验证器无法识别） | `200` | `full` | 完整传输规划：`Content-Length: <size>`、`Content-Type`、`Accept-Ranges: bytes`；`segments`/`segmentsCount` 为 `null`，Range 不解析 |
| `Range` 语法错误 / 非 byte 单位 / 缺失 | `400` | — | 头本身无效，区别于“语法合法但无法满足” |
| 合并后段数 > 16 | `422` | `partial` | `code: TOO_MANY_SEGMENTS` |
| 计划传输字节 > 资源大小 × 2 | `422` | `partial` | `code: TRANSFER_LIMIT_EXCEEDED`，封装字节（边界+段头+收尾）也计入 |

请求带 `If-Range` 时，结果中还有 `condition` 块说明判定依据：

```json
{ "header": "If-Range", "validatorKind": "etag", "outcome": "passed", "reason": "etag-match" }
```

`reason` 取值：通过时为 `etag-match` / `date-not-earlier`；失败时为
`etag-mismatch`、`date-earlier`、`weak-validator`、`resource-metadata-missing`
或 `invalid-validator`。提供了 `etag`/`lastModified` 时，200/206/416/422
的 `resource` 与 `responseHeaders` 会原样回显它们（`ETag`、`Last-Modified`）。

### RFC 9110 处理规则

- **闭区间** `bytes=0-499`：原样接受。
- **开放尾端** `bytes=500-`：结束位置自动延伸至最后一个字节。
- **后缀范围** `bytes=-200`：取最后 200 字节；后缀长度 **≥ 资源大小**时按 RFC
  覆盖整个资源（如 50 字节资源上的 `bytes=-200` → `bytes 0-49/50`），而不是
  丢弃。这是对 `range-parser` 原生行为的 RFC 兼容修正（预处理阶段完成）。
- **夹取越界端点**：末位超过 `size-1` 时夹到 `size-1`。
- **丢弃不可满足项**：`start ≥ size`、逆序闭区间、非空资源上的 `-0` 等单项被
  丢弃；其余项继续规划。所有项都被丢弃时才返回 `416`。
- **合并**：重叠或相邻（间隔为 0，如 `0-9,10-19`）的区间合并为一段；段顺序
  保持各区间**首次出现**的顺序（来自 `range-parser` 的 `combine` 语义）。
- **确定性边界**：对 `{size, contentType, 排序后的区间集合}` 取 SHA-256，得到
  `brp-` + 48 个十六进制字符。同样的覆盖字节集合（与列出顺序无关）必然产生
  同一边界；不同规划必然不同。
- **If-Range（§13.1.3）**：头值以 `"` 开头时按实体标签处理——必须是强标签
  且与当前 `etag` **逐字相等**（不做空白折叠/大小写归一；`W/…` 永不通过）；
  否则按 HTTP-date 解析，接受 IMF-fixdate、RFC 850、asctime 三种标准格式，
  校验星期与真实日历一致、日历日期与时间字段合法（RFC 850 两位年份按
  接收时 UTC 年份解释，超过未来 50 年回拨 100 年），并把双方统一解析成
  时刻后比较：日期 **不早于** `lastModified` 才通过。任何不通过的情形都
  降级为 `200 decision:"full"`；未提供 `If-Range` 时行为与原先完全一致。

单区间 206 响应示例（节选）：

```json
{
  "statusCode": 206,
  "decision": "partial",
  "segmentsCount": 1,
  "segments": [{ "index": 1, "start": 0, "end": 99, "bytes": 100,
    "headers": { "Content-Type": "video/mp4", "Content-Range": "bytes 0-99/10000" },
    "partHeaderBlock": "Content-Type: video/mp4\r\nContent-Range: bytes 0-99/10000\r\n\r\n" }],
  "bytes": { "selected": 100, "framing": 0, "total": 100, "resource": 10000, "ratio": 0.01 },
  "multipart": null,
  "responseHeaders": {
    "Accept-Ranges": "bytes",
    "Content-Type": "video/mp4",
    "Content-Range": "bytes 0-99/10000",
    "Content-Length": "100"
  }
}
```

`If-Range` 失败时的 200 完整规划示例：

```json
{
  "statusCode": 200,
  "decision": "full",
  "segmentsCount": null,
  "segments": null,
  "bytes": { "selected": 10000, "framing": 0, "total": 10000, "resource": 10000, "ratio": 1 },
  "multipart": null,
  "responseHeaders": {
    "Accept-Ranges": "bytes",
    "Content-Type": "video/mp4",
    "Content-Length": "10000",
    "ETag": "\"v1-abc\""
  },
  "condition": { "header": "If-Range", "validatorKind": "etag", "outcome": "failed", "reason": "etag-mismatch" }
}
```

多区间时 `multipart` 字段给出 `boundary`、`boundaryDelimiter`
（`--<boundary>`）、`closingBoundary`（`--<boundary>--`）和行终止符 `CRLF`，
可直接据此拼接真实的 multipart 报文。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `MAX_SEGMENTS` | `16` | 允许的最大段数，超过返回 422 |
| `TRANSFER_SIZE_RATIO` | `2` | 计划传输字节相对资源大小的上限倍数 |
| `LOG_LEVEL` | （空=关闭日志） | 设为 `info`/`debug` 等启用 Fastify 日志 |

修改端口/阈值后重新 `docker compose up -d` 即可。例如本地端口改为 8080：

```bash
PORT=8080 docker compose up --build -d   # 或编辑 compose 中的 ports 映射
```

## 项目结构

```
src/
  conditional.js    # If-Range 评估：强 ETag 逐字比较、严格 HTTP-date 解析（IMF-fixdate/RFC 850/asctime）
  planner.js        # 范围规划核心：解析、夹取、丢弃、合并、边界生成、422 守卫、条件降级
  resume.js         # 断点续传缺口规划：区间归并、缺口计算、按 chunkBytes/limit 拆分
  multipart-check.js # multipart/byteranges 报文核验：boundary 解析、严格分段、Content-Range 核算、区间归并/差集
  assemble.js       # 稀疏缓存拼装：片段校验、重叠冲突检测、覆盖核算、单段/multipart 报文生成
  cache-integrity.js # 稀疏缓存完整性校验：片段合并、逐块 SHA-256 比对、verified/missing/corrupt 分类、重取区间合并
  cache-retention.js # 缓存保留规划：缓存归并、访问权重扫描线累加、按权重/偏移选满预算、截断与归并
  shared-fetch.js   # 共享回源规划：跨客户端需求归并、按上限拆块、带间隙阈值的自左向右跨隙合并、逐客户端覆盖核算
  app.js            # Fastify 应用：POST/GET /plan、POST /resume-plan、POST /multipart-check、POST /assemble-response、POST /cache-integrity-check、POST /cache-retention-plan、POST /shared-fetch-plan、/healthz、输入校验
  server.js         # 启动入口与环境变量读取
test/
  planner.test.js       # 原有 node:test 用例（26 个）
  if-range.test.js      # If-Range ETag/日期（含旧式日期格式）/降级/元数据校验用例（34 个）
  headers.test.js       # 真实 socket 上的重复头与 CR/LF 拒绝用例（4 个）
  resume.test.js        # 断点续传缺口规划用例（24 个）
  multipart-check.test.js # multipart/byteranges 核验用例（32 个）
  assemble.test.js      # 稀疏缓存拼装用例（31 个）
  cache-integrity.test.js # 稀疏缓存完整性校验用例（30 个）
  cache-retention.test.js # 缓存保留规划用例（29 个）
  shared-fetch.test.js  # 共享回源规划用例（33 个）
```

## 本地开发与测试

```bash
npm ci
npm test          # 243 个用例：区间解析/合并/416/422/边界 + If-Range ETag/三种 HTTP-date/降级 + 重复头/CRLF + 续传缺口规划 + multipart 核验 + 稀疏缓存拼装 + 缓存完整性校验 + 缓存保留规划 + 共享回源规划
npm start
```

## 安全说明

- 只接受 `bytes` 范围单位，其他单位返回 `400 UNSUPPORTED_RANGE_UNIT`。
- `Range` 头长度上限 4096 字节；拒绝重复 `Range` 头。
- `If-Range` 同样拒绝重复头（`400 DUPLICATE_IF_RANGE_HEADER`）；含 CR/LF
  的值在 HTTP 解析层即被拒绝（应用层另有一道 CR/LF 检查兜底）。
- 资源元数据 `etag` 必须是合法 entity-tag、`lastModified` 必须是合法
  HTTP-date（IMF-fixdate / RFC 850 / asctime 三种标准格式之一，且星期、
  日历日期与时间字段均合法）且不含 CR/LF，否则
  `400 INVALID_ETAG` / `400 INVALID_LAST_MODIFIED`；GET 的重复同名参数也会被拒绝。
- `If-Range` 中的非法验证器**不**算请求错误：按 RFC 忽略 Range 并返回
  200 完整规划（`condition.reason: "invalid-validator"`）。
- `contentType` 需为合法媒体类型且不含 CR/LF，杜绝响应头注入。
- 所有偏移量使用非负安全整数（`Number.MAX_SAFE_INTEGER` 以内）解析。
- `/resume-plan` 使用独立的严格校验器：关闭类型强转与属性剔除，字符串数字、
  小数、多余字段一律 `400`；区间必须满足 `0 ≤ start ≤ end < size`，
  `completed` 上限 10000 项、`limit` 上限 10000 条，防止超大输入耗尽资源。
- `/multipart-check` 同样使用严格校验器：所有数值必须是安全整数，
  `expected` 与分段各上限 16 项，多余字段一律 `400`；报文仅接受标准 base64
  且解码后不超过 1 MiB（框架请求体上限 2 MiB）；boundary 限定为 1～70 位
  字母数字或连字符、不允许 CR/LF，杜绝边界注入；报文必须 CRLF 分隔、无前言
  尾声、闭合边界，段头仅接受合法 token 字段名与字段值，Content-Range 唯一、
  总大小与 `size` 一致、段数据长度与声明一致；数据中的伪边界序列不会截断分段。
- `/assemble-response` 同样使用严格校验器：`fragments` 上限 1024 项，每项的
  `start` 必须是非负安全整数、`dataBase64` 必须是规范标准 base64；片段必须
  完整落在资源内，解码后合计不超过 1 MiB，拼装出的响应体也不超过 1 MiB
  （超出分别返回 `400 FRAGMENTS_TOO_LARGE` / `422 ASSEMBLED_TOO_LARGE`）；
  重叠片段字节不一致（`409 FRAGMENT_CONFLICT`）或覆盖不完整
  （`409 INCOMPLETE_COVERAGE`）时不会生成任何响应体；`contentType` 沿用
  `/plan` 的媒体类型与 CR/LF 检查，杜绝响应头注入。
- `/cache-integrity-check` 同样使用严格校验器：`size` 不得超过 1 MiB
  （`400 RESOURCE_TOO_LARGE`），`blockBytes` 必须为正安全整数，
  `digests` 必须是数量恰为 `ceil(size/blockBytes)` 的 64 位**小写**十六进制
  字符串数组（数量不符 `INVALID_DIGEST_COUNT`、格式不符 `INVALID_DIGEST`），
  多余字段一律 `400`；片段沿用 `/assemble-response` 的全部校验（规范 base64、
  完整落在资源内、合计 ≤ 1 MiB、上限 1024 项）。逐块仅在完整覆盖且无冲突时
  才计算 SHA-256；冲突涉及的块无条件记为 corrupt。为容纳小块资源的大量摘要，
  该路由的请求体上限单独放宽到 4 MiB（语义上限仍为 1 MiB 资源/1 MiB 片段）。
- `/cache-retention-plan` 同样使用严格校验器：所有数值必须是安全整数，
  `cached` 与 `accesses` 各上限 1000 项、访问权重上限 100 万，多余字段一律
  `400`；区间必须满足 `0 ≤ start ≤ end < size`；单字节累计权重最高
  10^9（1000 × 10^6），权重累加与字节核算全程在安全整数范围内，不会溢出。
- `/shared-fetch-plan` 同样使用严格校验器：字符串数字、小数、多余字段一律
  `400`；`clients` 上限 1000 个、每个客户端的 `ranges` 上限 10000 项；
  客户端 `id` 必须是非空字符串（不超过 255 字节、不含 CR/LF，杜绝头注入），
  同一请求内重复 `id` 返回 `400 DUPLICATE_CLIENT_ID`；区间必须满足
  `0 ≤ start ≤ end < size`（倒置 `INVALID_CLIENT_RANGE`、越界
  `CLIENT_RANGE_OUT_OF_BOUNDS`）；`maxFetchBytes` 为正安全整数、
  `maxGapBytes` 为非负安全整数。回源区间的拆分、跨隙合并与字节核算全程
  只做安全整数加减，不会溢出。
