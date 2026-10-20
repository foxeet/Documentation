# Launchframe 技术设计文档

**日期**: 2026-10-20
**标签**: #技术设计 #架构 #视频渲染 #Agent #ClaudeAPI
**状态**: v1.0 待评审
**关联**: [005 Launchframe 产品需求文档](005-Launchframe产品需求文档.md), [003 代码视频引擎产品与技术规划](003-代码视频引擎产品与技术规划.md), [002 软件 Demo 视频生成 Agent](002-软件Demo视频生成Agent.md)

> 说明:
> - 本文是 005 的实现方案, 按团队确认不包含合规内容.
> - 主力模型为 Claude Opus 5.5.
> - 涉及 HyperFrames 程序化接口的细节, 以 M0 技术验证的结论为准 (见第 20 节).

---

## 1. 目标与设计原则

### 1.1 需要满足的关键指标 (来自 005 第 7 节)

| 指标 | 目标 |
|---|---|
| 分镜生成 | p50 <= 45 秒, p95 <= 90 秒 |
| 首版视频 (含质检) | p50 <= 2 分钟, p95 <= 4 分钟 |
| 对话修改 | p50 <= 15 秒 |
| 60 秒 1080p 导出 | p50 <= 90 秒 |
| 单条 60 秒首稿的模型成本 | <= $1.00 |
| 容量 (v0.2) | 每天 3,000 次生成, 1,000 次导出, 可水平扩展 |

### 1.2 设计原则

1. **场景描述 (Scene DSL) 是唯一数据源.** 模型, 属性面板, 时间轴都只修改 DSL. 预览和渲染都由 DSL 编译而来.
2. **组件优先, 自由代码兜底.** 模型从组件目录中选择组件并填参数. 只有在组件无法表达时, 才使用 "自定义场景" (自由 HTML/CSS/GSAP).
3. **确定性渲染.** 同一个 DSL 版本永远渲染出同样的画面, 因此可以缓存, 分片并行, 复现问题.
4. **一切皆版本.** 品牌套件, 分镜, DSL, 模板, 提示词都有版本号. 每次渲染和每次模型调用都能追溯.
5. **成本可见.** 每次模型调用都记账到作业和工作区.
6. **复用开源.** 渲染底座基于 HyperFrames (Apache-2.0). 我们的编译产物是 HyperFrames 兼容的合成文件, 开源模板因此可以直接用 HyperFrames CLI 渲染.

---

## 2. 总体架构

```
                         ┌───────────────────────────── 浏览器 ─────────────────────────────┐
                         │ Studio (Next.js)    预览 iframe (独立域名, @hyperframes/player)   │
                         └───────┬───────────────────────────────┬──────────────────────────┘
                                 │ REST / SSE                    │ 静态合成文件 (CDN)
                         ┌───────▼────────┐                      │
 Stripe / GitHub ──────► │  API (Fastify) │──────────────┐       │
 webhooks                └───────┬────────┘              │       │
                                 │                       │       │
                     ┌───────────▼───────────┐   ┌───────▼───────▼──────┐
                     │ Postgres (状态, 版本,  │   │ S3 + CloudFront       │
                     │ 账本, 成本)            │   │ 素材 / 合成 / 成片    │
                     └───────────▲───────────┘   └───────▲──────────────┘
                                 │                       │
                     ┌───────────┴───────────────────────┴──────────────────────┐
                     │ Redis + BullMQ 队列                                       │
                     └─┬──────────┬──────────┬──────────┬──────────┬────────────┘
                       │          │          │          │          │
              ┌────────▼──┐ ┌─────▼────┐ ┌───▼─────┐ ┌──▼──────┐ ┌─▼────────┐
              │ capture   │ │ agent    │ │ qa      │ │ audio   │ │ render   │
              │ Playwright│ │ 模型调用  │ │ 检查+抽帧│ │ TTS+混音│ │ HyperFrames│
              │ 采集+裁切  │ │ (网关)    │ │         │ │ ffmpeg  │ │ + ffmpeg │
              └───────────┘ └────┬─────┘ └─────────┘ └─────────┘ └──────────┘
                                 │
                       ┌─────────▼──────────┐
                       │ Model Gateway       │──► Claude API (Opus 5.5 / Sonnet 5.5 / Haiku 5.5)
                       │ 重试, 缓存, 记账     │
                       └────────────────────┘
```

**作业编排**: orchestrator 维护 Postgres 中的作业状态机, 每一步完成后投递下一步到对应队列 (见第 5 节).

---

## 3. 技术选型

| 领域 | 选择 | 理由 | 备选 |
|---|---|---|---|
| 语言 | TypeScript (Node 22), 音频和图像辅助脚本可用 Python | 前后端和组件统一一种语言; HyperFrames 要求 Node 22+ | — |
| 前端 | Next.js (App Router) + React + Tailwind + shadcn/ui; 编辑器状态用 Zustand | 生态成熟, 部署简单 | — |
| 预览播放器 | `@hyperframes/player`, 运行在独立域名的 sandbox iframe 中 | 与渲染使用同一份合成文件, 预览即所得 | 自研基于 seek 的播放器 |
| API | Fastify + zod (共享 schema) | 性能好, 类型共享 | Next.js Route Handlers |
| 数据库 | Postgres 16 + Drizzle ORM | 关系数据 + JSONB 存 DSL | — |
| 队列 | Redis + BullMQ | 重试, 延迟, 优先级, 并发控制齐全 | SQS |
| 存储 | S3 + CloudFront | 素材, 合成, 成片, 签名链接 | Cloudflare R2 |
| 渲染 | HyperFrames (CLI / `@hyperframes/producer`), Puppeteer + FFmpeg | 开源, 确定性, 支持分布式渲染 | 兜底: 自研 Playwright 逐帧管线 (002 实测约 10 帧/秒/进程) |
| 网页采集 | Playwright + Chromium | 截图, DOM 和样式提取 | — |
| 模型 | `@anthropic-ai/sdk`: Opus 5.5 / Sonnet 5.5 / Haiku 5.5 | 质量最高; 结构化输出; 提示缓存 | 网关保留接入其他模型的接口 |
| 旁白 | 候选 2-3 家 (要求: 逐词时间戳, 8 种语言, 自然度), M0 选定 | — | — |
| 认证 | Clerk (魔法链接, Google, GitHub, 组织即工作区) | 小团队最快; 自带团队和邀请 | Better Auth (自托管) |
| 支付 | Stripe Billing + Checkout + Customer Portal | 订阅, 一次性付款, 发票 | — |
| 邮件 | Resend | 简单, 支持 React 邮件模板 | Postmark |
| 分析 | PostHog | 埋点, 漏斗, 功能开关 | — |
| 错误监控 | Sentry | 前后端统一 | — |
| 链路追踪 | OpenTelemetry -> Grafana Cloud 或 Honeycomb | 作业跨服务追踪 | — |
| 部署 | Web 部署在 Vercel; API 和 worker 部署在 AWS ECS Fargate; RDS; ElastiCache; Terraform | 托管服务为主, 运维成本低 | Fly.io |
| 仓库 | pnpm workspace + Turborepo 单仓库 | 共享类型和组件 | — |

