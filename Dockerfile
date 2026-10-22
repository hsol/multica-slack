# multica-slack: Slack 앱에 Socket Mode 로 붙는 Bolt 프로세스.
# 인바운드 포트가 필요 없다(HTTP 모드로 돌릴 때만 PORT, 기본 3000).
#
#   docker build -t multica-slack .
#   docker run --rm --env-file .env multica-slack
#
# 컨테이너 안에는 multica CLI 설정이 없으므로 MULTICA_SERVER_URL, MULTICA_WORKSPACE_ID, MULTICA_TOKEN 을 넘긴다.
# 같은 Slack 앱에 소켓은 한 프로세스만 열어야 하니, 컨테이너를 띄울 때는 로컬 npm run dev 를 끈다.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# 점검 스크립트(카드 데이터 미리보기 등)를 컨테이너 안에서도 쓸 수 있게 같이 넣는다
COPY scripts ./scripts
USER node
CMD ["node", "src/index.js"]
