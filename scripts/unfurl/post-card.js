// 앱이 Work Object 카드를 단 메시지를 직접 올려 본다(티켓번호만 있는 메시지 대응 검증용).
// node --env-file=.env scripts/post-card.js <channel> <thread_ts> <url>
import { WebClient } from '@slack/web-api';
import { buildEntity } from '../../src/features/unfurl/entity.js';

const [channel, thread_ts, url] = process.argv.slice(2);
const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const entity = await buildEntity(url);
try {
  const res = await client.chat.postMessage({
    channel,
    thread_ts,
    text: url,
    metadata: { entities: [entity] },
  });
  console.log('ok', res.ok, res.ts);
} catch (e) {
  console.log('error', e.data?.error, JSON.stringify(e.data?.response_metadata?.messages || []));
}