---

## 4. 核心数据格式

### 4.1 概念关系

```
Workspace ─┬─ Project ─┬─ BrandKit (版本化)
           │           ├─ Asset (截图, logo, 视频片段, 采集结果)
           │           └─ Video ─┬─ Storyboard (版本化)
           │                     ├─ VideoVersion (DSL 快照, 版本链)
           │                     │     └─ Render (画幅 x 分辨率 x 语言)
           │                     └─ 本地化子视频 (parent_video_id)
           ├─ CreditLedger / Subscription
           └─ Order (精修服务)
Template ── TemplateVersion (分镜骨架 + 推荐组件 + 提示)
```

### 4.2 分镜 (Storyboard)

分镜是给用户看和改的 "剧本层", 由 Storyboarder 生成.

```ts
import { z } from "zod";

export const StoryboardSceneSchema = z.object({
  id: z.string(),
  purpose: z.enum(["hook", "problem", "reveal", "feature", "proof", "how", "offer", "cta", "other"]),
  component: z.string(),          // 推荐组件, 必须存在于组件目录
  visual: z.string(),             // 画面描述
  onScreenText: z.array(z.string()),
  narration: z.string(),          // 旁白 (英文按每秒约 2.5 个词估算时长)
  durationSec: z.number(),
  assetIds: z.array(z.string()),  // 只能引用素材清单里的 id
});

export const StoryboardSchema = z.object({
  title: z.string(),
  scenes: z.array(StoryboardSceneSchema),
});
```

数值范围, 数组长度, 素材 id 是否存在, 字数上限等约束, 不依赖结构化输出强制, 而是在服务端二次校验, 失败就带着错误信息重试一次.

### 4.3 场景描述 (Scene DSL)

DSL 是编辑和渲染的唯一数据源. 一个视频版本 = 一份 DSL.

```ts
export const AspectSchema = z.enum(["16:9", "9:16", "1:1"]);

export const BrandTokensSchema = z.object({
  logoAssetId: z.string().nullable(),
  colors: z.object({
    primary: z.string(), secondary: z.string(),
    background: z.string(), surface: z.string(), text: z.string(),
  }),
  fonts: z.object({ heading: z.string(), body: z.string() }),  // 只能选字体白名单中的字体
  radius: z.enum(["none", "small", "large"]),
  tone: z.string(),
});

export const SceneSchema = z.object({
  id: z.string(),
  component: z.string(),                       // 组件名, 或 "custom"
  durationSec: z.number(),
  props: z.record(z.string(), z.unknown()),    // 由组件自己的 propsSchema 二次校验
  transitionIn: z.string().optional(),         // 转场名, 来自转场目录
  narration: z.string().optional(),
  overrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),  // 按画幅覆盖 props
  locked: z.boolean().optional(),
});

export const CompositionDSLSchema = z.object({
  schemaVersion: z.literal(1),
  fps: z.literal(30),
  language: z.string(),
  brand: BrandTokensSchema,
  scenes: z.array(SceneSchema),
  audio: z.object({
    voiceId: z.string().nullable(),
    musicTrackId: z.string().nullable(),
    musicVolume: z.number(),
    sfx: z.boolean(),
  }),
  captions: z.object({ enabled: z.boolean() }),
});
```

要点:
- **画幅不是裁切.** 同一份 DSL 编译成 16:9, 9:16, 1:1 三种合成, 每个组件都内置三套布局, 必要时用 `overrides` 覆盖.
- **时长由旁白驱动.** 有旁白的场景, 最终时长 = max(组件最短时长, 旁白时长 + 0.4 秒), 在音频步骤之后回写.
- **自定义场景.** `component: "custom"` 时, `props` 里是 `{ html, css, script }`, 必须通过静态检查 (见第 15 节).

### 4.4 组件定义

```ts
export interface ComponentDef<P> {
  name: string;                         // 例如 "ui_zoom"
  version: string;
  propsSchema: z.ZodType<P>;
  textFields: Record<string, { maxChars: number }>;  // 英文字符上限; 其他语言按系数折算
  minDurationSec: number;
  layouts: Array<"16:9" | "9:16" | "1:1">;
  html(props: P, ctx: CompileCtx): string;           // 场景 DOM, 文字节点带 data-lf-text 标记
  docs: string;                                       // 给模型看的说明: 用途, 参数, 示例, 禁忌
}
```

- 动画不写在 DSL 里. 每个组件的动画函数在浏览器运行时 `lf-runtime.js` 中实现, 运行时读取场景数据, 构建 GSAP 时间轴.
- 组件目录 v0.1 (约 14 个): `hero_title`, `kinetic_text`, `logo_reveal`, `ui_showcase` (设备外框 + 截图平移缩放), `ui_zoom` (截图推镜 + 高亮框), `cursor_flow` (截图 + 光标路径 + 点击 + 标注), `feature_grid`, `feature_list`, `stat_counter`, `chart_bar`, `steps`, `quote_card`, `logo_pair`, `cta_end`.
- v0.2 再加: `before_after`, `code_typing`, `pricing_card`, `countdown`, `custom`.
- 转场目录: `cut`, `fade`, `slide`, `zoom`, `wipe`, `flash` (可复用 HyperFrames 的 shader transitions).

### 4.5 编译产物 (HyperFrames 合成)

编译器 `packages/compiler` 把 DSL + 画幅编译成一个 HyperFrames 合成目录:

```
v_8f3a_16x9/
  index.html          合成入口
  lf-runtime.js       组件动画运行时 (含 GSAP)
  lf-runtime.css      组件样式 + 品牌 CSS 变量
  fonts/              自托管字体文件
  assets/             截图, logo (渲染时下载到本地)
  audio/              旁白, 音乐, 音效
```

`index.html` 示意 (属性名以 HyperFrames 文档为准, M0 校对):

