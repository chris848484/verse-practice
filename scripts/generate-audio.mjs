import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

// Local generation only: OPENAI_API_KEY and FFmpeg (FFMPEG_PATH or PATH).
const root = fileURLToPath(new URL('../', import.meta.url));
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY is required.');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
execFileSync(ffmpeg, ['-version'], { stdio: 'ignore', windowsHide: true });
const html = await readFile(join(root, 'index.html'), 'utf8');
const match = html.match(/const BASE = (\[[\s\S]*?\n\]);/);
if (!match) throw new Error('BASE verses not found.');
const verses = vm.runInNewContext('(' + match[1] + ')', {}, { timeout: 1000 });
const model = 'gpt-4o-mini-tts';
const voice = 'marin';
// Keep body settings stable to reuse previously checked recordings.
const bodyInstructions = '한국어 성경 암송 연습용 낭독입니다. 표준 한국어 발음으로 차분하고 따뜻하며 또렷하게 읽으세요. 평소 대화보다 조금 느리게, 의미 단위마다 짧게 쉬어 주세요. 입력 본문을 처음부터 끝까지 한 글자도 빼거나 추가하거나 바꾸지 않고 그대로 읽으세요. 제목, 인사, 설명, 성경 주소를 추가하지 마세요. 배경음악과 효과음은 넣지 마세요.';
const referenceInstructions = '한국어 성경 암송 연습용 말씀 주소 낭독입니다. 입력된 성경 주소만 정확하게 한 번 읽으세요. 표준 한국어 발음으로 차분하고 따뜻하며 또렷하게, 평소 대화보다 조금 느리게 읽으세요. 장과 절의 숫자는 자연스러운 한국어로 읽으세요. 인사, 해설, 배경음악, 효과음을 추가하지 마세요.';
const bookNames = {
  '고후': '고린도후서', '요일': '요한일서', '계': '요한계시록',
  '살전': '데살로니가전서', '마': '마태복음', '요': '요한복음',
  '빌': '빌립보서', '벧전': '베드로전서'
};
function spokenReference(ref) {
  const parts = ref.match(/^(\S+)\s+(\d+):(\d+)(?:-(\d+))?$/);
  if (!parts || !bookNames[parts[1]]) throw new Error('Add a full book name for ' + ref);
  const [, book, chapter, first, last] = parts;
  return bookNames[book] + ' ' + chapter + '장 ' + first + '절' + (last ? '에서 ' + last + '절' : '');
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const exists = path => stat(path).then(s => s.size > 1000).catch(() => false);
const dir = join(root, 'audio');
const partsDir = join(dir, '.parts');
await mkdir(partsDir, { recursive: true });
async function generate(input, instructions, path) {
  if (await exists(path)) return;
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, voice, input, instructions, response_format: 'mp3' }),
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error('Speech generation failed: HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000) throw new Error('Empty audio');
  await writeFile(path, bytes);
}
const entries = [];
for (const verse of verses) {
  const spokenRef = spokenReference(verse.ref);
  const bodyHash = digest({ text: verse.text, model, voice, instructions: bodyInstructions });
  const oldBody = join(dir, 'verse-' + bodyHash + '.mp3');
  const body = await exists(oldBody) ? oldBody : join(partsDir, 'body-' + bodyHash + '.mp3');
  const refHash = digest({ input: spokenRef, model, voice, instructions: referenceInstructions });
  const reference = join(partsDir, 'reference-' + refHash + '.mp3');
  await generate(verse.text, bodyInstructions, body);
  await generate(spokenRef, referenceInstructions, reference);
  const hash = digest({ bodyHash, refHash, layout: 'reference-body-reference', gap: 0.8, version: 1 });
  const filename = 'verse-' + hash + '.mp3';
  const path = join(dir, filename);
  if (!(await exists(path))) {
    // Reuse exactly the same reference recording at both ends. No generative omission.
    const filter = '[0:a]asplit=2[first][last];[1:a]atrim=duration=0.8,asplit=2[gap1][gap2];[first][gap1][2:a][gap2][last]concat=n=5:v=0:a=1[out]';
    execFileSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', reference, '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-i', body,
      '-filter_complex', filter, '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '128k', path],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  }
  entries.push({ ref: verse.ref, text: verse.text, spokenRef,
    narration: spokenRef + '.\n\n' + verse.text + '.\n\n' + spokenRef + '.',
    file: 'audio/' + filename });
  console.log('Ready: ' + verse.ref);
}
await writeFile(join(dir, 'manifest.json'), JSON.stringify({
  version: 2, model, voice, aiGenerated: true, layout: 'reference-body-reference', verses: entries
}, null, 2) + '\n');
console.log('Ready: ' + entries.length + ' recordings.');
