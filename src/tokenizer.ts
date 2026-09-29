const STOPWORDS = new Set([
  'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'to', 'in', 'of', 'for', 'with', 'by',
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这'
]);

export function tokenize(text: string): string[] {
  if (!text || typeof text !== 'string') return [];

  const raw = text.toLowerCase();
  const tokens: string[] = [];

  // Match English words and code identifiers
  const englishMatches = raw.match(/[a-z0-9_\-\.]+/g) || [];
  for (const m of englishMatches) {
    if (m.length > 1 && !STOPWORDS.has(m)) {
      tokens.push(m);
      const subWords = m.split(/[_\-\.]+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
      if (subWords.length > 1) {
        tokens.push(...subWords);
      }
    }
  }

  // Match Chinese character segments
  const chineseMatches = raw.match(/[\u4e00-\u9fa5]+/g) || [];
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

  return tokens;
}
