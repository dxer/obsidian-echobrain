import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { VaultEngine } from './engine.js';
import { ActivityLogItem, EchoBrainPluginSettings } from './types.js';

interface ClientSession {
  sessionId: string;
  transport: SSEServerTransport;
  mcpServer: Server;
  clientName: string;
  createdAt: number;
}

export class EmbeddedMcpServer {
  private settings: EchoBrainPluginSettings;
  private port: number;
  private engine: VaultEngine;
  private httpServer: http.Server | null = null;
  private sessions: Map<string, ClientSession> = new Map();
  private isRunning: boolean = false;
  private onActivityLog: ((item: ActivityLogItem) => void) | null = null;

  constructor(settings: EchoBrainPluginSettings, engine: VaultEngine) {
    this.settings = settings;
    this.port = settings.port;
    this.engine = engine;
  }

  public updateSettings(settings: EchoBrainPluginSettings) {
    this.settings = settings;
    this.port = settings.port;
  }

  public validateAuth(req: http.IncomingMessage, url: URL): boolean {
    if (!this.settings.enableAuth || !this.settings.authToken) {
      return true;
    }
    const authHeader = String(req.headers['authorization'] || '');
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const tokenFromHeader = bearerMatch ? bearerMatch[1].trim() : '';
    const tokenFromQuery = url.searchParams.get('token') || '';

    return tokenFromHeader === this.settings.authToken || tokenFromQuery === this.settings.authToken;
  }

  public setActivityLogger(logger: (item: ActivityLogItem) => void) {
    this.onActivityLog = logger;
  }

