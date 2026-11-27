# Build stage: bundles the web apps and assembles site/, the static files every
# deployed host serves (scripts/build-site.js).
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder
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
FROM httpd:2.4-alpine@sha256:32bd0639bcc4917ef1fd9363a1d9dd2dd9c498565118b062a10d51e43a5c3a24
COPY httpd.conf /usr/local/apache2/conf/httpd.conf
COPY --from=builder /app/site/ /usr/local/apache2/htdocs/
USER 1001:1001
EXPOSE 4000
