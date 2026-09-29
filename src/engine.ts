import { App, TFile } from 'obsidian';
import { IndexedDocument, SearchResultItem, GraphNeighborItem, EchoBrainPluginSettings } from './types.js';
import { tokenize } from './tokenizer.js';
import { PluginEmbeddingService } from './embeddingService.js';

export class VaultEngine {
  private app: App;
  private documents: Map<string, IndexedDocument> = new Map();
  private pageRanks: Map<string, number> = new Map();
  private backlinks: Map<string, Set<string>> = new Map();
  private isIndexing: boolean = false;
  private inboxFolder: string;
  private settings: EchoBrainPluginSettings;
  private embeddingService: PluginEmbeddingService;

  constructor(app: App, settings: EchoBrainPluginSettings) {
    this.app = app;
    this.settings = settings;
    this.inboxFolder = settings.inboxFolder;
    const basePath = (app.vault.adapter as any).getBasePath?.() || '';
    this.embeddingService = new PluginEmbeddingService(basePath, settings);
  }

  public getEmbeddingService(): PluginEmbeddingService {
    return this.embeddingService;
  }

  public updateSettings(settings: EchoBrainPluginSettings) {
    this.settings = settings;
    this.inboxFolder = settings.inboxFolder;
    this.embeddingService.updateSettings(settings);
  }

  public isPathIgnored(filePath: string): boolean {
    if (!filePath) return true;
    const norm = filePath.replace(/\\/g, '/').toLowerCase();

    // Always ignore hidden / system folders
    if (norm.startsWith('.trash/') || norm.startsWith('.obsidian/') || norm.startsWith('.git/')) {
      return true;
    }

    const patterns = (this.settings.ignoredPaths || '')
      .split(/[\n,]+/)
      .map(p => p.trim().toLowerCase())
      .filter(Boolean);

    for (const pat of patterns) {
      if (pat.startsWith('*.')) {
        const ext = pat.slice(1);
        if (norm.endsWith(ext)) return true;
      } else {
        const cleanPat = pat.replace(/\/+$/, '');
        if (norm === cleanPat || norm.startsWith(cleanPat + '/') || norm.includes('/' + cleanPat + '/')) {
          return true;
        }
      }
    }
    return false;
  }

  public setInboxFolder(folder: string) {
    this.inboxFolder = folder;
  }

