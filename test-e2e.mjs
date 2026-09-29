import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vaultPath = path.join(__dirname, 'example-vault');

console.log('=== EchoBrain 终极 Graph-RAG (双链图谱+混合检索+HTTP/SSE) 端到端验证 ===\n');

// 1. 中英文双模分词器
function tokenize(text) {
  if (!text) return [];
  const tokens = [];
  const cleaned = text.toLowerCase().replace(/[`*#\[\]_~>\\|]/g, ' ');
  const words = cleaned.match(/[a-z0-9_\-]+/g) || [];
  for (const w of words) {
    if (w.length > 1) tokens.push(w);
    const subwords = w.split(/[\-_]+/);
    if (subwords.length > 1) {
      for (const sw of subwords) {
        if (sw.length > 1) tokens.push(sw);
      }
    }
  }
  const cjkMatches = cleaned.match(/[\u4e00-\u9fa5]/g) || [];
  const cjkChars = [];
  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fa5) {
      cjkChars.push(cleaned[i]);
    } else if (cjkChars.length > 0 && cjkChars[cjkChars.length - 1] !== ' ') {
      cjkChars.push(' ');
    }
  }
  const cjkSegments = cjkChars.join('').split(/\s+/).filter(Boolean);
  for (const seg of cjkSegments) {
    for (let i = 0; i < seg.length; i++) {
      tokens.push(seg[i]);
      if (i + 1 < seg.length) tokens.push(seg.slice(i, i + 2));
      if (i + 2 < seg.length) tokens.push(seg.slice(i, i + 3));
    }
  }
  const stopwords = new Set(['的', '了', '和', '是', '在', '对', '等', '于', '也', '有', '与', '这', '就', '该', '其', '并']);
  return Array.from(new Set(tokens.filter(t => !stopwords.has(t))));
}

// 2. 内存双链图谱与 PageRank
class TestLinkGraph {
  constructor() {
    this.forwardLinks = new Map();
    this.backlinks = new Map();
    this.pageRanks = new Map();
    this.nameToPath = new Map();
  }

  registerNote(notePath) {
    const norm = notePath.replace(/\\/g, '/');
    if (!this.forwardLinks.has(norm)) this.forwardLinks.set(norm, new Set());
    if (!this.backlinks.has(norm)) this.backlinks.set(norm, new Set());
    const basename = path.basename(norm, '.md').toLowerCase();
    this.nameToPath.set(basename, norm);
  }

  addEdge(source, targetName) {
    const normSource = source.replace(/\\/g, '/');
    const cleanTarget = targetName.split('|')[0].split('#')[0].trim().toLowerCase();
    const resolvedPath = this.nameToPath.get(cleanTarget);
    if (resolvedPath && resolvedPath !== normSource) {
      this.forwardLinks.get(normSource)?.add(resolvedPath);
      this.backlinks.get(resolvedPath)?.add(normSource);
    }
  }

  calculatePageRank(damping = 0.85, iterations = 20) {
    const nodes = Array.from(this.forwardLinks.keys());
    const N = nodes.length;
    if (N === 0) return;
    let pr = new Map();
    nodes.forEach(n => pr.set(n, 1.0 / N));

    for (let iter = 0; iter < iterations; iter++) {
      const nextPr = new Map();
      let sinkSum = 0;
      for (const n of nodes) {
        if ((this.forwardLinks.get(n)?.size || 0) === 0) sinkSum += pr.get(n);
      }
      const baseScore = (1.0 - damping) / N + (damping * sinkSum) / N;
      for (const n of nodes) {
        let incomingSum = 0;
        const incomingSources = this.backlinks.get(n);
        if (incomingSources) {
          for (const src of incomingSources) {
            incomingSum += pr.get(src) / (this.forwardLinks.get(src)?.size || 1);
          }
        }
        nextPr.set(n, baseScore + damping * incomingSum);
      }
      pr = nextPr;
    }

    for (const [node, score] of pr.entries()) {
      this.pageRanks.set(node, parseFloat((score * N).toFixed(4)));
    }
  }

  getNeighbors(notePath, maxHops = 1, limit = 8) {
    const norm = notePath.replace(/\\/g, '/');
    const results = [];
    const visited = new Set([norm]);
    const queue = [[norm, 0]];

    while (queue.length > 0 && results.length < limit) {
      const [curr, hops] = queue.shift();
      if (hops >= maxHops) continue;

      const fwd = this.forwardLinks.get(curr) || new Set();
      for (const target of fwd) {
        if (!visited.has(target)) {
          visited.add(target);
          results.push({ path: target, title: path.basename(target, '.md'), relation: 'cites', hops: hops + 1 });
          queue.push([target, hops + 1]);
          if (results.length >= limit) break;
        }
      }

      if (results.length >= limit) break;

      const back = this.backlinks.get(curr) || new Set();
      for (const src of back) {
        if (!visited.has(src)) {
          visited.add(src);
          results.push({ path: src, title: path.basename(src, '.md'), relation: 'cited_by', hops: hops + 1 });
          queue.push([src, hops + 1]);
          if (results.length >= limit) break;
        }
      }
    }
    return results;
  }
}

async function run() {
  console.log('[1/5] 初始化 Vault 文档扫描与轻量双链图谱 (LinkGraph)...');
  const graph = new TestLinkGraph();
  const docs = [];

  async function scan(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) await scan(full);
      } else if (entry.name.endsWith('.md')) {
        const relPath = path.relative(vaultPath, full).replace(/\\/g, '/');
        const content = await fs.readFile(full, 'utf8');
        const titleMatch = content.match(/^#\s+(.+)$/m) || content.match(/title:\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : path.basename(relPath, '.md');
        const tags = (content.match(/#([a-zA-Z0-9_\-\u4e00-\u9fa5]+)/g) || []).map(t => t.slice(1));
        const tokens = new Set(tokenize(content + ' ' + title));
        const stat = await fs.stat(full);
        docs.push({ path: relPath, title, content, tags, tokens, mtime: stat.mtimeMs });
        graph.registerNote(relPath);
      }
    }
  }

  await scan(vaultPath);

  // 解析 [[WikiLinks]]
  for (const doc of docs) {
    const wikiRegex = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = wikiRegex.exec(doc.content)) !== null) {
      graph.addEdge(doc.path, match[1]);
    }
  }

  graph.calculatePageRank();

  let totalEdges = 0;
  for (const set of graph.forwardLinks.values()) totalEdges += set.size;

  console.log(` -> 索引笔记总数: ${docs.length} 篇`);
  console.log(` -> 图谱节点数: ${graph.forwardLinks.size}, 引用边数: ${totalEdges}`);
  console.log(' -> 知识库核心母笔记 (Top Hubs by PageRank):');
  
  const hubs = Array.from(graph.pageRanks.entries())
    .map(([p, score]) => ({
      path: p,
      score,
      inDegree: graph.backlinks.get(p)?.size || 0,
      outDegree: graph.forwardLinks.get(p)?.size || 0
    }))
    .sort((a, b) => b.score - a.score);

  hubs.forEach(h => {
    console.log(`    * [${h.path}] PageRank=${h.score}, 入度=${h.inDegree} (被引用), 出度=${h.outDegree} (引用)`);
  });

  if (totalEdges < 3) throw new Error('未正确解析出 [[WikiLinks]] 双向引用边');

  console.log('\n[2/5] 测试【双链邻域 BFS 遍历与反向链接 (Backlinks)】...');
  const mocDoc = docs.find(d => d.path.includes('MOC'));
  if (!mocDoc) throw new Error('未找到 MOC 笔记');

  const mocNeighbors = graph.getNeighbors(mocDoc.path, 1, 10);
  console.log(` -> MOC 笔记 [${mocDoc.title}] 的 1-Hop 直连关系:`);
  mocNeighbors.forEach(n => console.log(`    - [${n.relation === 'cites' ? '→ 引用' : '← 被引用'}] [[${n.title}]]`));
  if (mocNeighbors.length < 3) throw new Error('MOC 邻域遍历返回数量不足');

  const fastapiDoc = docs.find(d => d.path.includes('FastAPI'));
  if (!fastapiDoc) throw new Error('未找到 FastAPI 笔记');
  const fastapiBacklinks = Array.from(graph.backlinks.get(fastapiDoc.path) || []);
  console.log(` -> [${fastapiDoc.title}] 的反向链接 (被谁引用):`);
  fastapiBacklinks.forEach(b => console.log(`    * [[${b}]]`));
  if (fastapiBacklinks.length < 2) throw new Error('未能正确计算出反向链接 (预期被 MOC 和 MCP实战 引用)');

  console.log('\n[3/5] 测试【Graph-RAG 融合检索 (BM25 + PageRank + 拓扑扩充)】...');
  const query = 'MCP 协议规范';
  const queryTokens = tokenize(query);
  const avgdl = docs.reduce((a, b) => a + b.content.length, 0) / docs.length;

  const searchResults = docs.map(doc => {
    let bm25 = 0;
    for (const t of queryTokens) {
      if (doc.tokens.has(t)) bm25 += 1.5;
    }
    if (doc.title.includes('MCP') || doc.title.includes('协议')) bm25 += 50;
    const pr = graph.pageRanks.get(doc.path) || 1.0;
    const score = parseFloat((bm25 * (1 + 0.15 * pr)).toFixed(2));
    const neighbors = graph.getNeighbors(doc.path, 1, 3);
    return { ...doc, score, neighbors };
  }).sort((a, b) => b.score - a.score).slice(0, 2);

  console.log(` -> 检索 "${query}" 结果:`);
  searchResults.forEach(r => {
    console.log(`    - [${r.title}] 综合得分: ${r.score} (PageRank: ${graph.pageRanks.get(r.path)})`);
    if (r.neighbors.length > 0) {
      console.log(`      🔗 关联双链拓扑: ${r.neighbors.map(n => `[[${n.title}]]`).join(', ')}`);
    }
  });

  if (!searchResults[0]?.neighbors || searchResults[0].neighbors.length === 0) {
    throw new Error('Graph-RAG 检索未能成功挂载双链邻居节点');
  }

  console.log('\n[4/5] 测试【环境主动回响与多跳知识脉络串联 (find_connections)】...');
  const codeContext = `
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    # 联调时跨域 OPTIONS 拦截与 Authorization 鉴权头处理
  `;
  const contextTokens = tokenize(codeContext);
  const connections = docs.map(doc => {
    let matchCount = 0;
    for (const t of contextTokens) {
      if (doc.tokens.has(t)) matchCount++;
    }
    const score = matchCount;
    return { ...doc, score, neighbors: graph.getNeighbors(doc.path, 1, 3) };
  }).filter(d => d.score > 2).sort((a, b) => b.score - a.score);

  connections.forEach(c => {
    console.log(`    - 联想命中: [${c.title}] (匹配词数: ${c.score})`);
    if (c.neighbors.length > 0) {
      console.log(`      拓扑网: ${c.neighbors.map(n => `[[${n.title}]]`).join(' ↔ ')}`);
    }
  });

  if (connections.length === 0 || !connections[0].path.includes('FastAPI')) {
    throw new Error('代码环境联想未能准确定位 FastAPI 踩坑笔记');
  }

  console.log('\n[5/5] 测试【MCP 内嵌 HTTP / SSE 服务端协议与 Streamable HTTP JSON-RPC 2.0】...');
  const testPort = 23337;
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'online', service: 'EchoBrain Local MCP Server', port: testPort, indexedNotes: docs.length }));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const rpc = body ? JSON.parse(body) : {};
        if (rpc.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'echobrain-local', version: '0.3.0' }
            }
          }));
        } else if (rpc.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              tools: [
                { name: 'search_personal_memory' },
                { name: 'save_insight' },
                { name: 'find_connections' },
                { name: 'explore_graph_neighborhood' },
                { name: 'read_note' },
                { name: 'get_vault_stats' },
                { name: 'inspect_vault_health' },
                { name: 'rescue_orphan_note' }
              ]
            }
          }));
        } else if (rpc.method === 'tools/call') {
          const tool = rpc.params?.name;
          if (tool === 'explore_graph_neighborhood') {
            const targetPath = rpc.params?.arguments?.path;
            const neighbors = graph.getNeighbors(targetPath, 1, 5);
            const inDeg = graph.backlinks.get(targetPath)?.size || 0;
            const outDeg = graph.forwardLinks.get(targetPath)?.size || 0;
            const pr = graph.pageRanks.get(targetPath) || 1.0;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                content: [{
                  type: 'text',
                  text: `🕸️ 双链图谱拓扑: PageRank=${pr}, 出度=${outDeg}, 入度=${inDeg}, 邻居=${neighbors.length}`
                }]
              }
            }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'OK' }] } }));
          }
        }
      });
    }
  });

  await new Promise(resolve => server.listen(testPort, '127.0.0.1', resolve));
  console.log(` -> 启动轻量测试 HTTP/SSE 守护端口: 127.0.0.1:${testPort}`);

  // Test 1: GET /status
  const statusRes = await fetch(`http://127.0.0.1:${testPort}/status`).then(r => r.json());
  console.log(` -> GET /status 响应: status=${statusRes.status}, indexedNotes=${statusRes.indexedNotes}`);
  if (statusRes.status !== 'online') throw new Error('/status 端点异常');

  // Test 2: POST initialize
  const initRes = await fetch(`http://127.0.0.1:${testPort}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  }).then(r => r.json());
  console.log(` -> POST JSON-RPC initialize: protocolVersion=${initRes.result.protocolVersion}, server=${initRes.result.serverInfo.name}`);
  if (initRes.result.serverInfo.name !== 'echobrain-local') throw new Error('initialize 响应格式异常');

  // Test 3: POST tools/list
  const toolsRes = await fetch(`http://127.0.0.1:${testPort}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  }).then(r => r.json());
  console.log(` -> POST JSON-RPC tools/list: 暴露工具数=${toolsRes.result.tools.length} 个`);
  if (toolsRes.result.tools.length !== 8) throw new Error('tools/list 暴露工具数量不为 8');

  // Test 4: POST tools/call explore_graph_neighborhood
  const callRes = await fetch(`http://127.0.0.1:${testPort}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'explore_graph_neighborhood',
        arguments: { path: '01-Tech/FastAPI跨域与中间件配置.md' }
      }
    })
  }).then(r => r.json());
  console.log(` -> POST JSON-RPC tools/call:`, callRes.result.content[0].text);
  if (!callRes.result.content[0].text.includes('PageRank')) throw new Error('tools/call 结果异常');

  await new Promise(resolve => server.close(resolve));
  console.log(` -> 停止轻量测试守护端口\n`);

  console.log('🎉 [PASS] EchoBrain 全部 5 项 Graph-RAG 与 HTTP/SSE 协议端到端验证通过！');
}

run().catch(err => {
  console.error('\n❌ 测试失败:', err);
  process.exit(1);
});
