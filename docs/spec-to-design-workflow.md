# Spec-to-Design Workflow 设计文档

> 状态：设计草案，先不实现。  
> 目标：为 `/workflow:compose` 之后的“粗需求 -> 专业工程设计包 -> 可执行任务”提供一个标准 workflow。  
> 第一版项目类型：`backend-service`，参考本地 `~/workspace/codes/gpt-proxy` 这类 Go 后端/API 代理服务。

## 1. 背景

当前 workflow extension 已经支持：

- JSON workflow template；
- 可视化 DAG designer；
- `/workflow:create` 生成 spec；
- `/workflow:run` 后台执行；
- 单 agent / multi-agent node；
- node artifact、conversation、verification、retry/resume；
- `/workflow:compose` 动态生成 task-specific workflow/spec。

但对于“用户只有一个粗需求”的场景，直接生成 implementation workflow 太早了。尤其是后端项目，很多关键问题在写代码前必须先明确：

- API 合约；
- 数据模型和 migration；
- 服务分层；
- 鉴权、租户、权限；
- 限流、配额、计费；
- 错误码、重试、熔断、降级；
- 日志、metrics、tracing、alerts；
- 性能容量；
- rollout、backfill、rollback；
- 测试策略。

因此需要一个独立的 `spec-to-design` workflow：它不直接实现功能，而是把粗需求变成专业的工程设计包、澄清问题、可执行任务列表和 readiness 结论。

## 2. 和 GitHub Spec Kit 的关系

参考项目：<https://github.com/github/spec-kit>

Spec Kit 的核心流程是：

```text
constitution -> specify -> plan -> tasks -> implement
```

它有几个非常值得借鉴的点：

1. `spec` 关注 what/why，不提前陷入技术实现。
2. `plan` 关注 technical context、architecture、project structure。
3. `tasks` 关注可执行任务，任务有 ID、依赖、并行标记、具体文件路径。
4. requirements 必须 testable。
5. user story 应该 independently testable。
6. 不明确的问题用 `NEEDS CLARIFICATION` 显式标记。
7. spec quality checklist 会在进入 plan 前检查质量。

但不建议直接把 Spec Kit skill/commands 原样搬过来作为主流程，原因是：

- Spec Kit 是线性 slash-command flow；我们是 DAG workflow + background agents。
- Spec Kit 模板偏通用；我们要按项目类型输出不同 artifact package。
- Spec Kit 更偏 spec/plan/tasks；我们的需求还包括 multi-agent 审核、artifact inspection、retry/resume、verification。
- 对 `gpt-proxy` 这类 brownfield 后端项目，需要 repo-aware discovery，而不是通用 `src/models/services` 模板。

因此本 workflow 采用：

```text
Spec Kit 的 spec/plan/tasks/checklist 方法论
+
Pi workflow 的 DAG/multi-agent/artifacts/inspect 执行模型
+
按 projectProfile 选择项目类型专用设计包
```

## 3. 设计目标

### 3.1 主要目标

`spec-to-design` 要完成：

1. 接收粗需求或 draft spec。
2. 识别项目类型、技术栈、现有代码结构。
3. 把粗需求转成 refined spec。
4. 对后端项目生成 backend design package。
5. 明确 assumptions、risks、open questions。
6. 生成 implementation plan 和 implementation tasks。
7. 从最终 spec/design 中吸取项目定制经验，沉淀项目场景 checklist 和可复用规则。
8. 输出 readiness summary，判断是否可以进入实现。
9. 如果 `ready = no/partial`，仍然视为 workflow 成功，因为发现问题就是该 workflow 的目标之一。

### 3.2 非目标

第一版不做：

- 不直接改代码；
- 不直接执行 implementation tasks；
- 不自动创建 git branch；
- 不强制兼容所有 Spec Kit extension；
- 不支持所有项目类型；
- 不做动态 agent routing，只使用当前 phase-based multi-agent executor。

## 4. 适用场景

适合：

```text
我有一个功能想法，但还没到能开工的程度。
我有一份粗 spec，需要转成工程设计。
我要改一个 brownfield 后端服务，需要先理解现有代码。
我要把一个需求拆成 API、数据、服务、测试、上线计划。
```

不适合：

```text
只是简单修 bug，直接 code-review/remediation 即可。
已有完整设计，只差实现任务。
纯代码审查。
纯文档润色。
```

## 5. 输入 spec contract

