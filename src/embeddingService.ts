import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { pipeline, env } from '@xenova/transformers';
import * as ort from 'onnxruntime-web';
import { EmbeddingMode, EchoBrainPluginSettings } from './types.js';

// Configure WebAssembly ONNX engine
env.backends.onnx = ort as any;
env.remoteHost = 'https://hf-mirror.com/';

export interface CachedVector {
  mtime: number;
  vector: number[];
}

const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx'
];

export class PluginEmbeddingService {
  private vaultBasePath: string;
  private settings: EchoBrainPluginSettings;
  private extractor: any = null;
  private vectorCache: Map<string, CachedVector> = new Map();
  private cacheFilePath: string;
  private modelsDirPath: string;
  private isCacheDirty: boolean = false;
  private isDownloading: boolean = false;

  constructor(vaultBasePath: string, settings: EchoBrainPluginSettings) {
    this.vaultBasePath = vaultBasePath;
    this.settings = settings;
    const cacheDir = path.join(vaultBasePath, '.echobrain');
    this.cacheFilePath = path.join(cacheDir, 'embeddings-cache.json');
    this.modelsDirPath = path.join(cacheDir, 'models');
    this.loadCache();
  }

  public updateSettings(settings: EchoBrainPluginSettings) {
    this.settings = settings;
    if (settings.embeddingMode !== 'local') {
      this.extractor = null;
    }
  }

  public isAvailable(): boolean {
    if (this.settings.embeddingMode === 'none') return false;
    if (this.settings.embeddingMode === 'api') {
      return Boolean(this.settings.apiBaseUrl);
    }
    if (this.settings.embeddingMode === 'local') {
      return this.extractor !== null || this.isLocalModelComplete();
    }
    return false;
  }

  public isLocalModelComplete(): boolean {
    const targetDir = path.join(this.modelsDirPath, 'Xenova', 'bge-small-zh-v1.5');
    for (const f of MODEL_FILES) {
      const full = path.join(targetDir, f);
      if (!fsSync.existsSync(full)) return false;
      const stat = fsSync.statSync(full);
      if (stat.size === 0) return false;
    }
    // Also check wasm runtime
    const wasmFile = path.join(this.modelsDirPath, 'wasm', 'ort-wasm-simd.wasm');
    if (!fsSync.existsSync(wasmFile)) return false;

    return true;
  }

  public getCachedVector(relativePath: string, mtime?: number): number[] | undefined {
    const cached = this.vectorCache.get(relativePath);
    if (!cached) return undefined;
    if (mtime !== undefined && cached.mtime !== mtime) return undefined;
    return cached.vector;
  }

  /**
   * Load cache from disk
   */
  private async loadCache(): Promise<void> {
    try {
      if (fsSync.existsSync(this.cacheFilePath)) {
        const data = await fs.readFile(this.cacheFilePath, 'utf-8');
        const json = JSON.parse(data);
        for (const [k, v] of Object.entries(json)) {
          this.vectorCache.set(k, v as CachedVector);
        }
      }
    } catch (e) {
      console.warn('[EchoBrain Embedding] Cache load error:', e);
    }
  }

  public async saveCache(): Promise<void> {
    if (!this.isCacheDirty) return;
    try {
      const cacheDir = path.dirname(this.cacheFilePath);
      if (!fsSync.existsSync(cacheDir)) {
        await fs.mkdir(cacheDir, { recursive: true });
      }
      const obj: Record<string, CachedVector> = {};
      for (const [k, v] of this.vectorCache.entries()) {
        obj[k] = v;
      }
      await fs.writeFile(this.cacheFilePath, JSON.stringify(obj), 'utf-8');
      this.isCacheDirty = false;
    } catch (e) {
      console.error('[EchoBrain Embedding] Cache save error:', e);
    }
  }

