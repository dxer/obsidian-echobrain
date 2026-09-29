---
title: AI Agent 架构与 MCP 协议规范落地
tags: [agent, mcp, architecture, cursor]
date: 2026-09-20
---

# AI Agent 架构与 MCP 协议规范落地

模型上下文协议（Model Context Protocol, MCP）是由开放标准推进的通用架构，用于解耦大语言模型客户端与私有数据源。

### 核心传输通道
1. **stdio 管道**：适用于纯本地场景。Agent 作为子进程启动 MCP Server，直接通过标准输入输出交互。
2. **SSE / HTTP Stream**：适用于云端及桌面端内嵌服务。基于 [[FastAPI跨域与中间件配置]] 提供跨域流式支持。

### 核心工具定义
- `search_personal_memory`：检索个人知识库，依赖 [[PostgreSQL全文索引与pgvector调优]] 的混合检索策略。
- `save_insight`：外部写入收件箱
- `find_connections`：上下文环境回响
