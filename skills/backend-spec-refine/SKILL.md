---
name: backend-spec-refine
description: 交互式完善后端需求或 spec-to-design 的开放问题，生成可运行的 spec-to-design spec。用于准备 backend-service 规格、回答 workflow open questions、在重新 /workflow:run 前 patch spec。
---

# Backend Spec Refine

这个 skill 用来把粗糙的后端需求完善成可运行的 `spec-to-design` spec，或者在 `spec-to-design` workflow 输出开放问题后，帮助用户根据回答修订已有 spec。

这个 skill **应该在主会话中交互式运行**。不要试图让后台 workflow node 在执行中途等待用户输入。

## 什么时候使用

当用户想做这些事情时使用本 skill：

- 把一个粗糙的后端功能想法变成 `spec-to-design` spec；
- 澄清或修补已有 `spec-to-design` spec；
- 回答上一次 `spec-to-design` run 产出的 open questions；
- 为类似 `gpt-proxy` 的后端服务准备设计 workflow；
- 在运行 `/workflow:run` 前补齐后端项目特有的关注点。

不要用这个 skill 直接写代码。它只负责准备 spec；设计包由 workflow 生成。

## 相关 Workflow

这里的 `spec-to-design` 不是 GitHub Spec Kit 自带 workflow，也不是通用 `/speckit.*` command。

它是我们基于 Pi workflow extension 设计的自定义拓展 workflow：

- workflow template 由我们的 Pi workflow extension 执行；
- 运行入口是 `/workflow:run <spec>`；
- 运行产物进入 `.workflow/runs/<runId>/`；
- 可通过 `/workflow:inspect` 查看 DAG 节点、agent conversation、artifact、readiness；
- 它借鉴 Spec Kit 的 spec/plan/tasks/checklist 思路，但不是直接搬 Spec Kit skill。

目标 workflow spec 声明是：

```yaml
workflow: spec-to-design
template: spec-to-design-spec-v1
```

如果存在，先读取 workflow 设计说明作为上下文：

```text
/Users/kl/.pi/agent/extensions/docs/spec-to-design-workflow.md
```

## 职责边界

```text
backend-spec-refine skill
  -> 交互式澄清、补 spec、读取 open questions、吸收用户回答、生成/patch spec

spec-to-design workflow
  -> 后台生成设计包、并行设计、artifact、verification、readiness
```

本 skill 可以创建或更新 spec 文件。除非用户明确要求，否则不要静默运行 workflow。通常在结束时告诉用户明确的运行命令：

```text
/workflow:run <spec-path>
```

## 可能的输入

用户可能提供：

1. 一段粗需求文本；
2. 一个已有 spec 路径；
3. 一个 workflow open questions 文件路径，例如：

   ```text
   .workflow/runs/<runId>/nodes/<nodeId>/backend-design/review/25-open-questions.md
   ```

4. 用户对上一轮 open questions 的回答。

如果没有项目路径，必须询问用户。对于 brownfield 后端项目，强烈建议提供项目路径。

## 输出 Spec Contract

生成或修补的 markdown spec 必须包含 frontmatter：

```yaml
---
template: spec-to-design-spec-v1
workflow: spec-to-design
title: <任务标题>
projectPath: <项目绝对路径>
projectTypeHint: backend-service
---
```

推荐章节顺序如下。创建新 spec 时尽量使用这个顺序；patch 旧 spec 时尽量保持原结构，只在必要时补齐缺失章节。

必需 sections：

```markdown
## Raw Requirement

## Refined Backend Requirement

## Target Project

## Desired Outcome

## Out of Scope

## User Scenarios & Testing

## Requirements

## Key Entities

## Backend-Specific Concerns

## Project Experience Checklist

## Edge Cases & Failure Handling

## Success Criteria

## Known Constraints

## Assumptions

## Current Questions

## Spec Quality Checklist
```

交互式 patch 时推荐附加 sections：

```markdown
## Clarifications

## Answers Incorporated
```

章节排序原则：

