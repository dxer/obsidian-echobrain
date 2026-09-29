const STOPWORDS = new Set([
  'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'to', 'in', 'of', 'for', 'with', 'by',
  'from', 'as', 'that', 'this', 'these', 'those', 'it', 'its', 'be', 'are', 'was', 'were', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'but', 'not', 'can', 'could', 'will', 'would', 'should',
  'all', 'any', 'about', 'into', 'then',
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到',
  '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这',
  '可以', '进行', '通过', '使用', '以及', '或者', '因为', '所以', '但是', '如果', '需要', '关于',
  '对于', '我们', '他们', '它们', '这个', '那个', '这些', '那些', '比如', '例如', '包括', '其中',
  '并且', '而且', '从而', '因此', '另外', '此外', '为了', '之后', '之前', '现在', '随后', '此时',
  '根据', '基于', '按照', '由于', '等等', '一些', '某个', '某些', '相关', '针对'
]);

/**
 * Split camelCase and PascalCase into constituent subwords
 * e.g. "getUserProfile" -> ["get", "User", "Profile"]
 * e.g. "XMLHttpParser" -> ["XML", "Http", "Parser"]
 */
function splitCamelCase(word: string): string[] {
  if (!word || word.length <= 1) return [];
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

export function tokenize(text: string): string[] {
  if (!text || typeof text !== 'string') return [];

  const tokens: string[] = [];

  // 1. Match code identifiers and English words with case preservation for CamelCase extraction
  const rawIdentifiers = text.match(/[A-Za-z0-9_\-\.]+/g) || [];
  for (const rawId of rawIdentifiers) {
    const lowerId = rawId.toLowerCase();
    if (lowerId.length > 1 && !STOPWORDS.has(lowerId)) {
      tokens.push(lowerId);
    }

    // Split by punctuation: underscore, hyphen, dot
    const punctParts = rawId.split(/[_\-\.]+/).filter(p => p.length > 1);
    for (const part of punctParts) {
      const lowerPart = part.toLowerCase();
      if (!STOPWORDS.has(lowerPart)) {
        tokens.push(lowerPart);
      }

      // CamelCase / PascalCase subword decomposition
      const camelParts = splitCamelCase(part);
      if (camelParts.length > 1) {
        for (const cp of camelParts) {
          const lowerCp = cp.toLowerCase();
          if (lowerCp.length > 1 && !STOPWORDS.has(lowerCp)) {
            tokens.push(lowerCp);
          }
        }
      }
    }
  }

  // 2. Match Chinese character segments
  const chineseMatches = text.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const segment of chineseMatches) {
    const chars = Array.from(segment);
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      if (!STOPWORDS.has(char)) {
        tokens.push(char);
      }
      if (i < chars.length - 1) {
        const bigram = chars[i] + chars[i + 1];
        if (!STOPWORDS.has(bigram)) {
          tokens.push(bigram);
        }
      }
      if (i < chars.length - 2) {
        tokens.push(chars[i] + chars[i + 1] + chars[i + 2]);
      }
    }
  }

  return Array.from(new Set(tokens));
}
