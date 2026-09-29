import { ItemView, WorkspaceLeaf, TFile, setIcon, MarkdownView, Notice } from 'obsidian';
import type EchoBrainLocalPlugin from './main.js';
import { VaultEngine } from './engine.js';
import { EmbeddedMcpServer } from './server.js';
import { SearchResultItem, ActivityLogItem } from './types.js';

export const VIEW_TYPE_ECHOBRAIN = 'echobrain-recall-view';

export class EchoBrainView extends ItemView {
  public plugin: EchoBrainLocalPlugin;
  private engine: VaultEngine;
  private server: EmbeddedMcpServer;
  private activeNotePath: string = '';
  private recallResults: SearchResultItem[] = [];
  private activityLogs: ActivityLogItem[] = [];
  private showHealthDashboard: boolean = false;
  private activeNoteOutlinks: Set<string> = new Set();

  constructor(leaf: WorkspaceLeaf, plugin: EchoBrainLocalPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.engine = plugin.engine;
    this.server = plugin.server;
  }

  public getViewType(): string {
    return VIEW_TYPE_ECHOBRAIN;
  }

  public getDisplayText(): string {
    return 'EchoBrain Recall';
  }

  public getIcon(): string {
    return 'brain-circuit';
  }

  public addActivityLog(log: ActivityLogItem) {
    this.activityLogs.unshift(log);
    if (this.activityLogs.length > 25) this.activityLogs.pop();
    if (this.plugin.settings.showActivityLogs) {
      this.renderActivityLogs();
    }
  }

