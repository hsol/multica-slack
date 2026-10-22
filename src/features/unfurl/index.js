// unfurl: Multica 이슈 링크를 Slack Work Object(task) 카드로 펼친다.
// - message                  -> chat.unfurl(channel, ts) : 봇이 올린 링크 포함 모든 메시지
// - link_shared              -> chat.unfurl(unfurl_id)   : 사람이 올린 링크(작성 중 미리보기 포함)
// - entity_details_requested -> entity.presentDetails    : 우측 패널
// - entity_comments_requested -> entity.presentComments  : 댓글 탭(원본은 Multica)
// - 버튼·패널 편집                                        : interactions.js
// 자세한 내용은 docs/unfurl.md

import { buildEntity, parseIssueUrl } from './entity.js';
import { registerInteractions } from './interactions.js';
import { presentComments } from './comments.js';
import { memberByEmail } from '../../lib/multica.js';

export const name = 'unfurl';

// 사람이 올린 메시지는 message 와 link_shared 가 둘 다 온다. 먼저 온 쪽만 처리한다.
const handled = new Map();
const DEDUP_TTL_MS = 10 * 60 * 1000;
function claim(channel, ts) {
  const now = Date.now();
  for (const [k, at] of handled) if (now - at > DEDUP_TTL_MS) handled.delete(k);
  const key = `${channel}:${ts}`;
  if (handled.has(key)) return false;
  handled.set(key, now);
  return true;
}

// 메시지 본문과 rich_text 블록에서 URL 을 모은다. 봇 메시지는 attachments 에 링크를 넣기도 한다.
const URL_RE = /https?:\/\/[^\s<>|"'\\]+/g;
function extractUrls(message) {
  const haystack = JSON.stringify([message.text, message.blocks, message.attachments]);
  return (haystack.match(URL_RE) || []).map((u) => u.replace(/[).,]+$/, ''));
}

export function register(app, { slackUsers }) {
  const lookupSlackUser = slackUsers.idForEmail;

  async function buildEntities(urls, logger) {
    const unique = [...new Set(urls)].filter(parseIssueUrl);
    const built = await Promise.all(
      unique.map((u) =>
        buildEntity(u, { lookupSlackUser }).catch((e) => {
          logger.warn(`build failed ${u}: ${e.message}`);
          return null;
        }),
      ),
    );
    return built.filter(Boolean);
  }

  async function unfurl(client, logger, target, entities) {
    try {
      await client.chat.unfurl({ ...target, metadata: { entities } });
      logger.info(`unfurled ${entities.map((e) => e.entity_payload.attributes.display_id).join(',')}`);
    } catch (e) {
      logger.error(`chat.unfurl failed: ${e.data?.error || e.message}`, e.data?.response_metadata);
    }
  }

  app.event('message', async ({ event, client, logger }) => {
    // 새로 올라온 메시지만. 수정·삭제·참여 알림 등은 건너뛴다
    if (event.subtype && event.subtype !== 'bot_message' && event.subtype !== 'thread_broadcast') return;
    const urls = extractUrls(event).filter(parseIssueUrl);
    if (!urls.length || !claim(event.channel, event.ts)) return;
    const entities = await buildEntities(urls, logger);
    if (entities.length) await unfurl(client, logger, { channel: event.channel, ts: event.ts }, entities);
  });

  app.event('link_shared', async ({ event, client, logger }) => {
    const urls = event.links.map((l) => l.url).filter(parseIssueUrl);
    if (!urls.length) return;
    // 작성 중(composer) 미리보기는 message_ts 가 임시값이라 중복 판정을 하지 않는다.
    // 새로고침(is_unfurl_refresh)은 이미 붙인 카드를 최신 값으로 다시 그리라는 요청이라 중복 판정에서 뺀다
    if (event.source !== 'composer' && !event.is_unfurl_refresh && !claim(event.channel, event.message_ts)) return;
    const entities = await buildEntities(urls, logger);
    if (!entities.length) return;
    const target = event.unfurl_id && event.source
      ? { unfurl_id: event.unfurl_id, source: event.source }
      : { channel: event.channel, ts: event.message_ts };
    await unfurl(client, logger, target, entities);
  });

  app.event('entity_details_requested', async ({ event, client, logger }) => {
    const url = event.app_unfurl_url || event.link?.url || event.entity_url;
    try {
      const entity = await buildEntity(url, { detail: true, lookupSlackUser });
      if (!entity) return;
      await client.entity.presentDetails({ trigger_id: event.trigger_id, metadata: entity });
    } catch (e) {
      logger.error(`entity.presentDetails failed: ${e.data?.error || e.message}`, e.data?.response_metadata);
    }
  });

  // 댓글 탭을 열거나 새로고침·다음 페이지를 요청할 때
  app.event('entity_comments_requested', async ({ event, client, logger }) => {
    try {
      const member = await memberByEmail(await slackUsers.emailForId(event.user));
      const issueUrl = event.entity_url || event.link?.url;
      await presentComments({ client, event, issueUrl, lookupSlackUser, member, logger });
    } catch (e) {
      logger.error(`presentComments failed: ${e.data?.error || e.message}`, e.data?.response_metadata);
    }
  });

  registerInteractions(app, { lookupSlackUser, emailForId: slackUsers.emailForId });

  // 댓글 작성처럼 아직 처리하지 않는 Work Object 상호작용은 형태를 남겨 둔다(구현용 관찰)
  app.use(async ({ body, next, logger }) => {
    const kind = body?.type === 'event_callback'
      ? `event:${body.event?.type}`
      : `${body?.type}:${body?.view?.type || body?.actions?.[0]?.action_id || ''}`;
    if (/comment/i.test(kind) || body?.container?.type === 'entity_detail' || body?.view?.type === 'entity_detail') {
      logger.info(`[observe] ${kind} ${JSON.stringify(body).slice(0, 1500)}`);
    }
    await next();
  });
}