`spec-to-design` 的初始 spec 应该允许“粗糙”，但必须有最低信息。

建议 frontmatter：

```yaml
---
template: spec-to-design-spec-v1
workflow: spec-to-design
title: <task title>
projectPath: /Users/kl/workspace/codes/gpt-proxy
projectTypeHint: backend-service
---
```

必需 sections：

```markdown
## Raw Requirement

## Target Project

## Desired Outcome

## Known Constraints

## Current Questions
```

说明：

- `Raw Requirement` 可以很粗。
- `Target Project` 可以是本地路径，例如 `~/workspace/codes/gpt-proxy`。
- `projectTypeHint` 可选；没有时由 workflow 自行识别。
- `Current Questions` 可以为空。

## 6. Project Profile

workflow 不应该固定输出一套万能文档，而应该先生成 `project-profile.json`。

第一版支持：

```json
{
  "projectType": "backend-service",
  "language": "go",
  "framework": "unknown-or-detected",
  "repositoryStyle": "brownfield",
  "hasDatabase": true,
  "hasMigrations": true,
  "hasRedis": true,
  "hasStreaming": true,
  "hasAuth": true,
  "hasRateLimit": true,
  "hasUsageMetering": true,
  "hasProviderRouting": true,
  "hasObservability": true,
  "designPackage": "backend-design"
}
```

对 `gpt-proxy`，discovery 应重点识别：

```text
app/api/controller/
app/api/router/
app/api/service/
app/api/payload/
app/api/conf/
dao/
dao/migrations/
models/
middle/
constant/
dashboards/
docs/
tests/
pkg/testutil/
```

## 7. DAG 设计

设计原则：**能拆成独立 workflow node 的，就不要塞进一个 cluster/multi-agent node；能并行的节点必须并行。**

原因：当前 phase-based cluster/multi-agent executor 更适合“强协调、强顺序”的内部协作；如果把 API、数据、鉴权、观测、测试等互相独立的设计面全部放进一个 cluster，整体会被串行 phase 拖慢。独立设计面应该作为外层 DAG 节点 fan-out，让多个 Pi child agents 同时运行。

推荐 DAG：

```text
spec-intake
  ↓
project-profile
  ↓
context-discovery
  ↓
project-experience-extraction
  ↓
  ├─ api-contract-design ───────────────┐
  ├─ service-architecture-design ───────┤
  ├─ data-model-design ─────────────────┤
  ├─ auth-quota-observability-design ───┤
  ├─ reliability-performance-security-design ─┤
  └─ test-strategy-design ──────────────┘
                                      ↓
                         design-package-synthesis
                                      ↓
          ┌─ spec-quality-gate ───────┼─ assumption-validation ─┐
          └─ experience-capture ──────┘                         ↓
                              readiness-gate
```

并行语义：

- `api-contract-design`、`service-architecture-design`、`data-model-design`、`auth-quota-observability-design`、`reliability-performance-security-design`、`test-strategy-design` 应该在同一 ready batch 中并行启动。
- `spec-quality-gate`、`assumption-validation`、`experience-capture` 在 `design-package-synthesis` 后也可以并行。
- 如果当前 engine 没有把同一批 ready nodes 同时拉起，这是 workflow engine 的缺陷，应修复 scheduler，而不是把设计压回一个 cluster。
- cluster/multi-agent node 只用于一个节点内部确实需要 manager/router、共享 artifact、顺序 handoff 的场景。

### 7.1 Node: `spec-intake`

类型：analysis  
executor：single agent

目标：

- 读取 raw spec；
- 提取目标、范围、约束、期望产物；
- 标记明显缺失信息；
- 不做代码实现设计；
- 输出初始 normalized requirement。

输出：

```text
intake/normalized-requirement.md
intake/initial-questions.md
result.json
report.md
```

### 7.2 Node: `project-profile`

类型：analysis  
executor：single agent

目标：

- 识别项目类型；
- 判断是否是 backend-service；
- 识别语言、结构、数据层、API 层、观测、测试、部署相关线索；
- 输出 `project-profile.json`。

输出：

```text
profile/project-profile.json
profile/project-structure.md
result.json
report.md
```

### 7.3 Node: `context-discovery`

类型：analysis  
executor：single agent 或 multi-agent

目标：

- 针对现有项目做 repo-aware discovery；
- 找出相关 controller/service/dao/model/config/test/dashboard/doc；
- 找相似实现；
- 记录证据路径；
- 不修改代码。

输出：