```html
<div id="stage" data-composition-id="v_8f3a" data-start="0" data-width="1920" data-height="1080">
  <section class="clip lf-scene" data-start="0" data-duration="3.5" data-track-index="1"
           data-lf-scene="s1" data-lf-component="hero_title">
    <h1 data-lf-text="title">Ship docs 10x faster</h1>
  </section>
  <section class="clip lf-scene" data-start="3.5" data-duration="6" data-track-index="1"
           data-lf-scene="s2" data-lf-component="ui_zoom">
    <!-- 组件 DOM -->
  </section>
  <audio src="audio/vo.mp3" data-start="0" data-duration="58.2" data-track-index="2" data-volume="1"></audio>
  <audio src="audio/music.mp3" data-start="0" data-duration="60" data-track-index="3" data-volume="0.25"></audio>
  <script type="application/json" id="lf-data">{ "scenes": [ ... ] }</script>
  <script>
    // 运行时创建 paused 的 GSAP 时间轴, 为每个场景添加组件动画,
    // 然后注册: window.__timelines["v_8f3a"] = tl
    LF.mount("v_8f3a");
  </script>
</div>
```

编译结果按 `hash(DSL 版本 + 画幅 + 运行时版本)` 缓存到 S3, 预览和渲染共用.

---

## 5. 生成流水线与作业状态机

### 5.1 作业类型

| 作业 | 队列 | 步骤 |
|---|---|---|
| `capture` | capture | 采集网页 -> 截图裁切 -> 品牌抽取 |
| `generate` | agent / audio / qa | 分镜 -> 编排 -> 旁白和时长回写 -> 编译 -> 质检和自动修复 -> 预览就绪 |
| `edit` | agent / qa | 修改意图 -> 产出补丁 -> 校验 -> 应用 -> 编译 -> 快速质检 |
| `localize` | agent / audio / qa | 翻译文案 -> 排版适配 -> 配音 -> 编译 -> 质检 |
| `render` | render / audio | 编译 -> 分片渲染 -> 拼接 -> 混音 -> 封装 -> 封面和字幕 |

### 5.2 `generate` 状态机

```
queued
  -> storyboarding        (agent: Storyboarder)        失败重试 1 次
  -> storyboard_ready     (用户可以修改; 默认自动继续)
  -> composing            (agent: Composer)            校验失败带错误重试 1 次
  -> voicing              (audio: TTS + 时长回写)
  -> compiling            (compiler)
  -> reviewing            (qa: 确定性检查 + 抽帧评审) ─┐
  -> fixing               (agent: Fixer)              ─┘ 最多 2 轮, 第 2 轮升级到 Opus
  -> preview_ready
失败 -> failed (预扣 credits 全额退回, 记录错误码)
```

- 每一步都按 `(video_version_id, step)` 做幂等, 重试不会重复扣费或重复写版本.
- 步骤进度通过 `GET /v1/jobs/:id/events` (SSE) 推送给前端.
- 用户在 `storyboard_ready` 时修改了分镜, 作业从 `composing` 继续.

### 5.3 `render` 流程

1. 读取 DSL 版本对应的合成 (没有就先编译).
2. 按场景边界把时间轴切成 N 段 (每段约 10 秒), 分发给 render worker 并行渲染.
3. ffmpeg concat 拼接视频段.
4. audio worker 产出混音 (旁白 + 音乐压低 + 音效, 响度 -14 LUFS).
5. 封装 MP4 (H.264, yuv420p, faststart), 生成封面图和 SRT, 上传 S3.
6. 免费层在片尾追加 2 秒署名片段 (单独渲染一次后缓存复用).

---

## 6. Agent 设计 (Claude API)

### 6.1 角色与模型

| 角色 | 模型 | effort | 输入 | 输出 |
|---|---|---|---|---|
| BrandExtractor | Sonnet 5.5 | low | 采集到的候选 logo, 颜色, 字体, 截图 | 品牌套件 + 产品要点 (结构化) |
| Storyboarder | Opus 5.5 | high | 产品要点, 品牌, 素材清单, 模板骨架, 时长, 补充说明 | Storyboard |
| Composer | Opus 5.5 | high | 分镜, 组件目录文档, 品牌, 素材清单 | Composition DSL |
| Reviewer | Sonnet 5.5 | medium | 每个场景的抽帧联系表 + 确定性检查结果 + 产品要点 | 问题列表 (结构化) |
| Fixer | Sonnet 5.5, 第 2 轮升级 Opus 5.5 | medium / high | DSL + 问题列表 | 补丁 (EditOp[]) |
| EditRouter | Haiku 5.5 | low | 用户的修改要求 + 场景摘要 | 意图分类: 简单 / 结构性 / 不支持 |
| ChatEditor | Sonnet 5.5 (简单), Opus 5.5 (结构性) | medium / high | DSL (压缩表示), 选中场景, 修改要求, 最近的修改摘要 | 补丁 + 给用户的说明 |
| Translator | Sonnet 5.5 | low | DSL 中的文字字段 + 旁白, 目标语言, 字数上限 | 翻译后的字段 |

### 6.2 Claude API 使用要点

- 模型 ID: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`. 价格分别为每百万 token $4/$20, $2/$10, $0.10/$0.50 (Haiku 5.5 为提示 100K 以内的价格); Opus 和 Sonnet 的缓存读取都是 $0.20.
- Opus 5.5 的思考不能关闭 (`thinking: {type: "disabled"}` 会返回 400), 用 `output_config.effort` 控制深度. 它的默认值是 `medium`, 必须按角色显式设置.
- 结构化输出用 `client.messages.parse` + `zodOutputFormat`, 结果在 `parsed_output`, 可能为 null, 必须判空.
- Opus 5.5 和 Sonnet 5.5 不支持强制指定工具 (`tool_choice` 为 `any` 或 `tool` 会返回 400). 需要固定格式时一律用结构化输出.
- 读取结果前先检查 `stop_reason`: `refusal` 和 `max_tokens` 单独处理.
- Opus 5.5 请求开启服务端拒答回退: 走 `client.beta.messages`, 带 `betas: ["server-side-fallback-2026-07-01"]` 和 `fallbacks: "default"`. 它与结构化输出 helper 的组合方式在 M0 确认.
- 输出可能较长的请求 (Composer) 用流式 `client.messages.stream(...).finalMessage()`, 再自行用 zod 解析, 避免 HTTP 超时.
- 429 和 5xx 由 SDK 自动重试 (默认 2 次); 网关再加一层按 `retry-after` 退避和排队.
- 提示缓存: 见 6.4.
- 非交互的批量任务 (多语言版本, 评测集) 走 Batch API (5 折).

### 6.3 网关调用示例 (Storyboarder)

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { StoryboardSchema } from "@launchframe/dsl";

const client = new Anthropic();

export async function runStoryboarder(input: StoryboardInput, ctx: CallCtx) {
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: {
      effort: "high",
      format: zodOutputFormat(StoryboardSchema),
    },
    system: [
      // 稳定前缀: 角色说明 + 写作规则 + 组件目录摘要 + 模板骨架, 放在缓存断点之前
      { type: "text", text: prompts.storyboarder.system, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: [{ role: "user", content: buildStoryboardContent(input) }],  // 产品要点, 品牌, 素材清单, 截图
  });

  await ctx.ledger.record("storyboarder", response.model, response.usage);

  if (response.stop_reason === "refusal") throw new AgentError("refusal", response.stop_details);
  if (response.stop_reason === "max_tokens") throw new AgentError("truncated");
  if (!response.parsed_output) throw new AgentError("parse_failed");

  return validateStoryboard(response.parsed_output, input);  // 二次校验: 时长, 字数, 素材 id
}
```

