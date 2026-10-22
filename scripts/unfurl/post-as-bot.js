// Multica 봇처럼 unfurl 을 끈 봇 메시지를 올려 message 경로를 검증한다.
// node --env-file=.env scripts/post-as-bot.js <channel> <thread_ts> <text>
import { WebClient } from '@slack/web-api';

const [channel, thread_ts, text] = process.argv.slice(2);
const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const res = await client.chat.postMessage({ channel, thread_ts, text, unfurl_links: false, unfurl_media: false });
console.log('posted', res.ok, res.ts);
