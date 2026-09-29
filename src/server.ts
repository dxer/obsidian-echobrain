import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { VaultEngine } from './engine.js';
import { ActivityLogItem } from './types.js';

interface ClientSession {
  sessionId: string;
  transport: SSEServerTransport;
  mcpServer: Server;
  clientName: string;
  createdAt: number;
}

export class EmbeddedMcpServer {
  private port: number;
  private engine: VaultEngine;
  private httpServer: http.Server | null = null;
  private sessions: Map<string, ClientSession> = new Map();
  private isRunning: boolean = false;
  private onActivityLog: ((item: ActivityLogItem) => void) | null = null;

  constructor(port: number, engine: VaultEngine) {
    this.port = port;
    this.engine = engine;
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
        description: 'Ambient proactive recall: Find related past notes and bugs based on current editor text/code context.',
        inputSchema: {
          type: 'object',
          properties: {
            current_context: { type: 'string', description: 'Current code block or paragraph' },
            limit: { type: 'integer', default: 3 },
            expand_graph_hops: { type: 'integer', default: 1 }
          },
          required: ['current_context']
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
      }
    ];
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

          const createdPath = await this.engine.saveInsight({ title, content, tags, category });
          this.logActivity(clientName, 'save_insight', `写入灵感: "${title}" -> ${createdPath}`, 'success');

          return {
            content: [
              {
                type: 'text',
                text: `✅ 灵感已保存到 Obsidian: \`${createdPath}\`，并已实时建立索引！`
              }
            ]
          };
        }

        case 'find_connections': {
          const currentContext = String(args?.current_context || '');
          const limit = Number(args?.limit) || 3;
          const expandGraphHops = Number(args?.expand_graph_hops) || 1;

          const connections = await this.engine.findConnections({ currentContext, limit, expandGraphHops });
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

        // 2. Direct JSON-RPC POST handling (Streamable HTTP, used by Cursor / direct HTTP clients)
        if (req.method === 'POST') {
          let rawBody = '';
          req.on('data', chunk => rawBody += chunk);
          req.on('end', async () => {
            const sessionId = url.searchParams.get('sessionId');
            const userAgent = req.headers['user-agent'] || 'Unknown Agent';
            const clientName = userAgent.includes('Cursor')
              ? 'Cursor'
              : userAgent.includes('Claude')
              ? 'Claude Desktop'
              : 'AI Agent';

            // If this is a POST to an established SSE session
            if (sessionId && this.sessions.has(sessionId)) {
              try {
                const session = this.sessions.get(sessionId)!;
                // Use session transport
                await session.transport.handlePostMessage(req, res, rawBody ? JSON.parse(rawBody) : undefined);
                return;
              } catch (err: any) {
                console.error('[EchoBrain SSE] Session error:', err);
              }
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
                      capabilities: { tools: {} },
                      serverInfo: { name: 'echobrain-local', version: '0.1.0' }
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

      // Listen on all local interfaces (0.0.0.0) to support localhost, 127.0.0.1 and IPv6 seamlessly
      this.httpServer.listen(this.port, () => {
        this.isRunning = true;
        this.logActivity('System', 'Server 启动', `本地 MCP 服务已在端口 ${this.port} 成功监听 (全协议双模支持)`, 'success');
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
   * Stop the server
   */
  public async stop(): Promise<void> {
    if (!this.isRunning || !this.httpServer) return;

    return new Promise((resolve) => {
      for (const s of this.sessions.values()) {
        try { s.transport.close(); } catch {}
      }
      this.sessions.clear();

      this.httpServer!.close(() => {
        this.isRunning = false;
        this.httpServer = null;
        this.logActivity('System', 'Server 停止', '本地 MCP 服务已停止', 'success');
        resolve();
      });
    });
  }

  /**
   * Create an independent Server instance with all tools registered for SSE
   */
  private createMcpServerInstance(clientName: string): Server {
    const mcpServer = new Server(
      {
        name: 'echobrain-local',
        version: '0.1.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    const tools = this.getToolDefinitions();

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.executeTool(name, args, clientName);
    });

    return mcpServer;
  }
}