```text
context/relevant-files.md
context/existing-flows.md
context/similar-implementations.md
context/current-architecture-notes.md
result.json
report.md
```

### 7.4 Node: `project-experience-extraction`

类型：analysis  
executor：single agent 或 multi-agent

目标：

- 从 raw spec、现有代码、历史类似实现中提取“这个项目特有的场景经验”；
- 生成项目级 domain checklist，供后续 design-panel 使用；
- 不只回答“这个需求要做什么”，还要回答“在这个项目里做这类需求通常还会牵扯什么”；
- 识别隐藏但必须考虑的横切问题，例如扣费、账单汇总、限流、观测、回滚、兼容性；
- 为后续 implementation tasks 提供项目定制检查项。

对 `gpt-proxy` 的例子：

```text
如果需求是“增加一个新 model / provider / modality”，不能只设计 API 调用。
还要检查：
- provider/model 常量和配置；
- request routing 和 model mapping；
- app key / provider key 选择；
- quota / rate limit；
- usage record；
- 扣费规则；
- hourly/daily billing summary；
- dashboard metrics；
- alert rules；
- error mapping；
- retry/fallback；
- migration/backfill；
- tests and fixtures。
```

输出：

```text
knowledge/project-experience-and-domain-checklist.md
knowledge/scenario-risk-matrix.md
knowledge/reusable-design-rules.md
result.json
report.md
```

这一步必须作为所有并行设计节点的输入，避免后续设计只覆盖显性需求、漏掉项目惯例中的隐性场景。

### 7.5 Parallel Design Fan-out Nodes

类型：design  
executor：single agent per node，外层 DAG 并行

这些节点都读取：

```text
{{inputs.spec}}
context/relevant-files.md
context/existing-flows.md
context/similar-implementations.md
knowledge/project-experience-and-domain-checklist.md
knowledge/scenario-risk-matrix.md
```

这些节点不是一个 cluster。它们应该是多个独立 workflow nodes，由 workflow scheduler 并行启动。

#### 7.5.1 Node: `api-contract-design`

目标：设计 API 合约、请求/响应、错误格式、streaming/SSE、兼容性。

输出：

```text
design/api-contract-notes.md
result.json
report.md
```

#### 7.5.2 Node: `service-architecture-design`

目标：设计 controller/router/service/adapter 边界，识别需要修改的 Go package 和调用链。

输出：

```text
design/service-architecture-notes.md
result.json
report.md
```

#### 7.5.3 Node: `data-model-design`

目标：设计 models/DAO/migration/index/backfill/data consistency。

输出：

```text
design/data-model-notes.md
result.json
report.md
```

#### 7.5.4 Node: `auth-quota-observability-design`

目标：设计 app key/provider key/tenant scope、rate limit、quota、usage metering、扣费、账单汇总、metrics、dashboards、alerts。

输出：

```text
design/auth-quota-observability-notes.md
result.json
report.md
```

#### 7.5.5 Node: `reliability-performance-security-design`

目标：设计 timeout、retry、fallback、circuit breaker、error mapping、performance capacity、安全隐私和日志脱敏。

输出：

```text
design/reliability-performance-security-notes.md
result.json
report.md
```

#### 7.5.6 Node: `test-strategy-design`

目标：设计 unit/integration/contract/DAO/provider stub/streaming/migration/load tests，并映射到项目真实路径。

输出：

```text
design/test-strategy-notes.md
result.json
report.md
```

#### Cluster 使用边界

如果未来某个设计面内部确实需要多角色顺序协作，可以在该设计面内部使用 multi-agent node。例如 `auth-quota-observability-design` 内部可能有 `billing-reviewer` 和 `observability-reviewer`。但默认不要把所有 specialist 放进一个大 cluster。

### 7.6 Node: `spec-quality-gate`

类型：verification  
executor：single agent

目标：

- 借鉴 Spec Kit 的 quality checklist；
- 检查 refined spec 是否可测试、可验收、边界清晰；
- 检查是否有过多 implementation detail 泄漏到 spec；
- 检查 open questions 是否被显式记录。

注意：

```text
quality gate 发现问题不等于 workflow failed。
它应该输出 ready/partial/no 和 issues。
```

输出：

```text
review/spec-quality-checklist.md
review/spec-quality-issues.md
result.json
report.md
```

### 7.7 Node: `assumption-validation`

类型：analysis  
executor：single agent

目标：