### 6.4 提示资产与缓存布局

- 提示词放在 `packages/prompts`, 以文件形式版本化. 每次调用都记录提示词版本号.
- 请求结构按 "稳定 -> 半稳定 -> 易变" 排列:
  1. system: 角色说明 + 规则 + 组件目录文档 (约 10-20k token, 所有用户共享, 打缓存断点, 1 小时 TTL).
  2. user 前段: 品牌套件 + 产品要点 + 素材清单 (同一个项目内稳定, 编辑会话中打第二个断点).
  3. user 后段: 当前 DSL, 本次修改要求 (每次都变).
- system 文本里不放时间戳, 请求 id 等易变内容. 用 `usage.cache_read_input_tokens` 监控命中率.

### 6.5 编辑协议

ChatEditor 和 Fixer 不重写整份 DSL, 只输出补丁:

```ts
export const EditOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_prop"), sceneId: z.string(), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("set_duration"), sceneId: z.string(), durationSec: z.number() }),
  z.object({ op: z.literal("move_scene"), sceneId: z.string(), toIndex: z.number() }),
  z.object({ op: z.literal("delete_scene"), sceneId: z.string() }),
  z.object({ op: z.literal("insert_scene"), afterSceneId: z.string().nullable(), scene: SceneSchema }),
  z.object({ op: z.literal("replace_scene"), sceneId: z.string(), scene: SceneSchema }),
  z.object({ op: z.literal("set_brand"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("set_audio"), path: z.string(), value: z.unknown() }),
]);

export const EditResultSchema = z.object({
  ops: z.array(EditOpSchema),
  explanation: z.string(),   // 给用户看的一两句说明
});
```

- 应用补丁前做校验: 组件 props, 字数上限, 被锁定的场景不可改, 素材 id 存在.
- 校验失败时带错误信息重试 1 次, 仍失败就告诉用户 "没能完成, 请换个说法" (不扣 credits).
- **每次修改是一次独立的无状态调用.** 上下文由我们组装: DSL + 最近 5 条修改摘要. 不维护模型侧的长对话, 因此不会因为改写历史或中途换模型而失效, 缓存命中也更稳定.
- 属性面板直接生成同样的补丁, 不经过模型.

### 6.6 单条成本估算 (60 秒首稿, Opus 5.5 定价)

| 步骤 | 估算 token (输入 / 输出, 输出含思考) | 成本 |
|---|---|---|
| 品牌抽取 (Sonnet, 每个项目一次) | 15k / 1.5k | 约 $0.05 |
| 分镜 (Opus, high) | 25k (约 15k 命中缓存) / 8k | 约 $0.20 |
| 编排 (Opus, high) | 40k (约 25k 命中缓存) / 14k | 约 $0.35 |
| 质检评审 (Sonnet, 1-2 轮) | 17k (含图) / 1.5k | 约 $0.05-0.10 |
| 修复 (Sonnet) | 20k / 2k | 约 $0.05 |
| **合计** | — | **约 $0.70-0.80** |
| 对话修改 (每次, Sonnet) | 30k (大部分命中缓存) / 2k | 约 $0.03-0.08 |
| 翻译 (每种语言, Sonnet low) | 5k / 2k | 约 $0.03 |

- 以上是设计估算, M0 用真实数据校准, 再据此调整 005 的 credits 参数.
- 按这个估算, 1 credit 的成本基准约 $0.04 (60 秒首稿 = 20 credits).

---

## 7. 渲染系统

### 7.1 预览

- 合成文件发布到 CDN 的独立域名 (例如 `preview.<域名>`). Studio 用 `<iframe sandbox="allow-scripts">` 加载 (不带 `allow-same-origin`), 使模型生成的代码与主站会话隔离.
- iframe 内用 `@hyperframes/player` 播放, 主站通过 `postMessage` 控制播放, 跳转和画幅切换, 并接收当前时间.
- 修改后只重新编译变化的合成, 播放器热替换并保持当前播放位置.

### 7.2 导出渲染

- **方案 A (首选):** render worker 容器内运行 HyperFrames 的渲染器 (CLI 或 `@hyperframes/producer`), 每个 worker 渲染一个时间分片.
- **方案 B:** `@hyperframes/aws-lambda` 分布式渲染, 适合流量波动大的阶段.
- **兜底方案:** 自研 Playwright 逐帧管线. 对每一帧调用 `window.__timelines[id].seek(t)` 后截图, 通过管道交给 ffmpeg. 002 的实测已验证: 1080p 约 10 帧/秒/进程.
- M0 的验证项: 程序化调用方式, 分片渲染, 中日韩字体, 确定性 (同一输入渲染两次的像素差), 吞吐.

### 7.3 确定性要求

- 运行时禁止依赖真实时间和未设种子的随机数; 动画全部挂在 paused 的 GSAP 时间轴上.
- 字体自托管, 渲染前等待 `document.fonts.ready`.
- 素材在渲染前下载到本地目录. 渲染环境断网, 只允许访问本地静态服务.

### 7.4 规格与性能

