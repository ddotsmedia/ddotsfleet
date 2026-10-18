FROM node:26-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.11.2
ENV HUSKY=0
COPY . .
RUN pnpm install --frozen-lockfile --filter @fleetos/api... && pnpm --filter @fleetos/api build \
 && pnpm --filter @fleetos/api --prod deploy /deploy

# Runs `prisma migrate deploy` against DATABASE_URL and exits. Docker compose runs it before the API starts.
# Declared before `run` so that a plain `docker build` still produces the API image (the last stage).
FROM build AS migrate
WORKDIR /repo
CMD ["pnpm", "--filter", "@fleetos/api", "db:deploy"]

FROM node:26-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=4000
COPY --from=build /deploy ./
USER node
EXPOSE 4000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
CMD ["node", "dist/main.js"]
