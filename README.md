# dsh-serper-mcp

DSH 用的 Serper（Google Search API）MCP 服务器。**零依赖**，只用 Node 内置模块 + 全局 `fetch`（Node 18+）。

## 为什么自研

现有的第三方包 `serper-search-scrape-mcp-server` 有两个问题：依赖很老的 `@modelcontextprotocol/sdk@0.6.0`（靠旧协议回退兼容），且只提供 2 个工具、`gl`/`hl` 还是必填。自研后这些问题都没有了，并且把 Serper 的 9 个 SERP 端点全开放。

## 提供的工具（10 个）

| 工具名（模型侧） | 端点 | 说明 |
|---|---|---|
| `mcp__serper__serper_search` | `/search` | Google 网页搜索，含 knowledgeGraph / peopleAlsoAsk / relatedSearches |
| `mcp__serper__serper_news` | `/news` | Google News 新闻 |
| `mcp__serper__serper_images` | `/images` | Google 图片 |
| `mcp__serper__serper_videos` | `/videos` | Google 视频 |
| `mcp__serper__serper_places` | `/places` | Google Maps 本地商家/地点 |
| `mcp__serper__serper_scholar` | `/scholar` | Google Scholar 学术文献 |
| `mcp__serper__serper_patents` | `/patents` | Google Patents 专利 |
| `mcp__serper__serper_shopping` | `/shopping` | Google Shopping 商品 |
| `mcp__serper__serper_autocomplete` | `/autocomplete` | 搜索建议词 |
| `mcp__serper__serper_scrape` | scrape 端点 | 抓网页正文（纯文本 / Markdown） |

## 配置

密钥放 `$DSH_HOME/.env`：

```bash
SERPER_API_KEY=你的密钥
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中挂载：

```yaml
- insert:
    - id: mcp-serper
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: serper
        transport: stdio
        command: /usr/local/bin/node
        args:
          - /root/dsha-serper-mcp/server.mjs
        env:
          SERPER_API_KEY: !!js 'process.env.SERPER_API_KEY ?? ""'
        toolCallTimeoutMs: 120000
```

> ⚠️ **`env:` 一行都不能省。** DSH 的 stdio 子进程会清洗掉变量名含 `KEY`/`TOKEN`/`SECRET`/`PASSWORD`
> 以及所有 `DSH_*` 的环境变量（见 `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()`），
> `SERPER_API_KEY` 正好命中这条规则。不显式传递的话，服务器会因为拿不到密钥而返回错误。

> ⚠️ `command` 用绝对路径，不依赖子进程的 `PATH` 解析。

改完需**重启 DSHA Web**（`patchReload: startup`）。

## 环境变量（可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SERPER_API_KEY` | — | **必填**，Serper 密钥 |
| `SERPER_TIMEOUT_MS` | `45000` | 单次请求超时（1000–300000） |
| `SERPER_MAX_TEXT_CHARS` | `120000` | 单次返回文本上限，超出则截断（1000–2000000） |

## 设计说明

- **协议**：stdio，消息帧为换行分隔的 JSON-RPC 2.0（NDJSON）。
- **协议版本协商**：`OUR_PROTOCOL_VERSIONS` 从高到低，取「不高于客户端请求版本」的最高版本。
  这些版本都在 DSH 客户端 `SUPPORTED_PROTOCOL_VERSIONS` 内，因此协商结果一定被接受。
- **stdout 只输出协议消息**，所有日志走 stderr，避免污染协议流。
- **缺密钥不崩溃**：`initialize` / `tools/list` 照常返回，工具调用返回可读错误文本
  （`isError: true`），便于模型自行判断，与 `dsh-tool-web` 的处理方式一致。
- **优雅收尾**：stdin 关闭时等待在途请求写完再退出，否则最后几个异步调用会随进程一起被丢弃。
- **参数容错**：`gl`/`hl` 有默认值（`cn` / `zh-cn`），`num` 自动夹取到 1–100，不会因为模型漏传而报错。
- **num 本地截断**（重要）：Serper 只有 `/search` 和 `/images` 真正遵守 `num`，其余端点忽略它并
  返回固定条数。实测固定值：

  | 端点 | 忽略 num 时的返回条数 |
  |---|---|
  | `/news` | 13 |
  | `/videos`、`/scholar`、`/patents`、`/places` | 10 |
  | `/shopping` | 40 |

  因此在本地按 `num` 截断，并在结果里附 `__truncated` 字段说明「该端点不遵守 num，已在本地截断」，
  避免模型误以为返回的就是全部结果。

> ⚠️ **改代码后必须重启 DSHA Web。** MCP stdio 服务器是随 DSH 启动拉起的**常驻子进程**，
> 只在启动时读取一次 `server.mjs`。改了文件但没重启，运行中的进程仍然是旧代码——
> 这一点很容易被误导：磁盘上的代码是新的，工具行为却是旧的。
> 判断方法：看结果里有没有 `__truncated` 字段，或对比进程启动时间与文件修改时间：
> `ps -o lstart= -p <PID>` 与 `stat -c %y /root/dsha-serper-mcp/server.mjs`。

## 自检

```bash
# 语法
node --check /root/dsha-serper-mcp/server.mjs

# 手动握手（应输出 10 个工具）
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| SERPER_API_KEY="$(grep '^SERPER_API_KEY=' /root/.dsh/.env | cut -d= -f2-)" node /root/dsha-serper-mcp/server.mjs
```

## 计费提醒

Serper 按 credit 计费：**1–10 条结果 = 1 credit，11–100 条 = 2 credits**。
响应里的 `credits` 字段是**本次请求消耗数**，不是剩余余额；余额需登录 serper.dev 后台查看。
