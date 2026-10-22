// Multica issue -> Slack Work Object (slack#/entities/task) metadata.

import { getIssue, resolveActor, projectTitle, issueStatuses, listComments, multicaAppUrl } from '../../lib/multica.js';
import { commentSummary } from './comments.js';

const APP_HOST = multicaAppUrl ? new URL(multicaAppUrl).host : '';
// https://<multica 웹 주소>/<workspace>/issues/ABC-123 (쿼리·해시 허용)
const ISSUE_URL_RE = /^\/([^/]+)\/issues\/([A-Za-z][A-Za-z0-9]*-\d+|[0-9a-f-]{36})\/?$/i;

export function parseIssueUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.host !== APP_HOST) return null;
  const m = u.pathname.match(ISSUE_URL_RE);
  return m ? { slug: m[1], ref: m[2] } : null;
}

const STATUS = {
  backlog: { label: 'Backlog', color: 'gray' },
  todo: { label: 'Todo', color: 'gray' },
  in_progress: { label: 'In Progress', color: 'yellow' },
  in_review: { label: 'In Review', color: 'blue' },
  blocked: { label: 'Blocked', color: 'red' },
  done: { label: 'Done', color: 'green' },
  cancelled: { label: 'Cancelled', color: 'gray' },
};
export const PRIORITY = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'None' };

// "에이전트에게 맡기기" 대상. 예:
// AGENT_TARGETS='[{"label":"리뷰 에이전트에게 맡기기","type":"agent","id":"<agent id>"}]'
// 비우면 맡기기 버튼을 만들지 않는다
export const AGENT_TARGETS = (() => {
  if (!process.env.AGENT_TARGETS) return [];
  try {
    return JSON.parse(process.env.AGENT_TARGETS);
  } catch {
    console.warn('AGENT_TARGETS 를 JSON 으로 읽지 못해 맡기기 버튼을 끈다');
    return [];
  }
})();

export const ACTION = {
  assignMe: 'multica_assign_me',
  done: 'multica_mark_done',
  delegate: 'multica_delegate',
  open: 'multica_open',
};

const toEpoch = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : undefined);
const clip = (s, n) => {
  const chars = Array.from(s || '');
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('');
};
const option = (text, value) => ({ text: { type: 'plain_text', text }, value });

function statusField(issue, statuses, editable) {
  const key = issue.status_category || issue.status;
  const base = STATUS[key] || { label: issue.status, color: 'gray' };
  const field = { value: issue.status_name || base.label, tag_color: base.color };
  if (editable && statuses.length) {
    field.edit = {
      enabled: true,
      select: {
        current_value: issue.status,
        static_options: statuses.map((s) => option(s.name, s.key)),
      },
    };
  }
  return field;
}

function priorityField(issue, editable) {
  const label = PRIORITY[issue.priority];
  if (!label && !editable) return undefined;
  const field = { value: label || 'None' };
  if (editable) {
    field.edit = {
      enabled: true,
      select: {
        current_value: issue.priority || 'none',
        static_options: Object.entries(PRIORITY).map(([k, v]) => option(v, k)),
      },
    };
  }
  return field;
}

function dueDateField(issue, editable) {
  if (!issue.due_date && !editable) return undefined;
  const field = { type: 'slack#/types/date', value: issue.due_date ? issue.due_date.slice(0, 10) : undefined };
  if (editable) field.edit = { enabled: true, optional: true };
  return field;
}

function actorField(actor, slackUserId) {
  if (slackUserId) return { type: 'slack#/types/user', user: { user_id: slackUserId } };
  if (!actor) return undefined;
  const suffix = actor.kind === 'agent' ? ' (agent)' : actor.kind === 'squad' ? ' (squad)' : '';
  return { type: 'slack#/types/user', user: { text: actor.name + suffix } };
}

function actions(issue, canonical) {
  const primary = [];
  primary.push({ text: '나에게 할당', action_id: ACTION.assignMe, value: issue.id });
  if (issue.status !== 'done') {
    primary.push({ text: '완료 처리', action_id: ACTION.done, value: issue.id, style: 'primary' });
  }
  const overflow = AGENT_TARGETS.slice(0, 4).map((t, i) => ({
    text: t.label,
    action_id: `${ACTION.delegate}_${i}`,
    value: JSON.stringify({ issue: issue.id, type: t.type, id: t.id }),
  }));
  overflow.push({ text: 'Multica에서 열기', action_id: ACTION.open, url: canonical });
  return { primary_actions: primary, overflow_actions: overflow };
}

/**
 * @param {string} url  Slack 메시지에 붙은 원본 URL (app_unfurl_url 과 정확히 같아야 한다)
 * @param {{detail?: boolean, lookupSlackUser?: (email: string) => Promise<string|undefined>}} opts
 */
export async function buildEntity(url, { detail = false, lookupSlackUser } = {}) {
  const parsed = parseIssueUrl(url);
  if (!parsed) return null;
  const issue = await getIssue(parsed.ref);
  if (!issue) return null;

  const canonical = `${new URL(url).origin}/${parsed.slug}/issues/${issue.identifier}`;
  const [assignee, creator, project, statuses, comments] = await Promise.all([
    resolveActor(issue.assignee_type, issue.assignee_id),
    detail ? resolveActor(issue.creator_type, issue.creator_id) : null,
    projectTitle(issue.project_id),
    detail ? issueStatuses() : [],
    listComments(issue.id).catch(() => null),
  ]);
  const slackId = async (a) =>
    a?.kind === 'member' && a.email && lookupSlackUser ? lookupSlackUser(a.email).catch(() => undefined) : undefined;
  const [assigneeSlack, creatorSlack] = await Promise.all([slackId(assignee), slackId(creator)]);

  // 편집은 우측 패널(detail)에서만 연다. 카드에는 버튼만 둔다
  const fields = {
    status: statusField(issue, statuses, detail),
    assignee: actorField(assignee, assigneeSlack),
    due_date: dueDateField(issue, detail),
    priority: priorityField(issue, detail),
  };
  if (detail) {
    fields.description = issue.description ? { value: clip(issue.description, 3000), format: 'markdown', long: true } : undefined;
    fields.created_by = actorField(creator, creatorSlack);
    fields.date_created = { type: 'slack#/types/timestamp', value: toEpoch(issue.created_at) };
    fields.date_updated = { type: 'slack#/types/timestamp', value: toEpoch(issue.updated_at) };
  }
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];

  const custom_fields = [];
  if (project) custom_fields.push({ key: 'project', label: 'Project', value: project, type: 'string' });
  if (issue.labels?.length) {
    custom_fields.push({ key: 'labels', label: 'Labels', value: issue.labels.map((l) => l.name).join(', '), type: 'string' });
  }

  return {
    app_unfurl_url: url,
    url: canonical,
    // external_ref 는 Work Object 의 정체성이다. 바뀌면 Related conversations 가 끊기므로 UUID 로 고정
    external_ref: { id: issue.id, type: 'issue' },
    entity_type: 'slack#/entities/task',
    // 댓글 탭 진입점. 이 필드가 있어야 카드·패널에 댓글 링크가 생긴다
    ...(comments ? { entity_comments: commentSummary(comments) } : {}),
    entity_payload: {
      attributes: {
        title: { text: clip(issue.title, 200) },
        display_id: issue.identifier,
        product_name: 'Multica',
        metadata_last_modified: toEpoch(issue.updated_at),
      },
      fields,
      ...(custom_fields.length ? { custom_fields } : {}),
      actions: actions(issue, canonical),
    },
  };
}