  public async updateRecall(file: TFile | null) {
    if (!file || file.extension !== 'md') {
      this.activeNotePath = '';
      this.recallResults = [];
      this.render();
      return;
    }

    this.activeNotePath = file.path;
    try {
      const content = await this.app.vault.read(file);
      const cache = this.app.metadataCache.getFileCache(file);

      // Extract title
      const title = cache?.frontmatter?.title || file.basename;

      // Extract tags
      const tagSet = new Set<string>();
      if (cache?.tags) {
        cache.tags.forEach(t => tagSet.add(t.tag.replace(/^#/, '')));
      }
      if (cache?.frontmatter?.tags) {
        const fmTags = cache.frontmatter.tags;
        if (Array.isArray(fmTags)) {
          fmTags.forEach(t => tagSet.add(String(t).replace(/^#/, '')));
        } else if (typeof fmTags === 'string') {
          fmTags.split(/[\s,]+/).forEach(t => tagSet.add(t.replace(/^#/, '')));
        }
      }

      // Extract outgoing link targets
      const outlinks = cache?.links ? cache.links.map(l => l.link) : [];
      this.activeNoteOutlinks.clear();
      outlinks.forEach(l => this.activeNoteOutlinks.add(l.toLowerCase()));

      // Clean body content by stripping YAML frontmatter and heavy noise
      let cleanBody = content;
      if (cleanBody.startsWith('---')) {
        const endFm = cleanBody.indexOf('---', 3);
        if (endFm !== -1) {
          cleanBody = cleanBody.slice(endFm + 3).trim();
        }
      }

      const contextParts = [
        `标题: ${title}`,
        tagSet.size > 0 ? `标签: ${Array.from(tagSet).map(t => '#' + t).join(' ')}` : '',
        outlinks.length > 0 ? `引用双链: ${outlinks.map(l => `[[${l}]]`).join(' ')}` : '',
        cleanBody.slice(0, 2000)
      ].filter(Boolean);

      const enrichedContext = contextParts.join('\n\n');
      const maxCards = this.plugin.settings.recallMaxCards || 3;

      const rawResults = await this.engine.findConnections({
        currentContext: enrichedContext,
        activePath: file.path,
        limit: maxCards + 1,
        expandGraphHops: 1
      });
      this.recallResults = rawResults.filter(r => r.path !== file.path).slice(0, maxCards);
    } catch (e) {
      console.warn('[EchoBrain Recall] updateRecall failed:', e);
      this.recallResults = [];
    }
    this.render();
  }

  public async onOpen() {
    this.render();
  }

  public render() {
    const container = this.contentEl || (this.containerEl && (this.containerEl.children[1] as HTMLElement)) || this.containerEl;
    if (!container) return;

    try {
      container.empty();
      container.addClass('echobrain-view-container');

      // 1. Header (Clean & Minimalist, removed MCP ONLINE badge)
      const header = container.createEl('div', { cls: 'echobrain-header' });
      const titleBox = header.createEl('div', { cls: 'echobrain-title-box' });
      titleBox.createEl('h4', { text: '关联知识召回 (Context Recall)' });

      // Action buttons: Vault Health Dashboard & Activity Logs
      const actionsBox = header.createEl('div', { cls: 'echobrain-header-actions' });

      const toggleHealthBtn = actionsBox.createEl('button', {
        cls: `clickable-icon echobrain-action-btn ${this.showHealthDashboard ? 'is-active' : ''}`,
        attr: {
          'aria-label': this.showHealthDashboard ? '收起知识库体检' : '展开知识库体检与孤岛雷达',
          'title': this.showHealthDashboard ? '收起知识库体检' : '展开知识库体检与孤岛雷达'
        }
      });
      setIcon(toggleHealthBtn, 'activity');
      toggleHealthBtn.onclick = () => {
        this.showHealthDashboard = !this.showHealthDashboard;
        this.render();
      };

      const toggleLogBtn = actionsBox.createEl('button', {
        cls: `clickable-icon echobrain-action-btn ${this.plugin.settings.showActivityLogs ? 'is-active' : ''}`,
        attr: {
          'aria-label': this.plugin.settings.showActivityLogs ? '隐藏 MCP 调用日志' : '显示 MCP 调用日志',
          'title': this.plugin.settings.showActivityLogs ? '隐藏 MCP 调用日志' : '显示 MCP 调用日志'
        }
      });
      setIcon(toggleLogBtn, 'scroll-text');
      toggleLogBtn.onclick = async () => {
        this.plugin.settings.showActivityLogs = !this.plugin.settings.showActivityLogs;
        await this.plugin.saveSettings();
        this.render();
      };

      // 1.5. Vault Health Dashboard (when active)
      if (this.showHealthDashboard) {
        this.renderHealthDashboard(container);
      }

    // 2. Active Note Section
    const activeSection = container.createEl('div', { cls: 'echobrain-active-section' });
    if (this.activeNotePath) {
      activeSection.createEl('div', {
        cls: 'echobrain-active-label',
        text: `当前文档: ${this.activeNotePath}`
      });
    } else {
      activeSection.createEl('div', {
        cls: 'echobrain-active-label empty',
        text: '选择或聚焦文档以查看关联笔记'
      });
    }

    // 3. Echo Cards Section
    const cardsContainer = container.createEl('div', { cls: 'echobrain-cards-container' });
    if (this.recallResults.length === 0 && this.activeNotePath) {
      cardsContainer.createEl('div', {
        cls: 'echobrain-empty-card',
        text: '当前文档暂无高相关度笔记或双链关联'
      });
    } else {
      for (const res of this.recallResults) {
        const card = cardsContainer.createEl('div', { cls: 'echobrain-card' });
        
        // Card Header: Title + Path + Quick Action Buttons
        const cardHeader = card.createEl('div', { cls: 'echobrain-card-header' });
        const cardTitleBox = cardHeader.createEl('div', { cls: 'echobrain-card-title-box' });
        const link = cardTitleBox.createEl('a', { text: res.title, cls: 'echobrain-card-title-link' });
        link.addEventListener('click', (e) => {
          e.preventDefault();
          this.app.workspace.openLinkText(res.path, '', false);
        });

        const folderPart = res.path.includes('/') ? res.path.slice(0, res.path.lastIndexOf('/')) : '';
        if (folderPart) {
          cardTitleBox.createEl('div', { cls: 'echobrain-card-folder', text: `📁 ${folderPart}` });
        }

        // Quick action buttons: Copy WikiLink & Insert at cursor
        const btnBox = cardHeader.createEl('div', { cls: 'echobrain-card-actions' });

        const copyBtn = btnBox.createEl('button', {
          cls: 'clickable-icon echobrain-card-action-btn',
          attr: { 'aria-label': '复制双链引用', 'title': '复制双链引用' }
        });
        setIcon(copyBtn, 'copy');
        copyBtn.onclick = (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(`[[${res.title}]]`);
          new Notice(`已复制: [[${res.title}]]`);
        };

        const isLinked = this.activeNoteOutlinks.has(res.title.toLowerCase()) ||
          this.activeNoteOutlinks.has(res.path.replace(/\.md$/, '').toLowerCase());

        const insertBtn = btnBox.createEl('button', {
          cls: 'clickable-icon echobrain-card-action-btn',
          attr: {
            'aria-label': isLinked ? '在当前光标插入双链' : '一键转为双链引用并插入光标处',
            'title': isLinked ? '在当前光标插入双链' : '一键转为双链引用并插入光标处'
          }
        });
        setIcon(insertBtn, isLinked ? 'file-input' : 'link');
        insertBtn.onclick = (e) => {
          e.stopPropagation();
          const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (activeView && activeView.editor) {
            activeView.editor.replaceSelection(`[[${res.title}]]`);
            new Notice(`已插入引用: [[${res.title}]]`);
          } else {
            new Notice('请先在编辑器中打开并聚焦一篇 Markdown 笔记');
          }
        };

        // Connection reason badge with semantic mention indication
        if (res.connectionReason) {
          const reasonClass = isLinked ? 'is-linked' : 'is-semantic-mention';
          const prefix = isLinked ? '🔗 已双链' : '💡 隐式提及';
          card.createEl('div', {
            cls: `echobrain-card-reason ${reasonClass}`,
            text: `${prefix} · ${res.connectionReason}`
          });
        }

        // Snippet
        card.createEl('div', { cls: 'echobrain-card-snippet', text: res.snippet });

        // Graph neighbors
        if (res.graphNeighbors && res.graphNeighbors.length > 0) {
          const graphLine = card.createEl('div', { cls: 'echobrain-card-graph' });
          graphLine.createEl('span', { text: '双链关联: ' });
          res.graphNeighbors.forEach((n, idx) => {
            if (idx > 0) graphLine.createEl('span', { text: ', ' });
            const neighborLink = graphLine.createEl('a', { text: `[[${n.title}]]` });
            neighborLink.addEventListener('click', (e) => {
              e.preventDefault();
              this.app.workspace.openLinkText(n.path, '', false);
            });
          });
        }
      }
    }

      // 4. Live Agent Activity Stream (Controlled by toggle)
      if (this.plugin.settings.showActivityLogs) {
        const logSection = container.createEl('div', { cls: 'echobrain-log-section' });
        const logHeader = logSection.createEl('div', { cls: 'echobrain-log-header' });
        logHeader.createEl('h5', { text: 'MCP 客户端调用日志' });
        const logList = logSection.createEl('div', { cls: 'echobrain-log-list', attr: { id: 'echobrain-log-list' } });

        if (this.activityLogs.length === 0) {
          logList.createEl('div', { cls: 'echobrain-empty-log', text: '暂无请求日志 (客户端发起调用时自动记录)' });
        } else {
          for (const log of this.activityLogs) {
            this.renderLogItem(logList, log);
          }
        }
      }
    } catch (e) {
      console.warn('[EchoBrain View] Render error:', e);
    }
  }

  private renderActivityLogs() {
    const listEl = this.containerEl.querySelector('#echobrain-log-list');
    if (!listEl) return;
    listEl.empty();
    for (const log of this.activityLogs) {
      this.renderLogItem(listEl as HTMLElement, log);
    }
  }

  private renderLogItem(container: HTMLElement, log: ActivityLogItem) {
    const item = container.createEl('div', { cls: `echobrain-log-item status-${log.status}` });
    const timeStr = new Date(log.timestamp).toLocaleTimeString();
    
    const topRow = item.createEl('div', { cls: 'echobrain-log-top' });
    topRow.createEl('span', { cls: 'echobrain-log-client', text: `[${log.agentClient}]` });
    topRow.createEl('span', { cls: 'echobrain-log-tool', text: log.tool });
    topRow.createEl('span', { cls: 'echobrain-log-time', text: timeStr });

    item.createEl('div', { cls: 'echobrain-log-summary', text: log.summary });
  }

  private renderHealthDashboard(container: HTMLElement) {
    const health = this.engine.getVaultHealth();
    const section = container.createEl('div', { cls: 'echobrain-health-section' });

    const header = section.createEl('div', { cls: 'echobrain-health-header' });
    header.createEl('h5', { text: '🩺 知识库健康体检与孤岛雷达' });

    // Metric Badges
    const statsRow = section.createEl('div', { cls: 'echobrain-health-stats' });
    statsRow.createEl('span', { cls: 'echobrain-health-badge', text: `📝 笔记: ${health.totalNotes}` });
    statsRow.createEl('span', {
      cls: `echobrain-health-badge ${health.orphanCount > 0 ? 'is-warning' : 'is-good'}`,
      text: `🏝️ 孤岛: ${health.orphanCount} 篇`
    });
    statsRow.createEl('span', {
      cls: `echobrain-health-badge ${health.brokenLinksCount > 0 ? 'is-error' : 'is-good'}`,
      text: `⚠️ 死链: ${health.brokenLinksCount} 条`
    });

    // Orphans list
    if (health.orphans.length > 0) {
      const orphanBox = section.createEl('div', { cls: 'echobrain-orphan-box' });
      orphanBox.createEl('div', { cls: 'echobrain-orphan-title', text: '待拯救孤岛笔记 (零引用 / 零被引用):' });

      for (const orphan of health.orphans.slice(0, 5)) {
        const item = orphanBox.createEl('div', { cls: 'echobrain-orphan-item' });
        const nameRow = item.createEl('div', { cls: 'echobrain-orphan-name-row' });
        const oLink = nameRow.createEl('a', { cls: 'echobrain-orphan-link', text: orphan.title });
        oLink.onclick = (e) => {
          e.preventDefault();
          this.app.workspace.openLinkText(orphan.path, '', false);
        };

        const rescueBtn = nameRow.createEl('button', {
          cls: 'echobrain-rescue-btn',
          text: '💡 智能解救'
        });

        const targetContainer = item.createEl('div', { cls: 'echobrain-rescue-targets' });

        rescueBtn.onclick = async () => {
          rescueBtn.disabled = true;
          rescueBtn.setText('分析中...');
          const result = await this.engine.rescueOrphanNote(orphan.path, 2);
          targetContainer.empty();

          if (!result || result.suggestedTargets.length === 0) {
            targetContainer.createEl('div', { cls: 'echobrain-rescue-empty', text: '未找到明显相关的建议节点' });
            rescueBtn.setText('无匹配');
            return;
          }

          rescueBtn.setText('已推荐');
          for (const target of result.suggestedTargets) {
            const targetRow = targetContainer.createEl('div', { cls: 'echobrain-rescue-target-row' });
            const tLink = targetRow.createEl('a', { cls: 'echobrain-rescue-target-name', text: `🔗 [[${target.title}]]` });
            tLink.onclick = (e) => {
              e.preventDefault();
              this.app.workspace.openLinkText(target.path, '', false);
            };

            const connectBtn = targetRow.createEl('button', {
              cls: 'echobrain-connect-btn',
              text: '一键织网连结'
            });
            connectBtn.onclick = async () => {
              const ok = await this.engine.connectNotes(orphan.path, target.title);
              if (ok) {
                new Notice(`已将 [[${target.title}]] 编织进 [[${orphan.title}]]！`);
                this.render();
              }
            };
          }
        };
      }
    } else {
      section.createEl('div', { cls: 'echobrain-health-good', text: '✨ 太棒了！全库无孤岛笔记，知识网络连接紧密。' });
    }
  }
}