1. 先保留用户原始输入，再给 refined requirement；
2. 先描述目标项目、期望结果、范围边界；
3. 再写用户场景、需求、实体、后端关注点；
4. 再写边界条件、成功标准、约束、假设；
5. 最后写未解决问题和质量检查。

借鉴 Spec Kit 的要求：

- spec 里 `what/why` 优先，不提前写具体实现细节；
- 每个 requirement 必须可测试；
- user story 必须独立可测试；
- success criteria 必须可度量；
- 不清楚的问题使用 `[NEEDS CLARIFICATION: 具体问题]`；
- 能合理默认的，不要问，写到 `## Assumptions`；
- 高影响澄清问题最多保留 3 个，优先级：scope > security/privacy > billing/data > user experience > technical detail。

## 交互策略

1. 先判断用户是在：
   - 从粗需求开始；
   - 修补已有 spec；
   - 回答 workflow open questions。
2. 如果用户给了文件路径，先读取文件，再提问。
3. 如果目标项目路径存在，只做足够轻量的结构探测来定制问题/spec。优先使用 `find`、`ls`、定向读取，不要无目的全量扫描。
4. 只有当问题会实质影响范围、安全、计费、API 合约、数据模型、上线或实现路径时，才向用户追问。
5. 生成新 spec 时最多保留 3 个 `[NEEDS CLARIFICATION]`；交互式澄清已有 spec 时最多问 5 个问题。
6. 如果存在合理默认值，直接写成 assumption，不要阻塞；但要明确标注默认假设。
7. 提问时优先使用多选格式，并给出推荐项和影响说明；如果不适合多选，要求用户用短答案回答。
8. 用户回答后，创建或更新 spec 文件。
9. 每次 patch spec 后，重新检查 spec quality checklist。
10. 结束时输出下一步命令：

   ```text
   /workflow:run <spec-path>
   ```

## Spec 写法要求

### 1. User Scenarios & Testing

每个 user story 必须：

- 有优先级，例如 P1/P2/P3；
- 说明为什么是这个优先级；
- 有 `Independent Test`，说明只做这一条时如何独立验证；
- 有 Given/When/Then acceptance scenario。

格式：

```markdown
### User Story 1 - <标题> (Priority: P1)

**Why this priority**: <为什么重要>

**Independent Test**: <如何独立测试这一条>

**Acceptance Scenarios**:

1. Given <初始状态>, When <动作>, Then <预期结果>
```

### 2. Requirements

Functional Requirements 使用稳定编号：

```markdown
- **FR-001**: System MUST <可测试能力>
- **FR-002**: System MUST <可测试行为>
```

要求：

- 每条 requirement 必须能被测试或验证；
- 避免“robust / scalable / secure / intuitive”这类不可验证形容词，除非有明确标准；
- 不确定但关键的问题写成：

  ```markdown
  - **FR-00X**: System MUST support billing by [NEEDS CLARIFICATION: billing unit not specified - token, request, duration, provider cost?]
  ```

### 3. Success Criteria

Success criteria 使用稳定编号：

```markdown
- **SC-001**: <可度量结果>
- **SC-002**: <可验证结果>
```

要求：

- 可度量：包含时间、比例、数量、错误率、覆盖率等；
- 尽量从用户/业务视角描述；
- 不把框架、语言、数据库等实现细节写进 success criteria；
- 对后端内部指标，如果确实影响验收，可以写成业务/运维可验证结果，例如“账单汇总在 T+1 小时内可查询”。

### 4. Assumptions 和 Clarifications

- 有合理默认值时，写入 `## Assumptions`，不要阻塞用户；
- 只有高影响且没有合理默认的问题，才写 `[NEEDS CLARIFICATION: ...]`；
- 新 spec 最多 3 个 clarification markers；
- 如果超过 3 个，保留最高风险的 3 个，其余使用合理默认并写入 assumptions。

### 5. Spec Quality Checklist

创建或 patch spec 后，检查并可写入：

