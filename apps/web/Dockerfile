FROM node:26-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.11.2
ENV HUSKY=0
# The browser calls /fleetos-api on the web origin; this rewrite target is fixed at build time.
ARG FLEETOS_API_URL=http://api:4000
ENV FLEETOS_API_URL=$FLEETOS_API_URL
COPY . .
RUN pnpm install --frozen-lockfile --filter @fleetos/web... && pnpm --filter @fleetos/web build

FROM node:26-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "apps/web/server.js"]
