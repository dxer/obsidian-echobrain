import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import { VaultEngine } from './engine.js';
import { EmbeddedMcpServer } from './server.js';
import { SearchResultItem, ActivityLogItem } from './types.js';

export const VIEW_TYPE_ECHOBRAIN = 'echobrain-recall-view';

export class EchoBrainView extends ItemView {
  private engine: VaultEngine;
  private server: EmbeddedMcpServer;
  private activeNotePath: string = '';
  private recallResults: SearchResultItem[] = [];
  private activityLogs: ActivityLogItem[] = [];

  constructor(leaf: WorkspaceLeaf, engine: VaultEngine, server: EmbeddedMcpServer) {
    super(leaf);
    this.engine = engine;
    this.server = server;
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
    this.renderActivityLogs();
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
      const rawResults = await this.engine.findConnections({
        currentContext: content.slice(0, 1500),
        limit: 4,
        expandGraphHops: 1
      });
      this.recallResults = rawResults.filter(r => r.path !== file.path).slice(0, 3);
    } catch {
      this.recallResults = [];
    }
    this.render();
  }

  public async onOpen() {
    this.render();
  }

  public render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('echobrain-view-container');

    // 1. Header
    const header = container.createEl('div', { cls: 'echobrain-header' });
    const titleBox = header.createEl('div', { cls: 'echobrain-title-box' });
    titleBox.createEl('h4', { text: '关联知识召回 (Context Recall)' });

    const serverStatus = this.server.getIsRunning();
    header.createEl('span', {
      cls: `echobrain-badge ${serverStatus ? 'status-online' : 'status-offline'}`,
      text: serverStatus ? `MCP Online (${this.server.getPort()})` : 'MCP Offline'
    });

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
        
        // Card title with jump link
        const cardTitle = card.createEl('div', { cls: 'echobrain-card-title' });
        const link = cardTitle.createEl('a', { text: res.title });
        link.addEventListener('click', (e) => {
          e.preventDefault();
          this.app.workspace.openLinkText(res.path, '', false);
        });

        // Connection reason badge
        if (res.connectionReason) {
          card.createEl('div', { cls: 'echobrain-card-reason', text: res.connectionReason });
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

    // 4. Live Agent Activity Stream
    const logSection = container.createEl('div', { cls: 'echobrain-log-section' });
    logSection.createEl('h5', { text: 'MCP 客户端调用日志' });
    const logList = logSection.createEl('div', { cls: 'echobrain-log-list', attr: { id: 'echobrain-log-list' } });

    if (this.activityLogs.length === 0) {
      logList.createEl('div', { cls: 'echobrain-empty-log', text: '暂无请求日志 (客户端发起调用时自动记录)' });
    } else {
      for (const log of this.activityLogs) {
        this.renderLogItem(logList, log);
      }
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
}