- 验证设计中的 assumptions；
- 尽量用代码证据确认或推翻；
- 区分 verified / false / partial / unclear / not-verifiable；
- 生成必须问用户的问题。

输出：

```text
review/assumption-validation.md
review/open-questions-draft.md
result.json
report.md
```

### 7.8 Node: `design-package-synthesis`

类型：synthesis  
executor：single agent

目标：

- 汇总所有上游 artifact；
- 生成最终 backend design package；
- 把 `project-experience-extraction` 的项目经验融入 spec/plan/tasks；
- 额外生成 Spec Kit compatible `spec.md` / `plan.md` / `tasks.md`；
- 确保文档之间一致。

输出：

```text
backend-design/spec/*.md
backend-design/plan/*.md
backend-design/tasks/*.md
backend-design/review/*.md
backend-design/knowledge/*.md
speckit-compatible/spec.md
speckit-compatible/plan.md
speckit-compatible/tasks.md
result.json
report.md
```

### 7.9 Node: `experience-capture`

类型：synthesis  
executor：single agent

目标：

- 在最终 spec/design/tasks 基本完成后，再反向总结“这次需求暴露了哪些项目场景经验”；
- 输出可复用经验，供下一次同类需求作为 context；
- 区分项目通用规则、场景特定规则、一次性假设；
- 不能把未验证假设写成确定规则；
- 对每条经验给出证据来源和适用边界。

输出：

```text
knowledge/final-project-lessons.md
knowledge/future-workflow-hints.md
knowledge/update-candidates.md
result.json
report.md
```

`update-candidates.md` 只提出建议，不自动修改项目文档或全局模板。用户确认后，才可以把经验写入例如：

```text
docs/project-playbook.md
.workflow/knowledge/<project>.md
AGENTS.md
```

### 7.10 Node: `readiness-gate`

类型：verification  
executor：single agent

目标：

- 读最终设计包；
- 判断是否可以进入 implementation workflow；
- 给出 next action。

输出：

```text
readiness/readiness-summary.md
readiness/next-action.md
result.json
report.md
```

状态语义：

```text
completed: 设计包已生成，readiness 结论明确。
needs-revision: 设计包结构不完整或自相矛盾。
failed: 执行失败、关键 artifact 缺失、无法读取输入。
```

`ready = no` 仍然可以是 `completed`。

## 8. Backend Design Package

第一版针对 `backend-service` 输出：

```text
backend-design/
  spec/
    01-refined-backend-spec.md
    02-user-scenarios-and-acceptance.md
    03-assumptions-and-clarifications.md

  plan/
    04-technical-context.md
    05-existing-system-context.md
    06-api-contract.md
    07-request-routing-and-provider-flow.md
    08-service-layer-design.md
    09-data-model-and-migration.md
    10-auth-permission-and-tenant-scope.md
    11-rate-limit-quota-and-billing.md
    12-observability-logging-metrics-alerts.md
    13-error-handling-and-retry-policy.md
    14-performance-and-capacity.md
    15-security-and-privacy.md
    16-rollout-backfill-and-compatibility.md
    17-test-strategy.md

  tasks/
    18-implementation-plan.md
    19-implementation-tasks.md

  knowledge/
    20-project-experience-and-domain-checklist.md
    21-scenario-risk-matrix.md
    22-final-project-lessons.md
    23-future-workflow-hints.md

  review/
    24-assumption-validation.md
    25-open-questions.md
    26-readiness-summary.md
```

### 8.1 `spec/01-refined-backend-spec.md`

关注 what/why：

```markdown
# Refined Backend Spec

## Goal
## Caller / User Scenario
## In Scope
## Out of Scope
## Functional Requirements
## Non-Functional Requirements
## Acceptance Criteria
## Success Criteria
## Edge Cases
## Assumptions
## NEEDS CLARIFICATION
```

### 8.2 `spec/02-user-scenarios-and-acceptance.md`

借鉴 Spec Kit：每个 user story 独立可测试。

```markdown
## User Story 1 - <title> (Priority: P1)

## Why this priority

## Independent Test

## Acceptance Scenarios

1. Given ..., When ..., Then ...
```

### 8.3 `plan/06-api-contract.md`

后端核心产物：

```markdown
## Endpoints
## Request Headers
## Request Body
## Response Body
## Error Contract
## Streaming / SSE Behavior
## Idempotency
## Compatibility
## Example Requests
```

### 8.4 `plan/07-request-routing-and-provider-flow.md`

