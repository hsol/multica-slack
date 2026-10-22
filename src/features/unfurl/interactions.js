// Work Object 버튼(block_actions)과 우측 패널 편집(view_submission)을 Multica 쓰기로 바꾼다.
// 쓰기는 서비스 토큰 하나로 하고, 누른 사람은 이메일로 Multica 멤버인지 확인한 뒤
// 이슈에 "[Slack · 이름] ..." 변경 이력 댓글을 남긴다.

import { ACTION, AGENT_TARGETS, PRIORITY, buildEntity } from './entity.js';
import { addComment, getIssue, memberByEmail, updateIssue, resolveActor } from '../../lib/multica.js';

const emailCache = new Map();
async function slackEmail(client, userId) {
  if (emailCache.has(userId)) return emailCache.get(userId);
  const email = (await client.users.info({ user: userId }).catch(() => null))?.user?.profile?.email;
  emailCache.set(userId, email);
  return email;
}

// 쓰기 권한 확인. entity_url·external_ref 는 클라이언트가 보낸 값이라 그대로 믿지 않는다
async function authorize(client, userId) {
  const member = await memberByEmail(await slackEmail(client, userId));
  if (!member) throw new UserFacingError('Multica 워크스페이스 멤버만 바꿀 수 있습니다. Slack 이메일과 Multica 계정 이메일이 같은지 확인해 주세요.');
  return member;
}

class UserFacingError extends Error {}

async function notify(client, body, text) {
  const channel = body.container?.channel_id || body.channel?.id;
  if (body.response_url) {
    await fetch(body.response_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
    }).catch(() => {});
  } else if (channel) {
    await client.chat.postEphemeral({ channel, user: body.user.id, text }).catch(() => {});
  }
}

// 버튼을 누른 곳(카드 또는 우측 패널)을 새 값으로 다시 그린다
async function refresh(client, logger, body, lookupSlackUser) {
  const c = body.container || {};
  const url = c.app_unfurl_url || c.entity_url;
  if (!url) return;
  try {
    if (c.type === 'entity_detail') {
      const entity = await buildEntity(url, { detail: true, lookupSlackUser });
      if (entity) await client.entity.presentDetails({ trigger_id: body.trigger_id, metadata: entity });
    } else if (c.channel_id && c.message_ts) {
      const entity = await buildEntity(url, { lookupSlackUser });
      if (entity) await client.chat.unfurl({ channel: c.channel_id, ts: c.message_ts, metadata: { entities: [entity] } });
    }
  } catch (e) {
    logger.warn(`refresh failed: ${e.data?.error || e.message}`);
  }
}

const tag = (member) => `[Slack · ${member.name}]`;

export function registerInteractions(app, { lookupSlackUser }) {
  const run = (label, fn) => async ({ ack, body, client, logger, action }) => {
    await ack();
    try {
      const member = await authorize(client, body.user.id);
      const summary = await fn({ body, action, member });
      logger.info(`${label} by ${member.name}: ${summary}`);
      await refresh(client, logger, body, lookupSlackUser);
    } catch (e) {
      logger.error(`${label} failed: ${e.message}`);
      await notify(client, body, e instanceof UserFacingError ? e.message : `처리하지 못했습니다: ${e.message}`);
    }
  };

  app.action(ACTION.assignMe, run('assign_me', async ({ action, member }) => {
    await updateIssue(action.value, { assignee_type: 'member', assignee_id: member.user_id });
    await addComment(action.value, `${tag(member)} 담당자를 ${member.name}(으)로 변경`);
    return action.value;
  }));

  app.action(ACTION.done, run('mark_done', async ({ action, member }) => {
    await updateIssue(action.value, { status: 'done' });
    await addComment(action.value, `${tag(member)} 상태를 Done 으로 변경`);
    return action.value;
  }));

  app.action(new RegExp(`^${ACTION.delegate}_\\d+$`), run('delegate', async ({ action, member }) => {
    const { issue, type, id } = JSON.parse(action.value);
    // 버튼 값도 클라이언트가 보낸 것이라 허용 목록에 있는 대상만 받는다
    if (!AGENT_TARGETS.some((t) => t.type === type && t.id === id)) throw new UserFacingError('허용되지 않은 대상입니다.');
    await updateIssue(issue, { assignee_type: type, assignee_id: id });
    const target = await resolveActor(type, id);
    await addComment(issue, `${tag(member)} ${target?.name || type}에게 맡김`);
    return `${issue} -> ${type}:${id}`;
  }));

  // URL 버튼은 Slack 이 링크를 열고, 앱에는 ack 만 필요하다
  app.action(ACTION.open, async ({ ack }) => ack());

  // 우측 패널 연필 아이콘 편집 저장
  app.view({ type: 'view_submission' }, async ({ ack, body, view, client, logger }) => {
    if (view?.type !== 'entity_detail') return ack();
    const ref = body.external_ref || view.external_ref;
    const url = body.app_unfurl_url || view.app_unfurl_url || body.entity_url || view.entity_url;
    const patch = {};
    for (const [blockId, inputs] of Object.entries(view.state?.values || {})) {
      const field = blockId.split('.')[0];
      const input = Object.values(inputs)[0] || {};
      const value = input.selected_option?.value ?? input.selected_date ?? input.value ?? null;
      if (field === 'status' && value) patch.status = value;
      if (field === 'priority' && value) patch.priority = value;
      if (field === 'due_date') patch.due_date = value || '';
    }
    if (patch.priority && !PRIORITY[patch.priority]) {
      return ack({ response_action: 'errors', errors: { priority: '알 수 없는 우선순위입니다.' } });
    }
    await ack();
    try {
      const member = await authorize(client, body.user.id);
      const issueId = ref?.id;
      const before = await getIssue(issueId);
      if (!before) throw new UserFacingError('이슈를 찾지 못했습니다.');
      await updateIssue(issueId, patch);
      const changes = Object.entries(patch)
        .filter(([k, v]) => (before[k] || '') !== v)
        .map(([k, v]) => `${k}: ${before[k] || '-'} → ${v || '-'}`);
      if (changes.length) await addComment(issueId, `${tag(member)} ${changes.join(', ')}`);
      logger.info(`edit by ${member.name}: ${before.identifier} ${changes.join(', ')}`);
      const entity = url && (await buildEntity(url, { detail: true, lookupSlackUser }));
      if (entity) await client.entity.presentDetails({ trigger_id: body.trigger_id, metadata: entity });
    } catch (e) {
      logger.error(`edit failed: ${e.message}`, JSON.stringify(view?.state?.values || {}));
      await client.entity
        .presentDetails({
          trigger_id: body.trigger_id,
          error: { status: 'edit_error', custom_message: e instanceof UserFacingError ? e.message : '저장하지 못했습니다.' },
        })
        .catch(() => {});
    }
  });
}
