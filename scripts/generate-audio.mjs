import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

// Run locally with OPENAI_API_KEY. Never put credentials into the website.
const root = fileURLToPath(new URL('../', import.meta.url));
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY is required.');
const html = await readFile(join(root, 'index.html'), 'utf8');
const match = html.match(/const BASE = (\[[\s\S]*?\n\]);/);
if (!match) throw new Error('BASE verses not found.');
const verses = vm.runInNewContext('(' + match[1] + ')', {}, { timeout: 1000 });
const model = 'gpt-4o-mini-tts';
const voice = 'marin';
const instructions = '한국어 성경 암송 연습용 낭독입니다. 표준 한국어 발음으로 차분하고 따뜻하며 또렷하게 읽으세요. 평소 대화보다 조금 느리게, 의미 단위마다 짧게 쉬어 주세요. 입력 본문을 처음부터 끝까지 한 글자도 빼거나 추가하거나 바꾸지 않고 그대로 읽으세요. 제목, 인사, 설명, 성경 주소를 추가하지 마세요. 배경음악과 효과음은 넣지 마세요.';
const dir = join(root, 'audio');
await mkdir(dir, { recursive: true });
const entries = [];
for (const verse of verses) {
  const hash = createHash('sha256').update(JSON.stringify({ text: verse.text, model, voice, instructions })).digest('hex').slice(0, 20);
  const filename = 'verse-' + hash + '.mp3';
  const path = join(dir, filename);
  const exists = await stat(path).then(s => s.size > 1000).catch(() => false);
  if (!exists) {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice, input: verse.text, instructions, response_format: 'mp3' }),
      signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) {
      // Do not log request headers or response bodies that might contain sensitive data.
      throw new Error('Speech generation failed: HTTP ' + response.status + ' for ' + verse.ref);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1000) throw new Error('Empty audio for ' + verse.ref);
    await writeFile(path, bytes);
  }
  entries.push({ ref: verse.ref, text: verse.text, file: 'audio/' + filename });
  console.log((exists ? 'Reused: ' : 'Generated: ') + verse.ref);
}
await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version: 1, model, voice, aiGenerated: true, verses: entries }, null, 2) + '\n');
console.log('Ready: ' + entries.length + ' recordings.');
