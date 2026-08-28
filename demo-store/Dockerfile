# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

# Runtime stage: static files + same-origin API proxy (mirrors the dashboard pattern).
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# envsubst template injects the configured dev key as X-API-Key server-side
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