  public getPort(): number {
    return this.port;
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getConnectedClientsCount(): number {
    return this.sessions.size;
  }

  private logActivity(agentClient: string, tool: string, summary: string, status: 'success' | 'error') {
    if (this.onActivityLog) {
      this.onActivityLog({
        id: Math.random().toString(36).slice(2, 9),
        timestamp: Date.now(),
        agentClient,
        tool,
        summary,
        status
      });
    }
  }

  public getToolDefinitions(): Tool[] {
    return [
      {
        name: 'search_personal_memory',
        description: 'Search personal notes, snippets, and verified knowledge in Obsidian vault with BM25 + PageRank + Dual-link expansion.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keywords or query' },
            mode: { type: 'string', enum: ['hybrid', 'bm25', 'semantic'], description: 'Search mode: hybrid (BM25 + Semantic, default), bm25, or semantic' },
            time_filter: { type: 'string', enum: ['all', 'recent_month', 'recent_year'], default: 'all' },
            limit: { type: 'integer', default: 5 },
            expand_graph_hops: { type: 'integer', default: 1 }
          },
          required: ['query']
        }
      },
      {
        name: 'save_insight',
        description: 'Save important insight or code solution directly to Obsidian Inbox without overwriting existing files.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Note title' },
            content: { type: 'string', description: 'Markdown note body' },
            tags: { type: 'array', items: { type: 'string' } },
            category: { type: 'string' }
          },
          required: ['title', 'content']
        }
      },
      {
        name: 'find_connections',
        description: 'Ambient proactive recall: Find related past notes, bi-directional links, and concepts based on current context or active note path.',
        inputSchema: {
          type: 'object',
          properties: {
            current_context: { type: 'string', description: 'Current code block, paragraph, or active editor text' },
            active_path: { type: 'string', description: 'Optional relative path of active note in vault (e.g. "01-Tech/FastAPI.md")' },
            limit: { type: 'integer', default: 3 },
            expand_graph_hops: { type: 'integer', default: 1 }
          }
        }
      },
      {
        name: 'explore_graph_neighborhood',
        description: 'Explore the bi-directional link graph around a note (cites, cited_by, PageRank score).',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path of note in vault' },
            max_hops: { type: 'integer', default: 1 },
            limit: { type: 'integer', default: 8 }
          },
          required: ['path']
        }
      },
      {
        name: 'read_note',
        description: 'Read the full markdown content and frontmatter of a specific note by path.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative note path (e.g. "01-Tech/FastAPI.md")' }
          },
          required: ['path']
        }
      },
      {
        name: 'get_vault_stats',
        description: 'Get total notes count, unique tags, and top hub notes by PageRank.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'inspect_vault_health',
        description: 'Inspect vault health: count isolated orphan notes and detect broken WikiLinks.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'rescue_orphan_note',
        description: 'Find intelligent linking targets to rescue an orphan note and weave it into the knowledge graph.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path of orphan note in vault' },
            auto_connect: { type: 'boolean', description: 'Whether to automatically append link into the note', default: false }
          },
          required: ['path']
        }
      }
    ];
  }

  public getResourceDefinitions() {
    return [
      {
        uri: 'obsidian://vault/stats',
        name: 'Knowledge Vault Stats',
        description: 'Real-time overview of indexed notes, tags, and top PageRank hubs in Obsidian',
        mimeType: 'text/markdown'
      },
      {
        uri: 'obsidian://vault/top-hubs',
        name: 'Core Knowledge Hubs (MOCs)',
        description: 'Top central concept notes and Maps of Content ranked by PageRank',
        mimeType: 'text/markdown'
      },
      {
        uri: 'obsidian://vault/inbox',
        name: 'Recent Inbox Insights',
        description: 'Latest precipitated insights and agent notes in the Inbox folder',
        mimeType: 'text/markdown'
      }
    ];
  }

  public readResource(uri: string): { contents: { uri: string; mimeType: string; text: string }[] } {
    if (uri === 'obsidian://vault/stats') {
      const stats = this.engine.getStats();
      const text = `# Obsidian Vault Overview\n- **Total Notes**: ${stats.totalNotes}\n- **Total Tags**: ${stats.totalTags}\n- **Indexed Vectors**: ${stats.vectorsIndexed}\n- **Embedding Ready**: ${stats.embeddingAvailable}`;
      return { contents: [{ uri, mimeType: 'text/markdown', text }] };
    }
    if (uri === 'obsidian://vault/top-hubs') {
      const stats = this.engine.getStats();
      const hubsText = stats.topHubs.map((h, i) => `${i + 1}. [[${h.title}]] (PageRank: ${h.pageRank}, Citations: ${h.inDegree})`).join('\n');
      return { contents: [{ uri, mimeType: 'text/markdown', text: `# Top Core Hubs (MOCs)\n\n${hubsText}` }] };
    }
    if (uri === 'obsidian://vault/inbox') {
      const text = `# Obsidian Inbox\nUse tool \`search_personal_memory\` to query recent insights.`;
      return { contents: [{ uri, mimeType: 'text/markdown', text }] };
    }
    throw new Error(`Resource not found: ${uri}`);
  }

  public getPromptDefinitions() {
    return [
      {
        name: 'distill_to_obsidian',
        description: 'Distill the current conversation into a clean, atomic technical note with [[WikiLinks]] ready for Obsidian',
        arguments: [
          { name: 'topic', description: 'Core topic of the note', required: true }
        ]
      },
      {
        name: 'review_code_with_vault',
        description: 'Review code using past experiences, pitfalls, and architectural standards stored in your personal vault',
        arguments: [
          { name: 'code_context', description: 'Code snippet to review', required: true }
        ]
      }
    ];
  }

  public getPrompt(name: string, args: any) {
    if (name === 'distill_to_obsidian') {
      const topic = String(args?.topic || '技术方案');
      return {
        description: `Distill conversation into a structured ${topic} note`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `请提炼我们刚才讨论中关于【${topic}】的核心结论、代码设计方案与避坑经验，生成符合 Obsidian 双链规范的 Markdown 笔记，包含：核心结论、代码示例、关键注意事项。生成完毕后建议调用 save_insight 工具将其保存到 Obsidian 知识库。`
            }
          }
        ]
      };
    }
    if (name === 'review_code_with_vault') {
      const code = String(args?.code_context || '');
      return {
        description: 'Review code using Obsidian personal knowledge',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `请首先调用 find_connections 或 search_personal_memory 工具，检索我个人知识库中关于以下代码涉及的技术栈的历史踩坑手记与设计模式，然后结合我的历史笔记经验进行深度代码审查：\n\n\`\`\`\n${code}\n\`\`\``
            }
          }
        ]
      };
    }
    throw new Error(`Prompt not found: ${name}`);
  }

  public async executeTool(name: string, args: any, clientName: string): Promise<{ content: any[]; isError?: boolean }> {
    try {
      switch (name) {
        case 'search_personal_memory': {
          const query = String(args?.query || '');
          const mode = args?.mode ? String(args.mode) : undefined;
          const timeFilter = String(args?.time_filter || 'all');
          const limit = Number(args?.limit) || 5;
          const expandGraphHops = Number(args?.expand_graph_hops) || 1;

          const results = await this.engine.search({ query, mode, timeFilter, limit, expandGraphHops });
          this.logActivity(clientName, 'search_personal_memory', `检索: "${query}" (命中 ${results.length} 篇)`, 'success');

          if (results.length === 0) {
            return { content: [{ type: 'text', text: `在个人知识库中未找到与 "${query}" 相关的笔记。` }] };
          }

          const formatted = results.map((r, i) => {
            const tagsStr = r.tags.length > 0 ? ` [标签: #${r.tags.join(' #')}]` : '';
            let graphStr = '';
            if (r.graphNeighbors && r.graphNeighbors.length > 0) {
              graphStr = `\n- **🔗 双链关联**: ` + r.graphNeighbors.map(n => `[[${n.title}]]`).join(', ');
            }
            const semanticBadge = r.semanticSimilarity !== undefined
              ? ` (语义相似度: ${(r.semanticSimilarity * 100).toFixed(0)}%)`
              : '';
            const matchType = r.bm25Rank && r.vectorRank
              ? '双引擎混合命中'
              : r.vectorRank
              ? '语义向量命中'
              : '关键词字面命中';
            return `### ${i + 1}. 📄 [${r.title}](${r.path})\n- **匹配机制**: ${matchType}${semanticBadge} | 综合得分: ${r.score} (PageRank: ${r.pageRank || 1.0})\n- **路径**: \`${r.path}\`${tagsStr}${graphStr}\n- **核心摘录**:\n> ${r.snippet.replace(/\n/g, '\n> ')}\n`;
          }).join('\n---\n\n');

          return { content: [{ type: 'text', text: `🔍 知识库检索结果（共匹配 ${results.length} 篇）:\n\n${formatted}` }] };
        }

        case 'save_insight': {
          const title = String(args?.title || '').trim();
          const content = String(args?.content || '').trim();
          const tags = Array.isArray(args?.tags) ? args.tags.map(String) : [];
          const category = args?.category ? String(args.category) : undefined;

          const { filePath: createdPath, connectedNotes } = await this.engine.saveInsight({ title, content, tags, category });
          const weaveMsg = connectedNotes.length > 0
            ? `\n🕸️ **知识自动织网**: 已自动挂载至既有知识节点: ${connectedNotes.map(n => `[[${n}]]`).join(', ')}`
            : '';
          this.logActivity(clientName, 'save_insight', `写入灵感: "${title}" -> ${createdPath}`, 'success');

          return {
            content: [
              {
                type: 'text',
                text: `✅ 灵感已保存到 Obsidian: \`${createdPath}\`，并已实时建立索引！${weaveMsg}`
              }
            ]
          };
        }

        case 'find_connections': {
          const currentContext = String(args?.current_context || args?.context || '');
          const activePath = (args?.active_path || args?.path) ? String(args.active_path || args.path).trim() : undefined;
          const limit = Number(args?.limit) || 3;
          const expandGraphHops = Number(args?.expand_graph_hops) || 1;

          const connections = await this.engine.findConnections({ currentContext, activePath, limit, expandGraphHops });
          this.logActivity(clientName, 'find_connections', `灵感回响: 找到 ${connections.length} 条关联经验`, 'success');

          if (connections.length === 0) {
            return { content: [{ type: 'text', text: '当前上下文中未发现与个人知识库历史笔记的明显关联。' }] };
          }

          const formatted = connections.map((c, i) => {
            let net = '';
            if (c.graphNeighbors && c.graphNeighbors.length > 0) {
              net = `\n- **🔗 联想知识网**: ` + c.graphNeighbors.map(n => `[[${n.title}]]`).join(' ↔ ');
            }
            return `### 💡 关联 ${i + 1}: [${c.title}](${c.path})\n- **关联原因**: ${c.connectionReason || '概念强相关'}\n- **最近修改**: ${new Date(c.mtime).toISOString().slice(0, 10)}${net}\n- **参考摘要**:\n> ${c.snippet.replace(/\n/g, '\n> ')}\n`;
          }).join('\n');

          return { content: [{ type: 'text', text: `🧠 灵感回响（找到 ${connections.length} 条关联经验）:\n\n${formatted}` }] };
        }

        case 'explore_graph_neighborhood': {
          const notePath = String(args?.path || '').trim();
          const maxHops = Math.min(2, Math.max(1, Number(args?.max_hops) || 1));
          const limit = Number(args?.limit) || 8;

          const doc = this.engine.getDocument(notePath);
          if (!doc) {
            return { content: [{ type: 'text', text: `未找到路径为 ${notePath} 的笔记。` }], isError: true };
          }

          const neighbors = this.engine.getNeighbors(notePath, maxHops, limit);
          const { forwardLinks, backlinks } = this.engine.getLinkDetails(notePath);
          this.logActivity(clientName, 'explore_graph_neighborhood', `探索双链: "${doc.title}" (邻接 ${neighbors.length} 个节点)`, 'success');

          const neighborText = neighbors.length > 0
            ? neighbors.map(n => `- **${n.relation === 'cited_by' ? '← 被引用' : '→ 引用'}**: [${n.title}](${n.path})`).join('\n')
            : '（暂无直接双链邻居）';

          return {
            content: [
              {
                type: 'text',
                text: `🕸️ **[${doc.title}] 双链图谱拓扑**:\n- **PageRank 权重**: ${doc.pageRank}\n- **拓扑连接**: 出度 ${forwardLinks.length} (引用), 入度 ${backlinks.length} (被引用)\n- **路径**: \`${doc.path}\`\n\n### 🔗 邻接拓扑:\n${neighborText}`
              }
            ]
          };
        }

        case 'read_note': {
          const notePath = String(args?.path || '').trim();
          const doc = this.engine.getDocument(notePath);
          if (!doc) {
            return { content: [{ type: 'text', text: `未找到笔记: ${notePath}` }], isError: true };
          }

          this.logActivity(clientName, 'read_note', `阅读笔记: "${doc.title}"`, 'success');
          const { forwardLinks, backlinks } = this.engine.getLinkDetails(notePath);
          const linksSection: string[] = [];
          if (forwardLinks.length > 0) linksSection.push(`- **引用外部笔记**: ` + forwardLinks.map(l => `[[${l}]]`).join(', '));
          if (backlinks.length > 0) linksSection.push(`- **被引用的反向链接**: ` + backlinks.map(l => `[[${l}]]`).join(', '));
          const metaStr = linksSection.length > 0 ? `\n${linksSection.join('\n')}` : '';

          return {
            content: [
              {
                type: 'text',
                text: `# ${doc.title}\n- **路径**: \`${doc.path}\`\n- **标签**: ${doc.tags.join(', ') || '无'}${metaStr}\n\n---\n\n${doc.content}`
              }
            ]
          };
        }

        case 'get_vault_stats': {
          const stats = this.engine.getStats();
          this.logActivity(clientName, 'get_vault_stats', '获取知识库统计', 'success');

          const hubStr = stats.topHubs.map(h => `- 🌟 [${h.title}] (PageRank: ${h.pageRank}, 被引用: ${h.inDegree}次)`).join('\n');
          const embStatus = stats.embeddingAvailable
            ? `🟢 已就绪 (已生成向量 ${stats.vectorsIndexed} 篇)`
            : '⚪ 未启用 (纯BM25模式)';

          return {
            content: [
              {
                type: 'text',
                text: `📊 **EchoBrain 知识库概况**:\n- **总笔记数**: ${stats.totalNotes} 篇\n- **总标签数**: ${stats.totalTags} 个\n- **向量引擎状态**: ${embStatus}\n\n### 🏆 核心母笔记 (Top Hubs):\n${hubStr}`
              }
            ]
          };
        }

        case 'inspect_vault_health': {
          const health = this.engine.getVaultHealth();
          this.logActivity(clientName, 'inspect_vault_health', `知识库体检: 孤岛 ${health.orphanCount} 篇, 死链 ${health.brokenLinksCount} 条`, 'success');

          const orphanList = health.orphans.slice(0, 8).map(o => `- 🏝️ [${o.title}](\`${o.path}\`)`).join('\n') || '（无孤岛笔记，知识网络连接紧密）';
          const brokenList = health.brokenLinks.slice(0, 8).map(b => `- ⚠️ \`${b.sourcePath}\` -> [[${b.link}]]`).join('\n') || '（无死链）';

          return {
            content: [
              {
                type: 'text',
                text: `🩺 **EchoBrain 知识库健康体检报告**:\n- **总笔记数**: ${health.totalNotes} 篇\n- **孤岛笔记 (零引用/零被引用)**: ${health.orphanCount} 篇\n- **死链 (指向不存在文档)**: ${health.brokenLinksCount} 条\n\n### 🏝️ 待拯救孤岛笔记 (Top 8):\n${orphanList}\n\n### 🔗 破损死链清单 (Top 8):\n${brokenList}`
              }
            ]
          };
        }

        case 'rescue_orphan_note': {
          const notePath = String(args?.path || '').trim();
          const autoConnect = Boolean(args?.auto_connect);
          const rescue = await this.engine.rescueOrphanNote(notePath, 3);
          if (!rescue) {
            return { content: [{ type: 'text', text: `未找到路径为 ${notePath} 的笔记。` }], isError: true };
          }

          this.logActivity(clientName, 'rescue_orphan_note', `解救孤岛: "${rescue.orphan.title}" (匹配 ${rescue.suggestedTargets.length} 个目标)`, 'success');

          let autoConnectMsg = '';
          if (autoConnect && rescue.suggestedTargets.length > 0) {
            const topTarget = rescue.suggestedTargets[0].title;
            const connected = await this.engine.connectNotes(notePath, topTarget);
            if (connected) {
              autoConnectMsg = `\n\n✅ 已自动将连接写入文档: \`[[${topTarget}]]\``;
            }
          }

          const targetList = rescue.suggestedTargets.length > 0
            ? rescue.suggestedTargets.map(t => `- 🔗 **[[${t.title}]]** (\`${t.path}\`) - 关联原因: ${t.connectionReason || '高度共鸣'}`).join('\n')
            : '（未找到明显相关的建议目标）';

          return {
            content: [
              {
                type: 'text',
                text: `🕸️ **孤岛笔记 [${rescue.orphan.title}] 解救建议**:\n- **路径**: \`${rescue.orphan.path}\`\n\n### 🎯 推荐挂靠知识节点:\n${targetList}${autoConnectMsg}`
              }
            ]
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err: any) {
      this.logActivity(clientName, name, `调用失败: ${err.message}`, 'error');
      return { content: [{ type: 'text', text: `Tool error: ${err.message}` }], isError: true };
    }
  }

  /**
   * Start the HTTP & SSE server with universal protocol support (Streamable HTTP + Classic SSE)
   */
  public async start(port?: number): Promise<boolean> {
    if (this.isRunning) return true;
    if (port) this.port = port;

    return new Promise((resolve) => {
      this.httpServer = http.createServer(async (req, res) => {
        // Universal CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const acceptHeader = req.headers.accept || '';

        // 1. Health / status endpoint
        if (pathname === '/health' || pathname === '/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const stats = this.engine.getStats();
          res.end(JSON.stringify({
            status: 'online',
            service: 'EchoBrain Local MCP Server',
            port: this.port,
            connectedClients: this.sessions.size,
            indexedNotes: stats.totalNotes
          }));
          return;
        }

        // Validate Local Bearer Token if auth is enabled
        if (!this.validateAuth(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32002, message: 'Unauthorized: Invalid or missing Bearer token' }
          }));
          return;
        }

        // 2. Direct JSON-RPC POST handling (Streamable HTTP, used by Cursor / direct HTTP clients)
        if (req.method === 'POST') {
          let rawBody = '';
          const maxBodyBytes = 10 * 1024 * 1024; // 10MB safety limit
          let exceeded = false;
          req.on('data', chunk => {
            rawBody += chunk;
            if (rawBody.length > maxBodyBytes) {
              exceeded = true;
              req.destroy();
            }
          });
          req.on('end', async () => {
            if (exceeded) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Payload Too Large' } }));
              return;
            }
            const sessionId = url.searchParams.get('sessionId');
            const userAgent = req.headers['user-agent'] || 'Unknown Agent';
            const clientName = userAgent.includes('Cursor')
              ? 'Cursor'
              : userAgent.includes('Claude')
              ? 'Claude Desktop'
              : 'AI Agent';

            // If this is a POST to an established SSE session
            if (sessionId) {
              if (this.sessions.has(sessionId)) {
                try {
                  const session = this.sessions.get(sessionId)!;
                  let parsedBody: any = undefined;
                  if (rawBody && rawBody.trim()) {
                    try {
                      parsedBody = JSON.parse(rawBody);
                    } catch {
                      res.writeHead(400, { 'Content-Type': 'application/json' });
                      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
                      return;
                    }
                  }
                  await session.transport.handlePostMessage(req, res, parsedBody);
                  return;
                } catch (err: any) {
                  console.error('[EchoBrain SSE] Session error:', err);
                  if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err.message } }));
                  }
                  return;
                }
              } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'SSE session not found or expired' } }));
                return;
              }
            }

            if (pathname === '/message' && !sessionId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing sessionId parameter' } }));
              return;
            }

            // Otherwise, handle as Direct Streamable HTTP JSON-RPC 2.0
            try {
              const rpc = rawBody ? JSON.parse(rawBody) : null;
              if (rpc && rpc.jsonrpc === '2.0') {
                const id = rpc.id;
                const method = rpc.method;

                if (method === 'initialize') {
                  this.logActivity(clientName, 'initialize', 'Agent 握手成功 (Streamable HTTP 模式)', 'success');
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    result: {
                      protocolVersion: '2024-11-05',
                      capabilities: {
                        tools: {},
                        resources: {},
                        prompts: {}
                      },
                      serverInfo: { name: 'echobrain-local', version: '0.3.0' }
                    }
                  }));
                  return;
                }

                if (method === 'notifications/initialized') {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ jsonrpc: '2.0' }));
                  return;
                }

                if (method === 'tools/list') {
                  const tools = this.getToolDefinitions();
                  this.logActivity(clientName, 'tools/list', `上报 ${tools.length} 个 MCP 工具`, 'success');
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    result: { tools }
                  }));
                  return;
                }

                if (method === 'tools/call') {
                  const toolName = rpc.params?.name;
                  const toolArgs = rpc.params?.arguments || {};
                  const toolResult = await this.executeTool(toolName, toolArgs, clientName);

                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    result: toolResult
                  }));
                  return;
                }

                if (method === 'resources/list') {
                  const resources = this.getResourceDefinitions();
                  this.logActivity(clientName, 'resources/list', `上报 ${resources.length} 个 MCP 资源`, 'success');
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { resources } }));
                  return;
                }

                if (method === 'resources/read') {
                  const uri = rpc.params?.uri;
                  const resContent = this.readResource(uri);
                  this.logActivity(clientName, 'resources/read', `读取资源: ${uri}`, 'success');
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ jsonrpc: '2.0', id, result: resContent }));
                  return;
                }

                if (method === 'prompts/list') {
                  const prompts = this.getPromptDefinitions();
                  this.logActivity(clientName, 'prompts/list', `上报 ${prompts.length} 个 MCP 提示词模板`, 'success');
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { prompts } }));
                  return;
                }

                if (method === 'prompts/get') {
                  const pName = rpc.params?.name;
                  const pArgs = rpc.params?.arguments || {};
                  const promptResult = this.getPrompt(pName, pArgs);
                  this.logActivity(clientName, 'prompts/get', `调取模板: ${pName}`, 'success');
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ jsonrpc: '2.0', id, result: promptResult }));
                  return;
                }

                // Generic empty result for other methods
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
                return;
              }
            } catch (err: any) {
              console.error('[EchoBrain HTTP] JSON-RPC parse error:', err);
            }

            // Fallback for non-JSON or unmatched POST
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          });
          return;
        }

        // 3. SSE handshake: GET /sse or GET / with event-stream
        const isSseRequest = req.method === 'GET' && (
          pathname === '/sse' ||
          pathname === '/' ||
          acceptHeader.includes('text/event-stream')
        );

        if (isSseRequest) {
          try {
            const transport = new SSEServerTransport('/message', res);
            const sessionId = transport.sessionId;
            const userAgent = req.headers['user-agent'] || 'Unknown Agent';
            const clientName = userAgent.includes('Cursor')
              ? 'Cursor'
              : userAgent.includes('Claude')
              ? 'Claude Desktop'
              : 'AI Agent';

            const mcpServer = this.createMcpServerInstance(clientName);
            const session: ClientSession = {
              sessionId,
              transport,
              mcpServer,
              clientName,
              createdAt: Date.now()
            };
            this.sessions.set(sessionId, session);

            this.logActivity(clientName, 'SSE 连接建立', `客户端会话就绪 (Session: ${sessionId.slice(0, 8)})`, 'success');

            transport.onclose = () => {
              this.sessions.delete(sessionId);
              this.logActivity(clientName, 'SSE 连接断开', `会话结束 (Session: ${sessionId.slice(0, 8)})`, 'success');
            };

            await mcpServer.connect(transport);
          } catch (err: any) {
            console.error('[EchoBrain SSE] Error in SSE handshake:', err);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'text/plain' });
              res.end(`SSE Connection Error: ${err.message}`);
            }
          }
          return;
        }

        // 4. Default informational page for web browser
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8" />
              <title>EchoBrain MCP Service</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 50px auto; padding: 24px; color: #24292f; background: #fafbfc; }
                .card { background: #ffffff; border: 1px solid #d0d7de; border-radius: 6px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
                h2 { margin-top: 0; font-size: 1.25rem; font-weight: 600; border-bottom: 1px solid #d0d7de; padding-bottom: 10px; }
                .status { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; background: #dafbe1; color: #1a7f37; }
                pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px; font-size: 0.875rem; overflow-x: auto; }
                .meta { font-size: 0.875rem; color: #57606a; margin: 8px 0; }
              </style>
            </head>
            <body>
              <div class="card">
                <h2>EchoBrain Local MCP Service</h2>
                <p>Status: <span class="status">Running (Port ${this.port})</span></p>
                <p class="meta">Protocol: Model Context Protocol (Streamable HTTP / SSE)</p>
                <p class="meta">Active Connections: ${this.sessions.size}</p>
                <hr style="border: 0; border-top: 1px solid #d0d7de; margin: 16px 0;" />
                <p class="meta">Endpoint Configuration for Cursor / Claude Desktop:</p>
                <pre>http://127.0.0.1:${this.port}/sse</pre>
              </div>
            </body>
          </html>
        `);
      });

      // Listen on 127.0.0.1 (loopback) to prevent Windows firewall prompts and ensure lightning-fast binding
      this.httpServer.listen(this.port, '127.0.0.1', () => {
        this.isRunning = true;
        this.logActivity('System', 'Server 启动', `本地 MCP 服务已在 127.0.0.1:${this.port} 成功监听 (全协议双模支持)`, 'success');
        resolve(true);
      });

      this.httpServer.on('error', (err: any) => {
        console.error('[EchoBrain Server] Port error:', err);
        this.isRunning = false;
        this.logActivity('System', 'Server 异常', `启动失败: ${err.message}`, 'error');
        resolve(false);
      });
    });
  }

  /**
   * Stop the server cleanly without hanging
   */
  public async stop(): Promise<void> {
    if (!this.isRunning || !this.httpServer) return;

    return new Promise((resolve) => {
      for (const s of this.sessions.values()) {
        try { s.transport.close(); } catch {}
      }
      this.sessions.clear();

      try {
        (this.httpServer as any)?.closeAllConnections?.();
      } catch {}

      let resolved = false;
      const finish = () => {
        if (!resolved) {
          resolved = true;
          this.isRunning = false;
          this.httpServer = null;
          this.logActivity('System', 'Server 停止', '本地 MCP 服务已停止', 'success');
          resolve();
        }
      };

      this.httpServer!.close(finish);
      // Safety timeout: ensure plugin unload doesn't hang if sockets linger
      setTimeout(finish, 1000);
    });
  }

  /**
   * Create an independent Server instance with all tools registered for SSE
   */
  private createMcpServerInstance(clientName: string): Server {
    const mcpServer = new Server(
      {
        name: 'echobrain-local',
        version: '0.3.0'
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        }
      }
    );

    const tools = this.getToolDefinitions();
    const resources = this.getResourceDefinitions();
    const prompts = this.getPromptDefinitions();

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.executeTool(name, args, clientName);
    });

    mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => {
      return { resources };
    });

    mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      return this.readResource(uri);
    });

    mcpServer.setRequestHandler(ListPromptsRequestSchema, async () => {
      return { prompts };
    });

    mcpServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.getPrompt(name, args);
    });

    return mcpServer;
  }
}
