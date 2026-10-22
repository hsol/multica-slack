// Slack 없이 Multica API 만으로 생성되는 Work Object metadata 를 출력한다.
// node scripts/unfurl/dry-run.js https://<multica 웹 주소>/<workspace>/issues/ABC-123
import { buildEntity } from '../../src/features/unfurl/entity.js';

const url = process.argv[2];
const card = await buildEntity(url);
const detail = await buildEntity(url, { detail: true });
console.log(JSON.stringify({ card, detail }, null, 2));
