---
title: FastAPI 跨域中间件 CORS 配置踩坑
tags: [fastapi, python, cors, bugfix]
date: 2026-09-15
---

# FastAPI 跨域中间件 CORS 配置踩坑

在生产环境下使用 FastAPI 的 `CORSMiddleware` 时，最常见的报错是浏览器控制台报：
`Access-Control-Allow-Origin cannot contain wildcard '*' when Access-Control-Allow-Credentials is true`.

### 核心原因
当前端请求设置了 `credentials: 'include'`（携带 Cookie 或 Authorization 头）时，后端不允许返回通配符 `*`，必须指定具体的来源域名。

### 正确配置代码
```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

origins = [
    "http://localhost:3000",
    "http://127.0.0.1:8080",
    "https://app.mydomain.com",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### 避坑点
1. 建议通过环境变量加载允许列表。
2. 永远不要同时设置 `allow_origins=["*"]` 和 `allow_credentials=True`。