```markdown
## Spec Quality Checklist

### Content Quality

- [ ] Focused on what/why, not implementation details
- [ ] All mandatory sections completed
- [ ] Backend-specific concerns considered

### Requirement Completeness

- [ ] No more than 3 NEEDS CLARIFICATION markers
- [ ] Requirements are testable and unambiguous
- [ ] Success criteria are measurable
- [ ] Acceptance scenarios are defined
- [ ] Edge cases are identified
- [ ] Scope is clearly bounded
- [ ] Dependencies and assumptions are documented

### Backend Readiness

- [ ] API contract impact considered
- [ ] Data/model/migration impact considered
- [ ] Auth/quota/billing impact considered
- [ ] Observability/reliability/security impact considered
- [ ] Rollout/testing impact considered
```

未通过的项目不一定阻止 spec-to-design workflow，但必须在 spec 中明确记录。

## 后端关注点 Checklist

完善 backend-service spec 时，检查该功能是否影响：

- API 合约：endpoint、headers、request/response、error、streaming/SSE；
- 路由链路：router、controller、service、provider adapter、model mapping；
- 数据模型：models、DAO、migrations、indexes、backfill；
- 鉴权和租户：app key、provider key、user/team/tenant scope、admin 权限；
- 限流和配额：按 key/user/team/provider/model 的 limit；
- 用量计量：record 写入、计费单位、token/duration/request/provider-cost accounting；
- 账单汇总：hourly/daily aggregation、reconciliation、refund/compensation；
- 可靠性：timeout、retry、fallback、circuit breaker、idempotency；
- 错误处理：provider error mapping、client-facing error format；
- 可观测性：logs、metrics、traces、dashboards、alerts；
- 安全和隐私：secret handling、敏感日志、PII/media retention、SSRF/abuse 风险；
- 性能容量：QPS、p95/p99 latency、DB write volume、streaming connections；
- 上线发布：config flags、migration order、compatibility、rollback；
- 测试：unit、integration、DAO、contract、provider stub、streaming、migration、load tests。

## gpt-proxy 场景经验

对于类似 `~/workspace/codes/gpt-proxy` 的项目，如果需求增加或修改 provider/model/modality，必须显式考虑：

- `constant/` provider/model 常量；
- `app/api/conf/` 配置和多环境差异；
- `app/api/router/` route 注册；
- `app/api/controller/` request handler；
- `app/api/service/` provider/proxy 逻辑；
- `app/api/payload/` request/response struct；
- `dao/` 和 `models/` 的 record / summary；
- `dao/migrations/` schema change；
- app key / provider key 选择；
- quota / rate limit 检查；
- usage record 写入路径；
- 扣费/charge 规则；
- hourly/daily billing summary；
- Prometheus metrics 和 dashboards；
- alert rules；
- error mapping 和 retry/fallback；
- tests 和 fixtures。

## 创建新 Spec

如果是创建新 spec：

1. 根据需求选择一个短的 kebab-case 名称。
2. 默认写到 `/Users/kl/specs/`，除非用户指定其他路径。
3. 先提取 actors、actions、data、constraints、external dependencies。
4. 生成 user stories、FR、SC、assumptions、current questions。
5. 只保留最多 3 个高影响 `[NEEDS CLARIFICATION]`。
6. 创建 `## Spec Quality Checklist` 并根据当前 spec 勾选/留空。
7. 文件名建议：

   ```text
   /Users/kl/specs/<short-name>-spec-to-design.md
   ```

8. 未解决问题放入 `## Current Questions`，但如果有合理默认值，不要过度阻塞。
9. 必须保留 `workflow: spec-to-design`，否则 `/workflow:run <spec>` 无法根据 spec 直接选择 workflow。

## 修补已有 Spec

如果是 patch 现有 spec：

1. 读取已有 spec。
2. 保留 frontmatter 和用户已提供内容，除非它明显错误。
3. 不为了排序做大规模重排；只有在用户要求整理结构或章节混乱影响理解时，才按推荐章节顺序整理。
4. 如不存在 `## Clarifications`，创建该 section，并添加 `### Session YYYY-MM-DD`。
5. 把用户回答记录成：

   ```markdown
   - Q: <问题> → A: <答案>
   ```

