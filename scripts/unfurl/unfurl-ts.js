// 이미 올라간 메시지(channel, ts)에 Work Object 카드를 직접 붙여 본다. Slack 스키마 검증용.
// node --env-file=.env scripts/unfurl-ts.js <channel> <ts> <url>
import { WebClient } from '@slack/web-api';
import { buildEntity } from '../../src/features/unfurl/entity.js';

const [channel, ts, ...urls] = process.argv.slice(2);
const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const entities = (await Promise.all(urls.map((u) => buildEntity(u)))).filter(Boolean);
try {
  const res = await client.chat.unfurl({ channel, ts, metadata: { entities } });
  console.log('ok', res.ok, JSON.stringify(res.response_metadata?.messages||res.warning||''));
} catch (e) {
  console.log('error', e.data?.error, JSON.stringify(e.data?.response_metadata || {}));
}
