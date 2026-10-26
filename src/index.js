// multica-slack: Slack 에서 Multica 를 다루는 기능을 한 프로세스에 모은다.
// 기능은 src/features/<이름>/index.js 의 register(app, ctx) 로 붙인다.
//
// Slack 앱 하나의 Socket Mode 연결은 이 프로세스 하나만 연다.
// 같은 앱에 소켓을 하나 더 열면 Slack 이 이벤트를 나눠 보내 일부 이벤트가 빠진다.
// chat 기능이 Multica 서버 내장 Slack 연동을 대신하므로, 이 앱을 Multica 서버 Slack 연동에도 걸어 두면 안 된다
// (Multica 설정에서 그 Slack 설치를 먼저 끊는다. docs/chat.md).

import bolt from '@slack/bolt';
import { createSlackUsers } from './lib/slack-users.js';
import * as unfurl from './features/unfurl/index.js';
import * as chat from './features/chat/index.js';
import { missingMulticaConfig } from './lib/multica.js';

const FEATURES = [unfurl, chat];

for (const key of ['SLACK_BOT_TOKEN']) {
  if (!process.env[key]) throw new Error(`${key} 가 비어 있다`);
}
const missing = missingMulticaConfig();
if (missing.length) {
  throw new Error(`${missing.join(', ')} 가 비어 있다(환경변수 또는 multica CLI 설정 필요)`);
}
if (!process.env.SLACK_APP_TOKEN && !process.env.SLACK_SIGNING_SECRET) {
  throw new Error('SLACK_APP_TOKEN(Socket Mode) 또는 SLACK_SIGNING_SECRET(HTTP 모드) 중 하나는 있어야 한다');
}

const { App, LogLevel } = bolt;
const socketMode = Boolean(process.env.SLACK_APP_TOKEN);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  ...(socketMode
    ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN }
    : { signingSecret: process.env.SLACK_SIGNING_SECRET }),
  logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});

const ctx = { slackUsers: createSlackUsers(app.client) };
for (const feature of FEATURES) {
  feature.register(app, ctx);
  app.logger.info(`feature registered: ${feature.name}`);
}

await app.start(Number(process.env.PORT || 3000));
app.logger.info(`multica-slack started (${socketMode ? 'socket mode' : 'http :' + (process.env.PORT || 3000)})`);

// docker stop / ECS 배포 교체 시 SIGTERM 이 온다. 소켓을 닫고 나가야 Slack 이 연결을 바로 정리한다
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    app.logger.info(`${signal} received, stopping`);
    await app.stop().catch(() => {});
    process.exit(0);
  });
}