对 `gpt-proxy` 类项目特别重要：

```markdown
## Routing Entry Point
## Controller Flow
## Service Flow
## Provider Selection
## Model Mapping
## Key Selection
## Retry / Fallback
## Usage Recording
## Error Mapping
## Sequence Diagram
```

### 8.5 `tasks/19-implementation-tasks.md`

借鉴 Spec Kit task 格式：

```markdown
- [ ] T001 [P] [FOUNDATION] Add migration in `dao/migrations/...`
- [ ] T002 [P] [FOUNDATION] Add model in `models/...`
- [ ] T003 [US1] Add DAO methods in `dao/...`
- [ ] T004 [US1] Add service method in `app/api/service/...`
- [ ] T005 [US1] Add controller handler in `app/api/controller/...`
- [ ] T006 [US1] Register route in `app/api/router/...`
- [ ] T007 [US1] Add integration test in `...`
```

要求：

- 每个任务必须有 ID；
- `[P]` 表示可以并行；
- `[USx]` 绑定 user story；
- 描述里尽量包含具体文件路径；
- 任务按 setup/foundation/user story/polish 分组；
- 不允许只有“实现业务逻辑”这种模糊任务。

### 8.6 `knowledge/20-project-experience-and-domain-checklist.md`

记录“这个项目里做某类需求必须额外检查什么”。这不是通用后端 checklist，而是项目经验。

对 `gpt-proxy` 可以形成类似规则：

```markdown
## Scenario: Add provider / model / modality

When a spec adds or changes a provider/model/modality, check:

- Provider/model constants and config
- Route/controller/service entry points
- Model mapping and provider selection
- App key and provider key selection
- Quota and rate limit impact
- Usage record write path
- Deduction / charge rule
- Hourly/daily billing summary
- Dashboard metrics and alert rules
- Error mapping and retry/fallback behavior
- Migration/backfill requirement
- Tests and fixtures
```

这个文件必须被 `design-package-synthesis` 和 `readiness-gate` 使用，避免最终 spec 只覆盖显性功能、漏掉项目惯例。

### 8.7 `knowledge/22-final-project-lessons.md`

在最终 spec/design/tasks 完成后反向总结：

```markdown
## Reusable Lessons

## Scenario-Specific Lessons

## Evidence

## Applicability Boundary

## Should Update Project Playbook?
```

其中 `Should Update Project Playbook?` 只能提出建议，不能自动写入全局规则。

## 9. Spec Kit Compatible Output

为了方便未来接入 Spec Kit 或让用户熟悉该格式，最终可以额外输出：

```text
speckit-compatible/spec.md
speckit-compatible/plan.md
speckit-compatible/tasks.md
```

映射关系：

```text
backend-design/spec/*
  -> speckit-compatible/spec.md

backend-design/plan/*
  -> speckit-compatible/plan.md

backend-design/tasks/19-implementation-tasks.md
  -> speckit-compatible/tasks.md
```

注意：

- 这是兼容输出，不是主产物；
- 不要求安装 Spec Kit；
- 不调用 `/speckit.*` commands；
- 不直接复制 Spec Kit 模板，只借鉴结构。

## 10. Verification 设计

每个 node 都可以有 engine-level semantic verification，但语义是最终质量门，不是开发反馈循环。

建议：

- `spec-intake`：检查是否提取了目标、范围、约束、问题；
- `project-profile`：检查是否识别项目类型和关键结构；
- `context-discovery`：检查是否给出代码证据路径；
- `project-experience-extraction`：检查是否提取了项目特有场景经验和 domain checklist；
- 并行设计 fan-out 节点：检查各后端关注面是否覆盖，并且是否使用了项目经验 checklist；
- `spec-quality-gate`：检查 checklist 是否完整；
- `assumption-validation`：检查 assumptions 是否有状态和证据；
- `design-package-synthesis`：检查最终 artifact package 是否完整，且项目经验已进入 spec/plan/tasks；
- `experience-capture`：检查是否从最终设计中总结了可复用经验、证据和适用边界；
- `readiness-gate`：检查 readiness 结论是否明确。

## 11. 与 `/workflow:compose` 的关系

`/workflow:compose` 仍然是新任务入口。

但交互式补 spec 更适合做成 skill，而不是 workflow node：

- skill 在主会话中运行，可以和用户多轮问答；
- skill 可以读取/修改 spec 文件；
- skill 可以调用 `/workflow:run` 或提示用户运行；
- workflow run 是后台执行，不适合中途等待用户回答。

