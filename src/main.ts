import { Plugin, TFile, WorkspaceLeaf, Notice } from 'obsidian';
import { EchoBrainPluginSettings, DEFAULT_SETTINGS } from './types.js';
import { VaultEngine } from './engine.js';
import { EmbeddedMcpServer } from './server.js';
import { EchoBrainView, VIEW_TYPE_ECHOBRAIN } from './view.js';
import { EchoBrainSettingTab } from './settings.js';
import { InlineRecallSuggest } from './editorSuggest.js';

export default class EchoBrainLocalPlugin extends Plugin {
  public settings: EchoBrainPluginSettings = DEFAULT_SETTINGS;
  public engine!: VaultEngine;
  public server!: EmbeddedMcpServer;
  private statusBarItem!: HTMLElement;
  private recallTimer: any = null;

  async onload() {
    console.log('[EchoBrain] Loading EchoBrain Local Plugin...');

    // 1. Load settings
    await this.loadSettings();

    // 2. Initialize Vault Engine
    this.engine = new VaultEngine(this.app, this.settings);

    // Instant topology setup (<5ms, zero blocking)
    this.engine.rebuildLinkGraph();

    // Background incremental indexing after layout is ready and settled (delay 1s for butter-smooth startup)
    this.app.workspace.onLayoutReady(() => {
      setTimeout(async () => {
        try {
          const count = await this.engine.indexVault();
          console.log(`[EchoBrain] Background indexed ${count} notes using cooperative time-slicing.`);
        } catch (err) {
          console.warn('[EchoBrain] Background indexing error:', err);
        }
      }, 1000);
    });

    // 3. Initialize Embedded MCP Server
    this.server = new EmbeddedMcpServer(this.settings, this.engine);
    this.server.setActivityLogger((log) => {
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ECHOBRAIN);
      for (const leaf of leaves) {
        if (leaf.view instanceof EchoBrainView) {
          leaf.view.addActivityLog(log);
        }
      }
    });

    // Auto-start server if configured
    if (this.settings.autoStart) {
      this.app.workspace.onLayoutReady(async () => {
        const ok = await this.server.start(this.settings.port);
        this.updateStatusBar();
        if (ok) {
          console.log(`[EchoBrain] Local MCP Server listening on http://127.0.0.1:${this.settings.port}/sse`);
        }
      });
    }

    // 4. Register Obsidian native Vault change events (Zero manual polling)
    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          await this.engine.indexFile(file);
          this.engine.rebuildLinkGraph();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('create', async (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          await this.engine.indexFile(file);
          this.engine.rebuildLinkGraph();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.engine.removeFile(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.engine.renameFile(oldPath, file.path);
          await this.engine.indexFile(file);
        }
      })
    );

    // 5. Register Proactive Recall on active note change
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        if (!this.settings.enableProactiveRecall) return;
        if (this.recallTimer) clearTimeout(this.recallTimer);

        this.recallTimer = setTimeout(async () => {
          const activeFile = this.app.workspace.getActiveFile();
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ECHOBRAIN);
          for (const leaf of leaves) {
            if (leaf.view instanceof EchoBrainView) {
              await leaf.view.updateRecall(activeFile);
            }
          }
        }, 600);
      })
    );

    // 6. Register Sidebar View
    this.registerView(
      VIEW_TYPE_ECHOBRAIN,
      (leaf: WorkspaceLeaf) => new EchoBrainView(leaf, this)
    );

    // Ribbon icon to open sidebar view
    this.addRibbonIcon('brain-circuit', '打开 EchoBrain 知识召回', () => {
      this.activateView();
    });

    // 7. Status bar item
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();
    this.statusBarItem.addEventListener('click', () => {
      this.activateView();
    });

    // 8. Register Commands
    this.addCommand({
      id: 'echobrain-toggle-mcp-server',
      name: '启动/停止 MCP 服务',
      callback: async () => {
        if (this.server.getIsRunning()) {
          await this.server.stop();
          new Notice('EchoBrain MCP 服务已停止');
        } else {
          const ok = await this.server.start(this.settings.port);
          if (ok) new Notice(`EchoBrain MCP 服务已启动 (端口: ${this.settings.port})`);
          else new Notice('启动失败，端口可能已被占用');
        }
        this.updateStatusBar();
      }
    });

    this.addCommand({
      id: 'echobrain-open-recall-view',
      name: '打开关联知识召回侧边栏',
      callback: () => {
        this.activateView();
      }
    });

    this.addCommand({
      id: 'echobrain-copy-cursor-config',
      name: '复制 Cursor 配置 (JSON)',
      callback: () => {
        const json = JSON.stringify({
          mcpServers: {
            echobrain: {
              url: `http://127.0.0.1:${this.settings.port}/sse`
            }
          }
        }, null, 2);
        navigator.clipboard.writeText(json);
        new Notice('Cursor 配置已复制至剪贴板');
      }
    });

    this.addCommand({
      id: 'echobrain-copy-workbuddy-config',
      name: '复制 WorkBuddy 配置 (JSON)',
      callback: () => {
        const json = JSON.stringify({
          mcpServers: {
            echobrain: {
              type: 'http',
              url: `http://127.0.0.1:${this.settings.port}/sse`
            }
          }
        }, null, 2);
        navigator.clipboard.writeText(json);
        new Notice('WorkBuddy 配置已复制至剪贴板');
      }
    });

    // 9. Register Inline Recall Autocomplete (Trigger via @@)
    this.registerEditorSuggest(new InlineRecallSuggest(this.app, this));

    // 10. Add Settings Tab
    this.addSettingTab(new EchoBrainSettingTab(this.app, this));
  }

  async onunload() {
    console.log('[EchoBrain] Unloading EchoBrain Local Plugin...');
    if (this.recallTimer) {
      clearTimeout(this.recallTimer);
      this.recallTimer = null;
    }
    if (this.server) {
      await this.server.stop();
    }
    if (this.engine) {
      await this.engine.close();
    }
  }

  public updateStatusBar() {
    if (!this.statusBarItem) return;
    const running = this.server?.getIsRunning();
    const port = this.settings.port;

    if (running) {
      this.statusBarItem.setText(`🧠 MCP: ${port}`);
      this.statusBarItem.setAttribute('title', `EchoBrain MCP 服务在线: http://127.0.0.1:${port}/sse (点击打开回响面板)`);
      this.statusBarItem.style.color = 'var(--text-success)';
    } else {
      this.statusBarItem.setText(`🧠 MCP: 离线`);
      this.statusBarItem.setAttribute('title', `EchoBrain MCP 服务已停止 (点击设置)`);
      this.statusBarItem.style.color = 'var(--text-muted)';
    }
  }

  public async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_ECHOBRAIN);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_ECHOBRAIN,
          active: true
        });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
      const activeFile = this.app.workspace.getActiveFile();
      if (leaf.view instanceof EchoBrainView) {
        await leaf.view.updateRecall(activeFile);
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.engine.updateSettings(this.settings);
    this.server.updateSettings(this.settings);
    this.updateStatusBar();
  }
}
