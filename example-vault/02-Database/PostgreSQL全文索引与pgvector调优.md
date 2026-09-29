---
title: PostgreSQL 全文索引与 pgvector 向量调优
tags: [database, postgres, vector, rag]
date: 2026-09-10
---

# PostgreSQL 全文索引与 pgvector 向量调优

在构建个人知识库或 RAG 系统时，单纯依靠向量检索（Vector Search）常常会在精准专有名词、错误代码和缩写上失真。最佳方案是构建混合检索（Hybrid Search）。

### 混合检索与 RRF 融合
通过 Reciprocal Rank Fusion (RRF) 将 BM25 倒排索引得分与 Cosine 向量距离得分加权归一化：
`Score = alpha * VectorScore + beta * BM25Score + gamma * TimeDecay`

### pgvector 索引选择
- **HNSW (Hierarchical Navigable Small World)**：召回率极高，适合毫秒级响应。
- **IVFFlat**：建索引快，适合超大规模聚类。
对于个人知识库规模，HNSW 是理想选择。