  /**
   * Initialize local WebAssembly ONNX pipeline if local model is downloaded
   */
  public async initLocalPipeline(): Promise<boolean> {
    if (this.extractor) return true;
    if (!this.isLocalModelComplete()) return false;

    try {
      const ortActual = (ort as any).default || ort;
      const wasmDir = path.join(this.modelsDirPath, 'wasm') + path.sep;
      if (ortActual?.env?.wasm) {
        ortActual.env.wasm.wasmPaths = wasmDir;
        ortActual.env.wasm.numThreads = 1;
      }
      env.backends.onnx = ortActual;
      env.localModelPath = this.modelsDirPath;
      env.allowRemoteModels = false;
      this.extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', {
        quantized: true
      });
      console.log('[EchoBrain Embedding] Local WASM ONNX model initialized successfully.');
      return true;
    } catch (err: any) {
      console.error('[EchoBrain Embedding] Failed to init local ONNX pipeline:', err);
      this.extractor = null;
      return false;
    }
  }

  /**
   * Download the 40MB bge-small-zh model on-demand with progress callback using robust Node streaming
   */
  public async downloadLocalModel(
    onProgress: (percent: number, statusText: string) => void
  ): Promise<boolean> {
    if (this.isDownloading) return false;
    this.isDownloading = true;

    try {
      const targetDir = path.join(this.modelsDirPath, 'Xenova', 'bge-small-zh-v1.5');
      await fs.mkdir(path.join(targetDir, 'onnx'), { recursive: true });
      const wasmDir = path.join(this.modelsDirPath, 'wasm');
      await fs.mkdir(wasmDir, { recursive: true });

      // 1. Prepare wasm runtime file first if not exists
      const wasmDest = path.join(wasmDir, 'ort-wasm-simd.wasm');
      if (!fsSync.existsSync(wasmDest) || fsSync.statSync(wasmDest).size === 0) {
        onProgress(3, '正在获取 WebAssembly 运行环境 (ort-wasm)...');

        // Check if available locally first (e.g. in node_modules or plugin folder)
        let copiedLocally = false;
        const localCandidates = [
          path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm'),
          path.resolve(__dirname, 'node_modules/@xenova/transformers/dist/ort-wasm-simd.wasm'),
          path.resolve(this.vaultBasePath, '.obsidian/plugins/echobrain-local/ort-wasm-simd.wasm')
        ];
        for (const cand of localCandidates) {
          if (fsSync.existsSync(cand) && fsSync.statSync(cand).size > 0) {
            try {
              fsSync.copyFileSync(cand, wasmDest);
              copiedLocally = true;
              console.log('[EchoBrain Embedding] Copied ort-wasm-simd.wasm from local module:', cand);
              break;
            } catch {}
          }
        }

        if (!copiedLocally) {
          const wasmUrls = [
            'https://cdn.bootcdn.net/ajax/libs/onnxruntime-web/1.14.0/ort-wasm-simd.wasm',
            'https://registry.npmmirror.com/onnxruntime-web/1.14.0/files/dist/ort-wasm-simd.wasm',
            'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort-wasm-simd.wasm'
          ];
          await this.downloadSingleFileWithFallback(
            wasmUrls,
            wasmDest,
            (received, total) => {
              if (total > 0) {
                const mbRec = (received / (1024 * 1024)).toFixed(1);
                const mbTot = (total / (1024 * 1024)).toFixed(1);
                const pct = Math.min(10, Math.floor((received / total) * 10));
                onProgress(pct, `下载运行时 ort-wasm-simd.wasm (${mbRec}MB / ${mbTot}MB)`);
              }
            }
          );
        }
      }

      // 2. Download model files with Multi-Source Fallback (ModelScope -> HF-Mirror -> HuggingFace)
      let totalFiles = MODEL_FILES.length;

      for (let i = 0; i < totalFiles; i++) {
        const fileRel = MODEL_FILES[i];
        const destFile = path.join(targetDir, fileRel);
        const fileName = path.basename(fileRel);

        // Check if file is already valid
        if (fsSync.existsSync(destFile) && fsSync.statSync(destFile).size > 0) {
          const basePercent = 10 + Math.floor(((i + 1) / totalFiles) * 85);
          onProgress(basePercent, `[已存在] ${fileName}`);
          continue;
        }

        const candidateUrls = [
          // 1. ModelScope (Alibaba Open Source Hub - ultra fast in China, direct OSS download)
          `https://modelscope.cn/api/v1/models/Xenova/bge-small-zh-v1.5/repo?Revision=master&FilePath=${encodeURIComponent(fileRel)}`,
          // 2. HF-Mirror
          `https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/${fileRel}`,
          // 3. Official Hugging Face
          `https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/${fileRel}`
        ];

        const basePercent = 10 + Math.floor((i / totalFiles) * 85);
        onProgress(basePercent, `正在拉取 [${i + 1}/${totalFiles}] ${fileName}...`);

        await this.downloadSingleFileWithFallback(candidateUrls, destFile, (received, total) => {
          if (total > 0) {
            const fileFraction = received / total;
            const currentPercent = Math.min(98, Math.floor(basePercent + fileFraction * (85 / totalFiles)));
            const mbReceived = (received / (1024 * 1024)).toFixed(1);
            const mbTotal = (total / (1024 * 1024)).toFixed(1);
            onProgress(
              currentPercent,
              `下载中 [${i + 1}/${totalFiles}] ${fileName} (${mbReceived}MB / ${mbTotal}MB)`
            );
          }
        });
      }

      onProgress(100, '模型权重拉取完成！正在加载向量引擎...');
      const ok = await this.initLocalPipeline();
      this.isDownloading = false;
      return ok;
    } catch (err: any) {
      this.isDownloading = false;
      console.error('[EchoBrain Embedding] Download failed:', err);
      throw err;
    }
  }

  /**
   * Download a single file trying multiple source URLs with streaming and redirect handling
   */
  private async downloadSingleFileWithFallback(
    candidateUrls: string[],
    destPath: string,
    onByteProgress?: (receivedBytes: number, totalBytes: number) => void
  ): Promise<void> {
    let lastError: Error | null = null;
    for (const url of candidateUrls) {
      try {
        await this.streamDownload(url, destPath, onByteProgress);
        if (fsSync.existsSync(destPath) && fsSync.statSync(destPath).size > 0) {
          return;
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`[EchoBrain Embedding] Download failed from ${url}, switching to next source. Reason:`, err.message);
      }
    }
    throw lastError || new Error(`Failed to download ${path.basename(destPath)} from all available sources.`);
  }

  /**
   * Pure Node.js streaming download with automatic redirect handling (Bypasses browser CORS & fetch limitations)
   */
  private streamDownload(
    urlStr: string,
    destPath: string,
    onProgress?: (receivedBytes: number, totalBytes: number) => void,
    maxRedirects = 8
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        return reject(new Error(`Too many redirects when downloading ${urlStr}`));
      }

      try {
        const u = new URL(urlStr);
        const mod = u.protocol === 'https:' ? https : http;
        const tmpPath = `${destPath}.tmp-${Date.now()}`;
        const dir = path.dirname(destPath);
        if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });

        const req = mod.get(u, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EchoBrain-Downloader',
            'Accept': '*/*'
          }
        }, (res) => {
          // Handle redirects
          if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            const nextUrl = new URL(res.headers.location, urlStr).href;
            res.resume();
            resolve(this.streamDownload(nextUrl, destPath, onProgress, maxRedirects - 1));
            return;
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} from ${u.hostname}`));
          }

          const totalBytes = Number(res.headers['content-length']) || 0;
          let receivedBytes = 0;
          const fileStream = fsSync.createWriteStream(tmpPath);

          res.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.length;
            fileStream.write(chunk);
            if (onProgress && totalBytes > 0) {
              onProgress(receivedBytes, totalBytes);
            }
          });

          res.on('end', () => {
            fileStream.end(() => {
              try {
                if (fsSync.existsSync(destPath)) {
                  fsSync.unlinkSync(destPath);
                }
                fsSync.renameSync(tmpPath, destPath);
                resolve();
              } catch (e) {
                reject(e);
              }
            });
          });

          res.on('error', (err) => {
            fileStream.destroy();
            try { if (fsSync.existsSync(tmpPath)) fsSync.unlinkSync(tmpPath); } catch {}
            reject(err);
          });

          fileStream.on('error', (err) => {
            try { if (fsSync.existsSync(tmpPath)) fsSync.unlinkSync(tmpPath); } catch {}
            reject(err);
          });
        });

        req.on('error', (err) => {
          reject(err);
        });

        // 60s socket timeout
        req.setTimeout(60000, () => {
          req.destroy();
          reject(new Error(`Connection timeout for ${u.hostname}`));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Compute normalized vector for text
   */
  public async getEmbedding(text: string): Promise<number[] | null> {
    if (!text || !text.trim() || !this.isAvailable()) return null;

    if (this.settings.embeddingMode === 'api') {
      return this.fetchApiEmbedding(text);
    }

    if (this.settings.embeddingMode === 'local') {
      if (!this.extractor) {
        await this.initLocalPipeline();
      }
      if (!this.extractor) return null;

      try {
        const clean = text.slice(0, 1000);
        const output = await this.extractor(clean, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
      } catch (err) {
        console.error('[EchoBrain Embedding] Local inference error:', err);
        return null;
      }
    }

    return null;
  }

  /**
   * Fetch embedding from standard OpenAI-compatible /v1/embeddings endpoint using Node HTTP/HTTPS (CORS-free)
   */
  private async fetchApiEmbedding(text: string): Promise<number[] | null> {
    return new Promise((resolve) => {
      try {
        const cleanUrl = this.settings.apiBaseUrl.replace(/\/+$/, '');
        const endpoint = cleanUrl.endsWith('/embeddings') ? cleanUrl : `${cleanUrl}/embeddings`;
        const u = new URL(endpoint);
        const mod = u.protocol === 'https:' ? https : http;

        const body = JSON.stringify({
          model: this.settings.apiModel || 'text-embedding-3-small',
          input: text.slice(0, 2000)
        });

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'User-Agent': 'Mozilla/5.0 EchoBrain-Embedding'
        };
        if (this.settings.apiKey) {
          headers['Authorization'] = `Bearer ${this.settings.apiKey}`;
        }

        const req = mod.request(u, {
          method: 'POST',
          headers
        }, (res) => {
          let resData = '';
          res.on('data', chunk => resData += chunk);
          res.on('end', () => {
            try {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                const data = JSON.parse(resData);
                if (data?.data?.[0]?.embedding) {
                  return resolve(data.data[0].embedding);
                }
              }
              resolve(null);
            } catch {
              resolve(null);
            }
          });
        });

        req.on('error', (e) => {
          console.error('[EchoBrain Embedding] API error:', e.message);
          resolve(null);
        });

        req.setTimeout(15000, () => {
          req.destroy();
          resolve(null);
        });

        req.write(body);
        req.end();
      } catch (err: any) {
        console.error('[EchoBrain Embedding] API exception:', err.message);
        resolve(null);
      }
    });
  }

  public async getDocumentVector(
    relativePath: string,
    content: string,
    mtime: number
  ): Promise<number[] | null> {
    const cached = this.vectorCache.get(relativePath);
    if (cached && cached.mtime === mtime && cached.vector?.length > 0) {
      return cached.vector;
    }

    const vector = await this.getEmbedding(content);
    if (vector) {
      this.vectorCache.set(relativePath, { mtime, vector });
      this.isCacheDirty = true;
    }
    return vector;
  }

  public cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
