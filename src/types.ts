export type EmbeddingMode = 'none' | 'local' | 'api';

export interface EchoBrainPluginSettings {
  port: number;
  autoStart: boolean;
  inboxFolder: string;
  enableProactiveRecall: boolean;
  recallIdleDelay: number; // in ms
  recallMaxCards: number;

  // Embedding Configuration
  embeddingMode: EmbeddingMode;
  apiBaseUrl: string; // e.g. "http://localhost:11434/v1" or "https://api.openai.com/v1"
  apiKey: string;
  apiModel: string; // e.g. "nomic-embed-text" or "text-embedding-3-small"
  localModelDownloaded: boolean;
}

export const DEFAULT_SETTINGS: EchoBrainPluginSettings = {
  port: 23333,
  autoStart: true,
  inboxFolder: 'Inbox',
  enableProactiveRecall: true,
  recallIdleDelay: 4000,
  recallMaxCards: 3,

  // Default: Pure lightweight BM25 + Obsidian LinkGraph (0 model, 0 download)
  embeddingMode: 'none',
  apiBaseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  apiModel: 'nomic-embed-text',
  localModelDownloaded: false
};

export interface ActivityLogItem {
  id: string;
  timestamp: number;
  agentClient: string;
  tool: string;
  summary: string;
  status: 'success' | 'error';
}

export interface GraphNeighborItem {
  path: string;
  title: string;
  relation: 'cites' | 'cited_by';
  hops: number;
}

export interface SearchResultItem {
  path: string;
  title: string;
  snippet: string;
  score: number;
  mtime: number;
  tags: string[];
  pageRank?: number;
  bm25Rank?: number;
  vectorRank?: number;
  semanticSimilarity?: number;
  connectionReason?: string;
  graphNeighbors?: GraphNeighborItem[];
}

export interface IndexedDocument {
  path: string;
  title: string;
  content: string;
  tags: string[];
  headings: string[];
  mtime: number;
  tokens: Set<string>;
  pageRank: number;
  vector?: number[];
}