因此推荐边界是：

```text
spec-refinement skill：负责交互式澄清、补 spec、吸收用户回答
spec-to-design workflow：负责后台生成设计包、并行设计、verification、artifacts、readiness
```

当 requirement 明显过粗时，compose prompt 应建议：

```text
Do not generate an implementation workflow yet.
Generate a spec-to-design run/spec first.
```

推荐用户流程：

skill 文件：

```text
/Users/kl/.pi/agent/skills/backend-spec-refine/SKILL.md
```

```text
/skill:backend-spec-refine <rough requirement or spec path>
  ↓
skill 在主会话中澄清需求、补充 spec、记录用户回答
  ↓
生成或更新 specs/<task>-spec-to-design.md
  ↓
/workflow:run specs/<task>-spec-to-design.md
  ↓
workflow 先提取项目经验和场景 checklist
  ↓
并行生成 backend design package
  ↓
用户查看 backend-design/review/25-open-questions.md
  ↓
/skill:backend-spec-refine specs/<task>-spec-to-design.md
  ↓
skill 根据用户回答 patch spec
  ↓
重新运行 spec-to-design workflow
  ↓
ready 后再生成 implementation workflow
```

`/workflow:compose` 可以继续作为“发现应该使用哪个 workflow/skill”的入口；但真正的补 spec 交互，第一版更适合放在 skill。

## 12. Readiness 语义

readiness 不等于 workflow status。

```text
Workflow status: completed
Readiness: yes / partial / no
```

示例：

```json
{
  "status": "completed",
  "readiness": "partial",
  "canImplementNow": [
    "US1: basic provider routing"
  ],
  "blockedBy": [
    "Q1: billing unit unclear",
    "Q2: retention policy unclear"
  ],
  "recommendedNextAction": "Ask user to answer open questions before implementation workflow."
}
```

这样可以避免把“发现问题”误判为失败。

## 13. 第一版实现建议

先做最小可用版本：

1. 新增 workflow template：

   ```text
   .pi/workflows/spec-to-design.workflow.json
   workflows/spec-to-design.workflow.json
   ```

2. 只支持 `backend-service`。
3. 使用固定 backend design package。
4. 后端设计面使用外层 DAG fan-out 节点并行执行，不默认塞进一个大 multi-agent cluster。
5. 增加 `project-experience-extraction` 和 `experience-capture` 两个经验节点。
6. 最终 sink node 是 `readiness-gate`，方便 inspect 按 `F` 打开最终 report。
7. 不新增命令。
8. `/workflow:create` 生成 spec；`/workflow:run <spec>` 执行。
9. `/workflow:compose` 后续再增强为“粗需求优先建议 spec-to-design”。

## 14. 后续扩展

后续可增加 project profiles：

```text
frontend-app
algorithm-ml
infra-platform
data-pipeline
mobile-app
library-sdk
cli-tool
```

每个 profile 有自己的 design package：

```text
frontend-design/
algorithm-design/
infra-design/
data-pipeline-design/
```

## 15. 待定问题

1. backend design package 是否应该固定所有文件都生成，还是只生成 applicable 文件？
   - 当前建议：结构固定，文件内写 applicability。

2. 是否要把 `speckit-compatible/` 作为必选输出？
   - 当前建议：第一版可以必选，成本低，方便验证 spec/plan/tasks。

3. `projectPath` 是否必须在 spec frontmatter？
   - 当前建议：最好必填；否则使用当前工作目录。

4. 是否要读取 `.specify/memory/constitution.md`？
   - 当前建议：如果存在则读取；不存在不阻塞。

5. 是否要支持用户多轮回答 open questions 后自动 patch spec？
   - 当前结论：不放在 workflow node 里做。workflow run 是后台执行，child agents 不能在 node 中途停下来向用户提问并等待回答。
   - 更合适的第一版方案：做一个 `backend-spec-refine` skill。skill 在主会话中读取 rough requirement、现有 spec、open questions 和项目经验文档，向用户追问，最后 patch/生成新版 spec。
   - skill 路径：`/Users/kl/.pi/agent/skills/backend-spec-refine/SKILL.md`。
   - workflow 只负责后台设计包生成、并行设计、artifact、verification 和 readiness。
   - 后续可能方向：增加 engine 级 `pending-user-input` run 状态；但这属于 workflow engine 能力扩展，不属于第一版 `spec-to-design`。
