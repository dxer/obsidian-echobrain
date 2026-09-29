import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

console.log('📦 正在生成 EchoBrain Local 生产发布 Bundle...\n');

// 1. 触发 esbuild 生产构建
console.log('[1/4] 执行 esbuild 生产环境打包 (Target: ES2022, Platform: Node)...');
execSync('node esbuild.config.mjs production', { stdio: 'inherit' });

// 2. 检查必需产物文件
const REQUIRED_FILES = ['main.js', 'manifest.json', 'styles.css'];
for (const file of REQUIRED_FILES) {
  if (!fs.existsSync(file)) {
    throw new Error(`缺少核心产物文件: ${file}`);
  }
}

// 3. 准备 dist 目录
console.log('[2/4] 组装标准化插件目录结构...');
const rootDist = path.resolve('dist');
const pluginDist = path.join(rootDist, 'echobrain-local');

if (fs.existsSync(rootDist)) {
  fs.rmSync(rootDist, { recursive: true, force: true });
}
fs.mkdirSync(pluginDist, { recursive: true });

for (const file of REQUIRED_FILES) {
  fs.copyFileSync(file, path.join(pluginDist, file));
}

// 4. 压缩为 zip 包
console.log('[3/4] 打包生成可分发 Release Zip 包...');
const zipName = 'echobrain-local.zip';
const zipPath = path.resolve(zipName);
const distZipPath = path.join(rootDist, zipName);

if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

const isWindows = process.platform === 'win32';
if (isWindows) {
  // PowerShell Compress-Archive
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${pluginDist}' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'inherit' }
  );
} else {
  // Unix zip
  execSync(`cd dist && zip -r ../${zipName} echobrain-local`, { stdio: 'inherit' });
}

// 复制一份到 dist 目录下
fs.copyFileSync(zipPath, distZipPath);

// 5. 生成校验摘要
console.log('\n[4/4] 校验 Bundle 文件完整性:');
function getFileInfo(filePath) {
  const stat = fs.statSync(filePath);
  const buffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const sizeKb = (stat.size / 1024).toFixed(1);
  return { size: `${sizeKb} KB`, sha256 };
}

console.log('------------------------------------------------------------');
console.log(`📁 插件发布目录: ${path.relative(process.cwd(), pluginDist)}`);
for (const f of REQUIRED_FILES) {
  const info = getFileInfo(path.join(pluginDist, f));
  console.log(`   - ${f.padEnd(16)} | 大小: ${info.size.padEnd(10)} | SHA256: ${info.sha256}`);
}
console.log('------------------------------------------------------------');
const zipInfo = getFileInfo(zipPath);
console.log(`🎁 可分发 Zip 包: ${zipName}`);
console.log(`   - 路径: ${zipPath}`);
console.log(`   - 大小: ${zipInfo.size} | SHA256: ${zipInfo.sha256}`);
console.log('------------------------------------------------------------\n');

console.log('🎉 Bundle 生成成功！可以直接解压安装到任何 Obsidian 库的 `.obsidian/plugins/` 目录中。');
