import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  TFile,
  setIcon
} from 'obsidian';
import type EchoBrainLocalPlugin from './main.js';
import { SearchResultItem } from './types.js';

export class InlineRecallSuggest extends EditorSuggest<SearchResultItem> {
  private plugin: EchoBrainLocalPlugin;

  constructor(app: App, plugin: EchoBrainLocalPlugin) {
    super(app);
    this.plugin = plugin;
  }

  /**
   * Trigger suggestion when user types "@@" or "@@keyword"
   * Supports seamless triggering after English, Chinese, or punctuation without requiring space
   */
  public onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    _file: TFile
  ): EditorSuggestTriggerInfo | null {
    const lineText = editor.getLine(cursor.line);
    const subStr = lineText.slice(0, cursor.ch);

    const atAtIndex = subStr.lastIndexOf('@@');
    if (atAtIndex === -1) return null;

    const queryPart = subStr.slice(atAtIndex + 2);
    // Cancel trigger if query has spaces, tabs or another @ (user moved on)
    if (queryPart.includes(' ') || queryPart.includes('@') || queryPart.includes('\t')) {
      return null;
    }

    return {
      start: { line: cursor.line, ch: atAtIndex },
      end: cursor,
      query: queryPart
    };
  }

  /**
   * Retrieve suggestions based on trigger query or current paragraph context
   */
  public async getSuggestions(context: EditorSuggestContext): Promise<SearchResultItem[]> {
    const query = (context.query || '').trim();
    const activeFile = context.file;

    // Case 1: User typed specific query after @@ (e.g. "@@FastAPI")
    if (query.length > 0) {
      const results = await this.plugin.engine.search({
        query,
        limit: 5,
        expandGraphHops: 1
      });
      return results.filter(r => !activeFile || r.path !== activeFile.path);
    }

    // Case 2: User just typed "@@" -> Ambient context recall based on current line/paragraph
    const lineNum = context.start.line;
    const currentLine = context.editor.getLine(lineNum);
    const prevLine = lineNum > 0 ? context.editor.getLine(lineNum - 1) : '';
    const nextLine = lineNum < context.editor.lineCount() - 1 ? context.editor.getLine(lineNum + 1) : '';

    const surroundingContext = [prevLine, currentLine.replace('@@', ''), nextLine]
      .map(l => l.trim())
      .filter(Boolean)
      .join('\n');

    if (!surroundingContext) {
      // Fallback: search top hubs if context is empty
      const stats = this.plugin.engine.getStats();
      return stats.topHubs.map(h => ({
        path: h.path,
        title: h.title,
        snippet: '知识库核心母笔记',
        score: h.pageRank,
        mtime: Date.now(),
        tags: [],
        connectionReason: '核心母笔记'
      })).filter(r => !activeFile || r.path !== activeFile.path);
    }

    const suggestions = await this.plugin.engine.findConnections({
      currentContext: surroundingContext,
      activePath: activeFile ? activeFile.path : undefined,
      limit: 5,
      expandGraphHops: 1
    });

    return suggestions.filter(r => !activeFile || r.path !== activeFile.path);
  }

  /**
   * Render custom popup item
   */
  public renderSuggestion(item: SearchResultItem, el: HTMLElement): void {
    el.addClass('echobrain-suggest-item');

    const mainBox = el.createEl('div', { cls: 'echobrain-suggest-main' });
    const titleBox = mainBox.createEl('div', { cls: 'echobrain-suggest-title-row' });
    
    const iconEl = titleBox.createEl('span', { cls: 'echobrain-suggest-icon' });
    setIcon(iconEl, 'file-text');

    titleBox.createEl('span', {
      cls: 'echobrain-suggest-title',
      text: item.title
    });

    if (item.connectionReason) {
      titleBox.createEl('span', {
        cls: 'echobrain-suggest-badge',
        text: item.connectionReason.split('·')[0].trim()
      });
    }

    const metaRow = mainBox.createEl('div', { cls: 'echobrain-suggest-meta' });
    const folderPart = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
    if (folderPart) {
      metaRow.createEl('span', { cls: 'echobrain-suggest-folder', text: `📁 ${folderPart}` });
    }
    if (item.tags && item.tags.length > 0) {
      metaRow.createEl('span', { cls: 'echobrain-suggest-tags', text: item.tags.slice(0, 2).map(t => '#' + t).join(' ') });
    }
  }

  /**
   * Insert [[WikiLink]] upon user selection
   */
  public selectSuggestion(item: SearchResultItem, _evt: MouseEvent | KeyboardEvent): void {
    if (!this.context) return;
    const replacement = `[[${item.title}]]`;
    this.context.editor.replaceRange(replacement, this.context.start, this.context.end);

    // Place cursor right after the closing brackets
    const newPos: EditorPosition = {
      line: this.context.start.line,
      ch: this.context.start.ch + replacement.length
    };
    this.context.editor.setCursor(newPos);
  }
}