| 项目 | 设置 |
|---|---|
| 导出编码 | H.264, yuv420p, CRF 18, 30fps, `+faststart`; 音频 AAC 192kbps |
| 分辨率 | 1080p (16:9 为 1920x1080, 9:16 为 1080x1920, 1:1 为 1080x1080); 免费层 720p |
| render worker | 8 vCPU / 16GB, 每个 worker 并行 6 个浏览器进程 |
| 60 秒导出估算 | 1,800 帧 / (6 进程 x 10 帧/秒) 约 30 秒, 加上拼接, 混音, 上传约 15 秒, p50 约 45-60 秒 |
| 扩缩容 | 按队列深度自动扩缩容; 付费用户使用优先队列 |

**算力成本:** 一次 60 秒导出约 3 vCPU 分钟. 每天 1,000 次导出约 50 vCPU 小时, 按 Fargate 价格每天只有几美元量级.

---

## 8. 音频

- **旁白:** 通过供应商抽象层调用 TTS, 每个场景一段, 取逐词时间戳. 场景时长回写到 DSL; 字幕由时间戳生成 (每行不超过 42 个字符, 每屏最多 2 行).
- **音乐:** 曲库的每首曲目都带风格标签, BPM 和可循环段落. 按视频时长自动截取并做淡入淡出.
- **音效:** 运行时在组件事件 (点击, 弹出, 转场) 上打标记, audio worker 按标记放置音效. 音效素材库为自有或已授权素材.
- **混音:** 最终混音由 audio worker 用 ffmpeg 完成: 旁白上压低音乐 (sidechaincompress), 响度标准化 (loudnorm, -14 LUFS). 预览中用 `<audio>` 元素近似播放.

---

## 9. 质量检查 (QA)

### 9.1 确定性检查 (qa worker, 每次编译后都跑)

用 Playwright 加载合成, 在每个场景的开始 +0.3 秒, 中点, 结束 -0.3 秒, 以及每个转场的中点调用 seek, 然后注入检查脚本:

| 检查 | 方法 | 级别 |
|---|---|---|
| 文字溢出 | `data-lf-text` 节点的 `scrollWidth > clientWidth` 或 `scrollHeight > clientHeight` | 错误 |
| 越出安全区 | 文字和关键元素的包围盒超出画面 5% 边距 | 错误 |
| 文字遮挡 | 文字层之间的包围盒相交面积 > 2% | 错误 |
| 字号过小 | 计算字号 x 缩放 < 画面短边的 2.2% | 警告 |
| 对比度 | 文字颜色与背景色的对比度 < 4.5 (纯色背景时) | 警告 |
| 空白画面 | 截图的像素方差过低 | 错误 |

### 9.2 视觉评审

- 每个场景把 3 帧拼成一张联系表 (约 1,568 像素宽), 连同确定性检查结果和产品要点交给 Reviewer.
- Reviewer 输出问题列表: 场景 id, 严重程度, 类别 (可读性, 层级, 品牌, 节奏, 内容错误), 描述, 修复建议.
- 自动修复循环: 第 1 轮由 Sonnet 产出补丁; 仍有错误级问题时, 第 2 轮升级 Opus. 两轮后仍未解决的, 在编辑器里标出.

### 9.3 质量指标

质检通过率, 每条视频的平均修复轮数, 用户首次修改的类型分布. 这些指标汇入成本和质量看板.

---

## 10. 网页采集与品牌抽取

1. **采集:** Playwright 以桌面 (1440x900) 和移动 (390x844) 两种视口打开网页, 等待网络空闲, 自动滚动以触发懒加载, 然后截取首屏和整页.
2. **DOM 提取:**
   - 标题, 描述, 按钮文字, 功能区块文字.
   - meta 和 og 信息, favicon 和 apple-touch-icon.
   - 页头里的 logo 候选 (img 或 svg, 类名, alt 或 id 含 logo).
   - 按钮和链接的计算颜色, `:root` 中的 CSS 变量, h1 和正文的字体.
3. **区块裁切:** 按 `section` 和 `main` 下各区块的包围盒裁切整页截图, 过滤掉高度小于 300 像素和颜色过于单一的区块. 每个网址产出 4-12 张裁切图, 作为素材.
4. **品牌抽取:** BrandExtractor (Sonnet 5.5, 带截图) 从候选中选择 logo 和配色, 把字体映射到白名单字体, 判断语气, 提炼产品一句话介绍和 3-6 个功能要点.
5. **失败处理:** 遇到需要登录, 被拦截或超时的页面, 返回明确的错误码, 前端引导用户上传截图.

---

## 11. 本地化

- 本地化视频是独立的子视频 (`parent_video_id`), 从源视频的当前版本复制 DSL.
- Translator 一次翻译所有文字字段和旁白, 并遵守每个字段的字数上限 (按语言折算). 例如德语按英文上限的 0.8 倍要求, 中日韩按字符数单独设定.
- 翻译后走旁白 -> 编译 -> 质检. 文字溢出时优先自动缩小字号 (下限为最小字号), 仍然溢出则交给 Fixer 改写为更短的译文.
- 多个语言可以并行处理. 用户选中 3 种及以上语言时, 走 Batch API 以降低成本.

---

## 12. 数据模型

核心表 (Drizzle 定义, 这里用 SQL 示意):

```sql
create table workspaces (
  id uuid primary key, clerk_org_id text unique, name text not null,
  plan text not null default 'free', stripe_customer_id text,
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key, workspace_id uuid not null references workspaces(id),
  name text not null, source_url text, brand_kit_version int,
  created_at timestamptz not null default now()
);

create table videos (
  id uuid primary key, project_id uuid not null references projects(id),
  workspace_id uuid not null references workspaces(id),
  title text, template_version_id uuid, settings jsonb not null,
  language text not null default 'en', parent_video_id uuid references videos(id),
  current_version_id uuid, created_by text not null,
  created_at timestamptz not null default now()
);

create table video_versions (
  id uuid primary key, video_id uuid not null references videos(id),
  seq int not null, dsl jsonb not null, storyboard_version int,
  source text not null,              -- generate | chat | panel | fix | restore | localize
  parent_version_id uuid, prompt_version text, created_by text,
  created_at timestamptz not null default now(),
  unique (video_id, seq)
);

create table renders (
  id uuid primary key, video_version_id uuid not null references video_versions(id),
  aspect text not null, resolution text not null, watermark boolean not null,
  status text not null,              -- queued | rendering | mixing | uploading | done | failed
  output_key text, poster_key text, srt_key text,
  duration_ms int, error_code text, created_at timestamptz not null default now()
);

create table jobs (
  id uuid primary key, workspace_id uuid not null, type text not null,
  status text not null, step text, input jsonb not null, output jsonb,
  error_code text, attempts int not null default 0, parent_job_id uuid,
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz
);

create table model_calls (
  id uuid primary key, job_id uuid references jobs(id), workspace_id uuid not null,
  role text not null, model text not null, prompt_version text,
  input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int,
  cost_usd numeric(10,5), latency_ms int, stop_reason text,
  created_at timestamptz not null default now()
);

create table credit_ledger (
  id uuid primary key, workspace_id uuid not null references workspaces(id),
  delta int not null,                 -- 负数为消耗, 正数为发放或退回
  kind text not null,                 -- grant_monthly | grant_topup | reserve | settle | refund | adjust
  bucket text not null,               -- monthly | topup
  ref_type text, ref_id uuid, reason text, expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key, workspace_id uuid not null references workspaces(id),
  package text not null,              -- basic | pro | premium
  status text not null,               -- paid | in_progress | delivered | revising | completed | refunded
  brief jsonb not null, assignee_user_id text, due_at timestamptz not null,
  revisions_used int not null default 0, stripe_payment_intent_id text,
  project_id uuid references projects(id),
  created_at timestamptz not null default now()
);
```

