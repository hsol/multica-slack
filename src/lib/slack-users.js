// Slack 유저 조회 공용 캐시. 여러 기능이 같이 쓴다.
// users:read.email 스코프가 있어야 이메일 기준 매칭이 된다.

export function createSlackUsers(client) {
  const idByEmail = new Map();
  const emailById = new Map();

  // Multica 멤버 이메일 -> Slack 유저 ID. 못 찾으면 undefined
  async function idForEmail(email) {
    if (!email || process.env.RESOLVE_SLACK_USERS === 'false') return undefined;
    if (idByEmail.has(email)) return idByEmail.get(email);
    let id;
    try {
      id = (await client.users.lookupByEmail({ email })).user?.id;
    } catch {
      id = undefined;
    }
    idByEmail.set(email, id);
    return id;
  }

  // Slack 유저 ID -> 이메일. Multica 멤버 확인용
  async function emailForId(userId) {
    if (emailById.has(userId)) return emailById.get(userId);
    const email = (await client.users.info({ user: userId }).catch(() => null))?.user?.profile?.email;
    emailById.set(userId, email);
    return email;
  }

  return { idForEmail, emailForId };
}
