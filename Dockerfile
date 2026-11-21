# Build stage: bundles the web apps and assembles site/, the static files every
# deployed host serves (scripts/build-site.js).
FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server/ ./server/
COPY public/ ./public/
COPY partyplug/ ./partyplug/
COPY scripts/ ./scripts/
# The commit in the pages' version label (docker-publish.yml passes it).
ARG GIT_SHA=
RUN npm run build:site

# Runtime: Apache serving site/ with public/.htaccess (httpd.conf has the rest).
FROM httpd:2.4-alpine
COPY httpd.conf /usr/local/apache2/conf/httpd.conf
COPY --from=builder /app/site/ /usr/local/apache2/htdocs/
USER 1001:1001
EXPOSE 4000