其他表: `memberships` (如果不完全依赖 Clerk 的组织), `brand_kits` (版本化 JSONB), `assets`, `captures`, `storyboards`, `edits`, `templates`, `template_versions`, `subscriptions`, `order_events`, `share_links`, `showcase_submissions`, `github_installations` (P1).

所有业务查询都必须带 `workspace_id` 条件, 数据访问层统一注入.

---

## 13. API 设计

认证: Clerk 会话 JWT; 当前工作区由 Clerk 的活动组织确定. 请求和响应的 schema 都在 `packages/shared` 中用 zod 定义, 前后端共用.

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/projects` | 创建项目 `{name, sourceUrl?}`; 有网址时自动发起采集 |
| GET | `/v1/projects/:id` | 项目详情 (品牌套件, 素材, 视频列表) |
| POST | `/v1/projects/:id/capture` | 重新采集 -> 作业 |
| PATCH | `/v1/projects/:id/brand-kit` | 修改品牌套件 (生成新版本) |
| POST | `/v1/projects/:id/assets/upload-url` | 获取 S3 预签名上传地址 |
| POST | `/v1/projects/:id/videos` | 创建视频并开始生成 `{templateId, lengthSec, aspects, language, voiceId, musicStyle, cta, brief, sourceType, sourceRef}` -> 作业 |
| GET | `/v1/videos/:id` | 视频详情: 状态, 分镜, 当前版本 DSL, 合成地址 |
| PATCH | `/v1/videos/:id/storyboard` | 修改分镜 |
| POST | `/v1/videos/:id/storyboard/scenes/:sceneId/regenerate` | 单镜重生成 -> 作业 |
| POST | `/v1/videos/:id/edits` | 对话修改 `{message, selectedSceneId?}` -> 作业 |
| POST | `/v1/videos/:id/ops` | 属性面板修改 `{baseVersionId, ops}`, 同步返回新版本 |
| GET | `/v1/videos/:id/versions` | 版本列表 |
| POST | `/v1/videos/:id/versions/:versionId/restore` | 恢复到某个版本 |
| POST | `/v1/videos/:id/localize` | `{languages: [...]}` -> 作业 |
| POST | `/v1/videos/:id/renders` | `{versionId, aspects, resolution}` -> 作业 |
| GET | `/v1/jobs/:id` | 作业状态 |
| GET | `/v1/jobs/:id/events` | SSE 进度推送 |
| POST | `/v1/renders/:id/share-link` | 创建或关闭分享链接 |
| GET | `/s/:slug` | 公开分享页 (Web 端渲染) |
| GET | `/v1/templates` | 模板列表 |
| GET | `/v1/billing/usage` | credits 余额和明细 |
| POST | `/v1/billing/checkout` | 创建 Stripe Checkout 会话 (订阅, 加购, 服务套餐) |
| POST | `/v1/billing/portal` | 创建 Stripe 客户门户会话 |
| POST | `/v1/orders` | 提交服务订单需求 (付款后) |
| GET | `/v1/orders/:id` | 订单详情 |
| POST | `/v1/orders/:id/revisions` | 提交修改意见 |
| POST | `/v1/orders/:id/approve` | 验收 |
| — | `/internal/*` | 内部控制台接口: 订单队列, 分派, 交付, credits 调整, 模板发布 |
| POST | `/webhooks/stripe` | 订阅, 发票, 付款事件 |
| POST | `/webhooks/github` | Release 事件 (P1) |

- 并发修改: `ops` 和 `edits` 都带 `baseVersionId`. 基线不是最新版本时返回 409, 前端提示刷新.
- 限流: 每个工作区的生成类接口按套餐限并发 (Free 1, Creator 2, Pro 3, Team 6).

---

## 14. 计费实现

- **Stripe 对象:**
  - 四个套餐 x (月付, 年付) 对应 Price.
  - 加购 credits 和三档服务是一次性 Price.
  - 团队加席位用订阅 item 数量.
- **发放 credits:** `invoice.paid` 时按套餐写入 `grant_monthly`, 过期时间为周期结束. 加购付款成功时写入 `grant_topup`, 12 个月后过期.
- **消耗:** 动作开始时写 `reserve` (按 005 的规则预估), 完成时写 `settle` (按实际规则结算差额), 失败时写 `refund`. 扣减顺序是先月度, 后加购.
- **余额:** 由账本实时汇总 (带过期过滤). 用 Postgres 行锁或咨询锁 (advisory lock) 保证同一工作区串行扣减, 不出现负数.
- **服务订单:** `checkout.session.completed` 后创建订单, 计算 `due_at` (48 或 72 小时), 发送确认邮件, 进入内部队列.
- **对账:** 每天核对 Stripe 发票与 `grant` 记录.

---

## 15. 安全

- **租户隔离:** 数据访问层强制带 `workspace_id`; 对象存储的 key 带工作区前缀; 一律使用签名链接.
- **模型生成代码的隔离:**
  - 预览运行在独立域名的 sandbox iframe 中, 不带 `allow-same-origin`, 并设置严格的 CSP (只允许本合成目录和 CDN 资源).
  - 渲染和质检容器断网, 只允许访问本地静态服务; 以非 root 用户运行; 每个任务有 CPU, 内存和时长上限.
  - 自定义场景的代码要先过静态检查: 禁止网络请求 (`fetch`, `XMLHttpRequest`, `WebSocket`, 外链 `import`), `eval`, `new Function`, 访问 cookie 和存储.
- **上传:** 校验 MIME 和实际文件头; 图片重新编码; SVG 先清洗再使用.
- **采集:** 采集 worker 只访问公网地址, 屏蔽内网和元数据地址 (防 SSRF).
- **密钥:** 存放在 AWS Secrets Manager; 不同环境的 API key 分开.
- **限流和防滥用:** 免费层要求邮箱验证; 同一设备或 IP 批量注册时触发人工审核.

---

## 16. 可观测性与成本

- **链路:** 每个作业一个 trace, 跨 API, 队列和各 worker; 模型调用作为 span, 记录模型, token, 缓存命中, 耗时.
- **成本账本:** `model_calls` 按调用记录成本, 汇总到作业, 视频和工作区. 渲染按 vCPU 秒估算成本, 写入作业输出.
- **看板:**
  - 按角色统计 p50/p95 延迟, 成功率, 每次成本.
  - 缓存命中率.
  - 质检通过率.
  - 单条视频成本分布.
  - 每个付费工作区的成本与收入.
- **告警:**
  - 作业失败率 > 5% (15 分钟窗口).
  - 队列等待 > 2 分钟.
  - 单条成本 > $2.
  - 缓存命中率骤降.
  - Stripe webhook 处理失败.

---

## 17. 测试与评测

| 类型 | 内容 | 频率 |
|---|---|---|
| 单元测试 | DSL 校验, 补丁应用, 编译器输出快照, credits 账本 | 每次提交 |
| 组件视觉回归 | 每个组件 x 3 种画幅 x 2 组 props 渲染关键帧, 与基准图做像素对比 | 每次提交 (组件或运行时有改动时) |
| 端到端测试 | Playwright 跑通 注册 -> 网址 -> 生成 -> 修改 -> 导出 -> 付费 (用 Stripe 测试模式, 模型调用打桩) | 每次合并到主干 |
| 渲染确定性 | 同一版本渲染两次, 逐帧对比 | 每晚 |
| E1 生成质量 | 30 个真实产品网址: 首稿由设计负责人按 5 分制打分, 记录成本和耗时 | 提示词或模型变更时; 每周 |
| E2 修改成功率 | 100 条常见修改指令 (带预期结果) | 同上 |
| E3 评审校准 | 100 张带已知缺陷标注的联系表, 计算 Reviewer 的精确率和召回率 | 每月 |
| E4 采集与品牌 | 30 个网址的 logo 和主色正确率 | 每月 |

- 评测脚本在 `evals/`. 每次运行记录提示词版本, 模型和成本, 并与上一次结果对比.
- 规则: 指标下降不合并.

---

## 18. 部署与环境

| 环境 | 说明 |
|---|---|
| 本地 | docker-compose 启动 Postgres, Redis, MinIO; worker 本地运行; 模型调用可切换为录制回放 |
| staging | 与生产同构, 规格较小; Stripe 测试模式; 每次合并主干自动部署 |
| production | Web 部署在 Vercel; API 和 6 类 worker 部署在 ECS Fargate (render worker 8 vCPU / 16GB, 按队列深度扩缩容); RDS Postgres; ElastiCache Redis; S3 + CloudFront (主站和预览各一个域名) |

- **CI/CD:** GitHub Actions: lint -> 类型检查 -> 单元测试 -> 构建镜像 -> 部署 staging -> 端到端测试 -> 手动批准后发布生产.
- **基础设施即代码:** Terraform.
- **镜像:** render, qa 和 capture worker 共用一个基础镜像, 包含 Chromium, ffmpeg, Noto CJK 等字体.
- **基础设施成本估算 (v0.2):** 每月约 $400-800, 不含模型和旁白费用.

---

## 19. 仓库结构

```
launchframe/
  apps/
    web/              Next.js: Studio, 落地页, 定价, 分享页, 订单页
    console/          内部控制台 + 管理后台
    api/              Fastify API, Stripe 和 GitHub webhook
  workers/
    orchestrator/     作业状态机
    capture/          网页采集, 截图裁切
    agent/            品牌抽取, 分镜, 编排, 修改, 翻译, 评审, 修复
    qa/               确定性检查, 抽帧, 联系表
    audio/            TTS, 字幕, 混音
    render/           HyperFrames 渲染, 分片, 拼接, 封装
  packages/
    dsl/              Storyboard, Composition DSL, EditOp 的 zod schema, 校验, 补丁应用
    components/       组件定义 (html, props schema, 文档) + 浏览器运行时 lf-runtime
    compiler/         DSL -> HyperFrames 合成
    model-gateway/    Claude API 封装, 重试, 缓存布局, 成本记账
    prompts/          各角色的系统提示词和示例 (版本化)
    db/               Drizzle schema 与迁移
    shared/           API schema, 错误码, 常量
    ui/               前端组件
  templates/          开源模板 (Apache-2.0, 可直接用 HyperFrames CLI 渲染)
  evals/              评测集与脚本
  infra/              Terraform
```

---

## 20. 开发计划

人员: 工程 = 产品 / 工程负责人; 设计 = 内容 / 设计负责人 (用 AI 辅助编写组件 HTML/CSS 和动画); PM = 增长 / 业务负责人.

### 20.1 M0 技术验证 (2026-11-02 至 2026-11-13)

| 编号 | 验证项 | 负责人 | 通过标准 |
|---|---|---|---|
| S1 | HyperFrames: 程序化渲染, 分片, 播放器嵌入, 中日韩字体, 确定性 | 工程 | 60 秒 1080p 在 8 vCPU 上 <= 90 秒; 播放器可在 sandbox iframe 中受控播放; 两次渲染像素一致 |
| S2 | 模型质量: Storyboarder + Composer 原型, 6 个组件, 10 个真实网址 | 工程 + 设计 | >= 6/10 被评为 "可直接用或小改"; 单条成本 <= $1; p50 延迟达标 |
| S3 | 旁白供应商: 2-3 家对比 | PM | 选定供应商: 逐词时间戳, 8 种语言, 自然度, 价格 |
| S4 | 采集与品牌抽取: 30 个网址 | 工程 | logo 和主色正确率 >= 85% |
| S5 | 编辑协议: 30 条修改指令 -> 补丁 | 工程 | 一次成功率 >= 80% |
| S6 | 拒答回退与结构化输出的组合调用 | 工程 | 确定网关的最终调用方式 |

### 20.2 迭代计划

| 迭代 | 时间 | 内容 | 里程碑 |
|---|---|---|---|
| Sprint 1 | 2026-11-16 至 11-27 | 单仓库, 数据库, 作业框架, 模型网关和成本账本, DSL v1 + 编译器, 8 个组件 (设计), 采集 worker, Storyboarder, 预览 iframe | — |
| Sprint 2 | 2026-11-30 至 12-11 | Composer, 质检和修复循环, 音频 (旁白, 音乐, 混音), render worker, 内部控制台 (订单, 内部模式, 交付), 服务页和一次性付款 | 内部 Alpha (12-11); 服务上线 (12-14) |
| Sprint 3 | 2026-12-14 至 12-25 | 对话修改, 属性面板, 版本历史, 9:16 和 1:1 布局, 分享页, 邮件通知 | — |
| Sprint 4 | 2027-01-04 至 01-15 | Clerk 认证和工作区, 订阅和 credits 账本, 付费墙, 创作向导, 模板库 (6 个), 管理后台成本看板, PostHog, Sentry | v0.1 私测 (01-18) |
| Sprint 5 | 2027-01-18 至 01-29 | 本地化 (8 种语言) 和字幕, 轻时间轴, 组件扩到 14 个, 模板扩到 10 个 | — |
| Sprint 6 | 2027-02-01 至 02-12 | 案例墙, 中文界面, 性能和扩缩容, 评测回归, 集中修 bug, Product Hunt 素材 | v0.2 公测 + PH 发布 (02-23) |
| v1.0 | 2027-02-24 至 05-31 | 团队和席位, GitHub App, 团队模板, 稳定性和成本优化 | v1.0 (05-31) |

**产能提醒:** 这个计划假设 1 名全职工程师 + AI 编码辅助, 再加上设计负责人编写组件, 排期偏紧. 如果 v0.2 的日期很重要, 建议从 Sprint 2 起增加 1 名全栈工程师 (全职或外包). 否则按优先级把 Sprint 5-6 的 P1 项顺延.

---

## 21. 技术决策记录 (ADR) 摘要

| 编号 | 决策 | 理由 | 何时复审 |
|---|---|---|---|
| ADR-1 | 渲染底座用 HyperFrames, 保留自研 Playwright 管线作为兜底 | 开源, 无按次费用, 自带分布式渲染; 兜底方案已经实测可行 | M0 结束时 |
| ADR-2 | DSL + 组件库为主, 自定义场景为辅 | 抬高质量下限, 便于校验, 编辑和本地化 | v0.2 后看自定义场景的占比 |
| ADR-3 | 修改走无状态的单次调用, 只输出补丁 | 延迟低, 成本低, 可审计, 不受长对话的状态约束 | — |
| ADR-4 | 最终混音由 ffmpeg 完成, 预览中近似播放 | 音质可控, 与渲染器解耦 | — |
| ADR-5 | 作业状态放在 Postgres, 队列用 BullMQ | 可追溯, 可恢复, 运维简单 | 每天作业超过 10 万次时 |
| ADR-6 | 认证用 Clerk | 交付最快, 自带组织和邀请 | 月活或费用超过阈值时 |
| ADR-7 | 创作用 Opus 5.5, 评审和常规修改用 Sonnet 5.5, 路由用 Haiku 5.5, 统一经过网关 | 关键环节质量优先, 高频环节成本优先 | 每次评测之后 |
| ADR-8 | Web 部署在 Vercel, 后端部署在 AWS ECS Fargate | 托管为主, 渲染需要长时间运行的容器 | — |

---

## 附录 A: 提示词骨架

**Storyboarder (system 要点):**
- 你是发布视频的编剧和分镜师. 目标: 在指定时长内, 让目标受众记住产品的一个核心价值, 并点击 CTA.
- 规则:
  - 前 2 秒必须有钩子.
  - 每个场景只讲一件事.
  - 屏幕文字精简 (遵守组件的字数上限).
  - 旁白英文约每秒 2.5 个词.
  - 只能使用组件目录中的组件和素材清单中的素材 id.
  - 最后一个场景必须是 CTA.
  - 不得编造产品功能或数据, 只能使用产品要点中的事实.
- 附: 组件目录摘要 (用途 + 适合放在哪个位置), 模板骨架.

**Composer (system 要点):**
- 你把分镜转成 Composition DSL. 每个场景从组件目录中选择最合适的组件, 填写严格符合 propsSchema 的参数.
- 优先使用素材中的真实界面截图. 品牌颜色和字体只能引用品牌套件.
- 只有在任何组件都无法表达时, 才使用 `custom` 场景, 并遵守自定义场景规则.
- 附: 完整的组件文档和示例 (缓存前缀).

**Reviewer (rubric):**

| 类别 | 判断标准 |
|---|---|
| 可读性 | 文字是否在 1 秒内可读; 字号和对比度是否足够 |
| 层级 | 每帧是否有明确的视觉焦点 |
| 品牌 | 颜色, 字体, logo 是否与品牌套件一致 |
| 节奏 | 3 帧的变化是否体现运动; 有没有长时间静止 |
| 内容 | 文字是否与产品要点一致; 有没有错别字 |

严重程度分三级: 错误 (必须修复), 警告 (建议修复), 提示.

**ChatEditor (system 要点):**
- 你把用户的修改要求转成最小的补丁 (EditOp[]), 并用一两句话说明改了什么.
- 不改动用户没有提到的内容, 不改动被锁定的场景.
- 要求含糊时, 按最可能的意图修改, 并在说明里写出你的理解.
- 无法用补丁表达的要求 (例如 "换一种完全不同的风格"), 返回空补丁, 并建议用户使用 "重新生成场景".

## 附录 B: 错误码 (节选)

| 错误码 | 含义 | 前端处理 |
|---|---|---|
| `CAPTURE_BLOCKED` | 页面需要登录或被拦截 | 引导上传截图 |
| `CAPTURE_TIMEOUT` | 采集超时 | 重试或上传截图 |
| `AGENT_REFUSAL` | 模型拒绝 | 提示修改输入 |
| `AGENT_PARSE_FAILED` | 结构化输出解析或校验失败 | 自动重试; 仍失败时提示 |
| `EDIT_NOT_APPLICABLE` | 修改无法用补丁表达 | 建议重新生成场景 |
| `VERSION_CONFLICT` | 基线版本过期 (409) | 刷新后重试 |
| `INSUFFICIENT_CREDITS` | credits 不足 | 弹出升级或加购 |
| `RENDER_FAILED` | 渲染失败 | 自动重试 1 次, 仍失败转人工 |
