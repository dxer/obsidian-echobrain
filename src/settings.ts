import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type EchoBrainLocalPlugin from './main.js';
import { EmbeddingMode } from './types.js';
import { EchoBrainView, VIEW_TYPE_ECHOBRAIN } from './view.js';

export class EchoBrainSettingTab extends PluginSettingTab {
  private plugin: EchoBrainLocalPlugin;
  private isDownloadingModel: boolean = false;
  private downloadStatusText: string = '';

  constructor(app: App, plugin: EchoBrainLocalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'EchoBrain Local 设置' });

    // 1. Server Status & Control
    const isRunning = this.plugin.server.getIsRunning();
    const port = this.plugin.settings.port;
    const sseUrl = `http://127.0.0.1:${port}/sse`;

    const statusBanner = containerEl.createEl('div', { cls: 'echobrain-settings-banner' });
    const statusText = statusBanner.createEl('div', { cls: 'echobrain-settings-status' });
    statusText.createEl('span', {
      cls: `echobrain-badge ${isRunning ? 'status-online' : 'status-offline'}`,
      text: isRunning ? `服务运行中 (端口: ${port})` : '服务已停止'
    });
    if (isRunning) {
      statusText.createEl('div', { cls: 'echobrain-settings-url', text: `接口地址: ${sseUrl}` });
    }

    const btnGroup = statusBanner.createEl('div', { cls: 'echobrain-btn-group' });
    if (isRunning) {
      const stopBtn = btnGroup.createEl('button', { text: '停止服务', cls: 'mod-warning' });
      stopBtn.onclick = async () => {
        await this.plugin.server.stop();
        this.plugin.updateStatusBar();
        this.display();
        new Notice('EchoBrain MCP 服务已停止');
      };
      const restartBtn = btnGroup.createEl('button', { text: '重启服务' });
      restartBtn.onclick = async () => {
        await this.plugin.server.stop();
        await this.plugin.server.start(port);
        this.plugin.updateStatusBar();
        this.display();
        new Notice('EchoBrain MCP 服务已重启');
      };
    } else {
      const startBtn = btnGroup.createEl('button', { text: '启动服务', cls: 'mod-cta' });
      startBtn.onclick = async () => {
        const ok = await this.plugin.server.start(port);
        this.plugin.updateStatusBar();
        this.display();
        if (ok) new Notice(`EchoBrain MCP 服务已启动 (端口: ${port})`);
        else new Notice('启动失败，请检查端口是否被占用');
      };
    }

    // 2. Server Configuration
    containerEl.createEl('h3', { text: '服务配置 (Server Configuration)' });

    new Setting(containerEl)
      .setName('监听端口')
      .setDesc('本地 HTTP/SSE 服务端口号 (默认 23333)')
      .addText(text =>
        text
          .setPlaceholder('23333')
          .setValue(String(this.plugin.settings.port))
          .onChange(async value => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 1024 && num < 65535) {
              this.plugin.settings.port = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('随应用自动启动')
      .setDesc('Obsidian 启动时在后台静默运行 MCP 服务')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoStart)
          .onChange(async value => {
            this.plugin.settings.autoStart = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('收件箱目录 (Inbox)')
      .setDesc('外部 Agent 通过 save_insight 工具写入的笔记存放路径')
      .addText(text =>
        text
          .setPlaceholder('Inbox')
          .setValue(this.plugin.settings.inboxFolder)
          .onChange(async value => {
            this.plugin.settings.inboxFolder = value.trim() || 'Inbox';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('显示客户端调用日志')
      .setDesc('在知识召回侧边栏底部显示外部 Agent (Cursor / Claude / WorkBuddy) 的实时请求与工具调用日志')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.showActivityLogs)
          .onChange(async value => {
            this.plugin.settings.showActivityLogs = value;
            await this.plugin.saveSettings();
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ECHOBRAIN);
            for (const leaf of leaves) {
              if (leaf.view instanceof EchoBrainView) {
                leaf.view.render();
              }
            }
          })
      );

    // 3. Client Integration Generators
    containerEl.createEl('h3', { text: '客户端集成 (Client Integration)' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '外部 AI 客户端（如 Cursor、Claude Desktop）可通过配置本地 SSE 地址直接接入。'
    });

    // Cursor Config
    const cursorBox = containerEl.createEl('div', { cls: 'echobrain-client-card' });
    cursorBox.createEl('h4', { text: 'Cursor' });
    cursorBox.createEl('p', {
      text: '在项目根目录 .cursor/mcp.json 或全局配置中添加：'
    });
    const cursorJson = JSON.stringify({
      mcpServers: {
        echobrain: {
          url: sseUrl
        }
      }
    }, null, 2);
    cursorBox.createEl('pre', { text: cursorJson });
    const copyCursorBtn = cursorBox.createEl('button', { text: '复制 Cursor 配置', cls: 'mod-cta' });
    copyCursorBtn.onclick = () => {
      navigator.clipboard.writeText(cursorJson);
      new Notice('Cursor 配置已复制至剪贴板');
    };

    // WorkBuddy Config (Tencent)
    const workbuddyBox = containerEl.createEl('div', { cls: 'echobrain-client-card' });
    workbuddyBox.createEl('h4', { text: 'WorkBuddy' });
    workbuddyBox.createEl('p', {
      text: '在 WorkBuddy【连接器 / Connectors】->【自定义连接器】->【配置 MCP】中粘贴：'
    });
    const workbuddyJson = JSON.stringify({
      mcpServers: {
        echobrain: {
          type: 'http',
          url: sseUrl
        }
      }
    }, null, 2);
    workbuddyBox.createEl('pre', { text: workbuddyJson });
    const copyWbBtn = workbuddyBox.createEl('button', { text: '复制 WorkBuddy 配置', cls: 'mod-cta' });
    copyWbBtn.onclick = () => {
      navigator.clipboard.writeText(workbuddyJson);
      new Notice('WorkBuddy 配置已复制至剪贴板');
    };

    // Claude Desktop Config
    const claudeBox = containerEl.createEl('div', { cls: 'echobrain-client-card' });
    claudeBox.createEl('h4', { text: 'Claude Desktop' });
    claudeBox.createEl('p', {
      text: '在 claude_desktop_config.json 的 mcpServers 中添加：'
    });
    const claudeJson = JSON.stringify({
      mcpServers: {
        echobrain: {
          url: sseUrl
        }
      }
    }, null, 2);
    claudeBox.createEl('pre', { text: claudeJson });
    const copyClaudeBtn = claudeBox.createEl('button', { text: '复制 Claude Desktop 配置', cls: 'mod-cta' });
    copyClaudeBtn.onclick = () => {
      navigator.clipboard.writeText(claudeJson);
      new Notice('Claude Desktop 配置已复制至剪贴板');
    };

    // 4. Semantic Embedding Configuration (3-tier)
    containerEl.createEl('h3', { text: '语义向量与混合检索 (Vector Embedding)' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '默认采用轻量级 BM25 词频与双链拓扑检索；可按需开启本地 ONNX 模型或外部兼容 API 实现向量语义泛化。'
    });

    const embeddingService = this.plugin.engine.getEmbeddingService();

    new Setting(containerEl)
      .setName('向量引擎模式')
      .setDesc('选择文本向量化计算方式')
      .addDropdown(dropdown => {
        dropdown
          .addOption('none', '关闭 (词频 BM25 + 双链拓扑，轻量高效)')
          .addOption('local', '本地离线模型 (bge-small-zh-v1.5，按需下载)')
          .addOption('api', '自定义兼容 API (Ollama / OpenAI / 兼容端点)')
          .setValue(this.plugin.settings.embeddingMode)
          .onChange(async (val: EmbeddingMode) => {
            this.plugin.settings.embeddingMode = val;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    // Sub-view: When 'local' is selected
    if (this.plugin.settings.embeddingMode === 'local') {
      const localCard = containerEl.createEl('div', { cls: 'echobrain-client-card' });
      localCard.createEl('h4', { text: '本地离线模型配置 (bge-small-zh-v1.5)' });

      const isModelReady = embeddingService.isLocalModelComplete();
      const statusP = localCard.createEl('p');
      statusP.createEl('span', {
        cls: `echobrain-badge ${isModelReady ? 'status-online' : 'status-offline'}`,
        text: isModelReady ? '模型已就绪 (离线运行)' : '模型未就绪'
      });

      if (!isModelReady) {
        localCard.createEl('p', {
          text: '插件默认不内置模型文件。点击下方按钮从加速镜像拉取 40MB 量化 ONNX 模型与 WASM 运行时。'
        });

        const dlBtn = localCard.createEl('button', {
          text: this.isDownloadingModel ? '正在下载...' : '下载模型文件 (~40MB)',
          cls: 'mod-cta'
        });
        dlBtn.disabled = this.isDownloadingModel;

        if (this.downloadStatusText) {
          localCard.createEl('div', { cls: 'echobrain-settings-url', text: this.downloadStatusText });
        }

        dlBtn.onclick = async () => {
          this.isDownloadingModel = true;
          this.downloadStatusText = '正在连接镜像源...';
          this.display();

          try {
            await embeddingService.downloadLocalModel((percent, status) => {
              this.downloadStatusText = `[${percent}%] ${status}`;
              const el = this.containerEl.querySelector('.echobrain-settings-url');
              if (el) el.textContent = this.downloadStatusText;
            });
            this.isDownloadingModel = false;
            this.plugin.settings.localModelDownloaded = true;
            await this.plugin.saveSettings();
            new Notice('本地向量模型已加载就绪');
            this.display();
          } catch (err: any) {
            this.isDownloadingModel = false;
            this.downloadStatusText = `下载失败: ${err.message}`;
            new Notice(`下载失败: ${err.message}`);
            this.display();
          }
        };
      } else {
        localCard.createEl('p', {
          cls: 'setting-item-description',
          text: '模型文件已完整存放于 .echobrain/models/ 目录中，在 WebAssembly 环境离线计算。'
        });
      }
    }

    // Sub-view: When 'api' is selected
    if (this.plugin.settings.embeddingMode === 'api') {
      const apiCard = containerEl.createEl('div', { cls: 'echobrain-client-card' });
      apiCard.createEl('h4', { text: '自定义向量 API 端点' });

      new Setting(apiCard)
        .setName('API 地址')
        .setDesc('Ollama 默认填写 http://localhost:11434/v1')
        .addText(text =>
          text
            .setPlaceholder('http://localhost:11434/v1')
            .setValue(this.plugin.settings.apiBaseUrl)
            .onChange(async val => {
              this.plugin.settings.apiBaseUrl = val.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(apiCard)
        .setName('API 密钥 (API Key)')
        .setDesc('使用本地 Ollama / LM Studio 时可留空')
        .addText(text =>
          text
            .setPlaceholder('sk-...')
            .setValue(this.plugin.settings.apiKey)
            .onChange(async val => {
              this.plugin.settings.apiKey = val.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(apiCard)
        .setName('模型名称')
        .setDesc('如 nomic-embed-text、bge-m3 或 text-embedding-3-small')
        .addText(text =>
          text
            .setPlaceholder('nomic-embed-text')
            .setValue(this.plugin.settings.apiModel)
            .onChange(async val => {
              this.plugin.settings.apiModel = val.trim();
              await this.plugin.saveSettings();
            })
        );

      const testBtn = apiCard.createEl('button', { text: '测试 API 连通性' });
      testBtn.onclick = async () => {
        new Notice('正在测试 API 连通性...');
        try {
          const vec = await embeddingService.getEmbedding('EchoBrain test embedding');
          if (vec && vec.length > 0) {
            new Notice(`连接成功: 返回 ${vec.length} 维向量`);
          } else {
            new Notice('连接失败: API 未返回有效向量');
          }
        } catch (err: any) {
          new Notice(`连接失败: ${err.message}`);
        }
      };
    }

    // 5. Proactive Recall Settings
    containerEl.createEl('h3', { text: '上下文关联 (Context Recall)' });

    new Setting(containerEl)
      .setName('启用侧边栏上下文关联')
      .setDesc('在侧边栏实时检索并展示与当前聚焦文档相关的笔记与链接拓扑')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.enableProactiveRecall)
          .onChange(async value => {
            this.plugin.settings.enableProactiveRecall = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