  /**
   * Scan and index all markdown files using Obsidian's internal metadataCache
   */
  public async indexVault(): Promise<number> {
    if (this.isIndexing) return this.documents.size;
    this.isIndexing = true;

    try {
      this.rebuildLinkGraph();
      const files = this.app.vault.getMarkdownFiles().filter(f => !this.isPathIgnored(f.path));
      const batchSize = 25;

      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        for (const file of batch) {
          await this.indexFile(file, false);
        }
        // Yield to the main event loop to ensure zero freezing during Obsidian startup
        await new Promise(r => setTimeout(r, 10));
      }

      this.rebuildLinkGraph();
      await this.embeddingService.saveCache();
      return this.documents.size;
    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Index or update a single file (computes embedding on-demand or uses cache)
   */
  public async indexFile(file: TFile, computeEmbedding: boolean = false): Promise<void> {
    if (file.extension !== 'md' || this.isPathIgnored(file.path)) return;

    try {
      const content = await this.app.vault.read(file);
      const cache = this.app.metadataCache.getFileCache(file);

      // Extract tags
      const tagSet = new Set<string>();
      if (cache?.frontmatter?.tags) {
        const fmTags = cache.frontmatter.tags;
        if (Array.isArray(fmTags)) {
          fmTags.forEach(t => tagSet.add(String(t).replace(/^#/, '')));
        } else if (typeof fmTags === 'string') {
          fmTags.split(/[\s,]+/).forEach(t => tagSet.add(t.replace(/^#/, '')));
        }
      }
      if (cache?.tags) {
        cache.tags.forEach(t => tagSet.add(t.tag.replace(/^#/, '')));
      }

      // Extract headings
      const headings = cache?.headings ? cache.headings.map(h => h.heading) : [];

      // Determine title
      let title = cache?.frontmatter?.title;
      if (!title && headings.length > 0) {
        title = headings[0];
      }
      if (!title) {
        title = file.basename;
      }

      // Tokenize
      const tokens = new Set<string>();
      for (const t of tokenize(title)) tokens.add(t);
      for (const tag of tagSet) {
        for (const t of tokenize(tag)) tokens.add(t);
      }
      for (const h of headings) {
        for (const t of tokenize(h)) tokens.add(t);
      }
      for (const t of tokenize(content)) tokens.add(t);

      // Instant check for cached vector (0ms, avoids blocking during indexing)
      let vector: number[] | undefined = this.embeddingService.getCachedVector(file.path, file.stat.mtime);
      if (!vector && computeEmbedding && this.embeddingService.isAvailable()) {
        const textToEmbed = `${title}\n${Array.from(tagSet).map(t => '#' + t).join(' ')}\n${content.slice(0, 800)}`;
        const vec = await this.embeddingService.getDocumentVector(file.path, textToEmbed, file.stat.mtime);
        if (vec) vector = vec;
      }

      const doc: IndexedDocument = {
        path: file.path,
        title,
        content,
        tags: Array.from(tagSet),
        headings,
        mtime: file.stat.mtime,
        tokens,
        pageRank: this.pageRanks.get(file.path) || 1.0,
        vector
      };

      this.documents.set(file.path, doc);
    } catch (err: any) {
      console.error(`[EchoBrain Engine] Failed to index ${file.path}:`, err);
    }
  }

  /**
   * Remove a deleted file from index
   */
  public removeFile(path: string): void {
    this.documents.delete(path);
    this.rebuildLinkGraph();
  }

  /**
   * Rebuild link graph and compute PageRank using Obsidian's native resolvedLinks
   */
  public rebuildLinkGraph(): void {
    const resolvedLinks = this.app.metadataCache.resolvedLinks || {};
    this.backlinks.clear();

    // 1. Build backlinks from Obsidian's resolvedLinks
    for (const [sourcePath, targetMap] of Object.entries(resolvedLinks)) {
      for (const targetPath of Object.keys(targetMap)) {
        if (!this.backlinks.has(targetPath)) {
          this.backlinks.set(targetPath, new Set());
        }
        this.backlinks.get(targetPath)!.add(sourcePath);
      }
    }

    // 2. Iterative PageRank (damping 0.85, 20 iterations)
    const nodes = Array.from(this.documents.keys());
    const N = nodes.length;
    if (N === 0) return;

    let pr: Map<string, number> = new Map();
    const init = 1.0 / N;
    nodes.forEach(n => pr.set(n, init));

    for (let iter = 0; iter < 20; iter++) {
      const nextPr: Map<string, number> = new Map();
      let sinkSum = 0;

      for (const n of nodes) {
        const outDegree = Object.keys(resolvedLinks[n] || {}).length;
        if (outDegree === 0) sinkSum += pr.get(n) || 0;
      }

      const baseScore = (0.15 / N) + (0.85 * sinkSum / N);

      for (const n of nodes) {
        let incomingSum = 0;
        const incomingSources = this.backlinks.get(n);
        if (incomingSources) {
          for (const src of incomingSources) {
            const srcPr = pr.get(src) || 0;
            const srcOutDegree = Math.max(1, Object.keys(resolvedLinks[src] || {}).length);
            incomingSum += srcPr / srcOutDegree;
          }
        }
        nextPr.set(n, baseScore + 0.85 * incomingSum);
      }
      pr = nextPr;
    }

    // Normalize
    for (const [node, score] of pr.entries()) {
      const normalizedScore = isFinite(score) ? parseFloat((score * N).toFixed(4)) : 1.0;
      this.pageRanks.set(node, normalizedScore);
      const doc = this.documents.get(node);
      if (doc) doc.pageRank = normalizedScore;
    }
  }

  /**
   * Search notes using BM25 or Hybrid Graph-RAG (if embedding is available)
   */
  public async search(options: {
    query: string;
    timeFilter?: string;
    limit?: number;
    expandGraphHops?: number;
    mode?: string;
  }): Promise<SearchResultItem[]> {
    const { query, timeFilter = 'all', limit = 5, expandGraphHops = 1, mode = 'hybrid' } = options;
    const allDocs = Array.from(this.documents.values());
    if (allDocs.length === 0 || !query || !query.trim()) return [];

    const queryLower = query.toLowerCase().trim();
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const eligibleDocs = allDocs.filter(doc => {
      if (timeFilter === 'recent_month') return (now - doc.mtime) <= 30 * oneDayMs;
      if (timeFilter === 'recent_year') return (now - doc.mtime) <= 365 * oneDayMs;
      return true;
    });

    const totalDocs = eligibleDocs.length;
    if (totalDocs === 0) return [];

    // 1. BM25 calculation
    const dfMap = new Map<string, number>();
    let totalLength = 0;
    for (const doc of eligibleDocs) {
      totalLength += doc.content.length;
      for (const token of queryTokens) {
        if (doc.tokens.has(token)) {
          dfMap.set(token, (dfMap.get(token) || 0) + 1);
        }
      }
    }

    const avgdl = totalLength / totalDocs;
    const k1 = 1.2;
    const b = 0.75;
    const bm25Scored: { path: string; score: number }[] = [];

    for (const doc of eligibleDocs) {
      let bm25Score = 0;
      let matchedCount = 0;
      const docContentLower = doc.content.toLowerCase();
      const docTitleLower = doc.title.toLowerCase();

      let titleBonus = 0;
      if (docTitleLower.includes(queryLower)) titleBonus += 50;

      let tagBonus = 0;
      for (const tag of doc.tags) {
        if (tag.toLowerCase().includes(queryLower)) tagBonus += 30;
      }

      for (const token of queryTokens) {
        if (!doc.tokens.has(token)) continue;
        matchedCount++;
        const df = dfMap.get(token) || 1;
        const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
        const occurrences = (docContentLower.match(new RegExp(escapeRegExp(token), 'g')) || []).length;
        const tf = (occurrences * (k1 + 1)) / (occurrences + k1 * (1 - b + (b * doc.content.length) / avgdl));
        bm25Score += idf * tf;
      }

      if (matchedCount > 0 || titleBonus > 0 || tagBonus > 0) {
        bm25Scored.push({ path: doc.path, score: bm25Score + titleBonus + tagBonus });
      }
    }

    bm25Scored.sort((a, b) => b.score - a.score);
    const bm25RankMap = new Map<string, number>();
    bm25Scored.forEach((item, index) => bm25RankMap.set(item.path, index + 1));

    // 2. Vector search if embedding available
    const vectorRankMap = new Map<string, number>();
    const vectorSimMap = new Map<string, number>();

    if (mode !== 'bm25' && this.embeddingService.isAvailable()) {
      const queryVec = await this.embeddingService.getEmbedding(query);
      if (queryVec) {
        const vecScored: { path: string; sim: number }[] = [];
        
        // Two-stage candidate selection: Top-30 BM25 candidates + all documents with cached vectors
        const candidateSet = new Set<IndexedDocument>();
        bm25Scored.slice(0, 30).forEach(s => {
          const doc = this.documents.get(s.path);
          if (doc) candidateSet.add(doc);
        });
        for (const doc of eligibleDocs) {
          if (doc.vector && doc.vector.length > 0) {
            candidateSet.add(doc);
          }
        }

        let onDemandCount = 0;
        for (const doc of candidateSet) {
          let vec = doc.vector;
          if (!vec && onDemandCount < 15) {
            onDemandCount++;
            const textToEmbed = `${doc.title}\n${doc.tags.map(t => '#' + t).join(' ')}\n${doc.content.slice(0, 800)}`;
            const computed = await this.embeddingService.getDocumentVector(doc.path, textToEmbed, doc.mtime);
            if (computed) {
              doc.vector = computed;
              vec = computed;
            }
          }
          if (vec && vec.length > 0) {
            const sim = this.embeddingService.cosineSimilarity(queryVec, vec);
            if (sim > 0.20) {
              vecScored.push({ path: doc.path, sim });
            }
          }
        }
        vecScored.sort((a, b) => b.sim - a.sim);
        vecScored.forEach((item, index) => {
          vectorRankMap.set(item.path, index + 1);
          vectorSimMap.set(item.path, item.sim);
        });
        if (onDemandCount > 0) {
          this.embeddingService.saveCache();
        }
      }
    }

    // 3. Fusion (RRF if vector active, else BM25 directly)
    const isHybrid = mode !== 'bm25' && this.embeddingService.isAvailable() && vectorRankMap.size > 0;
    const scoredDocs: SearchResultItem[] = [];
    const candidatePaths = new Set<string>([
      ...(mode !== 'semantic' ? bm25RankMap.keys() : []),
      ...(isHybrid ? vectorRankMap.keys() : [])
    ]);

    for (const docPath of candidatePaths) {
      const doc = this.documents.get(docPath);
      if (!doc) continue;

      const bm25Rank = bm25RankMap.get(docPath);
      const vecRank = vectorRankMap.get(docPath);
      const vecSim = vectorSimMap.get(docPath) || 0;
      const rawPr = this.pageRanks.get(docPath);
      const pr = (rawPr !== undefined && !isNaN(rawPr) && isFinite(rawPr)) ? rawPr : 1.0;
      const prBoost = 1.0 + 0.15 * Math.min(pr, 5.0);

      const ageDays = (now - doc.mtime) / oneDayMs;
      const timeFactor = 1 / (1 + 0.001 * Math.max(0, ageDays));

      let totalScore = 0;
      if (isHybrid) {
        const k = 60;
        let rrf = 0;
        if (bm25Rank) rrf += 1.0 / (k + bm25Rank);
        if (vecRank) rrf += (1.0 + vecSim) / (k + vecRank);
        if (doc.title.toLowerCase().includes(queryLower)) rrf += 0.05;
        totalScore = parseFloat((rrf * prBoost * timeFactor * 100).toFixed(3));
      } else {
        const rawScore = bm25Scored.find(s => s.path === docPath)?.score || 0;
        totalScore = parseFloat((rawScore * prBoost * timeFactor).toFixed(3));
      }

      const snippet = this.generateSnippet(doc.content, queryTokens, queryLower);
      let graphNeighbors: GraphNeighborItem[] | undefined;
      if (expandGraphHops > 0) {
        const neighbors = this.getNeighbors(doc.path, expandGraphHops, 3);
        if (neighbors.length > 0) graphNeighbors = neighbors;
      }

      scoredDocs.push({
        path: doc.path,
        title: doc.title,
        snippet,
        score: totalScore,
        mtime: doc.mtime,
        tags: doc.tags,
        pageRank: pr,
        bm25Rank,
        vectorRank: vecRank,
        semanticSimilarity: vecSim > 0 ? parseFloat(vecSim.toFixed(3)) : undefined,
        graphNeighbors
      });
    }

    scoredDocs.sort((a, b) => b.score - a.score);
    return scoredDocs.slice(0, limit);
  }

  /**
   * Find connections for active editor context
   */
  public async findConnections(options: {
    currentContext: string;
    limit?: number;
    expandGraphHops?: number;
  }): Promise<SearchResultItem[]> {
    const { currentContext, limit = 3, expandGraphHops = 1 } = options;
    if (!currentContext || !currentContext.trim()) return [];

    // Semantic vector connection if available
    if (this.embeddingService.isAvailable()) {
      const contextVec = await this.embeddingService.getEmbedding(currentContext.slice(0, 800));
      if (contextVec) {
        const allDocs = Array.from(this.documents.values());
        const scored: { doc: IndexedDocument; sim: number }[] = [];
        for (const doc of allDocs) {
          if (doc.vector && doc.vector.length > 0) {
            const sim = this.embeddingService.cosineSimilarity(contextVec, doc.vector);
            if (sim > 0.35) scored.push({ doc, sim });
          }
        }
        if (scored.length > 0) {
          scored.sort((a, b) => b.sim - a.sim);
          return scored.slice(0, limit).map(({ doc, sim }) => {
            const neighbors = this.getNeighbors(doc.path, expandGraphHops, 3);
            return {
              path: doc.path,
              title: doc.title,
              snippet: doc.content.slice(0, 200).replace(/\n/g, ' ') + '...',
              score: parseFloat((sim * 100).toFixed(1)),
              mtime: doc.mtime,
              tags: doc.tags,
              pageRank: doc.pageRank,
              semanticSimilarity: parseFloat(sim.toFixed(3)),
              connectionReason: `语义深度共鸣 (${(sim * 100).toFixed(0)}%)`,
              graphNeighbors: neighbors.length > 0 ? neighbors : undefined
            };
          });
        }
      }
    }

    // Fallback: Lexical token connection
    const lines = currentContext.split('\n');
    const filteredText = lines
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('# '))
      .join(' ');
    const contextTokens = tokenize(filteredText);

    const freq = new Map<string, number>();
    for (const t of contextTokens) {
      if (t.length <= 1) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
    }

    const sortedTokens = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(entry => entry[0]);

    if (sortedTokens.length === 0) return [];

    const searchQuery = sortedTokens.slice(0, 6).join(' ');
    const results = await this.search({
      query: searchQuery,
      limit,
      expandGraphHops
    });

    for (const res of results) {
      const doc = this.documents.get(res.path);
      if (!doc) continue;
      const matched = sortedTokens.filter(t => doc.tokens.has(t));
      res.connectionReason = matched.length > 0 ? `命中关键词 [${matched.slice(0, 4).join(', ')}]` : '上下文语义关联';
    }

    return results;
  }

  /**
   * Traverse neighborhood using Obsidian's resolvedLinks & backlinks
   */
  public getNeighbors(path: string, maxHops: number = 1, limit: number = 6): GraphNeighborItem[] {
    const doc = this.getDocument(path);
    const targetPath = doc ? doc.path : path;
    const resolvedLinks = this.app.metadataCache.resolvedLinks || {};
    const results: GraphNeighborItem[] = [];
    const visited = new Set<string>([targetPath]);
    const queue: [string, number][] = [[targetPath, 0]];

    while (queue.length > 0 && results.length < limit) {
      const [curr, hops] = queue.shift()!;
      if (hops >= maxHops) continue;

      // 1. Forward links
      const forwardMap = resolvedLinks[curr] || {};
      for (const target of Object.keys(forwardMap)) {
        if (!visited.has(target)) {
          visited.add(target);
          const neighborDoc = this.documents.get(target);
          results.push({
            path: target,
            title: neighborDoc?.title || target.replace(/\.md$/, ''),
            relation: 'cites',
            hops: hops + 1
          });
          queue.push([target, hops + 1]);
          if (results.length >= limit) break;
        }
      }

      if (results.length >= limit) break;

      // 2. Backlinks
      const backSet = this.backlinks.get(curr) || new Set();
      for (const source of backSet) {
        if (!visited.has(source)) {
          visited.add(source);
          const neighborDoc = this.documents.get(source);
          results.push({
            path: source,
            title: neighborDoc?.title || source.replace(/\.md$/, ''),
            relation: 'cited_by',
            hops: hops + 1
          });
          queue.push([source, hops + 1]);
          if (results.length >= limit) break;
        }
      }
    }

    return results;
  }

  /**
   * Get direct incoming and outgoing links for a document
   */
  public getLinkDetails(path: string): { forwardLinks: string[]; backlinks: string[] } {
    const doc = this.getDocument(path);
    const targetPath = doc ? doc.path : path;
    const resolvedLinks = this.app.metadataCache.resolvedLinks || {};
    const forwardLinks = Object.keys(resolvedLinks[targetPath] || {});
    const backSet = this.backlinks.get(targetPath) || new Set();
    const backlinks = Array.from(backSet);
    return { forwardLinks, backlinks };
  }

  /**
   * Save an insight to the Inbox folder using Obsidian native app.vault API with automatic graph weaving
   */
  public async saveInsight(options: {
    title: string;
    content: string;
    tags?: string[];
    category?: string
  }): Promise<{ filePath: string; connectedNotes: string[] }> {
    const inboxPath = (this.inboxFolder || 'Inbox').replace(/\\/g, '/').replace(/\/+$/, '').trim();
    
    // Ensure inbox folder exists
    if (inboxPath) {
      const folder = this.app.vault.getAbstractFileByPath(inboxPath);
      if (!folder) {
        try {
          await this.app.vault.createFolder(inboxPath);
        } catch {
          // Folder may have been created concurrently or already exists
        }
      }
    }

    const now = new Date();
    const datePrefix = now.toISOString().slice(0, 10);
    const cleanTitle = options.title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '_').slice(0, 50);
    const baseName = `${datePrefix}-${cleanTitle}`;
    let filePath = inboxPath ? `${inboxPath}/${baseName}.md` : `${baseName}.md`;

    // Avoid collision
    if (this.app.vault.getAbstractFileByPath(filePath)) {
      const suffix = Date.now().toString().slice(-4);
      filePath = inboxPath
        ? `${inboxPath}/${baseName}-${suffix}.md`
        : `${baseName}-${suffix}.md`;
    }

    // Auto-link discovery: Discover 2~3 existing related notes to weave new insight into personal graph
    let autoLinksSection = '';
    const connectedNotes: string[] = [];
    try {
      const suggestedConnections = await this.findConnections({
        currentContext: `${options.title}\n${options.content.slice(0, 1000)}`,
        limit: 3,
        expandGraphHops: 1
      });

      if (suggestedConnections.length > 0) {
        const linkItems: string[] = [];
        for (const c of suggestedConnections) {
          linkItems.push(`- [[${c.title}]] (${c.connectionReason || '知识拓扑高度共鸣'})`);
          connectedNotes.push(c.title);
        }
        autoLinksSection = `\n\n---\n## 🔗 推荐关联知识网络\n${linkItems.join('\n')}\n`;
      }
    } catch (e) {
      console.warn('[EchoBrain] Auto-weaving failed:', e);
    }

    const tagsArr = options.tags || ['agent-insight'];
    const frontmatterLines = [
      '---',
      `title: "${options.title.replace(/"/g, '\\"')}"`,
      `created_at: ${now.toISOString()}`,
      `source: "echobrain-local-plugin"`,
      `tags: [${tagsArr.map(t => `"${t}"`).join(', ')}]`
    ];
    if (options.category) {
      frontmatterLines.push(`category: "${options.category}"`);
    }
    frontmatterLines.push('---', '', `# ${options.title}`, '', options.content.trim() + autoLinksSection, '');

    const fileContent = frontmatterLines.join('\n');
    const newFile = await this.app.vault.create(filePath, fileContent);
    await this.indexFile(newFile);
    this.rebuildLinkGraph();

    return { filePath, connectedNotes };
  }

  public getDocument(path: string): IndexedDocument | undefined {
    if (!path) return undefined;

    // 1. Direct path lookup
    let clean = path.trim().replace(/^\[\[|\]\]$/g, '').trim();
    if (this.documents.has(clean)) {
      return this.documents.get(clean);
    }

    // 2. Normalized slashes
    clean = clean.replace(/\\/g, '/');
    if (this.documents.has(clean)) {
      return this.documents.get(clean);
    }

    // 3. With .md appended
    if (!clean.endsWith('.md') && this.documents.has(clean + '.md')) {
      return this.documents.get(clean + '.md');
    }

    // 4. Exact basename or title match (case-insensitive)
    const lowerClean = clean.toLowerCase();
    const cleanWithoutExt = lowerClean.endsWith('.md') ? lowerClean.slice(0, -3) : lowerClean;
    const baseTarget = cleanWithoutExt.split('/').pop() || cleanWithoutExt;

    for (const [docPath, doc] of this.documents.entries()) {
      const docPathLower = docPath.toLowerCase();
      const docTitleLower = (doc.title || '').toLowerCase();
      const docBase = docPathLower.split('/').pop()?.replace(/\.md$/, '') || '';

      if (docPathLower === lowerClean || docPathLower === lowerClean + '.md') {
        return doc;
      }
      if (docBase === baseTarget || docTitleLower === cleanWithoutExt) {
        return doc;
      }
    }

    // 5. Suffix match (e.g. "FastAPI.md" matches "01-Tech/FastAPI.md")
    for (const [docPath, doc] of this.documents.entries()) {
      const docPathLower = docPath.toLowerCase();
      if (docPathLower.endsWith('/' + lowerClean) || docPathLower.endsWith('/' + lowerClean + '.md')) {
        return doc;
      }
    }

    return undefined;
  }

  public getStats() {
    const allTags = new Set<string>();
    let vectorCount = 0;
    for (const doc of this.documents.values()) {
      for (const t of doc.tags) allTags.add(t);
      if (doc.vector && doc.vector.length > 0) vectorCount++;
    }

    const topHubs = Array.from(this.documents.values())
      .sort((a, b) => {
        const prA = isFinite(a.pageRank) ? a.pageRank : 1.0;
        const prB = isFinite(b.pageRank) ? b.pageRank : 1.0;
        return prB - prA;
      })
      .slice(0, 5)
      .map(d => ({
        path: d.path,
        title: d.title,
        pageRank: isFinite(d.pageRank) ? d.pageRank : 1.0,
        inDegree: this.backlinks.get(d.path)?.size || 0
      }));

    return {
      totalNotes: this.documents.size,
      totalTags: allTags.size,
      uniqueTags: Array.from(allTags).sort(),
      vectorsIndexed: vectorCount,
      embeddingAvailable: this.embeddingService.isAvailable(),
      topHubs
    };
  }

  private generateSnippet(content: string, tokens: string[], fullQuery: string): string {
    if (!content) return '';
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return '';

    if (fullQuery) {
      const lower = fullQuery.toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lower)) {
          return lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)).join('\n');
        }
      }
    }

    let bestLineIndex = 0;
    let maxMatch = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      let matches = 0;
      for (const t of tokens) if (l.includes(t)) matches++;
      if (matches > maxMatch) {
        maxMatch = matches;
        bestLineIndex = i;
      }
    }

    const start = Math.max(0, bestLineIndex - 1);
    const end = Math.min(lines.length, bestLineIndex + 3);
    const text = lines.slice(start, end).join('\n');
    return text.length > 300 ? text.slice(0, 300) + '...' : text;
  }
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