6. 把用户回答写入 `## Answers Incorporated` 或相关 section。
7. 将回答同步应用到最合适的位置：
   - functional ambiguity -> 更新 `## Requirements`；
   - user/actor 区分 -> 更新 `## User Scenarios & Testing`；
   - data/entity -> 更新 `## Key Entities` 或 backend concerns；
   - non-functional constraint -> 更新 `## Success Criteria`；
   - edge case -> 更新 `## Edge Cases & Failure Handling`；
   - terminology -> 统一术语。
8. 已解决的问题从 `## Current Questions` 移走。
9. 删除或替换被新答案否定的旧表述，避免 spec 自相矛盾。
10. 未解决的高影响问题继续保留在 `## Current Questions`。
11. 重新检查 `## Spec Quality Checklist`。
12. 除非用户要求 clean rewrite，否则避免破坏性重写。

## 处理 Workflow Open Questions

如果用户提供 open-questions artifact：

1. 读取该 artifact。
2. 定位原始 spec 路径；如果找不到，询问用户。
3. 用通俗语言总结问题。
4. 按主题分组向用户要答案。
5. 根据答案 patch spec。
6. 告诉用户重新运行：

   ```text
   /workflow:run <spec-path>
   ```

## 示例 Spec 骨架

```markdown
---
template: spec-to-design-spec-v1
workflow: spec-to-design
title: Add New Provider Model
projectPath: /Users/kl/workspace/codes/gpt-proxy
projectTypeHint: backend-service
---

## Raw Requirement

Add support for <provider/model/modality>.

## Refined Backend Requirement

Support the new provider/model/modality through the existing backend proxy flow, including routing, provider selection, usage recording, billing summary impact, observability, rollout, and tests.

## Target Project

- Project path: `/Users/kl/workspace/codes/gpt-proxy`
- Project type: backend-service
- Language: Go

## Desired Outcome

A backend design package that defines API behavior, routing/provider flow, data changes, usage metering, billing summary, observability, tests, rollout, and implementation tasks.

## Out of Scope

- Direct code implementation during spec-to-design.
- Unrelated provider/model refactors unless required for this feature.

## User Scenarios & Testing

### User Story 1 - Proxy calls for the new model (Priority: P1)

**Why this priority**: This is the minimum useful path for callers.

**Independent Test**: A caller can send a request for the new model and receive a provider response or mapped provider error.

**Acceptance Scenarios**:

1. Given a valid app key and supported model, When the caller sends a request, Then the system routes it to the correct provider and returns a compatible response.

## Requirements

- **FR-001**: System MUST route requests for the new model to the configured provider.
- **FR-002**: System MUST record usage for successful billable requests.
- **FR-003**: System MUST support billing by [NEEDS CLARIFICATION: billing unit not specified - token, request, duration, provider cost?]

## Key Entities

- **Provider**: External service that executes the model request.
- **Model**: Public or internal model identifier routed by the proxy.
- **Usage Record**: Billable request accounting record.

## Backend-Specific Concerns

- API compatibility and provider-specific payload mapping.
- Usage recording, deduction, and summary aggregation.
- Metrics, dashboards, alerts, and error mapping.

## Project Experience Checklist

- Provider/model constants and config considered.
- Router/controller/service/provider flow considered.
- DAO/model/migration impact considered.
- Quota/billing/summary impact considered.
- Observability and test impact considered.

## Edge Cases & Failure Handling

- Provider timeout or provider-specific error.
- Unsupported model name.
- Usage recording succeeds/fails around provider failure boundaries.

## Success Criteria

- **SC-001**: A valid request for the new model can be completed through the proxy in the target environment.
- **SC-002**: Billable usage records are available for summary generation after successful requests.

## Known Constraints

- Do not implement code during spec-to-design.
- Preserve compatibility with existing API/proxy behavior unless explicitly changed.

## Assumptions

- Existing app key validation will be reused.
- Existing provider configuration patterns will be reused where applicable.

## Current Questions

- [NEEDS CLARIFICATION] What is the billing unit?
- [NEEDS CLARIFICATION] Is streaming required?

## Spec Quality Checklist
```
