# Agent Note: 私有 workspace 应用

Status: implemented

[English](2026-08-19-private-workspace-applications.md) | 中文

## Problem

workspace 在 `apps/` 下包含产品程序集，但并非所有应用都是由 DeepSeek 发布序列发布的 npm 产品。将每个应用清单都视为发布成员，会强制内部应用采用官方包名、仓库元数据、公开访问级别和全仓统一发布版本。

## Decision

位于 `apps/<name>`、设置 `private: true` 且包名不属于 `@deepseek-ai/*` 的清单是私有 workspace 应用。它参与依赖安装和仓库检查，但不进入 npm 发布族发现结果。

共享的 `isPrivateWorkspaceApplication()` 判定函数统一负责此分类。workspace 约束对这些应用执行普通私有包要求。官方 `@deepseek-ai/*` 应用仍是发布成员，即使意外设置了 `private: true`，发布检查也会报告无效清单，而不会静默漏掉该应用。

## Alternatives considered

**发布所有应用。** 这会让内部产品程序集进入官方 npm 发布流程，并使其版本和仓库元数据与 Harness 发行版耦合。

**维护目录白名单。** 每增加一个内部应用都需要修改工具配置，而且白名单可能与已经声明发布意图的清单发生偏离。

**排除所有私有清单。** 官方发布成员意外设置 `private` 字段时，会从发布结果中消失。

## Consequences

私有应用可以位于根 workspace 并使用统一依赖管理，同时不会成为可发布制品。非作用域包名将其与官方发布应用区分开。约束检查和发布族测试同时固定私有应用排除规则以及官方应用必须保持可发布的要求。
