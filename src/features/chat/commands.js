// 메시지 첫 줄 명령 해석. Multica 서버 Slack 연동(channel/engine)의 규칙을 그대로 따른다
// - 첫 번째 비어 있지 않은 줄만 명령으로 본다
// - 대소문자 구분, 토큰 단위 일치("/issuetracker" 는 /issue 가 아니다)
// - /new, /clear 뒤에 붙은 내용(같은 줄 나머지 + 다음 줄들)은 새 채팅의 첫 메시지가 된다
// - /issue 제목은 첫 줄 나머지, 설명은 다음 줄부터

function splitFirstLine(body) {
  const lines = String(body || '').split('\n');
  const idx = lines.findIndex((l) => l.trim() !== '');
  if (idx === -1) return null;
  return { first: lines[idx].replace(/^[ \t]+/, ''), rest: lines.slice(idx + 1) };
}

function leading(body, prefix) {
  const parts = splitFirstLine(body);
  if (!parts || !parts.first.startsWith(prefix)) return null;
  const tail = parts.first.slice(prefix.length);
  if (tail && tail[0] !== ' ' && tail[0] !== '\t') return null;
  return { head: tail.trim(), rest: parts.rest };
}

// { kind: 'new' | 'clear', body } 또는 null
export function parseControl(body) {
  for (const kind of ['new', 'clear']) {
    const hit = leading(body, `/${kind}`);
    if (hit) {
      const text = [hit.head, ...hit.rest].join('\n').trim();
      return { kind, body: text };
    }
  }
  return null;
}

// { title, description } 또는 null. 제목이 비면 title 은 ''
export function parseIssue(body) {
  const hit = leading(body, '/issue');
  if (!hit) return null;
  return { title: hit.head, description: hit.rest.join('\n').replace(/[ \t\n]+$/, '') };
}

export const TEXT = {
  notMember: 'Multica 워크스페이스 멤버만 쓸 수 있어요. Slack 프로필 이메일과 같은 이메일로 Multica 에 가입돼 있는지 확인해 주세요.',
  chatStarted: '✅ 새 Multica 채팅을 시작했어요. 다음 메시지부터 이 채팅으로 들어갑니다.',
  chatCleared: '✅ 새 Multica 채팅으로 바꿨어요. 이전 대화 맥락 없이 이어집니다.',
  newThreadGuide: '채널에서는 대상 스레드에서 봇을 멘션하고 `/new` 를 붙여 주세요. 예: `@봇 /new`',
  issueUsage: '이슈 제목을 같이 적어 주세요.\n\n`/issue <제목>`\n`[설명]` (선택)',
  slashUsage: '무엇을 이슈로 만들지 적어 주세요. 예: `/issue 사파리에서 로그인 버튼이 안 눌려요`',
  slashQueued: '✅ 이슈로 정리하고 있어요. 다 만들어지면 Multica 알림으로 알려 드려요.',
  agentFailed: '⚠️ 처리하지 못했어요',
  replyTimeout: '⏳ 응답이 늦어지고 있어요. 끝나면 Multica 채팅에서 확인할 수 있어요.',
  sendFailed: '⚠️ Multica 로 메시지를 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.',
};
